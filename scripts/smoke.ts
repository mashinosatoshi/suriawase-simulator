// 実サーバーを --mcp で起動し、MCP クライアント (= AI 役) と HTTP (= プレイヤー役) で 1 ゲーム通して流す結合テスト。
//   npm run smoke
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { PublicState } from "../src/shared.js";

const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/server.ts", "--mcp"],
  env: { PORT: String(PORT) },
  stderr: "pipe",
});
const mcp = new Client({ name: "smoke", version: "1.0.0" });

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  const t = r.content[0].text;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const post = async (path: string, body: unknown = {}) => {
  const res = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.status;
};
/** SSE の最初のイベント = 現在の公開状態 */
async function publicState(): Promise<PublicState> {
  const ctl = new AbortController();
  const res = await fetch(BASE + "/api/stream", { signal: ctl.signal });
  const reader = res.body!.getReader();
  let buf = "";
  for (;;) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
    if (buf.includes("\n\n")) break;
  }
  ctl.abort();
  return JSON.parse(buf.replace(/^data: /, "").trim());
}
const rawStatus = (headers: Record<string, string>, path = "/api/new") =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, method: "POST", headers }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on("error", reject);
    req.end("{}");
  });

const step = (m: string) => console.log(`✔ ${m}`);

const scenario = {
  title: "スモークテスト",
  premise: "結合テスト用のシナリオ。小さな町の書店を閉めるかどうかを話し合う。",
  player_role: "店主の旧友",
  goal: "書店の今後について店主と合意する",
  characters: [
    {
      id: "owner",
      name: "店主",
      emoji: "📚",
      role: "書店主",
      persona: "穏やかだが頑固。本への愛着が強く、人の話を最後まで聞く。",
      trust_start: 6,
      openness: 5,
      understanding: 5,
      speech: "一人称は「私」、相手は「君」。穏やかな常体で、語尾は「〜だね」「〜かな」。",
      sample_lines: ["そうだね、最近は本が売れなくてね。", "君は昔から、よく店に来てくれたな。"],
    },
  ],
  concerns: [
    { id: "c1", owner: "owner", category: "お金", text: "毎月の赤字がもう限界に近い", importance: 9, reveal_hint: "売上や家計を気遣う", min_trust: 1, resolved_when: "赤字を減らす具体的な方法が示される" },
    { id: "c2", owner: "owner", category: "気持ち", text: "亡き妻と始めた店を自分の代で畳むのが辛い", importance: 8, reveal_hint: "店の思い出を聞く", min_trust: 7, resolved_when: "店の記憶を残す形が示される" },
    { id: "c3", owner: "owner", category: "常連", text: "常連の高齢者の居場所がなくなる", importance: 5, reveal_hint: "お客さんのことを尋ねる", min_trust: 4, resolved_when: "常連が集まれる場が確保される" },
    { id: "c4", owner: "owner", category: "体力", text: "腰を痛めて重い本の箱を運ぶのがつらい", importance: 4, reveal_hint: "体調や毎日の作業を気遣う", min_trust: 7, resolved_when: "力仕事を減らす手立てが示される" },
    { id: "c5", owner: "owner", category: "取引", text: "取次への支払いが残っていて簡単には畳めない", importance: 3, reveal_hint: "閉めるときの段取りを尋ねる", min_trust: 8, resolved_when: "支払いを片づける道筋が示される" },
  ],
  briefing: [
    { label: "店", text: "駅前で 40 年続く小さな書店。店主が一人で切り盛りしている" },
    { label: "状況", text: "この 3 年、売上が毎年 1 割ずつ落ちている" },
    { label: "あなた", text: "学生時代からの常連で、店主とは 20 年来の付き合い" },
  ],
  opening: [{ speaker: "owner", text: "店を続けるか迷っていてね。まあ、決めるのは私だが。" }],
};

try {
  await mcp.connect(transport);
  transport.stderr?.on("data", () => {});

  assert.equal(mcp.getServerVersion()?.name, "suriawase-simulator");
  const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["get_state", "reply", "start_scenario", "submit_review", "wait_for_player_turn"]);
  step("MCP ツール 5 本が公開されている");

  // サーバー起動待ち
  for (let i = 0; i < 50; i++) if (await fetch(BASE + "/").then((r) => r.ok, () => false)) break;
  else await new Promise((r) => setTimeout(r, 100));
  const page = await fetch(BASE + "/");
  const html = await page.text();
  assert.match(html, /すり合わせシミュレーター/);
  assert.match(html, /<meta name="backend" content="server">/, "MCP 版の印が付いていない");
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self';.*frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  step("ブラウザ UI が配信されている (MCP 版の印・セキュリティヘッダーつき)");

  assert.match(html, /href="\/privacy\.html"/);
  assert.match(html, /href="\/terms\.html"/);
  for (const path of ["/privacy.html", "/terms.html"]) {
    const res = await fetch(BASE + path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    assert.ok(!/<script|\sstyle=|<style/.test(text), `${path} にインラインのスクリプトかスタイルがある (CSP で止まる)`);
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  }
  step("プライバシーポリシーと利用規約のページが配信されている");

  assert.equal(await rawStatus({ "Content-Type": "application/json", Origin: "http://evil.example" }), 403);
  assert.equal(await rawStatus({ "Content-Type": "application/json", Host: "evil.example" }), 403);
  step("他サイトの Origin / 不正な Host は 403");

  assert.equal(await post("/api/act", { text: "早すぎる" }), 409);
  assert.equal(await post("/api/new", { request: "町の書店の話", difficulty: "nightmare" }), 409);
  assert.equal(await post("/api/new", { request: "キーは sk-ant-api03-" + "x".repeat(30) }), 409, "シナリオの希望に貼られたキーが通ってしまった");
  assert.equal(await post("/api/new", { request: "町の書店の話", difficulty: "normal" }), 204);
  const job = await call("wait_for_player_turn", { timeout_sec: 2 });
  assert.equal(job.type, "new_game");
  assert.equal(job.request, "町の書店の話");
  assert.deepEqual([job.difficulty.label, job.difficulty.concerns, job.difficulty.open_at_start, job.difficulty.trust_start, job.difficulty.understanding, job.difficulty.turns], ["普通", 5, 2, 5, 5, 19], "難易度が AI に届いていない");
  assert.equal(await post("/api/new", { request: "町の書店の話", difficulty: "normal", params: { concerns: 99 } }), 409);
  step("new_game の依頼が AI に届く");

  const bad = await call("start_scenario", { ...scenario, concerns: scenario.concerns.map((c) => ({ ...c, owner: "ghost" })) });
  assert.ok(bad.problems?.some((p: string) => p.includes("ghost")));
  step("不正なシナリオは理由つきで拒否される");

  const started = await call("start_scenario", scenario);
  assert.match(String(started), /開始しました/);
  const s0 = await publicState();
  assert.equal(s0.phase, "player_turn");
  assert.equal(s0.scenario?.briefing.length, 3, "前提情報がブラウザに届いていない");
  const leaked = JSON.stringify(s0);
  for (const secret of ["赤字がもう限界", "亡き妻", "常連の高齢者", "reveal_hint", "resolved_when", "persona", "頑固", "一人称は", "最近は本が売れなくてね"]) assert.ok(!leaked.includes(secret), `${secret} が公開状態に漏れている`);
  step("シナリオ開始。公開状態に隠し情報は含まれない");

  // 1 ターン目: 質問 → 本音 c1 が出る
  assert.equal(await post("/api/act", { text: "お店の調子はどう？" }), 204);
  assert.equal(await post("/api/act", { text: "二重送信" }), 409);
  step("AI の返答前の二重送信は 409");
  const t1 = await call("wait_for_player_turn", { timeout_sec: 2 });
  assert.equal(t1.type, "player_action");
  assert.equal(t1.turn, 1);
  assert.match(t1.voices[0].speech, /一人称は「私」/, "毎ターン口調の手本が渡る");
  const ng = await call("reply", { turn: 1, lines: [{ speaker: "ghost", text: "?" }] });
  assert.ok(ng.problems);
  const steering = await call("reply", { turn: 1, lines: [{ speaker: "narrator", text: "店主は何か言いかけて、口をつぐんだ。" }] });
  assert.ok(steering.problems?.some((p: string) => p.includes("誘導する描写")), "誘導する描写が通ってしまった");
  assert.equal((await publicState()).phase, "ai_turn");
  step("不正な reply は何も反映されず、手番もそのまま");
  const ok1 = await call("reply", {
    turn: 1,
    lines: [{ speaker: "owner", text: "…正直、毎月赤字でね。" }],
    trust_changes: [{ character: "owner", delta: 2, reason: "気遣ってくれた" }],
    concern_updates: [{ id: "c1", to: "revealed", asked: "お店の調子" }],
    moods: [{ character: "owner", emoji: "😔", label: "弱音" }],
  });
  assert.match(String(ok1), /^ok/);
  const s1 = await publicState();
  assert.equal(s1.phase, "player_turn");
  assert.equal(s1.concerns.find((c) => c.id === "c1")?.text, "毎月の赤字がもう限界に近い");
  assert.deepEqual(s1.concerns.map((c) => c.id), ["c1"], "ボードには見つけた懸念だけが載る");
  assert.equal(s0.concerns.length, 0, "ボードは空から始まる");
  assert.ok(s1.log.every((l) => l.from !== ("system" as string)), "進行の要約がログに出ている");
  assert.deepEqual(s1.scenario?.characters[0].mood, { emoji: "😔", label: "弱音" });
  // 信頼度はブラウザには出さず、AI (get_state) だけが知っている
  assert.ok(!("trust" in s1) && !s1.log.some((l) => /信頼/.test(l.text)));
  assert.deepEqual((await call("get_state")).trust, { owner: 7.2 }); // 打ち解けやすさ 5 なので、+2 の評価でも 1.2
  step("reply で本音・気分が反映され、信頼度は画面に出ない (AI だけが知っている)");

  // 2 ターン目: 会話文の中の提案を汲み取って「検討中」に進める (行動の種類は選ばない)
  const proposalText = "月に一度の朗読会を開いて、入場料で赤字を減らしてはどうでしょう。";
  assert.equal(await post("/api/act", { text: proposalText }), 204);
  const t1b = await call("wait_for_player_turn", { timeout_sec: 2 });
  assert.equal(t1b.turn, 2);
  const fake = await call("reply", { turn: 2, lines: [{ speaker: "owner", text: "ほう。" }], concern_updates: [{ id: "c1", to: "proposed", note: "朗読会", quote: "有名な作家を呼んで講演会を開く" }] });
  assert.ok(fake.problems?.some((p: string) => p.includes("見つかりません")), "発言に無い引用が通ってしまった");
  // 相手からの歩み寄り: 根拠が 1 ターン分しかないうちは使えない (initiative / evidence が MCP 経由でエンジンまで届くことの確認も兼ねる)
  const early = await call("reply", {
    turn: 2,
    lines: [{ speaker: "owner", text: "それなら、私も考えてみようか。" }],
    concern_updates: [{ id: "c1", to: "proposed", initiative: true, evidence: ["月に一度の朗読会を開いて", "入場料で赤字を減らして"], note: "朗読会で赤字を減らしたい" }],
  });
  assert.ok(early.problems?.some((p: string) => p.includes("1 つのターンにしかありません")), `歩み寄りの条件が効いていない: ${JSON.stringify(early)}`);
  assert.equal((await publicState()).concerns[0].status, "revealed");
  const real = await call("reply", { turn: 2, lines: [{ speaker: "owner", text: "朗読会か…考えたこともなかった。" }], concern_updates: [{ id: "c1", to: "proposed", note: "朗読会の入場料で赤字を減らす", quote: "月に一度の朗読会を開いて、入場料で赤字を減らして" }] });
  assert.match(String(real), /^ok/);
  const s1b = await publicState();
  assert.equal(s1b.concerns[0].status, "proposed");
  assert.ok(!JSON.stringify(s1b).includes("朗読会の入場料で赤字を減らす"), "対処案がブラウザに送られている");
  step("会話文の中の提案を、発言からの引用つきで「検討中」に進められる (言い換えは弾かれる)");

  // 「締める」ボタン → 終了
  assert.equal(await post("/api/defer", { text: "" }), 204);
  const t2 = await call("wait_for_player_turn", { timeout_sec: 2 });
  assert.equal(t2.defer, true);
  assert.equal(t2.turn, 3);
  const noEp = await call("reply", { turn: 3, lines: [{ speaker: "owner", text: "そうか。" }] });
  assert.ok(noEp.problems?.some((p: string) => p.includes("epilogue")));
  const end = await call("reply", { turn: 3, lines: [{ speaker: "owner", text: "そうか。また来てくれ。" }], epilogue: "二人は、続きを来週話すことにした。" });
  assert.match(String(end), /終了/);
  const s2 = await publicState();
  assert.equal(s2.phase, "ended");
  assert.equal(s2.ending?.type, "carry_over");
  assert.ok(s2.concerns.every((c) => c.text), "終了後は見つけられなかった懸念も公開される");
  assert.equal(s2.review, null);
  step("「締める」で終了。epilogue が必須で、結末と未発見の懸念が公開される");

  // 振り返り: 終了後に AI へ依頼が届き、解消できなかった懸念すべてに助言が要る
  const rv = await call("wait_for_player_turn", { timeout_sec: 2 });
  assert.equal(rv.type, "review");
  assert.ok(rv.transcript.some((t: string) => t.includes("朗読会")));
  assert.equal(rv.concerns.find((c: { id: string }) => c.id === "c2").reveal_hint, "店の思い出を聞く");
  const advice = (ids: string[]) => ids.map((id) => ({ id, advice: `${id} は、聞き方を変えれば届いたはず` }));
  const review = (ids: string[]) => ({ overall: "朗読会の提案は具体的で良かった。他の事情にも踏み込めるとさらに良い。", good: ["赤字の話に具体案を出せた"], improve: ["店の思い出も聞いてみる"], concerns: advice(ids) });
  const lacking = await call("submit_review", review(["c1"]));
  assert.ok(lacking.problems?.some((p: string) => p.includes('"c2"')), "助言の不足が弾かれていない");
  assert.equal((await publicState()).review, null);
  assert.match(String(await call("submit_review", review(["c1", "c2", "c3", "c4", "c5"]))), /受け付けました。wait_for_player_turn に戻って/);
  const s2b = await publicState();
  assert.equal(s2b.review?.concerns.length, 5);
  assert.match(s2b.review?.overall ?? "", /朗読会/);
  assert.equal(await call("wait_for_player_turn", { timeout_sec: 1 }), "新しい仕事はありません。もう一度 wait_for_player_turn を呼んでください");
  step("終了後の振り返りを AI が提出し、画面に載る (助言が足りなければ弾かれる)");

  // 同じシナリオでもう一度 (AI の手は要らない)
  assert.equal(await post("/api/replay"), 204);
  const s3 = await publicState();
  assert.equal(s3.phase, "player_turn");
  assert.equal(s3.turn, 0);
  assert.equal(s3.log.length, 1);
  assert.equal(s3.review, null);
  assert.notEqual(s3.epoch, s2.epoch);
  step("replay で同じシナリオを最初からやり直せる");

  const full = await call("get_state");
  assert.equal(full.scenario.concerns.length, 5);
  step("get_state は AI に隠し情報を含む全状態を返す");

  console.log("\nスモークテスト: すべて成功");
} catch (e) {
  console.error("\nスモークテスト失敗:", e);
  process.exitCode = 1;
} finally {
  await mcp.close().catch(() => {});
}
