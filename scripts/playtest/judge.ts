// 自動試遊の審査役 (AI)。1 ゲームの会話を読み、登場人物の台詞と地の文の不自然な箇所を、種類つきで挙げる。
// 審査役も AI なので外れることがある。指摘は人が読んで、直すかどうかを決める前提
import { z } from "zod";
import type { ChatSession, LlmProvider, ToolSpec } from "../../src/llm/index.js";
import type { Scenario } from "../../src/scenario.js";
import type { LogLine } from "../../src/shared.js";

export const CATEGORIES = [
  "状況との食い違い",
  "人物像のぶれ",
  "口調のぶれ",
  "聞かれていないことを話す",
  "不自然な日本語",
  "都合のよすぎる展開",
  "誘導・匂わせ",
  "その他",
] as const;
export const SEVERITIES = ["軽微", "目立つ", "重大"] as const;

const CATEGORY_HELP = `- 状況との食い違い: 前提情報・場面・それまでの会話と矛盾する。立場上ありえない言動
- 人物像のぶれ: persona に合わない言動。理由のない急な態度の変化
- 口調のぶれ: speech (一人称・呼び方・文体・語尾) から外れる。同じ人の中で敬体と常体が混ざる
- 聞かれていないことを話す: 聞かれていない事情や本音を自分から話す。しゃべりすぎ
- 不自然な日本語: 翻訳調・説明口調・オウム返し・不自然な助詞や敬語
- 都合のよすぎる展開: 本音をあっさり話す、不十分な案にすぐ納得する、など相手として不自然に甘い
- 誘導・匂わせ: 隠し事をほのめかす仕草や台詞で、プレイヤーを誘導する
- その他: 上のどれにも当たらない不自然さ`;

export const reportSchema = z.object({
  naturalness: z.number().int().min(1).max(5).describe("会話全体の自然さ。5 = 人間どうしの会話として違和感がない / 1 = 不自然な箇所だらけ"),
  summary: z.string().min(1).max(600).describe("全体の所見を 2〜4 文で"),
  issues: z
    .array(
      z.object({
        turn: z.number().int().min(0).max(999).describe("その台詞のターン番号 (会話の [n])"),
        speaker: z.string().describe("話した人の名前 (地の文なら「地の文」)"),
        quote: z.string().min(1).max(200).describe("不自然な部分を、台詞から一字一句そのまま抜き出す"),
        category: z.enum(CATEGORIES),
        severity: z.enum(SEVERITIES).describe("軽微 = 少し引っかかる / 目立つ = 多くの人が違和感を持つ / 重大 = 場面や人物が壊れる"),
        reason: z.string().min(1).max(300).describe("なぜ不自然か"),
        fix_hint: z.string().max(300).optional().describe("どう言えば自然だったか"),
      }),
    )
    .max(30)
    .describe("不自然な箇所。無ければ空の配列。登場人物の台詞と地の文だけが対象 (プレイヤーの発言は対象外)"),
});
export type JudgeReport = z.infer<typeof reportSchema>;

const REPORT: ToolSpec = (() => {
  const { $schema: _drop, ...parameters } = z.toJSONSchema(reportSchema) as Record<string, unknown>;
  return { name: "report", description: "審査の結果を提出する。1 回だけ呼ぶ", parameters };
})();

/** 審査役への指示 (API 版ではシステムプロンプト、MCP 版ではサブエージェントへの説明に使う) */
export const JUDGE_GUIDE = `あなたは、日本語の会話劇の脚本を校閲する編集者です。
対話ゲーム「すり合わせシミュレーター」で、AI が演じた登場人物の台詞と地の文に、不自然な箇所がないかを審査します。
プレイヤーの発言は試験用の AI が書いたもので、審査の対象ではありません (登場人物がそれにどう応じたかは対象)。

## 不自然さの種類
${CATEGORY_HELP}

## 審査の決まり
- 登場人物の設定 (persona・speech・sample_lines)、前提情報、その時点までの会話を踏まえて判断する。
- 本音 (concerns) は、登場人物が隠している事情。聞かれる前に話していないか、話すきっかけが自然かも見る。
- 好みの問題や、言い回しの小さな揺れは挙げない。読み手が「この人がこの場面でこう言うのはおかしい」と感じる箇所だけを挙げる。
- quote は台詞から一字一句そのまま抜き出す。`;

const SYSTEM = `${JUDGE_GUIDE}\n- 結果は report ツールで 1 回だけ提出する。`;

export interface TranscriptLine {
  turn: number;
  speaker: string;
  from: "player" | "character" | "narrator";
  text: string;
}

/** 会話の記録に、ターン番号 (プレイヤーの発言ごとに 1 つ進む。冒頭は 0) と話者の名前を付ける */
export function transcriptOf(log: LogLine[], names: Map<string, string>): TranscriptLine[] {
  let turn = 0;
  return log.map((l) => {
    if (l.from === "player") turn++;
    const speaker = l.from === "player" ? "プレイヤー" : l.from === "narrator" ? "地の文" : (names.get(l.speaker ?? "") ?? l.speaker ?? "?");
    return { turn, speaker, from: l.from, text: l.text };
  });
}

export const formatTranscript = (lines: TranscriptLine[]) => lines.map((l) => `[${l.turn}] ${l.from === "player" ? "プレイヤー" : l.speaker}: ${l.text}`).join("\n");

/** 審査役に渡す材料: 登場人物の設定・隠れた本音と、ターン番号つきの会話 */
export function material(sc: Scenario, lines: TranscriptLine[]) {
  const setup = {
    title: sc.title,
    premise: sc.premise,
    player_role: sc.player_role,
    briefing: sc.briefing,
    characters: sc.characters.map((c) => ({ name: c.name, role: c.role, persona: c.persona, speech: c.speech, sample_lines: c.sample_lines })),
    concerns: sc.concerns.map((c) => ({ owner: sc.characters.find((x) => x.id === c.owner)?.name ?? c.owner, text: c.text, reveal_hint: c.reveal_hint })),
  };
  return `## 設定\n${JSON.stringify(setup, null, 1)}\n\n## 会話\n${formatTranscript(lines)}`;
}

/** 審査する。形が正しくなければ理由を返して出し直させる (最大 3 回) */
export async function judge(provider: LlmProvider, model: string, sc: Scenario, lines: TranscriptLine[]): Promise<JudgeReport> {
  const session: ChatSession = provider.newSession({ system: SYSTEM, tools: [REPORT], model });
  let input: Parameters<ChatSession["next"]>[0] = { text: material(sc, lines) };
  let problem = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const turn = await session.next(input);
    if (turn.problem) {
      problem = turn.problem;
      continue;
    }
    const call = turn.toolCalls.find((c) => c.name === "report");
    if (!call) {
      problem = "report ツールが呼ばれなかった";
      input = { toolResults: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, content: "report ツールを使ってください", isError: true })), text: "report ツールで結果を提出してください。" };
      continue;
    }
    const parsed = reportSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
    problem = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" / ");
    input = { toolResults: [{ id: call.id, name: call.name, content: `形が正しくありません: ${problem}。直して report をもう一度呼んでください`, isError: true }] };
  }
  throw new Error(`審査役が有効な結果を出せませんでした: ${problem}`);
}
