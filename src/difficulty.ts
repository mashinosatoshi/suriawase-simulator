// 難易度のパラメータ (shared.ts の DIFFICULTY_PRESETS / PARAM_SPECS) から、エンジンと AI に渡すものを作る。
// エンジンが確かめるもの: 懸念の数・最初から話せる本音の数・初期の信頼度・ターン数の上限・歩み寄りの条件。
// AI への指示で決まるもの: 冒頭の雰囲気 (初期の信頼度に合わせる)・物わかりの良さ。
import {
  DIFFICULTIES,
  DIFFICULTY_INFO,
  DIFFICULTY_PRESETS,
  PARAM_SPECS,
  sameParams,
  turnLimitOf,
  UNDERSTANDING_LABELS,
  type Difficulty,
  type DifficultyParams,
  type Understanding,
} from "./shared.js";

/** AI への指示: 冒頭の雰囲気 (初期の信頼度 0〜3 ごと) */
const MOOD_TEXT = [
  "相手は最初から不信感や苛立ちを持っている (これまでの経緯や、プレイヤーの立場への不満など)。opening では表向きの要望を強い口調で主張し、不満も言葉にする。ただし罵倒や暴言にはせず、その人の立場と口調 (speech) のまま、冷たさ・苛立ち・不信感をにじませる。opening_moods も警戒・不満などにする。仕草や内心の描写ではなく、台詞と気分で表す。",
  "相手は警戒している。opening では表向きの要望を固く主張し、プレイヤーの出方をうかがう。opening_moods も警戒・慎重などにする。仕草や内心の描写ではなく、台詞と気分で表す。",
  "相手は様子見。表向きの要望ははっきり主張するが、敵対はしていない。",
  "相手は最初から好意的で、話を聞く姿勢がある。opening も穏やかに、opening_moods も前向きな気分にする。",
];

/** AI への指示: 物わかりの良さ (毎ターン渡す)。歩み寄りの条件はエンジンが別に確かめる */
export const UNDERSTANDING_TEXT: Record<Understanding, string> = {
  good: "物わかりがよい。プレイヤーの言いたいことを好意的に汲み取る。提案の意図が読み取れれば、言い方が多少あいまいでも提案として受け取り、細部は自分の側で補ってよい。resolved_when の要点を満たしていれば解消してよい。",
  normal: "ふつうの物わかり。具体的な対処案や条件が示されたときだけ提案として受け取り、resolved_when を満たしたときだけ解消する。",
  poor: "物わかりが悪い。プレイヤーの言葉を字面どおりにしか受け取らず、行間や遠回しな言い方は汲み取らない。あいまいな案は提案として受け取らず、具体的に何をするのかを聞き返す。resolved_when のすべての点が具体的に示されるまで解消しない。",
};

/** 画面と AI に出す難易度の名前 (微調整したら、そう分かるように) */
export const difficultyLabel = (level: Difficulty, params: DifficultyParams) =>
  `${DIFFICULTY_INFO[level].label}${sameParams(params, DIFFICULTY_PRESETS[level]) ? "" : " (調整あり)"}`;

/** 新しいゲームの依頼に添えて AI に渡す */
export function difficultyBrief(level: Difficulty, p: DifficultyParams) {
  return {
    level,
    label: difficultyLabel(level, p),
    concerns: p.concerns,
    open_at_start: p.openAtStart,
    trust_start: p.trustStart,
    turns: turnLimitOf(p),
    mood: MOOD_TEXT[p.trustStart],
  };
}
export type DifficultyBrief = ReturnType<typeof difficultyBrief>;

/** ブラウザから届いた難易度とパラメータを確かめる。パラメータが無ければ、その難易度の初期値 */
export function parseDifficulty(level: unknown, params: unknown): { level: Difficulty; params: DifficultyParams } | { error: string } {
  const d = (level ?? "normal") as Difficulty;
  if (!DIFFICULTIES.includes(d)) return { error: "不明な難易度です" };
  if (params === undefined || params === null) return { level: d, params: { ...DIFFICULTY_PRESETS[d] } };
  if (typeof params !== "object") return { error: "パラメータの形式が正しくありません" };
  const input = params as Record<string, unknown>;
  const out = { ...DIFFICULTY_PRESETS[d] };
  for (const [key, spec] of Object.entries(PARAM_SPECS) as Array<[keyof typeof PARAM_SPECS, (typeof PARAM_SPECS)[keyof typeof PARAM_SPECS]]>) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < spec.min || v > spec.max) return { error: `「${spec.label}」は ${spec.min}〜${spec.max} の整数にしてください` };
    out[key] = v;
  }
  if (input.understanding !== undefined) {
    if (!Object.keys(UNDERSTANDING_LABELS).includes(input.understanding as string)) return { error: "「物わかり」の値が正しくありません" };
    out.understanding = input.understanding as Understanding;
  }
  if (out.openAtStart > out.concerns) return { error: "「最初から話せる本音の数」は「懸念の数」以下にしてください" };
  return { level: d, params: out };
}
