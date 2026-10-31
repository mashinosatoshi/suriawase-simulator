// 難易度のパラメータ (shared.ts の DIFFICULTY_PRESETS / PARAM_SPECS) から、エンジンと AI に渡すものを作る。
// エンジンが確かめるもの: 懸念の数・最初から話せる本音の数・登場人物ごとの信頼度 (平均が難易度の値に近いか)・ターン数の上限・歩み寄りの条件。
// AI への指示で決まるもの: 冒頭の雰囲気 (各キャラの最初の信頼度に合わせる)・物わかりの良さ (各キャラの値に合わせる)。
import {
  DIFFICULTIES,
  DIFFICULTY_INFO,
  DIFFICULTY_PRESETS,
  IMPORTANCE_LEVEL_NAMES,
  levelBand,
  MIN_LEVEL,
  OPENNESS_LEVEL_NAMES,
  PARAM_SPECS,
  sameParams,
  TRUST_LEVEL_NAMES,
  turnLimitOf,
  UNDERSTANDING_LEVEL_NAMES,
  type Difficulty,
  type DifficultyParams,
} from "./shared.js";

/**
 * ランダム: 各パラメータを、範囲 (PARAM_SPECS) の中から一様に選ぶ。
 * 懸念の数に縛られるもの (最初から話せる本音・譲れない本音の数) は、選んだ懸念の数を超えない
 */
export function randomParams(rand: () => number = Math.random): DifficultyParams {
  const pick = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const any = (key: keyof DifficultyParams) => pick(PARAM_SPECS[key].min, PARAM_SPECS[key].max);
  const upToConcerns = (key: keyof DifficultyParams) => pick(PARAM_SPECS[key].min, Math.min(PARAM_SPECS[key].max, concerns));
  const concerns = any("concerns");
  return {
    concerns,
    openAtStart: upToConcerns("openAtStart"),
    nonNegotiable: upToConcerns("nonNegotiable"),
    trustStart: any("trustStart"),
    openness: any("openness"),
    turnsPerConcern: any("turnsPerConcern"),
    understanding: any("understanding"),
    initiativeTurns: any("initiativeTurns"),
    initiativeTrust: any("initiativeTrust"),
    initiativeCooldown: any("initiativeCooldown"),
  };
}

/** その難易度で、パラメータを指定せずに始めたときの値 (ランダムなら、ここで決める) */
export const defaultParams = (level: Difficulty): DifficultyParams => (level === "random" ? randomParams() : { ...DIFFICULTY_PRESETS[level] });

/** プリセットから微調整したか (ランダムは調整できない) */
export const isCustomized = (level: Difficulty, params: DifficultyParams) => level !== "random" && !sameParams(params, DIFFICULTY_PRESETS[level]);

/** 登場人物の値の平均は、難易度の値からこれだけずれてよい */
export const AVERAGE_TOLERANCE = 1;

/** AI への指示: 信頼度の段階ごとの態度 (冒頭の口調と気分もこれに合わせる) */
const TRUST_TEXT = [
  "不信感や苛立ちを持っている (これまでの経緯や、プレイヤーの立場への不満など)。表向きの要望を強い口調で主張し、不満も言葉にする。ただし罵倒や暴言にはせず、その人の口調 (speech) のまま、冷たさ・苛立ち・不信感をにじませる。",
  "警戒している。表向きの要望を固く主張し、プレイヤーの出方をうかがう。",
  "様子見。表向きの要望ははっきり主張するが、敵対はしていない。",
  "好意的で、話を聞く姿勢がある。穏やかに話す。",
  "プレイヤーを信頼していて、打ち解けて話す。",
];

/** AI への指示: 打ち解けやすさの段階ごとの、態度の和らぎ方。上がり幅そのものはエンジンが縮める (trustGainRate) */
const OPENNESS_TEXT = [
  "良い発言が続いても、なかなか態度を和らげない。打ち解けるには、誠実なやり取りを何度も重ねる必要がある。",
  "良い発言 1 回では態度を変えない。少しずつしか和らがない。",
  "良いやり取りが続けば、だんだん打ち解ける。",
  "誠実な発言には素直に応える。",
  "人を信じやすく、すぐ心を開く。",
];

/**
 * 打ち解けやすさ (1〜10) に応じた、信頼度の上がり幅 (%)。AI が付けた評価 (+1 / +2) に掛ける。
 * 10 × 打ち解けやすさ + 10 (1 = 20% 〜 9 以上 = 100%)。下がるときは縮めない
 */
export const trustGainRate = (openness: number) => Math.min(100, openness * 10 + 10);

/** AI への指示: 物わかりの段階ごとの受け取り方。歩み寄りの条件はエンジンが別に確かめる */
const UNDERSTANDING_TEXT = [
  "プレイヤーの言葉を字面どおりにしか受け取らず、行間や遠回しな言い方は汲み取らない。あいまいな案は提案として受け取らず、具体的に何をするのかを聞き返す。resolved_when のすべての点が具体的に示されるまで解消しない。",
  "汲み取りは少なめ。具体的な案だけを提案として受け取り、細部があいまいなら確かめる。resolved_when の点がすべてそろうまで解消しない。",
  "具体的な対処案や条件が示されたときだけ提案として受け取り、resolved_when を満たしたときだけ解消する。",
  "提案の意図が読み取れれば、言い方が多少あいまいでも提案として受け取る。足りない細部は聞き返して補う。",
  "プレイヤーの言いたいことを好意的に汲み取る。言い方があいまいでも提案として受け取り、細部は自分の側で補ってよい。resolved_when の要点を満たしていれば解消してよい。",
];

/** AI への指示: 本音の重要度の段階ごとの、こだわりの強さ。解消の判定の厳しさは、これと持ち主の物わかりの両方で決まる */
const IMPORTANCE_TEXT = [
  "こだわりは小さい。ほかの大事なことが前に進むなら、部分的な案や代わりの条件で納得してよい。",
  "できれば叶えたい。resolved_when の要点が満たされれば、細部は妥協してよい。",
  "大事なこと。resolved_when を満たす案でなければ納得しない。",
  "必ず達成したい。resolved_when を満たすまで納得せず、ほかの懸念と引き換えにもしない。",
  "これだけは譲れない。resolved_when のすべての点が満たされるまで決して納得しない。これが解消しないうちは、全体の合意にも応じない (エンジンも、残ったまま終わると持ち帰りにする)。",
];

const levels = (names: readonly string[], texts: string[]) =>
  names.map((name, i) => ({ range: `${MIN_LEVEL + i * 2}〜${MIN_LEVEL + i * 2 + 1}`, name, text: texts[i] }));

/** 各キャラの物わかり (1〜10) を、AI への指示の文にする (毎ターン渡す) */
export const understandingNote = (v: number) => `${UNDERSTANDING_LEVEL_NAMES[levelBand(v)]}: ${UNDERSTANDING_TEXT[levelBand(v)]}`;
/** 信頼度 (1〜10) の呼び名 */
export const trustName = (v: number) => TRUST_LEVEL_NAMES[levelBand(v)];
/** 各キャラの打ち解けやすさ (1〜10) を、AI への指示の文にする (毎ターン渡す) */
export const opennessNote = (v: number) => `${OPENNESS_LEVEL_NAMES[levelBand(v)]}: ${OPENNESS_TEXT[levelBand(v)]} (良い発言で上がる信頼度は、評価の ${trustGainRate(v)}%)`;
/** 本音の重要度 (1〜10) の呼び名 */
export const importanceName = (v: number) => IMPORTANCE_LEVEL_NAMES[levelBand(v)];

/** 画面と AI に出す難易度の名前 (微調整したら、そう分かるように) */
export const difficultyLabel = (level: Difficulty, params: DifficultyParams) => `${DIFFICULTY_INFO[level].label}${isCustomized(level, params) ? " (調整あり)" : ""}`;

/** 新しいゲームの依頼に添えて AI に渡す */
export function difficultyBrief(level: Difficulty, p: DifficultyParams) {
  return {
    level,
    label: difficultyLabel(level, p),
    concerns: p.concerns,
    open_at_start: p.openAtStart,
    /** これだけは譲れない本音 (importance 9〜10) の数 */
    non_negotiable: p.nonNegotiable,
    /** 登場人物の最初の信頼度の平均 (1〜10) */
    trust_start: p.trustStart,
    /** 登場人物の打ち解けやすさの平均 (1〜10) */
    openness: p.openness,
    /** 登場人物の物わかりの平均 (1〜10) */
    understanding: p.understanding,
    turns: turnLimitOf(p),
    note: `trust_start・openness・understanding は登場人物全員の平均。各キャラの characters[].trust_start / openness / understanding を persona (人柄) に合わせて決め、平均をこの値 ±${AVERAGE_TOLERANCE} に収める (2 人以上なら、人ごとに差をつける)。opening の口調と opening_moods は、各キャラの trust_start の段階 (trust_levels) に合わせる。仕草や内心の描写ではなく、台詞と気分で表す。`,
    trust_levels: levels(TRUST_LEVEL_NAMES, TRUST_TEXT),
    openness_levels: levels(OPENNESS_LEVEL_NAMES, OPENNESS_TEXT),
    understanding_levels: levels(UNDERSTANDING_LEVEL_NAMES, UNDERSTANDING_TEXT),
    importance_levels: levels(IMPORTANCE_LEVEL_NAMES, IMPORTANCE_TEXT),
  };
}
export type DifficultyBrief = ReturnType<typeof difficultyBrief>;

/** ブラウザから届いた難易度とパラメータを確かめる。パラメータが無ければ、その難易度の初期値。ランダムなら、ここで決める (送られたパラメータは使わない) */
export function parseDifficulty(level: unknown, params: unknown): { level: Difficulty; params: DifficultyParams } | { error: string } {
  const d = (level ?? "normal") as Difficulty;
  if (!DIFFICULTIES.includes(d)) return { error: "不明な難易度です" };
  if (d === "random" || params === undefined || params === null) return { level: d, params: defaultParams(d) };
  if (typeof params !== "object") return { error: "パラメータの形式が正しくありません" };
  const input = params as Record<string, unknown>;
  const out = { ...DIFFICULTY_PRESETS[d] };
  for (const [key, spec] of Object.entries(PARAM_SPECS) as Array<[keyof DifficultyParams, (typeof PARAM_SPECS)[keyof DifficultyParams]]>) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < spec.min || v > spec.max) return { error: `「${spec.label}」は ${spec.min}〜${spec.max} の整数にしてください` };
    out[key] = v;
  }
  if (out.openAtStart > out.concerns) return { error: "「最初から話せる本音の数」は「懸念の数」以下にしてください" };
  if (out.nonNegotiable > out.concerns) return { error: "「譲れない本音の数」は「懸念の数」以下にしてください" };
  return { level: d, params: out };
}
