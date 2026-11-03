// 自動試遊の結果を書き出す。ゲームごとの記録 (game-NN.json / game-NN.md) と、全体のまとめ (report.md)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ending, PublicReview, PublicRoot } from "../../src/shared.js";
import type { Scenario } from "../../src/scenario.js";
import type { Theme } from "../../src/themes.js";
import { rpmOf, tpmOf, type Options, type RoleSpec } from "./config.js";
import { CATEGORIES, REACH_VERDICTS, SEVERITIES, type JudgeReport, type TranscriptLine } from "./judge.js";
import type { Usage } from "./providers.js";

export interface Rejection {
  turn: number;
  message: string;
}

export interface GameRecord {
  index: number;
  title: string;
  /** 話題が空欄のときにゲームが選んだお題 (MCP 版ではサーバーの中で選ばれるので記録しない) */
  theme: Theme | null;
  style: string;
  /** ターンの使い方 (上限まで使う / 何回目で締める) */
  turns: string;
  difficulty: string;
  scenario: Scenario | null;
  transcript: TranscriptLine[];
  ending: Ending | null;
  review: PublicReview | null;
  /** 本質的な課題 (終了後の公開状態。中身と、届いたか) */
  root: PublicRoot | null;
  /** エンジンが差し戻した AI の返答 (GM のログから) */
  rejections: Rejection[];
  /** 途中で止まった理由 (止まらなければ null) */
  error: string | null;
  judge: JudgeReport | null;
  judgeError: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const avgOf = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : "-");
const squash = (s: string) => s.replace(/\s+/g, "");
const roleText = (r: RoleSpec) => `${r.provider} / ${r.model} / effort ${r.effort}`;
const cell = (s: string) => s.replace(/\|/g, "／").replace(/\n/g, " ");

/** 指摘の quote が、そのターンの台詞に実在するか (審査役の書き間違いを見分ける) */
export function quoteFound(g: GameRecord, issue: JudgeReport["issues"][number]) {
  const q = squash(issue.quote);
  return g.transcript.some((l) => l.from !== "player" && l.turn === issue.turn && squash(l.text).includes(q));
}

/** 本質的な課題の中身と、届いたか */
const rootText = (g: GameRecord) => (g.root?.text ? `${g.root.status === "reached" ? "届いた" : "届かなかった"} — ${g.root.text}` : "(記録なし)");

function gameMarkdown(g: GameRecord) {
  const issues = g.judge?.issues ?? [];
  const lines = g.transcript.map((l) => {
    const marks = issues.filter((i) => i.turn === l.turn && l.from !== "player" && squash(l.text).includes(squash(i.quote)));
    const who = l.from === "player" ? "**プレイヤー**" : l.from === "narrator" ? "(地の文)" : `**${l.speaker}**`;
    return `- [${l.turn}] ${who}: ${l.text}${marks.map((m) => `\n  - ⚠️ ${m.category} (${m.severity}): ${m.reason}`).join("")}`;
  });
  return [
    `# ゲーム ${pad(g.index)}: ${g.title}`,
    "",
    ...(g.theme ? [`- お題: ${g.theme.field} / ${g.theme.setting} / ${g.theme.topic} / ${g.theme.cast}`] : []),
    `- プレイヤー役の性格: ${g.style}`,
    `- ターン: ${g.turns}`,
    `- 難易度: ${g.difficulty}`,
    `- 結末: ${g.ending ? `${g.ending.type} (${g.ending.reason}) 解消 ${g.ending.resolved}/${g.ending.total}・スコア ${g.ending.score.total}/${g.ending.score.max} (${g.ending.score.rank})` : "(終わらなかった)"}`,
    ...(g.error ? [`- **止まった理由**: ${g.error}`] : []),
    `- 本質的な課題: ${rootText(g)}`,
    g.judge ? `- 審査: 自然さ ${g.judge.naturalness}/5。${g.judge.summary}` : `- 審査: ${g.judgeError ?? "(なし)"}`,
    ...(g.judge?.root_issue ? [`- 本質の審査: 深さ ${g.judge.root_issue.depth}/5・芋づる式 ${g.judge.root_issue.cascade}/5・${g.judge.root_issue.reach}。${g.judge.root_issue.comment}`] : []),
    "",
    "## 会話",
    "",
    ...lines,
    "",
    "## エンジンの差し戻し",
    "",
    ...(g.rejections.length ? g.rejections.map((r) => `- [${r.turn}] ${r.message}`) : ["- なし"]),
    "",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

/** レポートの冒頭に書く、実行の条件 (API 版) */
export function apiHeader(o: Options, seconds: number) {
  return [
    `- 実行: ${new Date().toISOString()}・${Math.round(seconds)} 秒${o.dryRun ? "・**dry-run (作り物の AI)**" : ""}`,
    `- GM: ${roleText(o.gm)}`,
    `- プレイヤー役: ${roleText(o.player)}`,
    `- 審査役: ${o.judge ? roleText(o.judge) : "Claude Code のサブエージェント (試遊の後で審査する)"}`,
    `- 難易度: ${o.difficulty}・ターン: ${o.turns === "mixed" ? "ゲームごとに「上限まで使う」と「途中で締める」を交互に" : o.turns === "full" ? "いつも上限まで使う" : `${o.turns} 発言で締める`}・seed ${o.seed}`,
    ...(o.dryRun
      ? []
      : [
          `- 1 分あたりの上限: ${[...new Set([o.gm.provider, o.player.provider, ...(o.judge ? [o.judge.provider] : [])])]
            .map((p) => `${p} ${rpmOf(o, p) ? `${rpmOf(o, p)} 回` : "回数なし"}・${tpmOf(o, p) ? `${tpmOf(o, p).toLocaleString()} トークン` : "トークン数なし"}`)
            .join(" / ")}`,
        ]),
  ];
}

/** usage = null は使用量を数えていない (MCP 版。Claude Code の利用枠で動く) */
export function writeResults(dir: string, header: string[], games: GameRecord[], usage: Record<"gm" | "player" | "judge", Usage> | null) {
  mkdirSync(dir, { recursive: true });
  for (const g of games) {
    writeFileSync(join(dir, `game-${pad(g.index)}.json`), JSON.stringify(g, null, 2));
    writeFileSync(join(dir, `game-${pad(g.index)}.md`), gameMarkdown(g));
  }

  const judged = games.filter((g) => g.judge);
  // 本質的な課題の評価が入った審査 (この評価を足す前の記録には無い)
  const rootJudged = judged.filter((g) => g.judge!.root_issue);
  const issues = judged.flatMap((g) => g.judge!.issues.map((i) => ({ g, i, found: quoteFound(g, i) })));
  const avg = judged.length ? (judged.reduce((n, g) => n + g.judge!.naturalness, 0) / judged.length).toFixed(1) : "-";
  const turns = games.map((g) => g.transcript.filter((l) => l.from === "player").length);

  const byCategory = CATEGORIES.map((c) => {
    const hit = issues.filter((x) => x.i.category === c);
    return { c, hit, counts: SEVERITIES.map((s) => hit.filter((x) => x.i.severity === s).length) };
  })
    .filter((x) => x.hit.length)
    .sort((a, b) => b.hit.length - a.hit.length);

  const usageRow = (name: string, u: Usage) => `| ${name} | ${u.calls} | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${u.output} |`;
  const rejections = games.flatMap((g) => g.rejections.map((r) => ({ g, r })));

  const md = [
    "# 自動試遊のレポート",
    "",
    ...header,
    "",
    "## 結果",
    "",
    `- ゲーム: ${games.length} (最後まで進んだもの ${games.filter((g) => g.ending).length}・途中で止まったもの ${games.filter((g) => g.error).length})`,
    `- プレイヤーの発言数: 平均 ${turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : "-"}`,
    `- 審査の自然さ (5 段階): 平均 ${avg} (審査できたゲーム ${judged.length})`,
    `- 不自然さの指摘: ${issues.length} 件 (台詞に引用が見つからない指摘 ${issues.filter((x) => !x.found).length} 件)`,
    `- エンジンの差し戻し: ${rejections.length} 回`,
    `- 本質的な課題: 届いたゲーム ${games.filter((g) => g.root?.status === "reached").length} / ${games.filter((g) => g.ending).length}・審査の深さ (5 段階) 平均 ${avgOf(rootJudged.map((g) => g.judge!.root_issue.depth))}・芋づる式 (5 段階) 平均 ${avgOf(rootJudged.map((g) => g.judge!.root_issue.cascade))}`,
    "",
    "## 本質的な課題",
    "",
    "表の本音の奥にある、本人も言葉にできていない根っこの原因。審査役が、作り込み (深さ)・解消すると形式的な課題の多くが解消に向かうか (芋づる式)・到達の判定の妥当さを見た。",
    "",
    `| 判定 | ${REACH_VERDICTS.join(" | ")} |`,
    `|---|${REACH_VERDICTS.map(() => "---").join("|")}|`,
    `| ゲーム数 | ${REACH_VERDICTS.map((v) => rootJudged.filter((g) => g.judge!.root_issue.reach === v).length).join(" | ")} |`,
    "",
    "| ゲーム | 本質的な課題 | 深さ | 芋づる式 | 到達の判定 | 所見 |",
    "|---|---|---|---|---|---|",
    ...games.map((g) => `| [${pad(g.index)}](game-${pad(g.index)}.md) | ${cell(rootText(g))} | ${g.judge?.root_issue?.depth ?? "-"} | ${g.judge?.root_issue?.cascade ?? "-"} | ${g.judge?.root_issue?.reach ?? "-"} | ${cell(g.judge?.root_issue?.comment ?? "")} |`),
    "",
    "## 使用量",
    "",
    ...(usage
      ? [
          "費用は各社の料金表で計算する。入力は、Claude ではキャッシュ読みを含まず、Gemini と GPT では含む。出力には考える過程の分も含む。",
          "",
          "| 役 | 呼び出し | 入力 | キャッシュ読み | キャッシュ書き | 出力 |",
          "|---|---|---|---|---|---|",
          usageRow("GM", usage.gm),
          usageRow("プレイヤー役", usage.player),
          usageRow("審査役", usage.judge),
        ]
      : ["Claude Code の利用枠で動かしたので、ここでは数えていない (Claude Code の利用状況で確かめる)。"]),
    "",
    "## 不自然さの種類",
    "",
    "| 種類 | 件数 | 軽微 | 目立つ | 重大 |",
    "|---|---|---|---|---|",
    ...(byCategory.length ? byCategory.map((x) => `| ${x.c} | ${x.hit.length} | ${x.counts.join(" | ")} |`) : ["| (指摘なし) | 0 | 0 | 0 | 0 |"]),
    "",
    "## 指摘の一覧",
    "",
    ...byCategory.flatMap((x) => [
      `### ${x.c} (${x.hit.length} 件)`,
      "",
      "| ゲーム | ターン | 話者 | 重さ | 台詞 | 理由 | 直し方の案 |",
      "|---|---|---|---|---|---|---|",
      ...x.hit.map(
        ({ g, i, found }) =>
          `| [${pad(g.index)}](game-${pad(g.index)}.md) | ${i.turn} | ${cell(i.speaker)} | ${i.severity} | ${cell(i.quote)}${found ? "" : " (台詞に見つからない)"} | ${cell(i.reason)} | ${cell(i.fix_hint ?? "")} |`,
      ),
      "",
    ]),
    "## エンジンの差し戻し",
    "",
    "GM が出した返答のうち、エンジンの審査で弾かれたもの (直して出し直している)。多いものは、指示文で事前に防げるかもしれない。",
    "",
    ...(rejections.length ? rejections.map(({ g, r }) => `- [${pad(g.index)}] ターン ${r.turn}: ${cell(r.message)}`) : ["- なし"]),
    "",
    "## ゲームごと",
    "",
    "| ゲーム | お題・題名 | プレイヤー役 | ターン | 結末 | 自然さ | 指摘 | 止まった理由 |",
    "|---|---|---|---|---|---|---|---|",
    ...games.map(
      (g) =>
        `| [${pad(g.index)}](game-${pad(g.index)}.md) | ${cell(g.theme ? `${g.theme.setting} × ${g.theme.topic}` : g.title)} | ${g.style} | ${cell(g.turns)} | ${g.ending ? `${g.ending.type} ${g.ending.resolved}/${g.ending.total}` : "-"} | ${g.judge?.naturalness ?? "-"} | ${g.judge?.issues.length ?? "-"} | ${cell(g.error ?? g.judgeError ?? "")} |`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(dir, "report.md"), md);
}
