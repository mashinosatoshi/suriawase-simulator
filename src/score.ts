// 終了後のスコア。どれだけ重要な本音を、手ごわい相手から引き出し、解決に導いたかで決まる。
// 採点はエンジンが行う (AI の判断や言い回しで点が変わらないように)。AI は結果を見て、振り返りでスコアに触れるだけ。
import type { Scenario } from "./scenario.js";
import { MAX_LEVEL, type ConcernStatus, type GameScore, type ScoreRank } from "./shared.js";

/** 引き出し点 = 重要度 × 引き出しの難しさ × これ */
const DISCOVER_POINTS = 2;
/** 解決点 = 重要度 × 解決の難しさ × これ (引き出すより、解決に導くほうを重く見る) */
const RESOLVE_POINTS = 5;
/** 完全合意のボーナス: 引き出し点と解決点の合計の、この割合 (%) */
const FULL_AGREEMENT_BONUS = 20;
/** ランク: 満点に対する割合 (%) がこれ以上 */
const RANKS: Array<[ScoreRank, number]> = [
  ["S", 90],
  ["A", 75],
  ["B", 55],
  ["C", 35],
  ["D", 0],
];

/**
 * 引き出しの難しさ (%): 打ち解けるまで話してくれない本音ほど高い。
 * 持ち主の最初の信頼度から、本音を話し始める信頼度までの差 1 つにつき +25% (最初から話せる本音は 100%)
 */
export const discoverRate = (minTrust: number, trustStart: number) => 100 + Math.max(0, minTrust - trustStart) * 25;

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
    const dRate = discoverRate(c.min_trust, owner.trust_start);
    const rRate = resolveRate(owner.understanding, owner.trust_start);
    const discoverMax = points(c.importance, DISCOVER_POINTS, dRate);
    const resolveMax = points(c.importance, RESOLVE_POINTS, rRate);
    const discovered = statuses[i] !== "hidden";
    const resolved = statuses[i] === "resolved";
    return {
      id: c.id,
      importance: c.importance,
      discovered,
      resolved,
      discoverRate: dRate,
      resolveRate: rRate,
      discoverPoints: discovered ? discoverMax : 0,
      resolvePoints: resolved ? resolveMax : 0,
      maxPoints: discoverMax + resolveMax,
    };
  });
  const subtotal = items.reduce((n, x) => n + x.discoverPoints + x.resolvePoints, 0);
  const subtotalMax = items.reduce((n, x) => n + x.maxPoints, 0);
  const bonusOf = (n: number) => Math.round((n * FULL_AGREEMENT_BONUS) / 100);
  const bonus = items.every((x) => x.resolved) ? bonusOf(subtotal) : 0;
  const total = subtotal + bonus;
  const max = subtotalMax + bonusOf(subtotalMax);
  const percent = max ? Math.floor((total * 100) / max) : 0;
  const rank = RANKS.find(([, min]) => percent >= min)![0];
  return { total, max, percent, rank, bonus, items };
}
