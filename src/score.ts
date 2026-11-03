// 終了後のスコア。このゲームの目的は、相手の隠れた本音をあぶり出すこと。重要で引き出しにくい本音を引き出すほど高く、
// 解決に導くと、さらに解決点が入る (合意までの道筋も評価するが、引き出すほうを重く見る)。
// 採点はエンジンが行う (AI の判断や言い回しで点が変わらないように)。AI は結果を見て、振り返りでスコアに触れるだけ。
import { revealDifficulty } from "./difficulty.js";
import type { Scenario } from "./scenario.js";
import { MAX_LEVEL, type ConcernStatus, type GameScore, type ScoreRank } from "./shared.js";

/** 引き出し点 = 重要度 × 引き出しにくさの倍率 × これ */
const DISCOVER_POINTS = 5;
/** 解決点 = 重要度 × 解決の難しさ × これ (引き出し点より軽く見る。満点のおよそ 3 割) */
const RESOLVE_POINTS = 2;
/** ランク: 満点に対する割合 (%) がこれ以上 */
const RANKS: Array<[ScoreRank, number]> = [
  ["S", 90],
  ["A", 75],
  ["B", 55],
  ["C", 35],
  ["D", 0],
];

/** 引き出しの倍率 (%): 引き出しにくさ (1〜10) が 1 上がるごとに +25% (最初から話せる本音は 100%、最も引き出しにくい本音で 325%) */
export const discoverRate = (difficulty: number) => 100 + (difficulty - 1) * 25;

/**
 * 解決の難しさ (%): 物わかりが悪く、最初から信頼されていない相手ほど高い。
 * 物わかりが 10 から 1 下がるごとに +10%、最初の信頼度が 10 から 1 下がるごとに +5%
 */
export const resolveRate = (understanding: number, trustStart: number) => 100 + (MAX_LEVEL - understanding) * 10 + (MAX_LEVEL - trustStart) * 5;

const points = (importance: number, per: number, rate: number) => Math.round((importance * per * rate) / 100);

/** statuses: 各懸念の最終的な状態 (シナリオの並び順) */
export function scoreGame(s: Scenario, statuses: ConcernStatus[]): GameScore {
  const items = s.concerns.map((c, i) => {
    const owner = s.characters.find((ch) => ch.id === c.owner)!;
    const difficulty = revealDifficulty(c.min_trust, owner.trust_start, owner.openness);
    const dRate = discoverRate(difficulty);
    const rRate = resolveRate(owner.understanding, owner.trust_start);
    const discoverMax = points(c.importance, DISCOVER_POINTS, dRate);
    const resolveMax = points(c.importance, RESOLVE_POINTS, rRate);
    const discovered = statuses[i] !== "hidden";
    const resolved = statuses[i] === "resolved";
    return {
      id: c.id,
      importance: c.importance,
      revealDifficulty: difficulty,
      discovered,
      resolved,
      discoverRate: dRate,
      resolveRate: rRate,
      discoverPoints: discovered ? discoverMax : 0,
      resolvePoints: resolved ? resolveMax : 0,
      maxPoints: discoverMax + resolveMax,
    };
  });
  const total = items.reduce((n, x) => n + x.discoverPoints + x.resolvePoints, 0);
  const max = items.reduce((n, x) => n + x.maxPoints, 0);
  const percent = max ? Math.floor((total * 100) / max) : 0;
  const rank = RANKS.find(([, min]) => percent >= min)![0];
  return { total, max, percent, rank, items };
}
