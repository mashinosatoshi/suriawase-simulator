// /playtest コマンドから使う道具。
// - MCP 版 (API キーを使わない): Claude Code のサブエージェントが GM (MCP のツール)・プレイヤー役・審査役を務め、このスクリプトは
//   ゲームのサーバー (Claude Code が起動した MCP 版のサーバー) との受け渡しと、記録・レポートを受け持つ。
//   プレイヤー役が見るのは、画面と同じ公開状態 (/api/stream) だけ。隠し情報 (本音・解消条件・信頼度) には触れない。
// - API 版 (npm run playtest -- --judge none) の結果を、Claude Code のサブエージェントに審査させるときにも使う (judge-brief・report)。
//   npx tsx scripts/playtest/mcp.ts new [--difficulty normal]          新しいゲームを頼む (話題は空欄 = お題はゲームが選ぶ)
//   npx tsx scripts/playtest/mcp.ts player-brief <n>                   n ゲーム目のプレイヤー役の性格と、ターンの使い方
//   npx tsx scripts/playtest/mcp.ts wait [--max-turns <数|full>]       自分の番か終了まで待ち、画面の様子を出す
//   npx tsx scripts/playtest/mcp.ts say "<発言>" [--to <id>] [--finish] [--max-turns <数|full>]
//   npx tsx scripts/playtest/mcp.ts dump <dir> <n>                     終了後の公開状態を game-NN-public.json に保存
//   npx tsx scripts/playtest/mcp.ts judge-brief <dir> <n>              審査役への説明と、ターン番号つきの会話
//   npx tsx scripts/playtest/mcp.ts check-judge <dir> <n>              審査役が書いた game-NN-judge.json の形を確かめる
//   npx tsx scripts/playtest/mcp.ts report <dir> [--label "<役の説明>"]  report.md とゲームごとの記録を書き出す
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { STATUS_LABELS, type PublicState } from "../../src/shared.js";
import { turnPlan, turnPlanText } from "./config.js";
import { formatTranscript, JUDGE_GUIDE, material, reportSchema, transcriptOf, type JudgeReport } from "./judge.js";
import { PLAYER_STYLES } from "./player.js";
import type { Usage } from "./providers.js";
import { writeResults, type GameRecord, type Rejection } from "./report.js";

const BASE = `http://localhost:${process.env.PLAYTEST_PORT ?? 3100}`;
const pad = (n: number) => String(n).padStart(2, "0");

/** ゲームのサーバーから状態を受け取り、until を満たしたら返す。時間切れなら最後に受け取った状態 (無ければ null) */
async function readState(until: (s: PublicState) => boolean, timeoutMs: number): Promise<PublicState | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let last: PublicState | null = null;
  try {
    const res = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`ゲームのサーバーに接続できません (${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return last;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const data = buf
          .slice(0, i)
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        buf = buf.slice(i + 2);
        if (!data) continue;
        last = JSON.parse(data) as PublicState;
        if (until(last)) return last;
      }
    }
  } catch (err) {
    if (ctrl.signal.aborted) return last;
    throw new Error(`ゲームのサーバー (${BASE}) に接続できません。Claude Code で suriawase-simulator (MCP) がつながっているか確かめてください: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `失敗しました (${res.status})`;
}

const playerTurns = (s: PublicState) => s.log.filter((l) => l.from === "player").length;

/** プレイヤー役に見せる画面の様子 (公開状態だけ) */
function view(s: PublicState, maxTurns: number) {
  const sc = s.scenario!;
  const name = (id?: string) => sc.characters.find((c) => c.id === id)?.name ?? id ?? "?";
  const lastPlayer = s.log.map((l) => l.from).lastIndexOf("player");
  const heard = s.log.slice(lastPlayer + 1).map((l) => `${l.from === "narrator" ? "(地の文)" : name(l.speaker)}: ${l.text}`);
  const said = playerTurns(s);
  const left = Math.min(maxTurns, sc.turnLimit) - said;
  const out: string[] = [];
  if (said === 0) {
    out.push(
      "## 場面",
      sc.premise,
      `- あなたの立場: ${sc.playerRole}`,
      `- 目標: ${sc.goal}`,
      "## あなたが知っていること",
      ...sc.briefing.map((f) => `- ${f.label}: ${f.text}`),
      "## 相手",
      ...sc.characters.map((c) => `- ${c.name} (id: ${c.id}): ${c.role}`),
    );
  }
  out.push(
    "## 相手の発言",
    ...(heard.length ? heard : ["(なし)"]),
    "## 相手の様子",
    sc.characters.map((c) => `${c.name} ${c.mood.emoji} ${c.mood.label}`).join(" / "),
    "## 見えてきた相手の本音 (懸念ボード)",
    ...(s.concerns.length ? s.concerns.map((c) => `- [${STATUS_LABELS[c.status]}] ${c.text}`) : ["- (まだ何も見えていない)"]),
    left > 1
      ? `## 残り ${left} 回発言できます。`
      : Number.isFinite(maxTurns)
        ? "## 次があなたの最後の発言です。今日の話し合いを締めくくる一言を言ってください (say が自動で締めます)。"
        : "## 次が最後のターンです。相手がこの話し合いを締めくくります。",
  );
  return out.join("\n");
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      difficulty: { type: "string", default: "normal" },
      // full = ターンの上限まで使う (自分からは締めない)。数 = その数の発言で自動的に締める
      "max-turns": { type: "string", default: "full" },
      to: { type: "string" },
      finish: { type: "boolean", default: false },
      label: { type: "string", default: "Claude Code のサブエージェント (GM・プレイヤー役は Haiku、審査役は Sonnet。effort medium)" },
    },
  });
  const maxTurns = values["max-turns"] === "full" ? Infinity : Number(values["max-turns"]);
  if (!(maxTurns >= 1)) throw new Error("--max-turns は 1 以上の数か full");

  switch (command) {
    case "new": {
      const error = await post("new", { request: "", difficulty: values.difficulty });
      console.log(error ? `失敗: ${error}` : "新しいゲームを頼みました (GM がシナリオを作るのを待ってください)");
      return;
    }
    case "player-brief": {
      // ゲームの番号で、性格とターンの使い方が決まる (API 版の npm run playtest と同じ割り振り)
      const n = Number(positionals[0] ?? 1);
      const style = PLAYER_STYLES[(n - 1) % PLAYER_STYLES.length];
      const plan = turnPlan(n, "mixed");
      console.log(
        [
          `性格: ${style.label}: ${style.text}`,
          `ターン: ${turnPlanText(plan)}${plan === "full" ? " (自分からは締めない。--finish は使わない)" : " (say が自動で締める)"}`,
          `wait と say に付ける引数: --max-turns ${plan}`,
        ].join("\n"),
      );
      return;
    }
    case "wait": {
      const s = await readState((x) => x.phase === "ended" || (x.phase === "player_turn" && !!x.scenario), 300_000);
      if (!s) return console.log("状態: 時間切れ (5 分待っても番が来ませんでした)。もう一度 wait してください");
      if (s.phase === "ended") return console.log("状態: ended (対話は終わりました。プレイヤー役の仕事はここまでです)");
      if (s.phase !== "player_turn") return console.log(`状態: ${s.phase} (まだ番ではありません。もう一度 wait してください)`);
      console.log(`状態: player_turn (あなたの番です)\n${view(s, maxTurns)}`);
      return;
    }
    case "say": {
      const text = (positionals[0] ?? "").trim();
      if (!text) return console.log("失敗: 発言が空です");
      const s = await readState(() => true, 10_000);
      if (s?.phase !== "player_turn") return console.log(`失敗: いまはあなたの番ではありません (状態: ${s?.phase ?? "不明"})。wait してください`);
      // ターンの上限まで使うゲームでは締めない (最後のターンは相手が締めくくる)
      const full = !Number.isFinite(maxTurns);
      const last = !full && (values.finish || playerTurns(s) + 1 >= maxTurns);
      const error = await post(last ? "defer" : "act", { text, to: values.to });
      const note = full && values.finish ? " (このゲームはターンの上限まで続けるので、締めずに送りました)" : "";
      console.log(error ? `失敗: ${error}` : last ? "送りました。この発言で締めました。wait すると終了を確かめられます" : `送りました${note}。wait で相手の返事を待ってください`);
      return;
    }
    case "dump": {
      const [dir, n] = positionals;
      // 振り返りが届くまで少し待つ
      const s = await readState((x) => x.phase === "ended" && !!x.review, 120_000);
      if (!s) throw new Error("状態を受け取れませんでした");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `game-${pad(Number(n))}-public.json`);
      writeFileSync(file, JSON.stringify(s, null, 2));
      console.log(`保存しました: ${file} (状態: ${s.phase}${s.review ? "・振り返りあり" : "・振り返りなし"})`);
      return;
    }
    case "judge-brief": {
      const [dir, n] = positionals;
      const { $schema: _drop, ...schema } = z.toJSONSchema(reportSchema) as Record<string, unknown>;
      // API 版の記録 (game-NN.json) には設定がすべて入っている。MCP 版の記録は公開状態だけなので、設定は get_state で見る
      const apiRecord = join(dir, `game-${pad(Number(n))}.json`);
      let body: string[];
      if (existsSync(apiRecord)) {
        const g = readJson<GameRecord>(apiRecord);
        if (!g.scenario) throw new Error("このゲームはシナリオができる前に止まったので、審査するものがありません");
        body = ["設定はすべて下にある。MCP のツールは呼ばない。", "", material(g.scenario, g.transcript)];
      } else {
        const s = readJson<PublicState>(join(dir, `game-${pad(Number(n))}-public.json`));
        const names = new Map((s.scenario?.characters ?? []).map((c) => [c.id, c.name]));
        body = [
          "## 登場人物の設定と隠れた本音",
          "MCP のツール mcp__suriawase-simulator__get_state を 1 回呼び、結果の scenario (characters の persona・speech・sample_lines、briefing、concerns) を見る。ほかの MCP のツールは呼ばない。",
          "",
          `## 会話 (題名: ${s.scenario?.title ?? "?"})`,
          formatTranscript(transcriptOf(s.log, names)),
        ];
      }
      console.log(
        [
          JUDGE_GUIDE,
          "",
          ...body,
          "",
          "## 提出のしかた",
          `次の JSON Schema に合う JSON を、ファイル ${resolve(dir, `game-${pad(Number(n))}-judge.json`)} に書く (JSON だけ。説明文は書かない)。`,
          `書いたら \`npx tsx scripts/playtest/mcp.ts check-judge ${dir} ${n}\` で形を確かめ、エラーがあれば直す。`,
          JSON.stringify(schema),
        ].join("\n"),
      );
      return;
    }
    case "check-judge": {
      const [dir, n] = positionals;
      const file = join(dir, `game-${pad(Number(n))}-judge.json`);
      const parsed = reportSchema.safeParse(readJson(file));
      console.log(parsed.success ? `OK (指摘 ${parsed.data.issues.length} 件)` : `形が正しくありません:\n${parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      if (!parsed.success) process.exitCode = 1;
      return;
    }
    case "report": {
      const [dir] = positionals;
      /** 審査役のサブエージェントが書いた結果 (無い・形が違うときは理由) */
      const judgeOf = (n: number): { judge: JudgeReport | null; judgeError: string | null } => {
        const file = join(dir, `game-${pad(n)}-judge.json`);
        if (!existsSync(file)) return { judge: null, judgeError: "審査の結果がありません" };
        const parsed = reportSchema.safeParse(readJson(file));
        return parsed.success ? { judge: parsed.data, judgeError: null } : { judge: null, judgeError: `審査の結果の形が正しくありません: ${parsed.error.issues[0]?.message}` };
      };
      const numbersOf = (re: RegExp) =>
        readdirSync(dir)
          .map((f) => f.match(re)?.[1])
          .filter((x): x is string => !!x)
          .map(Number)
          .sort((a, b) => a - b);

      // API 版 (npm run playtest -- --judge none) の結果: ゲームの記録に、審査役の結果を足す
      const runFile = join(dir, "run.json");
      if (existsSync(runFile)) {
        const run = readJson<{ header: string[]; usage: Record<"gm" | "player" | "judge", Usage> }>(runFile);
        const games = numbersOf(/^game-(\d+)\.json$/).map((n) => {
          const g = readJson<GameRecord>(join(dir, `game-${pad(n)}.json`));
          return g.judge ? g : { ...g, ...judgeOf(n) };
        });
        writeResults(dir, run.header, games, run.usage);
        console.log(`結果: ${resolve(dir, "report.md")}`);
        return;
      }

      // MCP 版の結果: 公開状態と、進行役 (自分) が書いた meta から組み立てる
      const games: GameRecord[] = numbersOf(/^game-(\d+)-public\.json$/).map((n) => {
        const s = readJson<PublicState>(join(dir, `game-${pad(n)}-public.json`));
        const metaFile = join(dir, `game-${pad(n)}-meta.json`);
        const meta = existsSync(metaFile) ? readJson<{ style?: string; turns?: number | "full"; difficulty?: string; rejections?: Rejection[]; error?: string | null }>(metaFile) : {};
        const names = new Map((s.scenario?.characters ?? []).map((c) => [c.id, c.name]));
        const turns = meta.turns ?? turnPlan(n, "mixed");
        return {
          index: n,
          title: s.scenario?.title ?? "(シナリオなし)",
          theme: null,
          style: meta.style ?? "-",
          turns: `${turnPlanText(turns)}${turns === "full" && s.scenario ? ` (${s.scenario.turnLimit} ターン)` : ""}`,
          difficulty: meta.difficulty ?? s.difficulty,
          scenario: null,
          transcript: transcriptOf(s.log, names),
          ending: s.ending,
          review: s.review,
          rejections: meta.rejections ?? [],
          error: meta.error ?? (s.phase !== "ended" ? "最後まで進みませんでした" : null),
          ...judgeOf(n),
        };
      });
      writeResults(dir, [`- 実行: ${new Date().toISOString()}・MCP 版 (API キーなし)`, `- GM・プレイヤー役・審査役: ${values.label}`, "- ターン: ゲームごとに「上限まで使う」と「途中で締める」を交互に (ゲームごとの表を参照)"], games, null);
      console.log(`結果: ${resolve(dir, "report.md")}`);
      return;
    }
    default:
      console.log("使い方は scripts/playtest/mcp.ts の先頭のコメントを見てください");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
