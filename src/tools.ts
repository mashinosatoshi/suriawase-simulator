// AI が呼ぶゲーム用ツール。MCP 経由 (server.ts) と内蔵 GM (gm.ts) で同じ定義・同じ検証を使う。
import { z } from "zod";
import type { Engine } from "./engine.js";
import { replySchema, replyShape, reviewShape, scenarioShape } from "./scenario.js";

export type GameToolName = "start_scenario" | "reply" | "submit_review";

export interface ToolOutcome {
  ok: boolean;
  /** AI に返す文 (成功時は要約、失敗時は直すべき点) */
  text: string;
  /** reply の成功で対話が終わった */
  ended?: boolean;
}

export interface GameTool {
  name: GameToolName;
  description: string;
  shape: z.ZodRawShape;
  run(engine: Engine, input: unknown): ToolOutcome;
}

const failure = (message: string, problems: string[]): ToolOutcome => ({ ok: false, text: JSON.stringify({ error: message, problems }, null, 2) });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export const GAME_TOOLS: GameTool[] = [
  {
    name: "start_scenario",
    description: `新しいシナリオを作ってゲームを始める (新しいゲームの依頼 type=new_game が来たとき)。検証エラーがあれば内容を直して再度呼ぶ。
設計の指針:
- 舞台は自由 (現実の仕事・家族・地域から、ファンタジー・SF まで)。プレイヤーの request があれば従う。
- 課題は「どちらかが勝つ」ものではなく、双方の事情を理解して落としどころを見つけるもの。
- 難易度 (仕事の difficulty) に従う。懸念はちょうど difficulty.concerns 個。
- 各キャラに trust_start (最初の信頼度) と understanding (物わかり) を 1〜10 で付ける。persona (人柄) に合わせて人ごとに差をつけ、全員の平均を difficulty.trust_start / difficulty.understanding ±1 に収める。
- 各懸念に importance (owner にとっての重要度 1〜10) を付ける。9〜10 (これだけは譲れない) はちょうど difficulty.non_negotiable 個。残りは 1〜8 で緩急をつける。
- 最初から話せる本音 (min_trust が owner の trust_start 以下) はちょうど difficulty.open_at_start 個にし、残りは owner の trust_start より上でばらつかせる。opening の口調と opening_moods は、各キャラの trust_start の段階 (difficulty.trust_levels) に合わせる。ターン数の上限 (difficulty.turns) はエンジンが設定する。
- 懸念は表向きの要望の裏にある本音で、互いに少しトレードオフになると面白い。どの本音を最初から話せるものにするかは、物語として自然なものを選ぶ (表向きの要望に近いものほど話しやすい)。
- resolved_when は「どんな案なら解消するか」を具体的に。AI自身が後から甘くしないための固定条件になる。
- briefing (前提情報) には、プレイヤーの立場なら当然知っている事実を 3〜8 項目、具体的に書く (何の話か・相手は誰か・期限や予算などの数字・これまでの経緯)。プレイヤーが「そもそも何の話か」を聞き直さずに議論に入れるようにする。隠された本音は書かない。
- プレイヤーに見える文 (premise・goal・briefing・opening) に URL を書かず、API キーやパスワードの入力・共有を求める文面も書かない。
- opening では表向きの要望だけを話す。本音は出さない。仕草や内心の描写は入れず、台詞だけにする。
- 各キャラクターに speech (口調の決まり) と sample_lines (手本のセリフ) を必ず付ける。日本語として自然な話し言葉にし、キャラごとに口調を変える。persona や sample_lines に「黙り込む」「言い淀む」など隠し事を匂わせる振る舞いは書かない。`,
    shape: scenarioShape,
    run(engine, input) {
      const r = engine.startScenario(input);
      return r.ok ? { ok: true, text: `開始しました: ${r.title}` } : failure("シナリオを採用できませんでした。直して再度 start_scenario を呼んでください", r.errors);
    },
  },
  {
    name: "reply",
    description:
      "プレイヤーの発言への返答。1 回で 1 ターンが完結し、手番がプレイヤーに戻る。発言・信頼度 (キャラごと)・懸念の進行・気分をまとめて渡す。ルール違反があると何も反映されずエラーが返るので、直して再度呼ぶ",
    shape: replyShape,
    run(engine, input) {
      const parsed = replySchema.safeParse(input);
      if (!parsed.success) return failure("返答の形が正しくありません (何も変更されていません)。直して再度 reply を呼んでください", issues(parsed.error));
      const r = engine.reply(parsed.data);
      return r.ok
        ? { ok: true, text: r.summary, ended: engine.phase === "ended" }
        : failure("返答を反映できませんでした (何も変更されていません)。直して再度 reply を呼んでください", r.errors);
    },
  },
  {
    name: "submit_review",
    description: "対話が終わった後 (type=review の仕事が来たとき) に、プレイヤーへの振り返りを提出する。解消できなかった懸念すべてに助言が必要。終了画面に表示される",
    shape: reviewShape,
    run(engine, input) {
      const r = engine.submitReview(input);
      return r.ok ? { ok: true, text: "振り返りを受け付けました" } : failure("振り返りを受け付けられませんでした。直して再度 submit_review を呼んでください", r.errors);
    },
  },
];

/** 各社の API に渡す JSON Schema (zod の定義から生成) */
export function toolJsonSchema(tool: GameTool): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(tool.shape)) as Record<string, unknown>;
  return schema;
}
