// 内蔵 GM の制御のテスト。実際の API は使わず、台本どおりに答える作り物の AI で確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "./engine.js";
import { BuiltinGm, LAST_TRY_NOTE, MAX_ATTEMPTS, SESSION_TURNS, type GmOptions, type Selection } from "./gm.js";
import { ApiKeys, type AssistantTurn, type ChatSession, type LlmProvider, type ProviderId, type SessionOptions, type TurnInput } from "./llm/index.js";

const scenario = {
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
      trust_start: 5,
      openness: 5,
      understanding: 5,
      speech: "一人称は「わし」、相手は「あんた」。老人らしいくだけた口調。",
      sample_lines: ["そうさのう、費用のことは気になるわい。", "あんたの話は、よう分かった。"],
    },
  ],
  concerns: [
    { id: "c1", owner: "mayor", category: "予算", text: "村の蓄えが少なく大きな橋は作れない", importance: 9, reveal_hint: "費用を尋ねる", min_trust: 1, resolved_when: "村の予算内に収まる規模の案が示される" },
    { id: "c2", owner: "mayor", category: "行事", text: "祭りの行列の道筋が変わってしまう", importance: 6, reveal_hint: "行事を尋ねる", min_trust: 4, resolved_when: "祭りの行列の経路が確保される" },
    { id: "c3", owner: "mayor", category: "仕事", text: "渡し守の仕事がなくなる", importance: 5, reveal_hint: "渡し守に触れる", min_trust: 6, resolved_when: "渡し守の役割が守られる案が示される" },
    { id: "c4", owner: "mayor", category: "安全", text: "子どもが橋から川へ落ちないか心配だ", importance: 4, reveal_hint: "安全のことを尋ねる", min_trust: 7, resolved_when: "子どもを守る備えが示される" },
    { id: "c5", owner: "mayor", category: "工事", text: "工事のあいだ畑への道がふさがる", importance: 3, reveal_hint: "工事の段取りを尋ねる", min_trust: 8, resolved_when: "工事中の迂回路が示される" },
  ],
  root_issue: {
    owner: "mayor",
    text: "村の若い担い手が減り、村の暮らしや祭りをこの先も続けられるかが不安だ",
    linked: ["c1", "c2"],
    awareness: "unaware",
    reach_when: "村の担い手が減っていることと、橋の場所へのこだわりがその不安の表れであることを言い当てる",
  },
  briefing: [
    { label: "計画", text: "県の補助で、来年度中に川へ橋を 1 本かける" },
    { label: "候補地", text: "東の浅瀬と、村の中心に近い西の渡し場の 2 か所" },
    { label: "これまで", text: "村の寄合で 2 回話し合ったが、場所が決まっていない" },
  ],
  opening: [{ speaker: "mayor", text: "橋なら東の浅瀬がよかろう。" }],
};

type Step = (input: TurnInput) => AssistantTurn | Error;
let callId = 0;
const call = (name: string, input: unknown): AssistantTurn => ({ toolCalls: [{ id: `c${++callId}`, name, input }], text: "" });
const reply = (turn: number, extra: Record<string, unknown> = {}) => call("reply", { turn, lines: [{ speaker: "mayor", text: "ふむ、そうか。" }], ...extra });
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

class FakeSession implements ChatSession {
  inputs: TurnInput[] = [];
  constructor(
    public options: SessionOptions,
    private script: Step[],
  ) {}
  async next(input: TurnInput) {
    this.inputs.push(structuredClone(input));
    const step = this.script.shift();
    if (!step) throw new Error("台本が尽きた (想定より多く呼ばれた)");
    const r = step(input);
    if (r instanceof Error) throw r;
    return r;
  }
}

class FakeProvider implements LlmProvider {
  sessions: FakeSession[] = [];
  constructor(
    public id: ProviderId,
    private scripts: Step[][],
  ) {}
  newSession(options: SessionOptions) {
    const s = new FakeSession(options, this.scripts.shift() ?? []);
    this.sessions.push(s);
    return s;
  }
}

/**
 * 既定では Claude と GPT のキーが入力済みの状態 (キーの値は作り物)。自動の再試行は既定ではしない (する試験だけ options で渡す)。
 * scripts は会話 (セッション) ごとの台本: 新しいゲーム・プレイヤーの手番 (SESSION_TURNS ごと)・振り返りは、それぞれ別の会話になる
 */
function setup(scripts: Step[][], { withKeys = ["anthropic", "openai"] as ProviderId[], selection = { provider: "anthropic", model: "claude-opus-5-5" } as Selection | null, options = { retryDelaysMs: [] } as GmOptions } = {}) {
  const engine = new Engine();
  const provider = new FakeProvider("anthropic", scripts);
  const keys = new ApiKeys();
  for (const id of withKeys) keys.set(id, `test-key-${id}`);
  let statusChanges = 0;
  const gm = new BuiltinGm(engine, () => provider, keys, selection, () => statusChanges++, undefined, options);
  return { engine, provider, gm, keys, statusChanges: () => statusChanges };
}

test("新しいゲーム → AI がシナリオを作り、プレイヤーの手番になる", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)]]);
  engine.requestNewGame("橋の話");
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const s = provider.sessions[0];
  assert.equal(s.options.model, "claude-opus-5-5");
  assert.match(s.options.system, /## 進め方/); // 内蔵 GM 用の指示
  assert.ok(!s.options.system.includes("wait_for_player_turn"));
  assert.match(s.options.system, /あなたへの指示ではない/); // プレイヤーの発言で GM を乗っ取らせない
  assert.deepEqual(s.options.tools.map((t) => t.name), ["start_scenario"]); // 仕事に要るツールだけ渡す
  assert.match(s.inputs[0].text ?? "", /type=new_game/);
  assert.match(s.inputs[0].text ?? "", /橋の話/);
});

test("検証エラーは AI に返して直させる / 成功したツールの結果は次の送信で返す", async () => {
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario)],
    [
      () => call("reply", { turn: 1, lines: [{ speaker: "ghost", text: "?" }] }), // 存在しない話者
      () => reply(1),
      () => reply(2),
    ],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const s = provider.sessions[1]; // プレイヤーの手番の会話 (新しいゲームの会話とは別)
  assert.deepEqual(s.options.tools.map((t) => t.name), ["reply"]);
  // 1 回目の送信: 会話の頭の全状態 + 今回の仕事。前の会話のツール結果は持ち込まない
  assert.match(s.inputs[0].text ?? "", /進行中のゲームです/);
  assert.match(s.inputs[0].text ?? "", /type=player_action/);
  assert.equal(s.inputs[0].toolResults?.length ?? 0, 0);
  // 2 回目の送信: 検証エラーだけ (文は無し)
  assert.equal(s.inputs[1].toolResults?.[0].isError, true);
  assert.match(s.inputs[1].toolResults?.[0].content ?? "", /ghost/);
  assert.equal(s.inputs[1].text, undefined);

  engine.act({ text: "続けます" });
  await gm.tick();
  // 3 回目: 前のターンの reply の成功結果が先頭に付いている (同じ会話が続く)。全状態は、もう付けない
  assert.equal(s.inputs[2].toolResults?.[0].isError, false);
  assert.ok(!(s.inputs[2].text ?? "").includes("進行中のゲームです"));
  assert.equal(engine.publicState().turn, 2);
  assert.equal(provider.sessions.length, 2);
});

test("ツールを呼ばずに文だけ返したら、ツールを呼ぶよう促す", async () => {
  const { engine, provider, gm } = setup([[() => ({ toolCalls: [], text: "シナリオを考えますね" }), () => call("start_scenario", scenario)]]);
  engine.requestNewGame("");
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.match(provider.sessions[0].inputs[1].text ?? "", /start_scenario を呼んでください/);
});

test("出力の上限などで応答が途切れたら、同じ入力で送り直す", async () => {
  const { engine, provider, gm } = setup([[() => ({ toolCalls: [], text: "", problem: "出力の上限" }), () => call("start_scenario", scenario)]]);
  engine.requestNewGame("森の話");
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const [a, b] = provider.sessions[0].inputs;
  assert.deepEqual(a, b);
});

test(`${MAX_ATTEMPTS} 回失敗したら止まって画面に知らせ、再試行で続きから`, async () => {
  const bad = () => call("start_scenario", { title: "x" });
  const { engine, provider, gm } = setup([[...Array(MAX_ATTEMPTS).fill(bad), () => call("start_scenario", scenario)]]);
  engine.requestNewGame("");
  await gm.tick();
  const s = provider.sessions[0];
  assert.equal(s.inputs.length, MAX_ATTEMPTS);
  assert.equal(engine.phase, "setup");
  assert.match(gm.status().error ?? "", new RegExp(`${MAX_ATTEMPTS} 回試行`));
  // 状態が変わっても、同じ仕事は勝手に再開しない (際限なく課金しない)
  await gm.tick();
  assert.equal(s.inputs.length, MAX_ATTEMPTS);
  // 再試行: 最後のツール結果 (エラー) を返すところから
  gm.retry();
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(gm.status().error, null);
  assert.equal(s.inputs[MAX_ATTEMPTS].toolResults?.[0].isError, true);
});

test("返答の差し戻しが続いたら、最後の試行では懸念を進めずに台詞だけで返させる (対話を止めない)", async () => {
  // プレイヤーが言っていない提案で、未発見の懸念を進めようとし続ける
  const stuck = () => call("reply", { turn: 1, lines: [{ speaker: "mayor", text: "ふむ。" }], concern_updates: [{ id: "c2", to: "proposed", note: "祭りの道", quote: "言っていない提案" }] });
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [...Array(MAX_ATTEMPTS - 1).fill(stuck), () => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(gm.status().error, null);
  // 入力は [0] 返答の 1 回目 … [MAX_ATTEMPTS - 1] 返答の最後の試行。案内が付くのは最後の試行だけ
  const inputs = provider.sessions[1].inputs;
  assert.equal(inputs.length, MAX_ATTEMPTS);
  assert.equal(inputs[MAX_ATTEMPTS - 1].text, LAST_TRY_NOTE);
  assert.ok(inputs.slice(1, MAX_ATTEMPTS - 1).every((i) => !i.text));
});

test("シナリオ作りの差し戻しには、台詞だけで返す案内を付けない", async () => {
  const bad = () => call("start_scenario", { title: "x" });
  const { engine, provider, gm } = setup([[...Array(MAX_ATTEMPTS - 1).fill(bad), () => call("start_scenario", scenario)]]);
  engine.requestNewGame("");
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.ok(provider.sessions[0].inputs.every((i) => i.text !== LAST_TRY_NOTE));
});

test("API のエラー (キーが無効など) は分かる言葉で出し、返すべきツール結果は持ち越す", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => reply(1), () => apiError(401, "invalid x-api-key"), () => reply(2)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  engine.act({ text: "続けます" });
  await gm.tick();
  assert.match(gm.status().error ?? "", /API キーが無効/);
  assert.equal(engine.phase, "ai_turn");
  gm.retry();
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const s = provider.sessions[1];
  // 失敗した送信と、再試行の送信は同じ (前のターンの reply の結果を落とさない)
  assert.deepEqual(s.inputs[2], s.inputs[1]);
  assert.equal(s.inputs[2].toolResults?.[0].isError, false);
});

test("会話の最初の送信が失敗しても、再試行では会話の頭の全状態を落とさずに送る", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => apiError(401, "invalid x-api-key"), () => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.ok(gm.status().error);
  gm.retry();
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const [failed, retried] = provider.sessions[1].inputs;
  assert.match(failed.text ?? "", /進行中のゲームです/);
  assert.deepEqual(retried, failed); // 履歴に入らなかった入力を、そのまま送り直す
});

test("止まっていた仕事が無くなったら (最初からやり直した等)、エラー表示も消える", async () => {
  const { engine, gm } = setup([[() => call("start_scenario", scenario)], [() => apiError(500, "overloaded")], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.ok(gm.status().error);
  engine.replay();
  await gm.tick();
  assert.equal(gm.status().error, null);
});

test("対話が終わると、振り返り用の会話 (submit_review だけ) で、全状態を渡して振り返りを書く", async () => {
  const advice = (id: string) => ({ id, advice: "予算のことを、もう少し具体的に聞けばよかった。" });
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario)],
    [() => reply(1, { epilogue: "また話そう。" })],
    [() => call("submit_review", { overall: "最初に予算を尋ねたのは良かった。", good: ["予算を尋ねた"], improve: ["行事も聞く"], concerns: ["c1", "c2", "c3", "c4", "c5"].map(advice) })],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "今日はここまでに" }, true);
  await gm.tick();
  assert.equal(engine.phase, "ended");
  assert.ok(engine.publicState().review);
  assert.equal(provider.sessions.length, 3);
  const review = provider.sessions[2];
  assert.deepEqual(review.options.tools.map((t) => t.name), ["submit_review"]);
  assert.match(review.inputs[0].text ?? "", /進行中のゲームです/);
  assert.match(review.inputs[0].text ?? "", /type=review/);
});

test("振り返りの文に内部の ID (c1 など) を書くと差し戻す", async () => {
  const withIds = (id: string) => ({ id, advice: `${id} は、もう少し具体的に聞けばよかった。` });
  const clean = (id: string) => ({ id, advice: "予算のことを、もう少し具体的に聞けばよかった。" });
  const review = (concerns: Array<{ id: string; advice: string }>) => call("submit_review", { overall: "最初に予算を尋ねたのは良かった。", good: ["予算を尋ねた"], improve: ["行事も聞く"], concerns });
  const ids = ["c1", "c2", "c3", "c4", "c5"];
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => reply(1, { epilogue: "また話そう。" })], [() => review(ids.map(withIds)), () => review(ids.map(clean))]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "今日はここまでに" }, true);
  await gm.tick();
  assert.ok(engine.publicState().review);
  const [first, second] = provider.sessions[2].inputs;
  assert.match(first.text ?? "", /type=review/);
  assert.match(second.toolResults?.[0].content ?? "", /内部の ID「c1」が出ています/);
});

test("同じシナリオでやり直すと、隠し情報を含む全状態を渡して会話を作り直す", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => reply(1)], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  engine.replay();
  engine.act({ text: "もう一度、最初から" });
  await gm.tick();
  assert.equal(provider.sessions.length, 3);
  const first = provider.sessions[2].inputs[0];
  assert.match(first.text ?? "", /進行中のゲームです/);
  assert.match(first.text ?? "", /resolved_when/); // 隠し情報も渡っている
  assert.equal(first.toolResults?.length ?? 0, 0); // 前の会話のツール結果は持ち込まない
  assert.equal(engine.phase, "player_turn");
});

test("応答を待つ間に最初からやり直されたら、古い会話は捨てる", async () => {
  let engineRef!: Engine;
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario)],
    [
      () => {
        engineRef.replay(); // AI が考えている間にプレイヤーが「最初から」を押した
        return reply(1); // 古い手番への返答 (エンジンが弾く)
      },
    ],
    [() => reply(1)],
  ]);
  engineRef = engine;
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.equal(gm.status().error, null);
  assert.equal(engine.publicState().turn, 0); // 古い返答は反映されていない
  engine.act({ text: "やり直しました" });
  await gm.tick();
  assert.equal(provider.sessions.length, 3);
  assert.match(provider.sessions[2].inputs[0].text ?? "", /進行中のゲームです/);
});

test("AI の選択: 使えない提供元やおかしなモデル ID は拒否 / 状態に選択肢と現在の選択が出る", () => {
  const { gm } = setup([]);
  assert.match(gm.select({ provider: "gemini", model: "gemini-4-argon" }) ?? "", /API キー/);
  assert.match(gm.select({ provider: "openai", model: "bad model id!" }) ?? "", /形式/);
  assert.equal(gm.select({ provider: "openai", model: "gpt-6.1-sol" }), null);
  const st = gm.status();
  assert.equal(st.mode, "builtin");
  assert.deepEqual(st.current, { provider: "openai", model: "gpt-6.1-sol" });
  assert.equal(st.label, "GPT-6.1 Sol");
  // 提供元はキーの有無にかかわらず全部出す。キーそのものは出さず、入力済みかどうかだけ
  assert.deepEqual(st.providers.map((p) => [p.id, p.hasKey]), [["anthropic", true], ["openai", true], ["gemini", false]]);
  assert.ok(!JSON.stringify(st).includes("test-key"), "API キーが状態に含まれている");
  assert.equal(gm.select({ provider: "anthropic", model: "claude-custom-1" }), null);
  assert.equal(gm.status().label, "Claude (Anthropic) · claude-custom-1");
});

test("起動直後はキーが無く未設定。キーが入力されると、その AI を選べる", async () => {
  const { engine, provider, gm, keys } = setup([[() => call("start_scenario", scenario)]], { withKeys: [], selection: null });
  const st = gm.status();
  assert.equal(st.label, "未設定");
  assert.equal(st.connected, false);
  assert.equal(st.current, null);
  assert.ok(st.providers.every((p) => !p.hasKey));
  assert.match(gm.select({ provider: "gemini", model: "gemini-3.5-flash-lite" }) ?? "", /API キー/);
  // 選ばれる前に新しいゲームの依頼が来ても、API は呼ばずに知らせる
  engine.requestNewGame("");
  await gm.tick();
  assert.match(gm.status().error ?? "", /AI が選ばれていません/);
  assert.equal(provider.sessions.length, 0);

  keys.set("gemini", "test-key-g");
  assert.equal(gm.status().providers.find((p) => p.id === "gemini")?.hasKey, true);
  assert.equal(gm.select({ provider: "gemini", model: "gemini-3.5-flash-lite" }), null);
  engine.requestNewGame("");
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(gm.status().label, "Gemini 3.5 Flash-Lite");
  assert.ok(!JSON.stringify(gm.status()).includes("test-key-g"));
});

test("使っている AI のキーを入れ直すと、新しいキーで会話を作り直し、止まっていた続きを試す", async () => {
  const { engine, provider, gm, keys } = setup([[() => call("start_scenario", scenario)], [() => apiError(401, "invalid x-api-key")], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.match(gm.status().error ?? "", /API キーが無効/);
  // 使っていない提供元のキーが変わっても、何もしない
  gm.keyChanged("openai");
  await gm.tick();
  assert.ok(gm.status().error);
  assert.equal(provider.sessions.length, 2);

  keys.set("anthropic", "test-key-new");
  gm.keyChanged("anthropic");
  await gm.tick();
  assert.equal(gm.status().error, null);
  assert.equal(engine.phase, "player_turn");
  // 新しいクライアントで会話を作り直し、いまの全状態から引き継いでいる
  assert.equal(provider.sessions.length, 3);
  assert.match(provider.sessions[2].inputs[0].text ?? "", /進行中のゲームです/);
  assert.equal(provider.sessions[2].inputs[0].toolResults?.length ?? 0, 0);
});

test("対話の途中で AI を変えると、新しいモデルが会話の最初から引き継ぎ、止まっていた返答を再試行で続ける", async () => {
  const turns = SESSION_TURNS - 2; // 会話の区切りに届かない手番の数 (区切りは別の試験で確かめる)
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario)],
    [...Array.from({ length: turns }, (_, i) => () => reply(i + 1)), () => apiError(429, "rate limit exceeded")],
    [() => reply(turns + 1)],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  for (let t = 1; t <= turns; t++) {
    engine.act({ text: t === 1 ? "最初に予算のことを伺えますか" : `続けます (${t})` });
    await gm.tick();
  }
  engine.act({ text: "もう少し聞かせてください" });
  await gm.tick();
  assert.ok(gm.status().error); // 前の AI は利用上限で止まった
  assert.ok(!JSON.stringify(engine.fullState()).includes("最初に予算"), "ふだんの全状態は直近の会話だけ");

  assert.equal(gm.select({ provider: "openai", model: "gpt-6.1-sol" }), null);
  assert.equal(gm.status().error, null);
  gm.retry(); // 画面は、AI を変えたら止まっていた返答を再試行する
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(engine.publicState().turn, turns + 1);
  assert.equal(provider.sessions.length, 3);
  const next = provider.sessions[2];
  assert.equal(next.options.model, "gpt-6.1-sol");
  assert.match(next.inputs[0].text ?? "", /進行中のゲームです/);
  assert.match(next.inputs[0].text ?? "", /最初に予算のことを伺えますか/); // 直近だけでなく、会話の最初から渡っている
  assert.equal(next.inputs[0].toolResults?.length ?? 0, 0); // 前の AI のツール結果は持ち込まない
});

test(`プレイヤーの手番が ${SESSION_TURNS} 回続いたら、会話を作り直す (履歴を増やし続けない)。全状態とプレイヤーの全発言を渡して引き継ぐ`, async () => {
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario)],
    Array.from({ length: SESSION_TURNS }, (_, i) => () => reply(i + 1)),
    [() => reply(SESSION_TURNS + 1), () => reply(SESSION_TURNS + 2)],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  for (let t = 1; t <= SESSION_TURNS + 2; t++) {
    engine.act({ text: t === 1 ? "最初に予算のことを伺えますか" : `続けます (${t})` });
    await gm.tick();
  }
  assert.equal(engine.publicState().turn, SESSION_TURNS + 2);
  assert.equal(provider.sessions.length, 3); // 新しいゲーム・手番 1〜SESSION_TURNS・それ以降
  // 区切りまでは、同じ会話が続く (全状態は最初の 1 回だけ)
  const before = provider.sessions[1].inputs;
  assert.equal(before.length, SESSION_TURNS);
  assert.ok(before.slice(1).every((i) => !(i.text ?? "").includes("進行中のゲームです")));
  // 区切りの後: 前の会話のツール結果は持ち込まず、全状態と、プレイヤーの全発言を渡す
  const after = provider.sessions[2].inputs[0];
  assert.match(after.text ?? "", /進行中のゲームです/);
  assert.equal(after.toolResults?.length ?? 0, 0);
  assert.match(after.text ?? "", /player_lines/);
  assert.match(after.text ?? "", /最初に予算のことを伺えますか/); // 区切りより前の発言も引用の根拠になる
  assert.match(after.text ?? "", /resolved_when/); // 隠し情報も渡っている
  // 続きの手番 (区切りの後の 2 回目) は、同じ会話のまま
  assert.equal(provider.sessions[2].inputs.length, 2);
  assert.ok(!(provider.sessions[2].inputs[1].text ?? "").includes("進行中のゲームです"));
});

test("会話の頭の全状態は、仕事を二重に含めず、直近の会話だけを付ける (履歴の重さを抑える)", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  const text = provider.sessions[1].inputs[0].text ?? "";
  // 全状態に含まれる仕事 (pending) は、あとに付く今回の仕事と重複するので付けない
  assert.equal(text.split("type=player_action").length - 1, 1);
  const start = text.indexOf("{"); // 全状態は 1 行の JSON
  const state = JSON.parse(text.slice(start, text.indexOf("\n", start)));
  assert.ok(!("pending" in state));
  assert.deepEqual(state.player_lines, [{ turn: 1, text: "こんにちは" }]);
  assert.equal(engine.fullState({ pending: true }).pending !== undefined, true); // MCP の get_state は、これまでどおり仕事を含む
});

test("一時的な失敗 (混雑・通信の乱れ) は、待って自動で再試行し、案内を出す。直ったら止まらずに続く", async () => {
  const waits: number[] = [];
  const notices: Array<string | null> = [];
  const { engine, gm } = setup([[() => call("start_scenario", scenario)], [() => apiError(503, "The model is overloaded"), () => apiError(503, "The model is overloaded"), () => reply(1)]], {
    options: { retryDelaysMs: [4000, 10000, 25000], sleep: async (ms) => void (waits.push(ms), notices.push(gm.status().notice)) },
  });
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(gm.status().error, null);
  assert.deepEqual(waits, [4000, 10000]);
  assert.match(notices[0] ?? "", /自動で再試行します \(1\/3\)/); // 待っている間は案内が出ている
  assert.match(notices[1] ?? "", /\(2\/3\)/);
  assert.equal(gm.status().notice, null); // 直ったら消える
});

test("自動で再試行しても直らなければ止まって知らせる / キーの誤りなど一時的でない失敗は、待たずにすぐ止まる", async () => {
  const waits: number[] = [];
  const options = { retryDelaysMs: [1000, 2000], sleep: async (ms: number) => void waits.push(ms) };
  const down = () => apiError(503, "The model is overloaded");
  const a = setup([[() => call("start_scenario", scenario)], [down, down, down]], { options });
  a.engine.requestNewGame("");
  await a.gm.tick();
  a.engine.act({ text: "こんにちは" });
  await a.gm.tick();
  assert.deepEqual(waits, [1000, 2000]); // 最初の 1 回 + 再試行 2 回で、3 回目も失敗
  assert.match(a.gm.status().error ?? "", /AI のサービス側でエラー.*503/);
  assert.equal(a.gm.status().notice, null);
  assert.equal(a.engine.phase, "ai_turn");

  waits.length = 0;
  const b = setup([[() => call("start_scenario", scenario)], [() => apiError(401, "invalid x-api-key")]], { options });
  b.engine.requestNewGame("");
  await b.gm.tick();
  b.engine.act({ text: "こんにちは" });
  await b.gm.tick();
  assert.deepEqual(waits, []);
  assert.match(b.gm.status().error ?? "", /API キーが無効/);
});

test("自動で再試行を待つあいだに最初からやり直されたら、古い会話は捨てて待たずに終える", async () => {
  let engineRef!: Engine;
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario)], [() => apiError(503, "overloaded")], [() => reply(1)]], {
    options: { retryDelaysMs: [1000], sleep: async () => void engineRef.replay() }, // 待っている間に「最初から」を押した
  });
  engineRef = engine;
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.equal(gm.status().error, null);
  assert.equal(gm.status().notice, null);
  assert.equal(provider.sessions[1].inputs.length, 1); // 古い手番への再送はしない
  engine.act({ text: "やり直しました" });
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  assert.equal(provider.sessions.length, 3);
});
