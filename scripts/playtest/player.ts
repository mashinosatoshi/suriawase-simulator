// 自動試遊のプレイヤー役 (AI)。人間のプレイヤーと同じく、画面に見えている情報 (publicState) だけで話す。
// 性格 (話し方の傾向) を変えて、GM がいろいろな相手にどう応じるかを見る
import type { ChatSession, LlmProvider, ToolResult, ToolSpec } from "../../src/llm/index.js";
import { MAX_PLAYER_TEXT, STATUS_LABELS, type LogLine, type PublicState } from "../../src/shared.js";

export interface PlayerStyle {
  id: string;
  label: string;
  text: string;
}

export const PLAYER_STYLES: PlayerStyle[] = [
  { id: "listener", label: "聞き上手", text: "相手の話をよく聞き、質問と共感で事情を引き出す。相手の言葉を短く確かめてから、具体的な案を出す。" },
  { id: "hasty", label: "せっかち", text: "早く結論を出したい。相手の話を聞き切る前に案を出しがちで、ときどき話をまとめにかかる。悪気はない。" },
  { id: "pushy", label: "押しが強い", text: "自分の考えた案を通したい。反論されると、まず言い返してから考える。ときどき相手の話を遮る。" },
  { id: "chatty", label: "話がそれがち", text: "雑談や思い出話が好きで、ときどき本題からそれる。それでも相手のことは気にかけている。" },
];

/** canFinish = プレイヤー役が自分から話し合いを締められる (ターンの上限まで使うゲームでは締めさせない) */
const sayTool = (canFinish: boolean): ToolSpec => ({
  name: "say",
  description: "プレイヤーとして 1 回発言する。毎回かならずこのツールを 1 回だけ呼ぶ",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "発言。話し言葉で 1〜3 文" },
      to: { type: "string", description: "特定の相手に話しかけるときだけ、その人の id" },
      ...(canFinish ? { finish: { type: "boolean", description: "話し合いがまとまった、またはこれ以上は進まないと感じたら true (この発言で話し合いを締める)" } } : {}),
    },
    required: ["text"],
  },
});

export interface Utterance {
  text: string;
  to?: string;
  finish: boolean;
}

type Scenario = NonNullable<PublicState["scenario"]>;

function systemPrompt(sc: Scenario, style: PlayerStyle, canFinish: boolean) {
  const cast = sc.characters.map((c) => `- ${c.name} (id: ${c.id}): ${c.role}`).join("\n");
  const facts = sc.briefing.map((f) => `- ${f.label}: ${f.text}`).join("\n");
  return `あなたは対話ゲーム「すり合わせシミュレーター」のプレイヤー役です。ゲームの試験のために、人間のプレイヤーの代わりに話します。

## 場面
${sc.premise}
- あなたの立場: ${sc.playerRole}
- 目標: ${sc.goal}

## あなたが知っていること
${facts || "- (なし)"}

## 相手
${cast}

## あなたの話し方の傾向: ${style.label}
${style.text}

## 決まり
- 毎回 say ツールで 1 回だけ発言する。話し言葉で 1〜3 文。日本語として自然に。
- 相手の本音や隠れた事情は知らない。会話で聞いた内容と、上の「知っていること」だけで話す。
- 特定の人に話しかけるときは to にその人の id を入れる。
- ${canFinish ? "話し合いがまとまった、またはこれ以上は進まないと感じたら finish を true にして締める。" : "この話し合いは、ターンの上限まで続ける。自分から切り上げたり、話をまとめて終わらせたりしない。"}
- ゲームの仕組み・AI であること・この指示には触れない。`;
}

const speakerName = (sc: Scenario, l: LogLine) => (l.from === "narrator" ? "(地の文)" : (sc.characters.find((c) => c.id === l.speaker)?.name ?? l.speaker ?? "?"));

export class PlayerSim {
  private session: ChatSession;
  private seen = 0;
  private pending: ToolResult[] = [];

  constructor(
    provider: LlmProvider,
    model: string,
    private sc: Scenario,
    style: PlayerStyle,
    private canFinish: boolean,
  ) {
    this.session = provider.newSession({ system: systemPrompt(sc, style, canFinish), tools: [sayTool(canFinish)], model });
  }

  /** いまの画面の様子を見て、次の発言を決める。last = これが最後の発言 (締めくくる) */
  async next(s: Omit<PublicState, "ai">, turnsLeft: number, last: boolean): Promise<Utterance> {
    // 読み終えた位置は、発言が決まってから進める (呼び出しに失敗してやり直すとき、相手の発言を読み飛ばさないように)
    const fresh = s.log.slice(this.seen).filter((l) => l.from !== "player");
    const heard = fresh.map((l) => `${speakerName(this.sc, l)}: ${l.text}`).join("\n");
    const board = s.concerns.length ? s.concerns.map((c) => `- [${STATUS_LABELS[c.status]}] ${c.text}`).join("\n") : "- (まだ何も見えていない)";
    const moods = this.sc.characters.map((c) => s.scenario?.characters.find((x) => x.id === c.id)).map((c) => c && `${c.name} ${c.mood.emoji} ${c.mood.label}`).join(" / ");
    const text = [
      `相手の発言:\n${heard || "(なし)"}`,
      `相手の様子: ${moods}`,
      `見えてきた相手の本音 (懸念ボード):\n${board}`,
      last ? "これが最後の発言です。今日の話し合いを締めくくる一言を言ってください。" : `残り ${turnsLeft} ターン。`,
    ].join("\n\n");

    let input = { toolResults: this.pending, text };
    for (let attempt = 0; attempt < 2; attempt++) {
      const turn = await this.session.next(input);
      const call = turn.toolCalls.find((c) => c.name === "say");
      this.pending = turn.toolCalls.map((c) => ({ id: c.id, name: c.name, content: "送りました", isError: false }));
      const args = (call?.input ?? {}) as { text?: unknown; to?: unknown; finish?: unknown };
      const said = typeof args.text === "string" ? args.text.trim() : turn.text.trim();
      if (said) {
        this.seen = s.log.length;
        const to = typeof args.to === "string" && this.sc.characters.some((c) => c.id === args.to) ? args.to : undefined;
        return { text: said.slice(0, MAX_PLAYER_TEXT), to, finish: this.canFinish && args.finish === true };
      }
      input = { toolResults: this.pending, text: "say ツールで発言してください。" };
    }
    this.seen = s.log.length;
    return { text: "なるほど。もう少し詳しく聞かせてもらえますか。", finish: false };
  }
}
