// 内蔵 GM の制御のテスト。実際の API は使わず、台本どおりに答える作り物の AI で確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "./engine.js";
import { BuiltinGm, MAX_ATTEMPTS, type Selection } from "./gm.js";
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

/** 既定では Claude と GPT のキーが入力済みの状態 (キーの値は作り物) */
function setup(scripts: Step[][], { withKeys = ["anthropic", "openai"] as ProviderId[], selection = { provider: "anthropic", model: "claude-opus-5-5" } as Selection | null } = {}) {
  const engine = new Engine();
  const provider = new FakeProvider("anthropic", scripts);
  const keys = new ApiKeys();
  for (const id of withKeys) keys.set(id, `test-key-${id}`);
  let statusChanges = 0;
  const gm = new BuiltinGm(engine, () => provider, keys, selection, () => statusChanges++);
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
  assert.deepEqual(s.options.tools.map((t) => t.name), ["start_scenario", "reply", "submit_review"]);
  assert.match(s.inputs[0].text ?? "", /type=new_game/);
  assert.match(s.inputs[0].text ?? "", /橋の話/);
});

test("検証エラーは AI に返して直させる / 成功したツールの結果は次の送信で返す", async () => {
  const { engine, provider, gm } = setup([
    [
      () => call("start_scenario", scenario),
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
  const s = provider.sessions[0];
  // 2 回目の送信: start_scenario の成功結果 + プレイヤーの発言
  assert.equal(s.inputs[1].toolResults?.[0].isError, false);
  assert.match(s.inputs[1].text ?? "", /type=player_action/);
  // 3 回目の送信: 検証エラーだけ (文は無し)
  assert.equal(s.inputs[2].toolResults?.[0].isError, true);
  assert.match(s.inputs[2].toolResults?.[0].content ?? "", /ghost/);
  assert.equal(s.inputs[2].text, undefined);

  engine.act({ text: "続けます" });
  await gm.tick();
  // 4 回目: 前のターンの reply の成功結果が先頭に付いている
  assert.equal(s.inputs[3].toolResults?.[0].isError, false);
  assert.equal(engine.publicState().turn, 2);
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

test("API のエラー (キーが無効など) は分かる言葉で出し、返すべきツール結果は持ち越す", async () => {
  const { engine, provider, gm } = setup([
    [() => call("start_scenario", scenario), () => apiError(401, "invalid x-api-key"), () => reply(1)],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.match(gm.status().error ?? "", /API キーが無効/);
  assert.equal(engine.phase, "ai_turn");
  gm.retry();
  await gm.tick();
  assert.equal(engine.phase, "player_turn");
  const s = provider.sessions[0];
  // 失敗した送信と、再試行の送信は同じ (start_scenario の結果を落とさない)
  assert.deepEqual(s.inputs[2], s.inputs[1]);
  assert.equal(s.inputs[2].toolResults?.[0].isError, false);
});

test("止まっていた仕事が無くなったら (最初からやり直した等)、エラー表示も消える", async () => {
  const { engine, gm } = setup([[() => call("start_scenario", scenario), () => apiError(500, "overloaded")], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.ok(gm.status().error);
  engine.replay();
  await gm.tick();
  assert.equal(gm.status().error, null);
});

test("対話が終わると、同じ会話のまま振り返りを書く", async () => {
  const { engine, provider, gm } = setup([
    [
      () => call("start_scenario", scenario),
      () => reply(1, { epilogue: "また話そう。" }),
      () => call("submit_review", { overall: "最初に予算を尋ねたのは良かった。", good: ["予算を尋ねた"], improve: ["行事も聞く"], concerns: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, advice: `${id} はこう聞けばよかった` })) }),
    ],
  ]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "今日はここまでに" }, true);
  await gm.tick();
  assert.equal(engine.phase, "ended");
  assert.ok(engine.publicState().review);
  assert.equal(provider.sessions.length, 1);
  assert.match(provider.sessions[0].inputs[2].text ?? "", /type=review/);
});

test("同じシナリオでやり直すと、隠し情報を含む全状態を渡して会話を作り直す", async () => {
  const { engine, provider, gm } = setup([[() => call("start_scenario", scenario), () => reply(1)], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  engine.replay();
  engine.act({ text: "もう一度、最初から" });
  await gm.tick();
  assert.equal(provider.sessions.length, 2);
  const first = provider.sessions[1].inputs[0];
  assert.match(first.text ?? "", /進行中のゲームです/);
  assert.match(first.text ?? "", /resolved_when/); // 隠し情報も渡っている
  assert.equal(first.toolResults?.length ?? 0, 0); // 前の会話のツール結果は持ち込まない
  assert.equal(engine.phase, "player_turn");
});

test("応答を待つ間に最初からやり直されたら、古い会話は捨てる", async () => {
  let engineRef!: Engine;
  const { engine, provider, gm } = setup([
    [
      () => call("start_scenario", scenario),
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
  assert.equal(provider.sessions.length, 2);
  assert.match(provider.sessions[1].inputs[0].text ?? "", /進行中のゲームです/);
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
  const { engine, provider, gm, keys } = setup([[() => call("start_scenario", scenario), () => apiError(401, "invalid x-api-key")], [() => reply(1)]]);
  engine.requestNewGame("");
  await gm.tick();
  engine.act({ text: "こんにちは" });
  await gm.tick();
  assert.match(gm.status().error ?? "", /API キーが無効/);
  // 使っていない提供元のキーが変わっても、何もしない
  gm.keyChanged("openai");
  await gm.tick();
  assert.ok(gm.status().error);
  assert.equal(provider.sessions.length, 1);

  keys.set("anthropic", "test-key-new");
  gm.keyChanged("anthropic");
  await gm.tick();
  assert.equal(gm.status().error, null);
  assert.equal(engine.phase, "player_turn");
  // 新しいクライアントで会話を作り直し、いまの全状態から引き継いでいる
  assert.equal(provider.sessions.length, 2);
  assert.match(provider.sessions[1].inputs[0].text ?? "", /進行中のゲームです/);
  assert.equal(provider.sessions[1].inputs[0].toolResults?.length ?? 0, 0);
});
