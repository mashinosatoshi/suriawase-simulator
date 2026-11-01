import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDifficulty, randomParams, trustGainRate } from "./difficulty.js";
import { Engine, stripSelfIntro, type Work } from "./engine.js";
import { leaksSecret, replySchema, type ReplyInput, type Scenario } from "./scenario.js";
import { discoverRate, resolveRate, scoreGame } from "./score.js";
import { DIFFICULTY_PRESETS, PARAM_SPECS, type DifficultyParams, type PresetDifficulty } from "./shared.js";

const scenario = () => ({
  title: "橋の場所",
  premise: "川に新しい橋をかけたい。村長と場所について話し合う。",
  player_role: "隣村から来た調停役",
  goal: "橋の建設場所について村長と合意する",
  characters: [
    {
      id: "mayor",
      name: "村長",
      emoji: "👴",
      role: "村長",
      persona: "慎重で面倒見がよい。決めつけられるのを嫌う。",
      trust_start: 6,
      openness: 9,
      understanding: 6,
      speech: "一人称は「わし」、相手は「あんた」。老人らしいくだけた口調で、語尾は「〜じゃ」「〜かのう」。",
      sample_lines: ["そうさのう、費用のことは気になるわい。", "あんたの話は、よう分かった。"],
    },
    {
      id: "ferry",
      name: "渡し守",
      emoji: "🛶",
      role: "渡し守",
      persona: "口数が少なく頑固。川と共に生きてきた。",
      trust_start: 4,
      openness: 3,
      understanding: 4,
      speech: "一人称は「おれ」、相手は「あんた」。ぶっきらぼうな常体で、短く言い切る。",
      sample_lines: ["川は毎日違う。", "船は四十年、おれが漕いできた。"],
    },
  ],
  concerns: [
    { id: "c1", owner: "mayor", category: "予算", text: "村の蓄えが少なく大きな橋は作れない", importance: 9, reveal_hint: "費用や工期を尋ねる", min_trust: 1, resolved_when: "村の予算内に収まる規模の案が示される" },
    { id: "c2", owner: "ferry", category: "仕事", text: "橋ができると渡し守の仕事がなくなる", importance: 7, reveal_hint: "渡し守の暮らしに触れる", min_trust: 6, resolved_when: "渡し守の収入や役割が守られる案が示される" },
    { id: "c3", owner: "mayor", category: "行事", text: "祭りの行列の道筋が変わってしまう", importance: 4, reveal_hint: "村の行事や慣習を尋ねる", min_trust: 3, resolved_when: "祭りの行列の経路が確保される" },
    { id: "c4", owner: "mayor", category: "安全", text: "子どもが橋から川へ落ちないか心配だ", importance: 6, reveal_hint: "子どもや安全のことを尋ねる", min_trust: 7, resolved_when: "欄干など、子どもを守る備えが示される" },
    { id: "c5", owner: "ferry", category: "工事", text: "工事のあいだ船が出せず収入が途絶える", importance: 5, reveal_hint: "工事中の川の使い方を尋ねる", min_trust: 6, resolved_when: "工事中も船を出せる段取りが示される" },
  ],
  briefing: [
    { label: "計画", text: "県の補助で、来年度中に川へ橋を 1 本かける" },
    { label: "候補地", text: "東の浅瀬と、村の中心に近い西の渡し場の 2 か所" },
    { label: "これまで", text: "村の寄合で 2 回話し合ったが、場所が決まっていない" },
  ],
  opening: [{ speaker: "mayor", text: "橋なら東の浅瀬がよかろう。それで決まりじゃ。" }],
});

const line = (speaker = "mayor", text = "ふむ…") => ({ speaker, text });
/** 信頼度が動くターンには、その人の気分の更新が必須 */
const calm = [{ character: "mayor", emoji: "😌", label: "安心" }];
const calmFerry = [{ character: "ferry", emoji: "😌", label: "安心" }];
/** 1 人の信頼度を動かす (気分の更新つき) */
const up = (character: string, delta = 1) => ({ trust_changes: [{ character, delta }], moods: [{ character, emoji: "😌", label: "安心" }] });

/** 5 つの懸念それぞれへの提案を含む発言と、その引用 */
const BIG = "小さな木橋にして費用を抑え、行列は川沿いの道を通し、渡し守には渡し賃を残してはどうでしょう。欄干は高くして、工事は船の少ない冬に行います。";
const Q1 = "小さな木橋にして費用を抑え";
const Q3 = "行列は川沿いの道を通し";
const Q2 = "渡し守には渡し賃を残して";
const Q4 = "欄干は高くして";
const Q5 = "工事は船の少ない冬に行います";

function started() {
  const e = new Engine();
  e.requestNewGame("橋の話");
  const r = e.startScenario(scenario());
  assert.ok(r.ok, JSON.stringify(r));
  return e;
}
/** プレイヤーが 1 回発言した状態 (ai_turn) にする */
function playing(text = "こんにちは") {
  const e = started();
  assert.equal(e.act({ text }), null);
  return e;
}
const reply = (e: Engine, r: Partial<ReplyInput> = {}) => e.reply({ turn: 1, lines: [line()], ...r });
const errorsOf = (r: { ok: boolean; errors?: string[] }) => (r.ok ? "" : (r.errors ?? []).join("\n"));
/** 通るはずの返答。失敗したら理由を出す */
const must = (r: ReturnType<Engine["reply"]>) => assert.ok(r.ok, errorsOf(r));
const work = (e: Engine) => e.pendingWork() as Extract<Work, { type: "player_action" }>;

test("new_game の依頼が仕事として届き、シナリオ開始で消える", () => {
  const e = new Engine();
  assert.equal(e.pendingWork(), null);
  e.requestNewGame("ファンタジー");
  const w = e.pendingWork() as Extract<Work, { type: "new_game" }>;
  assert.equal(w.type, "new_game");
  assert.equal(w.request, "ファンタジー");
  assert.equal(w.difficulty.level, "normal"); // 指定が無ければ普通
  assert.ok(e.startScenario(scenario()).ok);
  assert.equal(e.pendingWork(), null);
  assert.equal(e.phase, "player_turn");
  assert.equal(e.publicState().log[0].text, "橋なら東の浅瀬がよかろう。それで決まりじゃ。");
});

test("不正なシナリオは理由つきで拒否される", () => {
  const e = new Engine();
  const bad = scenario();
  bad.concerns[0].owner = "nobody";
  for (const c of bad.concerns) c.min_trust = 9;
  const r = e.startScenario(bad);
  assert.equal(r.ok, false);
  const msg = errorsOf(r);
  assert.match(msg, /nobody/);
  assert.match(msg, /最初から話せる本音 \(min_trust が owner の trust_start 以下\) をちょうど 2 個にしてください \(いま 0 個\)/);
  assert.equal(e.phase, "setup");
  assert.equal(e.startScenario({ title: "x" }).ok, false);
});

test("公開状態に隠し情報が含まれない / 懸念ボードは空から始まる", () => {
  const e = started();
  const json = JSON.stringify(e.publicState());
  for (const secret of ["村の蓄えが少なく", "渡し守の仕事がなくなる", "祭りの行列", "子どもが橋から", "船が出せず", "reveal_hint", "resolved_when", "persona", "慎重で面倒見", "trust_start", "understanding"]) {
    assert.ok(!json.includes(secret), `${secret} が漏れている`);
  }
  // 未発見の懸念は存在も分類 (category) も送らない
  for (const tag of ["予算", "仕事", "行事", "安全", "工事"]) assert.ok(!json.includes(`"${tag}"`), `未発見の懸念の分類 ${tag} が漏れている`);
  assert.deepEqual(e.publicState().concerns, []);
});

test("懸念ボードは見つけた順に増え、進行の要約はログに出ない", () => {
  const e = playing("お祭りのことを聞かせてください。");
  // c3 → c1 の順に見つかる (シナリオの並びとは無関係)
  assert.ok(reply(e, { concern_updates: [{ id: "c3", to: "revealed", asked: "お祭りのこと" }] }).ok);
  assert.deepEqual(e.publicState().concerns.map((c) => [c.id, c.status]), [["c3", "revealed"]]);
  e.act({ text: BIG });
  const r2 = e.reply({
    turn: 2,
    lines: [line()],
    concern_updates: [
      { id: "c1", to: "proposed", note: "小さな木橋にする", quote: Q1 },
      { id: "c3", to: "proposed", note: "行列は川沿いの道へ", quote: Q3 },
    ],
  });
  assert.ok(r2.ok, errorsOf(r2));
  assert.deepEqual(e.publicState().concerns.map((c) => c.id), ["c3", "c1"]); // 見つかった順
  e.act({ text: "どうでしょう" });
  assert.ok(e.reply({ turn: 3, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな橋で合意" }] }).ok);
  const s = e.publicState();
  assert.equal(s.concerns.length, 2); // 未発見の c2 は載らない
  assert.ok(s.log.every((l) => l.from === "player" || l.from === "character" || l.from === "narrator"));
  // ログは会話そのものだけ: 開始時の 1 行 + プレイヤー 3 回 + AI の 3 回
  assert.equal(s.log.length, 1 + 3 + 3);
  assert.ok(!s.log.some((l) => /本音|信頼|解消|対処案/.test(l.text)));
});

test("手番の排他制御: AI の返事が来るまでプレイヤーは次に進めない", () => {
  const e = playing();
  assert.equal(e.phase, "ai_turn");
  assert.match(e.act({ text: "もう一回" }) ?? "", /考え中/);
  assert.ok(reply(e).ok);
  assert.equal(e.phase, "player_turn");
  assert.equal(e.act({ text: "続き" }), null);
});

test("発言が空だと送れない (「締める」だけは空でもよい)", () => {
  const e = started();
  assert.match(e.act({ text: "   " }) ?? "", /入力/);
  assert.equal(e.phase, "player_turn");
  assert.equal(e.act({ text: "" }, true), null);
  assert.equal(work(e).defer, true);
});

test("古い turn の reply は拒否され、何も変わらない", () => {
  const e = playing();
  const before = JSON.stringify(e.publicState());
  const r = e.reply({ turn: 7, lines: [line()] });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(e.publicState()), before);
});

test("pendingWork は reply するまで同じ仕事を返し続ける", () => {
  const e = playing("予算はどのくらいですか？");
  const a = e.pendingWork();
  const b = e.pendingWork();
  assert.deepEqual(a, b);
  assert.equal(a?.type, "player_action");
  assert.equal(work(e).text, "予算はどのくらいですか？");
  reply(e);
  assert.equal(e.pendingWork(), null);
});

test("信頼度はキャラクターごと。本音を持つ人の信頼度が足りなければ出せない / 増減は先に適用される", () => {
  const e = playing("渡し守さんの暮らしはどうですか？");
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 4 }); // シナリオで決めた、各キャラの最初の信頼度
  // c2 は渡し守 (信頼度 4) の本音で、min_trust=6。村長の信頼度は関係ない
  const bad = reply(e, { concern_updates: [{ id: "c2", to: "revealed", asked: "渡し守さんの暮らし" }] });
  assert.equal(bad.ok, false);
  assert.match(errorsOf(bad), /ferry の信頼度 4 < 必要 6/);
  assert.match(errorsOf(reply(e, { ...up("mayor", 2), concern_updates: [{ id: "c2", to: "revealed", asked: "渡し守さんの暮らし" }] })), /ferry の信頼度 4 < 必要 6/);
  // 渡し守は頑な (打ち解けやすさ 3 → 上がり幅 40%): +2 の評価でも 0.8 しか上がらない
  assert.match(errorsOf(reply(e, { ...up("ferry", 2), concern_updates: [{ id: "c2", to: "revealed", asked: "渡し守さんの暮らし" }] })), /ferry の信頼度 4 < 必要 6/);
  assert.equal(e.phase, "ai_turn"); // 失敗しても手番は進まない
  // 良い発言を重ねれば、少しずつ打ち解ける: 4 → 4.8 → 5.6 → 6.4
  const care = (reason: string) => ({ trust_changes: [{ character: "ferry", delta: 2, reason }], moods: calmFerry });
  must(reply(e, care("暮らしを気遣ってくれた")));
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 4.8 });
  e.act({ text: "渡し守さんの暮らしを、もう少し聞かせてください。" });
  must(e.reply({ turn: 2, lines: [line("ferry")], ...care("話を最後まで聞いてくれた") }));
  e.act({ text: "渡し守さんの暮らしが心配なんです。" });
  must(e.reply({ turn: 3, lines: [line("ferry")], ...care("暮らしを本気で心配してくれた"), concern_updates: [{ id: "c2", to: "revealed", asked: "渡し守さんの暮らし" }] }));
  const s = e.publicState();
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 6.4 });
  assert.equal(s.concerns.find((c) => c.id === "c2")?.text, "橋ができると渡し守の仕事がなくなる");
  assert.deepEqual(e.fullState().trust_history, [
    { turn: 1, character: "ferry", from: 4, to: 4.8, reason: "暮らしを気遣ってくれた" },
    { turn: 2, character: "ferry", from: 4.8, to: 5.6, reason: "話を最後まで聞いてくれた" },
    { turn: 3, character: "ferry", from: 5.6, to: 6.4, reason: "暮らしを本気で心配してくれた" },
  ]);
});

test("打ち解けやすさ: 良い発言で上がる信頼度は、その人の打ち解けやすさで縮む (下がるときはそのまま) / 気分の更新は段階が変わったときだけ", () => {
  assert.deepEqual([1, 2, 3, 5, 8, 9, 10].map(trustGainRate), [20, 30, 40, 60, 90, 100, 100]);
  const e = playing("お二人のお考えを聞かせてください。");
  // 村長 (打ち解けやすさ 9 → 100%) は評価どおり、渡し守 (3 → 40%) は +2 でも 0.8。渡し守は段階が 4 のままなので、気分の更新は要らない
  must(reply(e, { trust_changes: [{ character: "mayor", delta: 1 }, { character: "ferry", delta: 2 }], moods: calm }));
  assert.deepEqual(e.fullState().trust, { mayor: 7, ferry: 4.8 });
  // 下がるときは縮まない (4.8 → 3.8)
  e.act({ text: "それは考えすぎでしょう。" });
  must(e.reply({ turn: 2, lines: [line()], trust_changes: [{ character: "ferry", delta: -1 }], moods: [{ character: "ferry", emoji: "😒", label: "不満" }] }));
  assert.deepEqual(e.fullState().trust, { mayor: 7, ferry: 3.8 });
  // 段階が変わるなら、気分の更新が要る (3.8 + 0.4 = 4.2: 段階 3 → 4)
  e.act({ text: "失礼しました。渡し守さんのお考えを大事にしたいです。" });
  assert.match(errorsOf(e.reply({ turn: 3, lines: [line()], trust_changes: [{ character: "ferry", delta: 1 }] })), /"ferry" の信頼度が 3 → 4 に変わるターンは、その人の moods も更新/);
  must(e.reply({ turn: 3, lines: [line()], trust_changes: [{ character: "ferry", delta: 1 }], moods: calmFerry }));
  assert.deepEqual(e.fullState().trust, { mayor: 7, ferry: 4.2 });
  // AI には、小数の信頼度と打ち解けやすさが毎ターン渡る
  e.act({ text: "続けます" });
  const d = work(e).digest;
  assert.deepEqual(d.characters.map((c) => [c.id, c.trust, c.trust_level, c.openness]), [["mayor", 7, "好意的", 9], ["ferry", 4.2, "警戒", 3]]);
  assert.match(d.characters[1].openness_note, /^頑な: 良い発言 1 回では態度を変えない。.*評価の 40%/);
  // 難易度ごとの平均: 簡単 8・普通 5・難しい 3
  assert.deepEqual([DIFFICULTY_PRESETS.easy.openness, DIFFICULTY_PRESETS.normal.openness, DIFFICULTY_PRESETS.hard.openness], [8, 5, 3]);
});

test("信頼度の増減: 1 人 1 ターン ±2 まで / 1〜10 に収まる / 存在しない人・重複は不可 / 2 人同時に動かせる", () => {
  const parse = (delta: number) => replySchema.safeParse({ turn: 1, lines: [line()], trust_changes: [{ character: "mayor", delta }] }).success;
  assert.deepEqual([parse(-2), parse(2), parse(-3), parse(3)], [true, true, false, false]);
  const e = playing("お二人とも、ありがとうございます。");
  assert.match(errorsOf(reply(e, { trust_changes: [{ character: "ghost", delta: 1 }] })), /trust_changes: キャラクター "ghost"/);
  assert.match(errorsOf(reply(e, { trust_changes: [{ character: "mayor", delta: 1 }, { character: "mayor", delta: 1 }], moods: calm })), /"mayor" が重複/);
  must(reply(e, { trust_changes: [{ character: "mayor", delta: 2 }, { character: "ferry", delta: -2 }], moods: [...calm, { character: "ferry", emoji: "😠", label: "不満" }] }));
  assert.deepEqual(e.fullState().trust, { mayor: 8, ferry: 2 });
  e.act({ text: "続けます" });
  must(e.reply({ turn: 2, lines: [line()], trust_changes: [{ character: "mayor", delta: 2 }, { character: "ferry", delta: -2 }], moods: [...calm, ...calmFerry] }));
  e.act({ text: "さらに続けます" });
  must(e.reply({ turn: 3, lines: [line()], trust_changes: [{ character: "mayor", delta: 2 }, { character: "ferry", delta: -2 }], moods: [...calm, ...calmFerry] }));
  assert.deepEqual(e.fullState().trust, { mayor: 10, ferry: 1 }); // 上限 10・下限 1
});

test("信頼度は画面に出さない: 公開状態にもログにも現れず、段階が変わったターンは moods が必須", () => {
  const e = playing();
  const noMood = reply(e, { trust_changes: [{ character: "mayor", delta: 1, reason: "要約してくれた" }] });
  assert.equal(noMood.ok, false);
  assert.match(errorsOf(noMood), /"mayor" の信頼度が 6 → 7 に変わるターンは、その人の moods も更新/);
  // 気分を更新するのは、信頼度が動いた本人
  assert.match(errorsOf(reply(e, { trust_changes: [{ character: "mayor", delta: 1 }], moods: calmFerry })), /"mayor" の信頼度が 6 → 7 に変わるターン/);
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 4 }); // 失敗したので変わっていない
  assert.ok(reply(e, { trust_changes: [{ character: "mayor", delta: 1, reason: "要約してくれた" }], moods: calm, lines: [line("mayor", "そう、その通りじゃ。")] }).ok);
  const s = e.publicState();
  assert.ok(!("trust" in s) && !("maxTrust" in s));
  // 各キャラの信頼度・物わかりも送らない
  assert.deepEqual(Object.keys(s.scenario!.characters[0]).sort(), ["emoji", "id", "mood", "name", "role"]);
  assert.ok(!s.log.some((l) => /信頼/.test(l.text)), "ログに信頼度が出ている");
  assert.deepEqual(s.scenario?.characters[0].mood, { emoji: "😌", label: "安心" }); // 手がかりは気分で伝わる
  // 動かさないターンは moods 不要
  e.act({ text: "続けます" });
  assert.ok(e.reply({ turn: 2, lines: [line()] }).ok);
});

test("検討中に進めるには、プレイヤーの発言からの引用が要る", () => {
  const proposal = (quote?: string) => ({ concern_updates: [{ id: "c1", to: "proposed" as const, note: "小さな木橋にする", quote }] });

  // 引用なし / 短すぎる
  const e1 = playing(BIG);
  assert.match(errorsOf(reply(e1, proposal())), /quote が必要/);
  assert.match(errorsOf(reply(e1, proposal("木橋"))), /quote が必要/);
  // 言い換え (発言に無い文) は通らない
  const paraphrase = reply(e1, proposal("安い橋を建てる案を出した"));
  assert.equal(paraphrase.ok, false);
  assert.match(errorsOf(paraphrase), /見つかりません/);
  assert.equal(e1.phase, "ai_turn");
  // 発言のとおりなら通る。空白・改行の違いは無視して照合される
  const ok = reply(e1, proposal("小さな木橋にして 費用を\n抑え"));
  assert.ok(ok.ok, errorsOf(ok));
  assert.equal(e1.publicState().concerns[0].status, "proposed");
  // 対処案は AI だけが記録として持つ。ボードのカードには本音の内容と状態しか出さない
  assert.equal(e1.fullState().concerns?.[0].proposal, "小さな木橋にする");
  assert.ok(!JSON.stringify(e1.publicState()).includes("小さな木橋にする"), "対処案がブラウザに送られている");
  assert.deepEqual(Object.keys(e1.publicState().concerns[0]).sort(), ["category", "id", "owner", "status", "text"]);

  // 提案が無い発言 (雑談) には、発言に無い提案を作って進めることはできない
  const e2 = playing("今日はいい天気ですね。");
  assert.equal(reply(e2, proposal(Q1)).ok, false);
});

test("段階を飛ばせない (hidden→resolved) と、同一懸念の二重更新", () => {
  const e = playing(BIG);
  assert.equal(reply(e, { concern_updates: [{ id: "c1", to: "resolved", note: "これで解決した" }] }).ok, false);
  const dup = reply(e, {
    concern_updates: [
      { id: "c1", to: "revealed", asked: Q1 },
      { id: "c1", to: "proposed", note: "二重更新のテスト", quote: Q1 },
    ],
  });
  assert.equal(dup.ok, false);
  assert.match(errorsOf(dup), /複数回/);
});

test("proposed→resolved は次のターン以降 / 差し戻しもできる", () => {
  const e = playing(BIG);
  assert.ok(reply(e, { concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋にする", quote: Q1 }] }).ok);
  assert.equal(e.act({ text: "どうでしょう" }), null);
  // 解消には note が必要
  assert.equal(e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c1", to: "resolved" }] }).ok, false);
  assert.ok(e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな橋で予算内に収める" }] }).ok);
  const c1 = e.publicState().concerns[0];
  assert.equal(c1.status, "resolved");
  // 合意内容はゲーム中は送らない (終了後の合意書にだけ載る)
  assert.equal(c1.agreement, undefined);
  assert.ok(!JSON.stringify(e.publicState()).includes("小さな橋で予算内に収める"));
  assert.equal(e.fullState().concerns?.[0].agreement, "小さな橋で予算内に収める");

  // 差し戻し
  assert.equal(e.act({ text: BIG }), null);
  assert.ok(e.reply({ turn: 3, lines: [line()], concern_updates: [{ id: "c3", to: "proposed", note: "川沿いの道", quote: Q3 }] }).ok);
  assert.equal(e.act({ text: "いかがですか" }), null);
  assert.ok(e.reply({ turn: 4, lines: [line()], concern_updates: [{ id: "c3", to: "revealed", note: "川沿いの道は狭く、行列が通れない" }] }).ok);
  assert.equal(e.publicState().concerns[1].status, "revealed");
  assert.equal(e.fullState().concerns?.[2].proposal, undefined); // 差し戻しで案は取り下げられる
});

test("即決: 本音が見えた懸念は、プレイヤーの案にその場で合意できる (引用が要る / 歩み寄りでは使えない)", () => {
  const e = playing("お祭りのことを聞かせてください。");
  assert.ok(reply(e, { concern_updates: [{ id: "c3", to: "revealed", asked: "お祭りのこと" }] }).ok);
  e.act({ text: BIG });
  const instant = (u: object = {}) => e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c3", to: "resolved" as const, note: "行列は川沿いの道を通す", ...u }] });
  // 案を出したのがプレイヤーであることは、検討中に進めるときと同じく引用で確かめる
  assert.match(errorsOf(instant()), /quote が必要/);
  assert.match(errorsOf(instant({ quote: "行列の道を変える案" })), /見つかりません/);
  // 相手からの歩み寄りは、プレイヤーが受け入れるまで解消しない
  assert.match(errorsOf(instant({ quote: Q3, initiative: true, evidence: [Q3] })), /to=proposed のときだけ/);
  const r = instant({ quote: Q3 });
  assert.ok(r.ok, errorsOf(r));
  assert.equal(e.publicState().concerns[0].status, "resolved");
  assert.equal(e.fullState().concerns?.[2].agreement, "行列は川沿いの道を通す");
  assert.equal(e.fullState().concerns?.[2].proposed_by, "player");

  // 「締める」のターンでも、最後の案にその場で合意できる
  const e2 = playing("お祭りのことを聞かせてください。");
  assert.ok(reply(e2, { concern_updates: [{ id: "c3", to: "revealed", asked: "お祭りのこと" }] }).ok);
  e2.act({ text: BIG }, true);
  must(e2.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c3", to: "resolved", note: "行列は川沿いの道を通す", quote: Q3 }], epilogue: "続きはまた今度。" }));
  assert.equal(e2.phase, "ended");
  assert.equal(e2.publicState().ending?.resolved, 1);
});

test("譲れない本音は即決できず、検討中で一度確かめてから解消する", () => {
  const e = playing("費用のことが気になります。");
  assert.ok(reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "費用のこと" }] }).ok);
  e.act({ text: BIG });
  assert.match(errorsOf(e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな木橋で合意", quote: Q1 }] })), /譲れない本音.*本当にそれで大丈夫か/);
  must(e.reply({ turn: 2, lines: [line("mayor", "木橋で、本当に大水に耐えられるかのう？")], concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋にする", quote: Q1 }] }));
  e.act({ text: "毎年の点検は隣村が受け持ちます。" });
  must(e.reply({ turn: 3, lines: [line("mayor", "それなら安心じゃ。")], concern_updates: [{ id: "c1", to: "resolved", note: "小さな木橋で、点検は隣村が受け持つ" }] }));
  assert.equal(e.publicState().concerns[0].status, "resolved");
});

test("存在しない話者・懸念は拒否される", () => {
  const e = playing();
  assert.equal(reply(e, { lines: [line("ghost")] }).ok, false);
  assert.equal(reply(e, { concern_updates: [{ id: "zzz", to: "revealed" }] }).ok, false);
  assert.equal(reply(e, { moods: [{ character: "ghost", emoji: "😀", label: "x" }] }).ok, false);
});

test("「締める」で終了: epilogue が必須で、検討中に進めることはできない", () => {
  const e = started();
  e.act({ text: BIG }, true);
  assert.match(work(e).note, /「締める」/);
  assert.match(errorsOf(reply(e, { concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋にする", quote: Q1 }], epilogue: "また。" })), /「締める」のターン/);
  const noEpilogue = reply(e);
  assert.equal(noEpilogue.ok, false);
  assert.match(errorsOf(noEpilogue), /epilogue/);
  assert.ok(reply(e, { epilogue: "また日を改めて話そう。" }).ok);
  const s = e.publicState();
  assert.equal(s.phase, "ended");
  assert.equal(s.ending?.type, "carry_over");
  assert.equal(s.ending?.reason, "deferred");
  // 終了後は見つけられなかった懸念が公開される
  assert.ok(s.concerns.every((c) => c.missed && c.text));
  assert.match(e.act({ text: "まだ" }) ?? "", /終了/);
});

/**
 * 5 つの懸念を 1 ターンに 1 つずつ見つけて (提案が当たって未発見からいきなり検討中) 解消していき、
 * 最後の c2 の解消を待つ状態 (ターン 6 の返答待ち) にする。見つかる本音は 1 回の返答で 1 つまでなので、まとめては進めない
 */
function nearlyAgreed() {
  const e = playing(BIG);
  // c4 (村長) と c2・c5 (渡し守) は信頼度が要る: 村長 6→7。渡し守は頑なで +2 の評価でも 0.8 ずつなので、3 ターンかけて 4→6.4
  const r1 = reply(e, { trust_changes: [{ character: "mayor", delta: 1 }, { character: "ferry", delta: 2 }], moods: [...calm, ...calmFerry], concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋", quote: Q1 }] });
  assert.ok(r1.ok, errorsOf(r1));
  const warm = { trust_changes: [{ character: "ferry", delta: 2 }], moods: calmFerry };
  // 毎ターン、前のターンの案で合意しつつ、次の懸念に案が当たる
  const next = [["c3", "川沿いの道", Q3], ["c4", "欄干を高くする", Q4], ["c5", "工事は冬に", Q5], ["c2", "渡し賃を残す", Q2]] as const;
  let prev = "c1";
  next.forEach(([id, note, quote], i) => {
    e.act({ text: BIG });
    const r = e.reply({ turn: i + 2, lines: [line()], ...(i < 2 ? warm : {}), concern_updates: [{ id: prev, to: "resolved", note: `${prev} で合意` }, { id, to: "proposed", note, quote }] });
    assert.ok(r.ok, errorsOf(r));
    prev = id;
  });
  e.act({ text: "どうでしょう" });
  return e;
}
const resolveLast = [{ id: "c2", to: "resolved" as const, note: "c2 で合意" }];

test("1 回の返答で見つかる本音は 1 つまで (複数キャラでも、提案が当たった場合も数える)", () => {
  const e = playing("お祭りと予算のことを教えてください。");
  const two = reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "予算のことを教えて" }, { id: "c3", to: "revealed", asked: "お祭りと予算" }] });
  assert.equal(two.ok, false);
  assert.match(errorsOf(two), /見つけられる本音は 1 つまで.*c1, c3/);
  assert.equal(e.publicState().concerns.length, 0); // 何も反映されない
  // 本音 1 つ + 提案が当たって未発見からいきなり検討中、も 2 つと数える
  const e2 = playing(BIG);
  assert.match(errorsOf(reply(e2, { concern_updates: [{ id: "c3", to: "revealed", asked: Q3 }, { id: "c1", to: "proposed", note: "小さな木橋", quote: Q1 }] })), /1 つまで/);
  // 1 つなら通る。すでに見つかっている懸念の進行は数えない
  assert.ok(reply(e2, { concern_updates: [{ id: "c3", to: "revealed", asked: Q3 }] }).ok);
  e2.act({ text: BIG });
  assert.ok(e2.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c3", to: "proposed", note: "川沿いの道", quote: Q3 }, { id: "c1", to: "revealed", asked: Q1 }] }).ok);
  assert.deepEqual(e2.publicState().concerns.map((c) => [c.id, c.status]), [["c3", "proposed"], ["c1", "revealed"]]);
});

test("全懸念を解消すると完全合意で自動終了する", () => {
  const e = nearlyAgreed();
  const noEpilogue = e.reply({ turn: 6, lines: [line()], concern_updates: resolveLast });
  assert.equal(noEpilogue.ok, false);
  const done = e.reply({ turn: 6, lines: [line()], epilogue: "橋は無事にかかった。", concern_updates: resolveLast });
  assert.ok(done.ok, errorsOf(done));
  assert.equal(e.publicState().ending?.type, "full_agreement");
  // 終了後は合意書用に、何で合意したかが公開される
  assert.deepEqual(e.publicState().concerns.map((c) => c.agreement).sort(), ["c1 で合意", "c2 で合意", "c3 で合意", "c4 で合意", "c5 で合意"]);
});

test("ターン上限で終了し、半分未満の解消なら持ち帰り", () => {
  const e = new Engine();
  e.startScenario(scenario());
  const limit = e.publicState().scenario!.turnLimit;
  assert.equal(limit, 5 * 3 + 4); // 普通: 懸念 5 × 3 + 4
  for (let t = 1; t <= limit; t++) {
    assert.equal(e.act({ text: t === 1 ? BIG : `発言${t}` }), null);
    const updates = t === 1 ? [{ id: "c1", to: "proposed" as const, note: "小さな木橋にする", quote: Q1 }] : t === 2 ? [{ id: "c1", to: "resolved" as const, note: "小さな橋で合意" }] : [];
    const last = t === limit;
    const r = e.reply({ turn: t, lines: [line()], concern_updates: updates, epilogue: last ? "時間切れだ。" : undefined });
    assert.ok(r.ok, errorsOf(r));
  }
  const s = e.publicState();
  assert.equal(s.phase, "ended");
  assert.equal(s.ending?.reason, "turn_limit");
  assert.equal(s.ending?.resolved, 1);
  assert.equal(s.ending?.type, "carry_over"); // 解消した重要度 9 は、合計 31 の半分未満
  assert.deepEqual(s.ending?.importance, { resolved: 9, total: 31 });
});

test("replay: 同じシナリオで最初から (AI の手は不要) / 進行中の reply は無効になる", () => {
  const e = playing();
  assert.equal(e.replay(), null);
  const s = e.publicState();
  assert.equal(s.phase, "player_turn");
  assert.equal(s.turn, 0);
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 4 });
  assert.equal(s.log.length, 1);
  assert.equal(reply(e).ok, false); // 古い手番への返答は弾かれる
});

test("waitForWork: 仕事が来たら待っている側が起きる / タイムアウトで null", async () => {
  const e = started();
  const waiting = e.waitForWork(2000);
  setTimeout(() => e.act({ text: "予算はどのくらいですか？", to: "mayor" }), 20);
  const w = await waiting;
  assert.equal(w?.type, "player_action");
  assert.equal((w as { to: string }).to, "mayor");
  assert.ok(reply(e).ok);
  assert.equal(await e.waitForWork(30), null);
});

// ---- 終了後の振り返り ---------------------------------------------------------

/** 「締める」で終わらせた状態 (c1 だけ見つかっている) */
function endedWithOneFound() {
  const e = playing("予算はどのくらいですか？");
  assert.ok(reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "予算はどのくらい" }] }).ok);
  e.act({ text: "今日はここまでにします" }, true);
  assert.ok(e.reply({ turn: 2, lines: [line()], epilogue: "また話そう。" }).ok);
  assert.equal(e.phase, "ended");
  return e;
}
const reviewInput = (ids: string[]) => ({
  overall: "予算を丁寧に尋ねたのは良かったが、他の人の事情までは聞けなかった。",
  good: ["最初に予算を気遣って尋ねた"],
  improve: ["渡し守の暮らしにも触れてみる"],
  concerns: ids.map((id) => ({ id, advice: `${id} は、聞き方を変えれば届いたはず` })),
});

test("終了すると AI に振り返りの依頼が届く (隠し情報つき・会話の全文つき)", () => {
  const e = endedWithOneFound();
  const w = e.pendingWork();
  assert.equal(w?.type, "review");
  const r = w as Extract<Work, { type: "review" }>;
  assert.ok(r.transcript.some((t) => t.startsWith("プレイヤー: 予算はどのくらいですか？")));
  assert.ok(r.transcript.some((t) => t.startsWith("村長: ")));
  assert.equal(r.concerns.find((c) => c.id === "c2")?.reveal_hint, "渡し守の暮らしに触れる");
  assert.equal(r.concerns.find((c) => c.id === "c1")?.status, "revealed");
  assert.equal(r.ending.reason, "deferred");
  assert.equal(r.difficulty, "普通");
  assert.deepEqual(r.characters, [
    { id: "mayor", name: "村長", trust_start: 6, trust_end: 6, openness: 9, understanding: 6 },
    { id: "ferry", name: "渡し守", trust_start: 4, trust_end: 4, openness: 3, understanding: 4 },
  ]);
  // 依頼は提出されるまで同じものが返り続ける
  assert.deepEqual(e.pendingWork(), w);
  // 提出前の公開状態には振り返りが無い
  assert.equal(e.publicState().review, null);
});

test("振り返りは、解消できなかった懸念すべてに助言が要る", () => {
  const e = endedWithOneFound();
  const unresolved = ["c1", "c2", "c3", "c4", "c5"];
  assert.match(errorsOf(e.submitReview(reviewInput(["c1", "c2"]))), /未解消の懸念 "c3"/);
  assert.match(errorsOf(e.submitReview(reviewInput([...unresolved, "zzz"]))), /"zzz" は存在しない/);
  assert.match(errorsOf(e.submitReview(reviewInput([...unresolved, "c1"]))), /重複/);
  assert.equal(e.submitReview({ overall: "短い" }).ok, false);
  assert.equal(e.publicState().review, null); // 失敗しても何も反映されない

  const ok = e.submitReview(reviewInput(unresolved));
  assert.ok(ok.ok, errorsOf(ok));
  assert.equal(e.pendingWork(), null); // 依頼は消える
  const review = e.publicState().review;
  assert.equal(review?.concerns.length, 5);
  assert.match(review?.overall ?? "", /予算を丁寧に尋ねた/);
  assert.match(errorsOf(e.submitReview(reviewInput(unresolved))), /提出済み/);
});

test("振り返りは終了後だけ。解消済みの懸念には助言を付けない。replay で消える", () => {
  const playingEngine = playing();
  assert.match(errorsOf(playingEngine.submitReview(reviewInput([]))), /終了後だけ/);

  // c1 だけ解消して「締める」 → 助言が要るのは c2〜c5
  const e = playing(BIG);
  assert.ok(reply(e, { concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋", quote: Q1 }] }).ok);
  e.act({ text: "どうでしょう" });
  assert.ok(e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな橋で合意" }] }).ok);
  e.act({ text: "ここまでにしましょう" }, true);
  assert.ok(e.reply({ turn: 3, lines: [line()], epilogue: "また話そう。" }).ok);
  assert.match(errorsOf(e.submitReview(reviewInput(["c1", "c2", "c3", "c4", "c5"]))), /"c1" は存在しないか、すでに解消済み/);
  assert.ok(e.submitReview(reviewInput(["c2", "c3", "c4", "c5"])).ok);
  assert.ok(e.publicState().review);

  assert.equal(e.replay(), null);
  assert.equal(e.publicState().review, null);
  assert.equal(e.pendingWork(), null);
});

test("全部解消した完全合意でも振り返りは書く (助言は不要)", () => {
  const e = nearlyAgreed();
  assert.ok(e.reply({ turn: 6, lines: [line()], epilogue: "橋は無事にかかった。", concern_updates: resolveLast }).ok);
  assert.equal(e.pendingWork()?.type, "review");
  const ok = e.submitReview(reviewInput([]));
  assert.ok(ok.ok, errorsOf(ok));
  assert.equal(e.publicState().review?.concerns.length, 0);
});

// ---- 口調と、誘導する描写の検出 -------------------------------------------------

test("シナリオには口調 (speech / sample_lines) が要る", () => {
  const e = new Engine();
  const noSpeech = scenario();
  delete (noSpeech.characters[0] as { speech?: string }).speech;
  const r1 = e.startScenario(noSpeech);
  assert.equal(r1.ok, false);
  assert.match(errorsOf(r1), /characters\.0\.speech/);

  const oneSample = scenario();
  oneSample.characters[1].sample_lines = ["川は毎日違う。"];
  assert.match(errorsOf(e.startScenario(oneSample)), /characters\.1\.sample_lines/);
  assert.equal(e.phase, "setup");
});

test("シナリオの手本セリフや冒頭に、誘導する描写があると採用されない", () => {
  const e = new Engine();
  const bad1 = scenario();
  bad1.characters[0].sample_lines = ["そうさのう、費用のことは…（言いかけてやめる）", "あんたの話は、よう分かった。"];
  assert.match(errorsOf(e.startScenario(bad1)), /characters\[0\]\.sample_lines\[0\] に、相手を誘導する描写/);

  const bad2 = scenario();
  bad2.opening = [{ speaker: "mayor", text: "橋なら東の浅瀬がよかろう。村長は何か言いたげに口をつぐんだ。" }];
  assert.match(errorsOf(e.startScenario(bad2)), /opening\[0\] に、相手を誘導する描写/); // 複数該当するとき、報告されるのは先に見つかった表現
  assert.equal(e.phase, "setup");
});

test("返答に、隠し事を匂わせる仕草や括弧書きの動作があると差し戻される", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["narrator", "村長は何か言いかけて、口をつぐんだ。", /「言いかけ」/],
    ["narrator", "渡し守は目を伏せ、しばらく黙り込んでいる。", /「目を伏せ」/],
    ["narrator", "村長は意味ありげに微笑んだ。", /「意味ありげ」/],
    // 台詞の中に紛れた括弧書きの動作
    ["mayor", "（うつむく）そうさのう、わしは構わんが。", /誘導する描写「うつむ」/],
    ["mayor", "*ためらうように視線をそらす* さあ、どうかのう。", /誘導する描写/],
  ];
  for (const [speaker, text, expected] of cases) {
    const e = playing("お祭りのことを教えてください。");
    const r = reply(e, { lines: [line(speaker, text)] });
    assert.equal(r.ok, false, text);
    assert.match(errorsOf(r), expected, text);
    assert.equal(e.phase, "ai_turn", "差し戻されたので手番は進まない");
  }
  // 気分のラベル・締めくくりの一文にも同じ検査がかかる
  const e2 = playing();
  assert.match(errorsOf(reply(e2, { trust_changes: [{ character: "mayor", delta: 1 }], moods: [{ character: "mayor", emoji: "😶", label: "言い淀む" }] })), /moods \(mayor\) の label/);
  const e3 = started();
  e3.act({ text: "ここまでにします" }, true);
  assert.match(errorsOf(reply(e3, { epilogue: "村長は何か言いかけて口をつぐんだ。" })), /epilogue に、相手を誘導する描写/);
});

test("ふつうの台詞や、地の文での場面転換は差し戻されない (誤検出の確認)", () => {
  const natural = [
    line("mayor", "橋なら東の浅瀬がよかろう。それで決まりじゃ。"),
    line("mayor", "……稲は今、穂ばらみじゃ。ここで水を切ったら穂が出ん。"),
    line("ferry", "川は毎日違う。おれは四十年、この渡しを守ってきた。"),
    line("mayor", "ふむ…それは費用次第じゃのう。あんたはどう思う？"),
    line("narrator", "日が傾き、川面が赤く染まってきた。"),
    line("narrator", "しばらくして、二人は川岸の小屋に移った。"),
  ];
  for (const l of natural) {
    const e = playing("お話を聞かせてください。");
    const r = reply(e, { lines: [l] });
    assert.ok(r.ok, `${l.text} → ${errorsOf(r)}`);
  }
});

test("毎ターン、各キャラクターの口調の手本が AI に渡る", () => {
  const e = playing("こんにちは");
  const w = work(e);
  assert.equal(w.voices.length, 2);
  const mayor = w.voices.find((v) => v.id === "mayor");
  assert.match(mayor?.speech ?? "", /一人称は「わし」/);
  assert.deepEqual(mayor?.sample_lines, ["そうさのう、費用のことは気になるわい。", "あんたの話は、よう分かった。"]);
  // 口調の手本は AI だけが持つ。ブラウザには送らない
  const json = JSON.stringify(e.publicState());
  assert.ok(!json.includes("一人称は") && !json.includes("費用のことは気になるわい"));
});

// ---- 相手からの歩み寄り (initiative) ------------------------------------------------

const T2 = "大きな橋は村の負担が重いですよね。お祭りの行列も、道が変わると困りますよね。";
const T3 = "小さな木橋なら費用を抑えられるかもしれません。行列は川沿いの道を通せば大丈夫です。";
const T5 = "では、お祭りの行列のほうも進めましょう。";
const E1 = ["大きな橋は村の負担が重い", "小さな木橋なら費用を抑えられる"]; // c1 の根拠 (ターン 2, 3)
const E3 = ["行列は川沿いの道を通せば大丈夫", "お祭りの行列のほうも進めましょう"]; // c3 の根拠 (ターン 3, 5。c3 はターン 2 に見つかる)
const walk = (id: string, evidence: string[], note = "小さな木橋にして村の予算内に収めたい") => ({ id, to: "proposed" as const, initiative: true, evidence, note });

/**
 * c1 の本音がターン 1、c3 の本音がターン 2 に見つかり (見つかる本音は 1 回の返答で 1 つまで)、
 * プレイヤーが話を重ねた状態 (ターン 3 の返答待ち)。trustBump=false だと、村長の信頼度は初期値 6 のまま。
 */
function ripe(trustBump = true) {
  const e = started();
  e.act({ text: "村の予算はどのくらいですか？お祭りのことも聞かせてください。" });
  const r1 = e.reply({ turn: 1, lines: [line()], ...(trustBump ? up("mayor") : {}), concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算はどのくらい" }] });
  assert.ok(r1.ok, errorsOf(r1));
  e.act({ text: T2 });
  assert.ok(e.reply({ turn: 2, lines: [line()], concern_updates: [{ id: "c3", to: "revealed", asked: "お祭りの行列" }] }).ok);
  e.act({ text: T3 });
  return e;
}
const reply3 = (e: Engine, updates: NonNullable<ReplyInput["concern_updates"]>, turn = 3) => e.reply({ turn, lines: [line()], concern_updates: updates });

test("条件がそろえば、相手の側から歩み寄れる (検討中に進み、プレイヤーが受け入れたら解消)", () => {
  const e = ripe();
  const r = reply3(e, [walk("c1", E1)]);
  assert.ok(r.ok, errorsOf(r));
  assert.equal(e.publicState().concerns.find((c) => c.id === "c1")?.status, "proposed");
  assert.equal(e.fullState().concerns?.find((c) => c.id === "c1")?.proposed_by, "character");
  // 着地点 (AI の記録) はブラウザに送らない (根拠の引用はプレイヤー自身の発言なので、会話ログに載っているのは当然)
  assert.ok(!JSON.stringify(e.publicState()).includes("村の予算内に収めたい"));
  // 次のターンでプレイヤーが受け入れたら解消 (勝手には解消しない: 1 ターン 1 段階)
  e.act({ text: "ありがとうございます。ぜひそれで進めましょう。" });
  must(e.reply({ turn: 4, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな木橋にして予算内に収める" }] }));
  assert.equal(e.publicState().concerns.find((c) => c.id === "c1")?.status, "resolved");
});

test("歩み寄りの条件: 信頼度 / 別々のターンの根拠 / 発言に実在する引用", () => {
  // 本音を持つ村長の信頼度が足りない (初期値 6 のまま。普通では 7 が要る)
  assert.match(errorsOf(reply3(ripe(false), [walk("c1", E1)])), /mayor の信頼度 6 < 必要 7/);
  // 根拠が 1 つのターン (ターン 3) にしかない
  assert.match(errorsOf(reply3(ripe(), [walk("c1", ["小さな木橋なら", "費用を抑えられる"])])), /1 つのターンにしかありません/);
  // 本音が見えたターン (1) の発言は根拠にならない
  assert.match(errorsOf(reply3(ripe(), [walk("c1", ["村の予算はどのくらいですか", "小さな木橋なら費用を抑えられる"])])), /ターン 1 より後\) のプレイヤーの発言に見つかりません/);
  // 言い換えは通らない / 引用が足りない
  assert.match(errorsOf(reply3(ripe(), [walk("c1", ["橋を小さくすれば安く済む", "小さな木橋なら費用を抑えられる"])])), /見つかりません/);
  assert.match(errorsOf(reply3(ripe(), [walk("c1", ["小さな木橋なら費用を抑えられる"])])), /2 つ以上/);
  assert.match(errorsOf(reply3(ripe(), [walk("c1", [])])), /2 つ以上/);
  // 失敗したら何も変わらず、手番もそのまま
  const e = ripe();
  assert.equal(reply3(e, [walk("c1", ["橋を小さくすれば安く済む", "別の言い換え"])]).ok, false);
  assert.equal(e.phase, "ai_turn");
  assert.equal(e.publicState().concerns.find((c) => c.id === "c1")?.status, "revealed");
});

test("歩み寄りは、本音が見えていて案が無い懸念にだけ使える / 解消には使えない", () => {
  const e = ripe();
  // c4 は未発見 (hidden。持ち主の村長の信頼度は足りている)
  assert.match(errorsOf(reply3(e, [walk("c4", E1)])), /revealed.*現在 hidden/);
  // initiative は to=proposed のときだけ
  assert.match(errorsOf(reply3(e, [{ id: "c1", to: "revealed", initiative: true }])), /to=proposed のときだけ/);
  // 提案済み (proposed) の懸念は revealed ではない: 一度歩み寄ったら、同じ懸念に続けては使えない
  must(reply3(e, [walk("c1", E1)]));
  e.act({ text: "続けましょう" });
  assert.match(errorsOf(e.reply({ turn: 4, lines: [line()], concern_updates: [walk("c1", E1)] })), /proposed から proposed へ進められません/);
});

test("歩み寄りのペース: 1 回の返答で 1 つ、2 ターンに 1 回まで", () => {
  const e = ripe();
  // 同じ返答で 2 つは不可
  const two = reply3(e, [walk("c1", E1), walk("c3", E3, "行列は川沿いの道を通したい")]);
  assert.equal(two.ok, false);
  assert.match(errorsOf(two), /1 つの懸念までです/);
  // 1 つ目は通る
  must(reply3(e, [walk("c1", E1)]));
  // 直後のターンは続けて使えない (クールダウン)
  e.act({ text: "ありがとうございます。それで進めましょう。" });
  assert.match(errorsOf(e.reply({ turn: 4, lines: [line()], concern_updates: [walk("c3", E3, "行列は川沿いの道を通したい")] })), /直前のターンで歩み寄ったばかり/);
  must(e.reply({ turn: 4, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな木橋で合意" }] }));
  // 2 ターン空ければ、また使える (根拠は本音が見えた後の発言なら過去のものでもよい)
  e.act({ text: T5 });
  must(e.reply({ turn: 5, lines: [line()], concern_updates: [walk("c3", E3, "行列は川沿いの道を通したい")] }));
});

test("「締める」のターンには歩み寄れない", () => {
  const e = ripe();
  assert.ok(e.reply({ turn: 3, lines: [line()] }).ok);
  e.act({ text: "今日はここまでにします" }, true);
  assert.match(errorsOf(e.reply({ turn: 4, lines: [line()], epilogue: "また話そう。", concern_updates: [walk("c1", E1)] })), /「締める」のターン/);
});

test("差し戻された後の歩み寄りは、差し戻し以降の発言が根拠になる", () => {
  const e = ripe();
  assert.ok(reply3(e, [walk("c1", E1)]).ok); // ターン 3: 歩み寄り (since=1, 根拠はターン 2・3)
  e.act({ text: "それだと、まだ足りませんか？" });
  assert.ok(e.reply({ turn: 4, lines: [line()], concern_updates: [{ id: "c1", to: "revealed", note: "冬の備蓄まで考えたい" }] }).ok); // 差し戻し: since=4
  e.act({ text: "冬の備蓄は、橋の費用とは別に積み立てましょう。" });
  assert.ok(e.reply({ turn: 5, lines: [line()] }).ok);
  e.act({ text: "毎年の積み立てなら、負担も少なくて済みます。" });
  // 差し戻し前 (ターン 2・3) の発言だけでは根拠にならない
  const old = e.reply({ turn: 6, lines: [line()], concern_updates: [walk("c1", E1, "冬の備蓄も含めて進めたい")] });
  assert.equal(old.ok, false);
  assert.match(errorsOf(old), /ターン 4 より後/);
  // 差し戻し後 (ターン 5・6) の発言なら通る。ただしクールダウン (ターン 3 の次は 2 ターン後) は過ぎている
  assert.ok(e.reply({ turn: 6, lines: [line()], concern_updates: [walk("c1", ["冬の備蓄は、橋の費用とは別に積み立て", "毎年の積み立てなら、負担も少なくて済み"], "冬の備蓄も含めて進めたい")] }).ok);
});

test("AI に、歩み寄りに必要な条件が毎ターン渡る / 振り返りで誰の案かが分かる", () => {
  const e = ripe();
  const d = work(e).digest;
  assert.equal(d.initiative_cooldown_ok, true);
  assert.equal(d.concerns.find((c) => c.id === "c1")?.initiative_trust, 7);
  assert.equal(d.concerns.find((c) => c.id === "c4")?.initiative_trust, 8); // min_trust 7 + 1
  // 各キャラのいまの信頼度と物わかりも毎ターン渡る
  assert.deepEqual(
    d.characters.map((c) => [c.id, c.trust, c.trust_level, c.understanding]),
    [["mayor", 7, "好意的", 6], ["ferry", 4, "警戒", 4]],
  );
  assert.match(d.characters[1].understanding_note, /^悪い: 汲み取りは少なめ/);
  assert.equal(d.concerns.find((c) => c.id === "c1")?.since_turn, 1);
  assert.equal(d.concerns.find((c) => c.id === "c2")?.since_turn, undefined); // 未発見

  assert.ok(reply3(e, [walk("c1", E1)]).ok);
  e.act({ text: "ありがとうございます。それで進めましょう。" });
  assert.equal(work(e).digest.initiative_cooldown_ok, false); // 直前のターンで歩み寄った

  assert.ok(e.reply({ turn: 4, lines: [line()], concern_updates: [{ id: "c1", to: "resolved", note: "小さな木橋で合意" }] }).ok);
  e.act({ text: "ここまでにしましょう" }, true);
  assert.ok(e.reply({ turn: 5, lines: [line()], epilogue: "また話そう。" }).ok);
  const review = e.pendingWork() as Extract<Work, { type: "review" }>;
  assert.equal(review.concerns.find((c) => c.id === "c1")?.proposed_by, "character");
  assert.equal(review.concerns.find((c) => c.id === "c3")?.proposed_by, undefined);
  assert.match(review.note, /proposed_by が character/);
});

// ---- 崩れた返答の検出 (軽いモデルが引数の組み立てに失敗したとき) ----------------------------

test("台詞に JSON の切れ端が混ざった返答や、同じ台詞の重複は差し戻す", () => {
  // 実際に Gemini Flash-Lite が返した形: 同じ台詞が 4 つ並び、末尾に後ろの項目が流れ込んでいた
  const broken = "「サラの情熱も理解はしているのですがね。そこが大きな問題なんです。」}],moods:[{character:";
  const e = playing("船長の意見を聞きたい。");
  const r = reply(e, { lines: [line("mayor", broken), line("mayor", broken), line("mayor", broken), line("mayor", broken)] });
  assert.equal(r.ok, false);
  assert.match(errorsOf(r), /JSON の切れ端/);
  assert.match(errorsOf(r), /同じ台詞を繰り返さない/);
  assert.equal(e.phase, "ai_turn"); // 何も反映されない
  assert.equal(e.publicState().log.length, 2);

  // 切れ端の形いろいろ
  for (const t of ['そうですか。", "moods": [', "なるほど。}, {speaker: ferry", "はい。] , epilogue: x"]) {
    assert.match(errorsOf(reply(playing(), { lines: [line("mayor", t)] })), /JSON の切れ端/, t);
  }
  // 締めくくりの一文にも
  const e2 = started();
  e2.act({ text: "ここまでで" }, true);
  assert.match(errorsOf(reply(e2, { epilogue: "また会おう。}],moods:[" })), /epilogue に、ツール引数の JSON/);
});

test("ふつうの台詞は差し戻さない / 台詞全体のかぎ括弧は外して表示する", () => {
  const ok = ["明日の10:30に、川沿いで会おう。", "費用は 3 割ほど抑えられるかのう。", "「橋」という言葉には、思い入れがあるんじゃ。"];
  for (const t of ok) assert.ok(reply(playing(), { lines: [line("mayor", t)] }).ok, t);
  // 同じ人でも、違う台詞なら複数あってよい / 別の人の同じ台詞 (相づち) もよい
  assert.ok(reply(playing(), { lines: [line("mayor", "そうじゃな。"), line("ferry", "そうじゃな。"), line("mayor", "続けよう。")] }).ok);

  const e = playing();
  assert.ok(reply(e, { lines: [line("mayor", "「わしは、浅瀬がよいと思うておる。」")] }).ok);
  assert.equal(e.publicState().log.at(-1)?.text, "わしは、浅瀬がよいと思うておる。");
  // 文の中のかぎ括弧はそのまま
  e.act({ text: "続けます" });
  assert.ok(e.reply({ turn: 2, lines: [line("mayor", "「橋」と「渡し」、どちらも大事なんじゃ。")] }).ok);
  assert.equal(e.publicState().log.at(-1)?.text, "「橋」と「渡し」、どちらも大事なんじゃ。");
});

test("台詞の頭の名乗り (「鈴木です。」) は、最初の発言でも外す (名前は吹き出しに出る)", () => {
  const e = playing("お二人のお考えを聞かせてください。");
  // 渡し守は初めて話すが、名乗りは外す
  assert.ok(reply(e, { lines: [line("ferry", "渡し守です。川は毎日違う。"), line("ferry", "渡し守です。橋の話は、まだ早い。")] }).ok);
  e.act({ text: "続けてください" });
  assert.ok(e.reply({ turn: 2, lines: [line("mayor", "村長です。予算のことが気がかりでのう。"), line("mayor", "村長です。")] }).ok);
  const texts = e.publicState().log.filter((l) => l.from === "character").map((l) => l.text);
  assert.deepEqual(texts.slice(-4), ["川は毎日違う。", "橋の話は、まだ早い。", "予算のことが気がかりでのう。", "村長です。"]); // 名乗りしか無い台詞はそのまま
  // シナリオの冒頭の発言でも外す
  const e2 = new Engine();
  e2.startScenario({ ...scenario(), opening: [{ speaker: "mayor", text: "村長です。橋なら東の浅瀬がよかろう。" }] });
  assert.equal(e2.publicState().log[0].text, "橋なら東の浅瀬がよかろう。");
});

test("前提情報: 冒頭に公開され、隠された本音をそのまま書くと採用されない", () => {
  const e = started();
  const s = e.publicState().scenario!;
  assert.equal(s.briefing.length, 3);
  assert.deepEqual(s.briefing[0], { label: "計画", text: "県の補助で、来年度中に川へ橋を 1 本かける" });
  // 前提情報が無い・少なすぎるシナリオは採用しない
  const none = new Engine();
  assert.match(errorsOf(none.startScenario({ ...scenario(), briefing: [] })), /briefing/);
  // 本音 (c2) をそのまま前提情報に書いたら弾く
  const leak = scenario();
  leak.briefing = [...leak.briefing, { label: "渡し守", text: "実は、橋ができると渡し守の仕事がなくなる。" }];
  assert.match(errorsOf(new Engine().startScenario(leak)), /briefing\[3\] に、隠された懸念 "c2" の本音がそのまま/);
});

test("名乗りの外し方: フルネーム・空白を詰めた名前・名字のどれでも。文の途中の名前は外さない", () => {
  assert.equal(stripSelfIntro("鈴木です。お客様には約束しているんです。", "鈴木 一郎"), "お客様には約束しているんです。");
  assert.equal(stripSelfIntro("鈴木一郎です、よろしく。", "鈴木 一郎"), "よろしく。");
  assert.equal(stripSelfIntro("鈴木 一郎です！遅れました。", "鈴木 一郎"), "遅れました。");
  assert.equal(stripSelfIntro("佐藤と申します。検証は必要です。", "佐藤"), "検証は必要です。");
  assert.equal(stripSelfIntro("そうですね、鈴木です。", "鈴木 一郎"), "そうですね、鈴木です。");
  assert.equal(stripSelfIntro("鈴木さんの言う通りです。", "鈴木 一郎"), "鈴木さんの言う通りです。");
  assert.equal(stripSelfIntro("鈴木です。", "鈴木"), "鈴木です。"); // 名乗りしか無いなら残す
});

// ---- 難易度 ---------------------------------------------------------------------------

const EXTRA = [
  { id: "c6", owner: "ferry", category: "景色", text: "川辺の眺めが橋で変わってしまう", importance: 2, reveal_hint: "川辺の思い出を尋ねる", min_trust: 2, resolved_when: "眺めを残す橋の形が示される" },
  { id: "c7", owner: "mayor", category: "隣村", text: "隣村に借りを作るのが気に入らない", importance: 9, reveal_hint: "隣村との関係を尋ねる", min_trust: 5, resolved_when: "対等な関係を保つ取り決めが示される" },
];
type Fixture = ReturnType<typeof scenario> & { opening_moods?: Array<{ character: string; emoji: string; label: string }> };
/**
 * その難易度に合わせたシナリオ: 信頼度・打ち解けやすさ・物わかりは、村長が平均 + 1、渡し守が平均 - 1。
 * 懸念の数と、最初から話せる本音の数もそろえる (先頭から open_at_start 個を、持ち主の信頼度で話せるものにする)
 */
function scenarioOf(level: PresetDifficulty): Fixture {
  const s = scenario();
  const { concerns, openAtStart, trustStart, openness, understanding } = DIFFICULTY_PRESETS[level];
  const start = { mayor: trustStart + 1, ferry: trustStart - 1 };
  s.characters[0] = { ...s.characters[0], trust_start: start.mayor, openness: openness + 1, understanding: understanding + 1 };
  s.characters[1] = { ...s.characters[1], trust_start: start.ferry, openness: openness - 1, understanding: understanding - 1 };
  s.concerns = [...s.concerns, ...EXTRA].slice(0, concerns).map((c, i) => {
    const own = start[c.owner as keyof typeof start];
    return { ...c, min_trust: i < openAtStart ? Math.min(c.min_trust, own) : Math.max(c.min_trust, own + 1) };
  });
  return s;
}
function startedAt(level: PresetDifficulty, edit: (s: Fixture) => void = () => {}) {
  const e = new Engine();
  e.requestNewGame("橋の話", level);
  const s = scenarioOf(level);
  edit(s);
  const r = e.startScenario(s);
  assert.ok(r.ok, errorsOf(r));
  return e;
}

test("難易度で懸念の数が決まり、ちょうどその数でないシナリオは採用しない", () => {
  assert.deepEqual([DIFFICULTY_PRESETS.easy.concerns, DIFFICULTY_PRESETS.normal.concerns, DIFFICULTY_PRESETS.hard.concerns], [4, 5, 7]);
  const e = new Engine();
  e.requestNewGame("橋の話", "easy");
  assert.equal((e.pendingWork() as Extract<Work, { type: "new_game" }>).difficulty.concerns, 4); // AI に数が伝わる
  assert.match(errorsOf(e.startScenario(scenario())), /難易度「簡単」では、懸念はちょうど 4 個にしてください \(いま 5 個\)/);
  assert.equal(e.phase, "setup");
  assert.ok(e.startScenario(scenarioOf("easy")).ok);

  const hard = new Engine();
  hard.requestNewGame("", "hard");
  assert.match(errorsOf(hard.startScenario(scenario())), /ちょうど 7 個/);
  assert.ok(hard.startScenario(scenarioOf("hard")).ok);
  // 範囲外 (9 個) はスキーマで弾く
  const nine = scenarioOf("hard");
  nine.concerns.push({ ...EXTRA[0], id: "c8" }, { ...EXTRA[1], id: "c9" });
  const e9 = new Engine();
  e9.requestNewGame("", "hard");
  assert.match(errorsOf(e9.startScenario(nine)), /^concerns:/m);
});

test("最初の信頼度は登場人物ごと (平均は難易度の値) / 冒頭の気分はシナリオの opening_moods から / やり直しても同じ", () => {
  for (const [level, trust] of [["easy", { mayor: 8, ferry: 6 }], ["normal", { mayor: 6, ferry: 4 }], ["hard", { mayor: 3, ferry: 1 }]] as const) {
    const e = startedAt(level);
    assert.deepEqual(e.fullState().trust, trust, level);
    assert.equal(e.publicState().difficulty, level);
    assert.ok(!("trust" in e.publicState()));
  }
  // 難しい (村長 3・渡し守 1) で、どちらも最初に話せる本音が無い
  const e = new Engine();
  e.requestNewGame("", "hard");
  const noOpen = scenarioOf("hard");
  noOpen.concerns[0].min_trust = 4;
  assert.match(errorsOf(e.startScenario(noOpen)), /難易度「難しい」では、最初から話せる本音 \(min_trust が owner の trust_start 以下\) をちょうど 1 個にしてください \(いま 0 個\)/);

  const hard = startedAt("hard", (s) => (s.opening_moods = [{ character: "mayor", emoji: "😠", label: "不信感" }]));
  const moods = Object.fromEntries(hard.publicState().scenario!.characters.map((c) => [c.id, `${c.mood.emoji} ${c.mood.label}`]));
  assert.deepEqual(moods, { mayor: "😠 不信感", ferry: "😐 ふつう" }); // 指定の無い人は「ふつう」
  hard.act({ text: "こんにちは" });
  assert.ok(hard.replay() === null);
  assert.deepEqual(hard.fullState().trust, { mayor: 3, ferry: 1 });
  assert.equal(hard.publicState().difficulty, "hard");
  assert.equal(hard.publicState().scenario!.characters[0].mood.label, "不信感");
  // 冒頭の気分にも、存在しない人や誘導する言葉は使えない
  const bad = new Engine();
  bad.requestNewGame("");
  assert.match(errorsOf(bad.startScenario({ ...scenario(), opening_moods: [{ character: "ghost", emoji: "😠", label: "不信感" }] })), /opening_moods: キャラクター "ghost"/);
  assert.match(errorsOf(bad.startScenario({ ...scenario(), opening_moods: [{ character: "mayor", emoji: "😶", label: "言い淀む" }] })), /opening_moods \(mayor\) の label/);
});

test("簡単: 物わかりがよく、本音が見えた後 1 ターン向き合えば相手から歩み寄れる", () => {
  const e = startedAt("easy");
  e.act({ text: "村の予算はどのくらいですか？" });
  must(e.reply({ turn: 1, lines: [line()], concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算" }] }));
  e.act({ text: T3 });
  const w = work(e);
  assert.equal(w.difficulty, "簡単");
  // 物わかりは各キャラの値 (村長 9・渡し守 7) で伝わる
  assert.match(w.digest.characters[0].understanding_note, /^とてもよい: プレイヤーの言いたいことを好意的に汲み取る/);
  assert.match(w.digest.characters[1].understanding_note, /^よい: /);
  assert.equal(w.digest.initiative_min_turns, 1);
  assert.equal(w.digest.concerns.find((c) => c.id === "c1")?.initiative_trust, 5);
  must(e.reply({ turn: 2, lines: [line()], concern_updates: [walk("c1", ["小さな木橋なら費用を抑えられる"])] }));
  assert.equal(e.publicState().concerns[0].status, "proposed");
});

test("難しい: 物わかりが悪く打ち解けにくい。歩み寄りには高い信頼度と 3 ターン分の積み重ねが要る", () => {
  const e = startedAt("hard");
  e.act({ text: "村の予算はどのくらいですか？" });
  must(e.reply({ turn: 1, lines: [line()], concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算" }] }));
  // ターン 2〜5: 予算の話を重ねる。村長は打ち解けにくく (打ち解けやすさ 4 → 上がり幅 50%)、+2 の評価でも 1 ずつ: 信頼度 3 → 7
  [T2, T3, "木橋なら、毎年の修繕費も安く済みますね。", "村の負担が軽くなる形を探したいんです。"].forEach((text, i) => {
    e.act({ text });
    must(e.reply({ turn: i + 2, lines: [line()], ...up("mayor", 2) }));
  });
  e.act({ text: "予算の範囲で進めたいと思います。" });
  const w = work(e);
  assert.deepEqual(w.digest.characters.map((c) => [c.trust, c.openness]), [[7, 4], [1, 2]]);
  assert.match(w.digest.characters[1].openness_note, /^とても頑な: /);
  // 物わかりは村長 3・渡し守 1
  assert.match(w.digest.characters[0].understanding_note, /^悪い: /);
  assert.match(w.digest.characters[1].understanding_note, /^とても悪い: プレイヤーの言葉を字面どおりにしか受け取らず/);
  assert.equal(w.digest.initiative_min_turns, 3);
  assert.equal(w.digest.concerns.find((c) => c.id === "c1")?.initiative_trust, 8);
  // 信頼度 7 では足りない
  assert.match(errorsOf(e.reply({ turn: 6, lines: [line()], concern_updates: [walk("c1", E1)] })), /mayor の信頼度 7 < 必要 8/);
  const bump = { turn: 6, lines: [line()], ...up("mayor", 2) };
  // 信頼度 8 でも、根拠が 2 つでは足りない / 3 つあっても 2 つのターンからだけでは足りない
  assert.match(errorsOf(e.reply({ ...bump, concern_updates: [walk("c1", E1)] })), /3 つ以上、別のターンから/);
  assert.match(errorsOf(e.reply({ ...bump, concern_updates: [walk("c1", ["大きな橋は村の負担が重い", "道が変わると困り", "小さな木橋なら費用を抑えられる"])] })), /2 つのターンにしかありません.*3 ターン以上/);
  must(e.reply({ ...bump, concern_updates: [walk("c1", [...E1, "毎年の修繕費も安く済み"])] }));
  assert.equal(e.publicState().concerns[0].status, "proposed");
});

test("ターン数の上限は難易度で決まる (懸念の数 × 1 つあたりのターン数 + 4)。AI が決めた turns は使わない", () => {
  for (const [level, limit] of [["easy", 4 * 4 + 4], ["normal", 5 * 3 + 4], ["hard", 7 * 2 + 4]] as const) {
    const e = new Engine();
    e.requestNewGame("", level);
    assert.equal((e.pendingWork() as Extract<Work, { type: "new_game" }>).difficulty.turns, limit, level); // AI にも伝わる
    assert.ok(e.startScenario({ ...scenarioOf(level), turns: 99 }).ok);
    assert.equal(e.publicState().scenario!.turnLimit, limit, level);
    e.act({ text: "こんにちは" });
    assert.equal(work(e).turns_left, limit - 1);
  }
});

test("最初から話せる本音の数は難易度で決まり、ちょうどその数でないシナリオは採用しない", () => {
  const e = new Engine();
  e.requestNewGame("");
  const w = e.pendingWork() as Extract<Work, { type: "new_game" }>;
  assert.deepEqual([w.difficulty.open_at_start, w.difficulty.trust_start], [2, 5]);
  const three = scenario();
  three.concerns[3].min_trust = 2; // c1, c3, c4 が話せる
  assert.match(errorsOf(e.startScenario(three)), /ちょうど 2 個にしてください \(いま 3 個: c1, c3, c4\)。残りの min_trust は、owner の trust_start \+ 1 〜 9 にする/);
  // 話せるかどうかは持ち主の信頼度で決まる: 渡し守を 6 に上げると c2・c5 も話せる
  const ferryUp = scenario();
  ferryUp.characters[0].trust_start = 4;
  ferryUp.characters[1].trust_start = 6;
  assert.match(errorsOf(e.startScenario(ferryUp)), /いま 4 個: c1, c2, c3, c5/);
  assert.ok(e.startScenario(scenario()).ok);
});

test("登場人物の信頼度と物わかりは、平均が難易度の値 ±1 で、2 人以上なら人ごとに差がある", () => {
  const e = new Engine();
  e.requestNewGame(""); // 普通: どちらも平均 5
  const w = e.pendingWork() as Extract<Work, { type: "new_game" }>;
  assert.deepEqual([w.difficulty.trust_start, w.difficulty.understanding], [5, 5]);
  assert.deepEqual(w.difficulty.trust_levels.map((l) => `${l.range} ${l.name}`), ["1〜2 険悪", "3〜4 警戒", "5〜6 様子見", "7〜8 好意的", "9〜10 信頼"]);
  assert.equal(w.difficulty.understanding_levels.length, 5);
  const edited = (edit: (s: ReturnType<typeof scenario>) => void) => {
    const s = scenario();
    edit(s);
    return errorsOf(e.startScenario(s));
  };
  // 平均がずれている (村長 8・渡し守 7 → 平均 7.5)
  assert.match(edited((s) => ((s.characters[0].understanding = 8), (s.characters[1].understanding = 7))), /物わかり \(understanding\)の平均を 4〜6 にしてください \(いま 8, 7 で平均 7\.5\)/);
  // 全員同じ値
  assert.match(edited((s) => ((s.characters[0].understanding = 5), (s.characters[1].understanding = 5))), /物わかり \(understanding\)が全員 5 です。persona \(人柄\) に合わせて、人ごとに差をつけて/);
  assert.match(edited((s) => (s.characters[1].trust_start = 1)), /最初の信頼度 \(trust_start\)の平均を 4〜6 にしてください \(いま 6, 1 で平均 3\.5\)/);
  assert.match(edited((s) => (s.characters[1].openness = 9)), /打ち解けやすさ \(openness\)の平均を 4〜6 にしてください \(いま 9, 9 で平均 9\)/);
  // 範囲外はスキーマで弾く (信頼度は 1〜9 で始まる / 物わかりは 1〜10)
  assert.match(edited((s) => (s.characters[0].trust_start = 10)), /characters\.0\.trust_start/);
  assert.match(edited((s) => (s.characters[0].understanding = 0)), /characters\.0\.understanding/);
  assert.equal(e.phase, "setup");
  // 1 人だけなら、差は要らない (平均 = その人の値)
  const solo = scenario();
  solo.characters = [{ ...solo.characters[0], trust_start: 5, openness: 5, understanding: 5 }];
  solo.concerns = solo.concerns.map((c) => ({ ...c, owner: "mayor", min_trust: c.id === "c1" || c.id === "c3" ? c.min_trust : 7 }));
  const r = e.startScenario(solo);
  assert.ok(r.ok, errorsOf(r));
});

test("パラメータを微調整して始められる (懸念の数・話せる本音・信頼度・ターン数・物わかり・歩み寄り)", () => {
  const tuned = { ...DIFFICULTY_PRESETS.hard, concerns: 5, openAtStart: 2, nonNegotiable: 1, trustStart: 5, openness: 6, turnsPerConcern: 4, understanding: 8, initiativeTurns: 1, initiativeTrust: 2, initiativeCooldown: 1 };
  const e = new Engine();
  e.requestNewGame("", "hard", tuned);
  const brief = (e.pendingWork() as Extract<Work, { type: "new_game" }>).difficulty;
  assert.deepEqual([brief.label, brief.concerns, brief.open_at_start, brief.trust_start, brief.understanding, brief.turns], ["難しい (調整あり)", 5, 2, 5, 8, 24]);
  assert.equal(e.publicState().customized, true);
  // 物わかりの平均は、難易度ではなく調整した値 (8) に合わせる
  assert.match(errorsOf(e.startScenario(scenario())), /物わかり \(understanding\)の平均を 7〜9 にしてください/);
  const s = scenario();
  s.characters[0].understanding = 9;
  s.characters[1].understanding = 7;
  assert.ok(e.startScenario(s).ok);
  assert.deepEqual(e.fullState().trust, { mayor: 6, ferry: 4 });
  e.act({ text: "村の予算はどのくらいですか？" });
  const w = work(e);
  assert.equal(w.difficulty, "難しい (調整あり)");
  assert.match(w.digest.characters[0].understanding_note, /^とてもよい: /);
  assert.equal(w.digest.initiative_min_turns, 1);
  // 調整せずに始めたら「調整あり」は付かない
  const plain = new Engine();
  plain.requestNewGame("", "hard");
  assert.equal(plain.publicState().customized, false);
});

test("ブラウザから届いた難易度とパラメータを確かめる", () => {
  assert.deepEqual(parseDifficulty(undefined, undefined), { level: "normal", params: DIFFICULTY_PRESETS.normal });
  assert.deepEqual(parseDifficulty("hard", null), { level: "hard", params: DIFFICULTY_PRESETS.hard });
  // 一部だけ送られたら、残りはその難易度の初期値
  const r = parseDifficulty("easy", { concerns: 6, understanding: 3 });
  assert.ok(!("error" in r));
  assert.deepEqual(r.params, { ...DIFFICULTY_PRESETS.easy, concerns: 6, understanding: 3 });
  const error = (level: unknown, params: unknown) => {
    const x = parseDifficulty(level, params);
    return "error" in x ? x.error : "";
  };
  assert.match(error("nightmare", undefined), /不明な難易度/);
  assert.match(error("normal", "x"), /形式/);
  assert.match(error("normal", { concerns: 9 }), /「懸念の数」は 3〜8 の整数/);
  assert.match(error("normal", { trustStart: 1.5 }), /「最初の信頼度 \(平均\)」は 1〜9 の整数/);
  assert.match(error("normal", { trustStart: 10 }), /「最初の信頼度 \(平均\)」は 1〜9 の整数/);
  assert.match(error("normal", { initiativeTrust: "3" }), /「歩み寄りに要る信頼度」は 1〜10 の整数/);
  assert.match(error("normal", { understanding: "good" }), /「物わかり \(平均\)」は 1〜10 の整数/);
  assert.match(error("normal", { understanding: 11 }), /「物わかり \(平均\)」は 1〜10 の整数/);
  assert.match(error("normal", { concerns: 3, openAtStart: 4 }), /「最初から話せる本音の数」は「懸念の数」以下/);
  assert.match(error("normal", { nonNegotiable: 4 }), /「譲れない本音の数」は 0〜3 の整数/);
});

// ---- 本音の重要度 (要望の緩急) ------------------------------------------------------------

/**
 * ids の順に 1 ターンに 1 つずつ提案が当たって解消していき、最後は「締める」で終える。
 * 信頼度が要る本音 (村長の c4、渡し守の c2・c5) にも届くよう、最初の 3 ターンで村長 6→7・渡し守 4→6.4 にしておく
 * (渡し守は頑なで、+2 の評価でも 0.8 ずつしか上がらない)
 */
function endAfterResolving(ids: string[]) {
  const quotes: Record<string, string> = { c1: Q1, c2: Q2, c3: Q3, c4: Q4, c5: Q5 };
  const propose = (id: string) => ({ id, to: "proposed" as const, note: `${id} の案`, quote: quotes[id] });
  const e = started();
  for (let t = 1; t <= 3; t++) {
    e.act({ text: "皆さんのお考えを、もう少し聞かせてください。" });
    must(e.reply({ turn: t, lines: [line()], trust_changes: [...(t === 1 ? [{ character: "mayor", delta: 1 }] : []), { character: "ferry", delta: 2 }], moods: [...calm, ...calmFerry] }));
  }
  e.act({ text: BIG });
  must(e.reply({ turn: 4, lines: [line()], concern_updates: [propose(ids[0])] }));
  ids.forEach((id, i) => {
    const next = ids[i + 1];
    e.act({ text: BIG }, !next);
    must(e.reply({ turn: i + 5, lines: [line()], concern_updates: [{ id, to: "resolved", note: `${id} で合意` }, ...(next ? [propose(next)] : [])], epilogue: next ? undefined : "続きはまた今度。" }));
  });
  assert.equal(e.phase, "ended");
  return e.publicState().ending!;
}

test("結末は重要度で決まる: 妥協案は、譲れない本音がすべて解消し、解消した重要度が合計の半分以上のとき", () => {
  // 重要度は c1 9 (譲れない)・c2 7・c3 4・c4 6・c5 5 (合計 31)
  // 数は 2/5 でも、重要な 2 つ (9 + 7 = 16) を解消すれば妥協案で合意
  const two = endAfterResolving(["c1", "c2"]);
  assert.deepEqual([two.type, two.resolved, two.importance, two.nonNegotiableLeft], ["compromise", 2, { resolved: 16, total: 31 }, 0]);
  // 譲れない本音を解消しても、重要度が半分に届かなければ持ち帰り (9 + 4 = 13)
  assert.equal(endAfterResolving(["c1", "c3"]).type, "carry_over");
  // 4/5 を解消して重要度も半分以上 (22) でも、譲れない本音 (c1) が残ったら持ち帰り
  const four = endAfterResolving(["c3", "c4", "c2", "c5"]);
  assert.deepEqual([four.type, four.resolved, four.importance.resolved, four.nonNegotiableLeft], ["carry_over", 4, 22, 1]);
});

test("本音の重要度: ゲーム中は画面に送らない (終了後の答え合わせだけ) / AI に毎ターン渡る / 譲れない本音の数は難易度で決まる", () => {
  const e = playing("村の予算はどのくらいですか？");
  assert.deepEqual(work(e).digest.concerns.map((c) => [c.id, c.importance]), [["c1", 9], ["c2", 7], ["c3", 4], ["c4", 6], ["c5", 5]]);
  must(reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算" }] }));
  // 見つかった本音でも、相手の思いの強さ (重要度) は見えない
  assert.deepEqual(e.publicState().concerns.map((c) => [c.id, c.importance]), [["c1", undefined]]);
  assert.ok(!JSON.stringify(e.publicState()).includes("importance"));
  // 終了後は、見つけられなかった本音も含めて重要度が公開され、振り返りにも渡る
  e.act({ text: "今日はここまでにします" }, true);
  must(e.reply({ turn: 2, lines: [line()], epilogue: "また話そう。" }));
  assert.deepEqual(e.publicState().concerns.map((c) => [c.id, c.importance]), [["c1", 9], ["c2", 7], ["c3", 4], ["c4", 6], ["c5", 5]]);
  const review = e.pendingWork() as Extract<Work, { type: "review" }>;
  assert.equal(review.concerns.find((c) => c.id === "c2")?.importance, 7);
  assert.equal(review.ending.nonNegotiableLeft, 1);
  assert.match(review.note, /重要度 \(importance\) の高い本音を優先できたか/);

  // 譲れない本音 (9〜10) の数は難易度で決まる (普通 1・簡単 1・難しい 2)
  assert.deepEqual([DIFFICULTY_PRESETS.easy.nonNegotiable, DIFFICULTY_PRESETS.normal.nonNegotiable, DIFFICULTY_PRESETS.hard.nonNegotiable], [1, 1, 2]);
  const g = new Engine();
  g.requestNewGame("");
  const brief = (g.pendingWork() as Extract<Work, { type: "new_game" }>).difficulty;
  assert.equal(brief.non_negotiable, 1);
  assert.deepEqual(brief.importance_levels.map((l) => `${l.range} ${l.name}`), ["1〜2 譲ってもよい", "3〜4 できれば", "5〜6 大事", "7〜8 必ず達成したい", "9〜10 譲れない"]);
  const withImportance = (values: number[]) => {
    const s = scenario();
    s.concerns = s.concerns.map((c, i) => ({ ...c, importance: values[i] }));
    return errorsOf(g.startScenario(s));
  };
  assert.match(withImportance([9, 10, 4, 6, 5]), /これだけは譲れない本音 \(importance 9〜10\) をちょうど 1 個にしてください \(いま 2 個: c1, c2\)/);
  assert.match(withImportance([8, 7, 4, 6, 5]), /ちょうど 1 個にしてください \(いま 0 個\)。残りの importance は 1〜8 にする/);
  assert.match(withImportance([9, 5, 5, 5, 5]), /譲れない本音以外の重要度 \(importance\) が全部 5 です/);
  assert.match(withImportance([9, 7, 4, 6, 11]), /concerns\.4\.importance/);
  assert.equal(g.phase, "setup");
  assert.equal(withImportance([10, 1, 3, 8, 5]), "");
});

// ---- スコア ---------------------------------------------------------------------------------
// 普通のシナリオ: 村長 (信頼度 6・打ち解けやすさ 9・物わかり 6)、渡し守 (信頼度 4・打ち解けやすさ 3・物わかり 4)。
// 本音ごとの最高点 (引き出し + 解決): c1 18+72=90 / c2 25+67=92 / c3 8+32=40 / c4 15+48=63 / c5 18+48=66 (合計 351)。
// 完全合意ボーナスは 2 割 (70) で、満点は 421

test("スコアの難しさ: 打ち解けるまで話さない本音ほど (持ち主が頑なほど) 引き出しが、物わかりが悪く信頼されていない相手ほど解決が難しい", () => {
  assert.equal(discoverRate(1, 6, 9), 100); // 最初から話せる
  assert.equal(discoverRate(6, 4, 10), 150); // 信頼度を 2 上げないと話さない (1 段 +25%)
  assert.equal(discoverRate(6, 4, 3), 178); // 持ち主が頑な (打ち解けやすさ 3) なら 1 段 +39%
  assert.equal(discoverRate(9, 1, 1), 444);
  assert.equal(resolveRate(10, 10), 100);
  assert.equal(resolveRate(6, 6), 160);
  assert.equal(resolveRate(1, 1), 235);
});

test("スコア: 重要な本音を手ごわい相手から引き出し、解決するほど高い / ランクは満点に対する割合", () => {
  // 妥協案 (c1・c2 を解決、ほかは見つけられなかった): 90 + 92 = 182 点 (43%)
  const two = endAfterResolving(["c1", "c2"]).score;
  assert.deepEqual([two.total, two.max, two.percent, two.rank, two.bonus], [182, 421, 43, "C", 0]);
  const c2 = two.items.find((x) => x.id === "c2")!;
  assert.deepEqual([c2.discovered, c2.resolved, c2.discoverRate, c2.resolveRate, c2.discoverPoints, c2.resolvePoints], [true, true, 178, 190, 25, 67]);
  assert.deepEqual(two.items.find((x) => x.id === "c3"), { id: "c3", importance: 4, discovered: false, resolved: false, discoverRate: 100, resolveRate: 160, discoverPoints: 0, resolvePoints: 0, maxPoints: 40 });
  // 完全合意: すべての点 + ボーナス 2 割で満点
  const e = nearlyAgreed();
  must(e.reply({ turn: 6, lines: [line()], epilogue: "橋は無事にかかった。", concern_updates: resolveLast }));
  const full = e.publicState().ending!.score;
  assert.deepEqual([full.total, full.bonus, full.percent, full.rank], [421, 70, 100, "S"]);
  // 引き出しただけ (c1 を見つけて持ち帰り): 引き出し点 18 だけ
  const one = endedWithOneFound().publicState().ending!.score;
  assert.deepEqual([one.total, one.rank], [18, "D"]);
  assert.deepEqual(one.items.find((x) => x.id === "c1"), { id: "c1", importance: 9, discovered: true, resolved: false, discoverRate: 100, resolveRate: 160, discoverPoints: 18, resolvePoints: 0, maxPoints: 90 });
});

test("スコア: 同じ結果でも、相手が手ごわいほど点が高い / 振り返りを書く AI にも渡る", () => {
  const statuses = ["resolved", "resolved", "hidden", "hidden", "hidden"] as const;
  const base = scoreGame(scenario() as Scenario, [...statuses]);
  // 渡し守がもっと頑固 (物わかり 4 → 2) で、渡し賃の本音も打ち解けにくい (min_trust 6 → 8) とき
  const tough = scenario();
  tough.characters[1].understanding = 2;
  tough.concerns[1].min_trust = 8;
  const hard = scoreGame(tough as Scenario, [...statuses]);
  const c2 = (g: typeof base) => g.items.find((x) => x.id === "c2")!;
  assert.deepEqual([c2(base).discoverPoints, c2(base).resolvePoints], [25, 67]);
  assert.deepEqual([c2(hard).discoverPoints, c2(hard).resolvePoints], [36, 74]); // 7×2×256% / 7×5×210%
  assert.ok(hard.total > base.total);

  const e = endedWithOneFound();
  const review = e.pendingWork() as Extract<Work, { type: "review" }>;
  assert.equal(review.ending.score.total, 18);
  assert.match(review.note, /ending\.score はエンジンが出したスコア/);
});

// ---- 難易度: ランダム ------------------------------------------------------------------------

/** 決まった順に値を返す乱数 (0 以上 1 未満)。尽きたら最後の値をくり返す */
const sequence = (...values: number[]) => () => (values.length > 1 ? values.shift()! : values[0]);

test("ランダム: 各パラメータを範囲の中から選ぶ (最初から話せる本音・譲れない本音は懸念の数まで)", () => {
  const lows = randomParams(sequence(0));
  const highs = randomParams(sequence(0.9999));
  for (const key of Object.keys(PARAM_SPECS) as Array<keyof DifficultyParams>) {
    assert.equal(lows[key], PARAM_SPECS[key].min, `${key} の最小`);
    assert.equal(highs[key], PARAM_SPECS[key].max, `${key} の最大`);
  }
  // 懸念が 3 つなら、最初から話せる本音・譲れない本音も 3 つまで
  const few = randomParams(sequence(0, 0.9999));
  assert.deepEqual([few.concerns, few.openAtStart, few.nonNegotiable], [3, 3, 3]);
  // 本物の乱数でも、いつも範囲内 (ブラウザから届いたパラメータと同じ検査を通る) で、値はばらつく
  const draws = Array.from({ length: 300 }, () => randomParams());
  for (const p of draws) assert.deepEqual(parseDifficulty("normal", p), { level: "normal", params: p });
  assert.ok(new Set(draws.map((p) => p.concerns)).size >= 4);
  assert.ok(new Set(draws.map((p) => p.understanding)).size >= 6);
});

test("ランダム: 始めるたびに決まり、AI に伝わる / 調整扱いにはならない / 何が選ばれたかは終了後にだけ見られる", () => {
  // ブラウザから届いたパラメータは使わず、ここで決める
  const parsed = parseDifficulty("random", { concerns: 99 });
  assert.ok(!("error" in parsed), JSON.stringify(parsed));
  assert.equal(parsed.level, "random");
  assert.ok(parsed.params.concerns >= 3 && parsed.params.concerns <= 8);

  const e = new Engine();
  e.requestNewGame("", "random");
  const brief = (e.pendingWork() as Extract<Work, { type: "new_game" }>).difficulty;
  assert.deepEqual([brief.level, brief.label], ["random", "ランダム"]);
  assert.equal(e.publicState().customized, false);
  assert.equal(e.publicState().params, null);

  // 選ばれた値 (ここでは普通と同じ値) に従ってシナリオを作れば始まる
  const picked = { ...DIFFICULTY_PRESETS.normal };
  const g = new Engine();
  g.requestNewGame("", "random", picked);
  assert.ok(g.startScenario(scenario()).ok);
  assert.deepEqual([g.publicState().difficulty, g.publicState().customized, g.publicState().params], ["random", false, null]); // ゲーム中は見えない
  g.act({ text: "今日はここまでにします" }, true);
  assert.equal(work(g).difficulty, "ランダム");
  must(g.reply({ turn: 1, lines: [line()], epilogue: "また話そう。" }));
  assert.deepEqual(g.publicState().params, picked); // 終了後の答え合わせ
  // 同じシナリオでやり直しても、同じ値のまま
  assert.equal(g.replay(), null);
  assert.equal(g.publicState().scenario!.turnLimit, 5 * 3 + 4);
});

// ---- 公開に向けた安全対策 -----------------------------------------------------------------

test("チャットに API キーらしい文字列を貼ったら送らない (会話として AI の会社に送られてしまうため)", () => {
  const e = started();
  const fakes = ["sk-ant-api03-" + "x".repeat(30), "sk-proj-" + "A".repeat(30), "AIza" + "B".repeat(35), "AQ." + "C".repeat(30)];
  for (const key of fakes) assert.match(e.act({ text: `このキーです: ${key}` }) ?? "", /キーは「AI の設定」でだけ入力してください/, key.slice(0, 6));
  assert.match(e.act({ text: fakes[0] }, true) ?? "", /API キー/); // 「締める」の別れのひとことでも
  assert.equal(e.phase, "player_turn");
  assert.equal(e.publicState().turn, 0); // 何も送られていない
  // 似ているだけのふつうの文は通る
  assert.equal(e.act({ text: "sk-8 という部品と、AIza という店の話です。" }), null);
});

test("AI の出力に URL や、秘密情報の入力・共有を求める文面があれば差し戻す", () => {
  const bad = [
    "詳しくは https://example.com を見てくれ。",
    "www.example.jp に書いてある。",
    "manereco.jp で確認できます。",
    "続けるには、APIキーを入力してください。",
    "パスワードを教えてもらえますか。",
    "これを使って: sk-proj-" + "A".repeat(30),
  ];
  for (const t of bad) {
    const e = playing();
    assert.match(errorsOf(reply(e, { lines: [line("mayor", t)] })), /lines\[0\] に(URL|秘密情報の入力や共有を求める文面|API キーらしい文字列)が含まれています/, t);
    assert.equal(e.phase, "ai_turn");
  }
  // 語として出るだけなら通す (IT が題材のシナリオなど)
  for (const t of ["APIキーの管理が、いちばんの課題なんです。", "パスワードの使い回しは禁止されています。", "バージョン3.5 では直っている。"]) {
    assert.ok(reply(playing(), { lines: [line("mayor", t)] }).ok, t);
  }
  // 締めくくり・シナリオ・振り返りにも同じ検査をかける
  const e = started();
  e.act({ text: "ここまでで" }, true);
  assert.match(errorsOf(reply(e, { epilogue: "続きは https://example.com で。" })), /epilogue にURL/);
  const sc = new Engine();
  sc.requestNewGame("");
  assert.match(errorsOf(sc.startScenario({ ...scenario(), premise: "村に橋をかける話。詳しくは www.example.jp を参照。" })), /premise にURL/);
  assert.match(errorsOf(sc.startScenario({ ...scenario(), opening: [{ speaker: "mayor", text: "まずは、あんたのパスワードを教えてくれんか。" }] })), /opening\[0\] に秘密情報/);
  const done = endedWithOneFound();
  assert.match(errorsOf(done.submitReview({ ...reviewInput(["c1", "c2", "c3", "c4", "c5"]), overall: "よく聞けていました。次は example.com の記事も参考に。" })), /overall にURL/);
});

test("まだ見つかっていない本音を台詞でほぼそのまま話したら差し戻す (本音が見つかったことにするなら通る)", () => {
  // c1 の本音: 村の蓄えが少なく大きな橋は作れない
  const leak = line("mayor", "正直に言うと、村の蓄えが少なくて、大きな橋は作れないんじゃ。");
  const e = playing("村の予算はどのくらいですか？");
  assert.match(errorsOf(reply(e, { lines: [leak] })), /lines\[0\] に、まだ見つかっていない本音 "c1" がほぼそのまま出ています/);
  assert.ok(reply(e, { lines: [leak], concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算" }] }).ok);
  // 一度見つかった本音は、何度話してもよい
  e.act({ text: "やはり予算ですね" });
  assert.ok(e.reply({ turn: 2, lines: [leak] }).ok);
  // 言い換えや、話題に触れるだけなら差し戻さない
  for (const t of ["蓄えが心もとないからのう、立派な橋はちと無理じゃ。", "橋の大きさは、費用次第じゃな。"]) assert.ok(reply(playing(), { lines: [line("mayor", t)] }).ok, t);
  // シナリオの冒頭で本音を話してしまうのも採用しない
  const sc = new Engine();
  sc.requestNewGame("");
  assert.match(errorsOf(sc.startScenario({ ...scenario(), opening: [{ speaker: "mayor", text: "実は祭りの行列の道筋が変わってしまうのが困るんじゃ。" }] })), /opening\[0\] に、隠された懸念 "c3"/);
});

test("本音の漏れの判定: 間に字が入っただけの漏れは拾い、言い換えは拾わない", () => {
  const secret = "村の蓄えが少なく大きな橋は作れない";
  assert.ok(leaksSecret("村の蓄えが少なく大きな橋は作れない", secret));
  assert.ok(leaksSecret("村の蓄えが少なくて、大きな橋は作れないのじゃ", secret));
  assert.ok(!leaksSecret("蓄えが心もとないからのう、立派な橋はちと無理じゃ", secret));
  assert.ok(!leaksSecret("村の蓄えのことは、また今度話そう", secret)); // 一部 (「村の蓄え」) だけでは漏れとみなさない
  assert.ok(leaksSecret("赤字です", "赤字")); // 4 文字以下の本音は、そのまま含まれていたら
});

// ---- しゃべりすぎを防ぐ ---------------------------------------------------------------------

test("本音を話すのは、プレイヤーがその話題に触れたときだけ (きっかけの発言を引用させる)", () => {
  const e = playing("こんにちは。今日はよろしくお願いします。");
  // きっかけの引用が無い / 発言に無い (話題に触れていない) なら、本音は出せない
  assert.match(errorsOf(reply(e, { concern_updates: [{ id: "c1", to: "revealed" }] })), /revealed にするには asked が必要/);
  assert.match(errorsOf(reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "予算はどのくらい" }] })), /asked がプレイヤーの今回の発言に見つかりません/);
  assert.match(errorsOf(reply(e, { concern_updates: [{ id: "c1", to: "revealed", asked: "よろ" }] })), /4 文字以上/); // 短すぎる引用
  assert.equal(e.publicState().concerns.length, 0);
  // 話題に触れていれば出せる (空白の違いは無視)
  const e2 = playing("村の予算は、どのくらいですか？");
  assert.ok(reply(e2, { concern_updates: [{ id: "c1", to: "revealed", asked: "村の予算は、どの くらい" }] }).ok);
  // 差し戻し (proposed → revealed) や、提案が当たったとき (hidden → proposed は quote で確かめる) には要らない
  const e3 = playing(BIG);
  assert.ok(reply(e3, { concern_updates: [{ id: "c1", to: "proposed", note: "小さな木橋", quote: Q1 }] }).ok);
});

test("しゃべりすぎの返答は差し戻す (台詞の長さ・数、しゃべる人数、地の文)", () => {
  const long = "そうさのう。" + "あの橋のことは、わしも昔からずっと考えておってな。".repeat(5);
  const cases: Array<[Partial<ReplyInput>, RegExp]> = [
    [{ lines: [line("mayor", long)] }, /lines\[0\] の台詞が長すぎます \(\d+ 文字 > 120\)/],
    [{ lines: [line("mayor", "あ".repeat(100)), line("ferry", "い".repeat(100)), line("mayor", "う".repeat(60))] }, /合計 260 文字 > 240/],
    [{ lines: [line("mayor", "ふむ。"), line("ferry", "そうか。"), line("mayor", "続けよう。"), line("ferry", "ああ。")] }, /台詞は 1 回の返答で 3 つまで/],
    [{ lines: [line("mayor", "ふむ。"), line("narrator", "日が傾いた。"), line("narrator", "風が吹いた。")] }, /地の文 \(narrator\) は 1 回の返答で 1 つまで/],
    [{ lines: [line("narrator", "日が傾き、" + "川面が赤く染まってきた。".repeat(8))] }, /地の文が長すぎます/],
  ];
  for (const [r, expected] of cases) {
    const e = playing("橋のことを聞かせてください。");
    assert.match(errorsOf(reply(e, r)), expected);
    assert.equal(e.phase, "ai_turn");
  }
  // 3 人目がしゃべったら多すぎる
  const three = new Engine();
  three.requestNewGame("");
  const sc = scenario();
  sc.characters.push({ ...sc.characters[1], id: "smith", name: "鍛冶屋", emoji: "⚒️" });
  assert.ok(three.startScenario(sc).ok);
  three.act({ text: "皆さんのご意見を聞かせてください。" });
  assert.match(errorsOf(three.reply({ turn: 1, lines: [line("mayor", "ふむ。"), line("ferry", "おれは反対だ。"), line("smith", "わしは賛成だ。")] })), /しゃべるのは 2 人までです \(今回 3 人\)/);
  // 上限の内側なら通る
  assert.ok(reply(playing(), { lines: [line("mayor", "あ".repeat(120)), line("ferry", "い".repeat(120)), line("narrator", "日が傾いた。")] }).ok);
});

