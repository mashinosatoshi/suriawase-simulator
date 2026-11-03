// 自動試遊: 本物の AI に GM とプレイヤー役を任せて何ゲームも回し、会話の不自然な箇所を審査役の AI に挙げさせる。
// ゲームのエンジンと内蔵 GM (src/engine.ts・src/gm.ts) を、ブラウザ版と同じ形でそのまま使う。
//   npm run playtest -- --games 3                 (既定: GM・プレイヤー役は Claude Haiku 5.5、審査役は Sonnet 5.5。effort medium)
//   npm run playtest -- --dry-run                  (作り物の AI で仕組みだけ確かめる。費用ゼロ)
//   npm run playtest -- --judge anthropic:claude-haiku-5-5:medium    (審査役も軽いモデルに)
//   npm run playtest -- --gm gemini:gemini-3.5-flash-lite --player gemini:gemini-3.5-flash-lite --judge none
//                                                  (審査は後で Claude Code のサブエージェントに任せる。/playtest から使う)
// API キーは、起動するとブラウザに開く入力画面で受け取る (ファイルや環境変数からは読まない)。
// 結果は playtest-results/ の下に書き出す (report.md がまとめ)。AI を呼ぶたびに課金されるので、回数に気をつける
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultParams, randomParams } from "../src/difficulty.js";
import { Engine } from "../src/engine.js";
import { BuiltinGm } from "../src/gm.js";
import { ApiKeys, type LlmProvider, type ProviderId } from "../src/llm/index.js";
import { pickTheme } from "../src/themes.js";
import { parseOptions, seededRandom, turnPlan, turnPlanText, type Options } from "./playtest/config.js";
import { fakeProvider } from "./playtest/fake.js";
import { judge, transcriptOf } from "./playtest/judge.js";
import { askKeys } from "./playtest/keypage.js";
import { PLAYER_STYLES, PlayerSim } from "./playtest/player.js";
import { emptyUsage, makeProvider, type Usage } from "./playtest/providers.js";
import { apiHeader, writeResults, type GameRecord, type Rejection } from "./playtest/report.js";

type Role = "gm" | "player" | "judge";
/** judge = null は審査をしない (あとで Claude Code のサブエージェントが審査する) */
type Providers = { gm: LlmProvider; player: LlmProvider; judge: LlmProvider | null };

async function playGame(index: number, o: Options, providers: Providers, keys: ApiKeys, rand: () => number): Promise<GameRecord> {
  const theme = pickTheme(rand);
  const style = PLAYER_STYLES[(index - 1) % PLAYER_STYLES.length];
  const plan = turnPlan(index, o.turns);
  // dry-run の作り物の GM は、普通の難易度に合わせたシナリオしか出せない
  const difficulty = o.dryRun ? "normal" : o.difficulty;
  const params = difficulty === "random" ? randomParams(rand) : defaultParams(difficulty);
  const engine = new Engine();
  const rejections: Rejection[] = [];
  const log = (...a: unknown[]) => {
    const message = a.map(String).join(" ");
    if (/差し戻し|失敗/.test(message)) rejections.push({ turn: engine.publicState().turn, message });
  };
  const gm = new BuiltinGm(engine, () => providers.gm, keys, { provider: o.gm.provider, model: o.gm.model }, () => {}, log);
  const record: GameRecord = { index, title: "(シナリオなし)", theme, style: style.label, turns: turnPlanText(plan), difficulty, scenario: null, transcript: [], ending: null, review: null, rejections, error: null, judge: null, judgeError: null };
  const step = (text: string) => process.stdout.write(`\r  ${text}`.padEnd(60));

  engine.requestNewGame("", difficulty, params, theme);
  step("シナリオを作成中…");
  await gm.tick();
  const pub = () => engine.publicState();
  let sc = pub().scenario;
  if (gm.status().error || !sc) record.error = gm.status().error ?? "シナリオができませんでした";
  else {
    console.log(`\r  シナリオ: ${sc.title} (${sc.characters.map((c) => c.name).join("・")})`.padEnd(60));
    // 上限まで使うゲームでは、プレイヤー役は自分から締めない (最後のターンはエンジンが締めくくらせる)
    const full = plan === "full";
    if (full) record.turns = `${turnPlanText(plan)} (${sc.turnLimit} ターン)`;
    const limit = full ? sc.turnLimit : Math.min(plan, sc.turnLimit);
    const player = new PlayerSim(providers.player, o.player.model, sc, style, !full);
    let said = 0;
    while (engine.phase === "player_turn") {
      said++;
      const last = said >= limit;
      step(`ターン ${said}: プレイヤー役が考え中…`);
      const u = await player.next(pub(), limit - said, last);
      const defer = !full && (last || u.finish);
      const refused = engine.act({ text: u.text, to: u.to }, defer);
      // 発言が受け付けられなかった (キーらしい文字列を含む等) ときは、無難な一言で続ける
      if (refused) engine.act({ text: "なるほど。もう少し聞かせてください。" }, defer);
      step(`ターン ${said}: GM が考え中…`);
      await gm.tick();
      if (gm.status().error) {
        record.error = gm.status().error;
        break;
      }
    }
    sc = pub().scenario;
  }

  const state = engine.fullState({ wholeLog: true });
  const names = new Map((state.scenario?.characters ?? []).map((c) => [c.id, c.name]));
  record.scenario = state.scenario;
  if (state.scenario) record.title = state.scenario.title;
  record.transcript = transcriptOf(state.recent_log, names);
  record.ending = state.ending;
  record.review = state.review;
  if (!record.error && engine.phase === "ended" && !state.review) record.error = gm.status().error ?? "振り返りが届きませんでした";

  if (!providers.judge || !o.judge) record.judgeError = "審査待ち (Claude Code のサブエージェントが審査する)";
  else if (state.scenario && record.transcript.some((l) => l.from !== "player")) {
    step("審査役が会話を読んでいます…");
    try {
      record.judge = await judge(providers.judge, o.judge.model, state.scenario, record.transcript);
    } catch (err) {
      record.judgeError = err instanceof Error ? err.message : String(err);
    }
  }
  const result = record.error ? `止まりました: ${record.error.slice(0, 80)}` : `${record.ending?.type ?? "-"}・指摘 ${record.judge?.issues.length ?? "-"} 件・自然さ ${record.judge?.naturalness ?? "-"}/5`;
  console.log(`\r  ${result}`.padEnd(60));
  return record;
}

async function main() {
  const o = parseOptions(process.argv.slice(2));
  const usage: Record<Role, Usage> = { gm: emptyUsage(), player: emptyUsage(), judge: emptyUsage() };
  let keys = new ApiKeys();
  let providers: Providers;

  if (o.dryRun) {
    keys.set(o.gm.provider, "dry-run"); // 内蔵 GM は「キーが入力済み」かだけを見る。作り物の AI はキーを使わない
    providers = { gm: fakeProvider("gm"), player: fakeProvider("player"), judge: o.judge && fakeProvider("judge") };
  } else {
    const needed = [...new Set<ProviderId>([o.gm.provider, o.player.provider, ...(o.judge ? [o.judge.provider] : [])])];
    keys = await askKeys(needed);
    const make = (role: Role) => {
      const spec = o[role]!;
      return makeProvider(spec, keys.get(spec.provider)!, usage[role]);
    };
    providers = { gm: make("gm"), player: make("player"), judge: o.judge && make("judge") };
  }

  console.log(`自動試遊: ${o.games} ゲーム (GM ${o.gm.model} / プレイヤー役 ${o.player.model} / 審査役 ${o.judge?.model ?? "後で Claude Code"})${o.dryRun ? " [dry-run]" : ""}`);
  const rand = seededRandom(o.seed);
  const started = Date.now();
  const games: GameRecord[] = [];
  for (let i = 1; i <= o.games; i++) {
    console.log(`ゲーム ${i}/${o.games}`);
    games.push(await playGame(i, o, providers, keys, rand));
  }
  const dir = resolve(o.out);
  const header = apiHeader(o, (Date.now() - started) / 1000);
  writeResults(dir, header, games, usage);
  // 後で審査の結果を足してレポートを作り直すとき (scripts/playtest/mcp.ts report) に、実行の条件と使用量を引き継ぐ
  writeFileSync(join(dir, "run.json"), JSON.stringify({ header, usage }, null, 2));
  console.log(`\n結果: ${resolve(dir, "report.md")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
