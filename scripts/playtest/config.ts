// 自動試遊の設定 (コマンドラインの引数)。
//   --games 3                       回すゲームの数
//   --gm / --player / --judge       各役の AI。「提供元:モデル:effort」(例: anthropic:claude-haiku-5-5:medium)。
//                                   --judge none は審査をしない (あとで Claude Code のサブエージェントが審査する。/playtest を参照)
//   --difficulty normal             easy / normal / hard / random
//   --max-turns mixed               プレイヤーの発言の打ち切り。mixed = ゲームごとに「ターンの上限まで使う」と「途中で締める」を交互に /
//                                   full = いつも上限まで / 数 = その数の発言で「締める」
//   --seed 1                        お題・難易度・プレイヤーの性格の選び方 (同じ seed なら同じ条件で回せる)
//   --out playtest-results/...      結果を書き出すフォルダ
//   --dry-run                       作り物の AI で仕組みだけ確かめる (API を呼ばない・費用ゼロ)
import { parseArgs } from "node:util";
import { isValidModelId, PROVIDER_IDS, type Effort, type ProviderId } from "../../src/llm/index.js";
import { DIFFICULTIES, type Difficulty } from "../../src/shared.js";

export interface RoleSpec {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

export type TurnSetting = "mixed" | "full" | number;

export interface Options {
  games: number;
  gm: RoleSpec;
  player: RoleSpec;
  /** null = 審査をしない (あとで Claude Code のサブエージェントが審査する) */
  judge: RoleSpec | null;
  difficulty: Difficulty;
  turns: TurnSetting;
  seed: number;
  out: string;
  dryRun: boolean;
}

/**
 * 既定: GM とプレイヤー役は軽いモデル (使用量を抑える)。審査役だけ 1 段上のモデルにする
 * (軽いモデルの審査は見落としが多い。審査は 1 ゲーム 1 回なので、上げても全体の使用量はあまり増えない)
 */
export const DEFAULT_ROLE = "anthropic:claude-haiku-5-5:medium";
export const DEFAULT_JUDGE = "anthropic:claude-sonnet-5-5:medium";
const EFFORTS: Effort[] = ["low", "medium", "high"];

export function parseRole(text: string, name: string): RoleSpec {
  const [provider, model, effort = "medium"] = text.split(":");
  if (!PROVIDER_IDS.includes(provider as ProviderId)) throw new Error(`--${name}: 提供元は ${PROVIDER_IDS.join(" / ")} のどれか (受け取った値: ${provider})`);
  if (!model || !isValidModelId(model)) throw new Error(`--${name}: モデル ID の形式が正しくありません`);
  if (!EFFORTS.includes(effort as Effort)) throw new Error(`--${name}: effort は ${EFFORTS.join(" / ")} のどれか`);
  return { provider: provider as ProviderId, model, effort: effort as Effort };
}

const positive = (text: string, name: string, max: number) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} は 1〜${max} の整数`);
  return n;
};

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

export function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      games: { type: "string", default: "3" },
      gm: { type: "string", default: DEFAULT_ROLE },
      player: { type: "string", default: DEFAULT_ROLE },
      judge: { type: "string", default: DEFAULT_JUDGE },
      difficulty: { type: "string", default: "normal" },
      "max-turns": { type: "string", default: "mixed" },
      seed: { type: "string", default: "1" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const difficulty = values.difficulty as Difficulty;
  if (!DIFFICULTIES.includes(difficulty)) throw new Error(`--difficulty は ${DIFFICULTIES.join(" / ")} のどれか`);
  const seed = Number(values.seed);
  if (!Number.isInteger(seed)) throw new Error("--seed は整数");
  return {
    games: positive(values.games, "games", 50),
    gm: parseRole(values.gm, "gm"),
    player: parseRole(values.player, "player"),
    judge: values.judge === "none" ? null : parseRole(values.judge, "judge"),
    difficulty,
    turns: parseTurns(values["max-turns"]),
    seed,
    out: values.out ?? `playtest-results/${stamp()}`,
    dryRun: values["dry-run"],
  };
}

export const parseTurns = (text: string): TurnSetting => (text === "mixed" || text === "full" ? text : positive(text, "max-turns", 40));

/**
 * このゲームでのプレイヤーの発言の打ち切り。"full" = ターンの上限まで使う (プレイヤー役は自分から締めない)。
 * mixed では、偶数番目のゲームは上限まで、奇数番目は 4〜10 回目のどこかで締める (同じ番号なら毎回同じ。API 版と MCP 版で共通)
 */
export function turnPlan(index: number, setting: TurnSetting): number | "full" {
  if (setting !== "mixed") return setting;
  return index % 2 === 0 ? "full" : 4 + Math.floor(seededRandom(index * 7919)() * 7);
}

export const turnPlanText = (plan: number | "full") => (plan === "full" ? "ターンの上限まで使う" : `${plan} 回目の発言で締める`);

/** 再現できる乱数 (mulberry32)。同じ seed なら同じお題・性格・パラメータになる */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
