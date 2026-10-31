// ブラウザ版 (構成 A) のゲーム本体のテスト。AI の会社には実際には接続せず、台本どおりに答える作り物の AI で確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalBackend, type Action } from "./backend.js";
import type { AssistantTurn, ProviderId, TurnInput } from "./llm/index.js";
import type { PublicState } from "./shared.js";

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
      speech: "一人称は「わし」、相手は「あんた」。老人らしいくだけた口調。",
      sample_lines: ["そうさのう、費用のことは気になるわい。", "あんたの話は、よう分かった。"],
    },
  ],
  concerns: [
    { id: "c1", owner: "mayor", category: "予算", text: "村の蓄えが少なく大きな橋は作れない", reveal_hint: "費用を尋ねる", min_trust: 0, resolved_when: "村の予算内に収まる規模の案が示される" },
    { id: "c2", owner: "mayor", category: "行事", text: "祭りの行列の道筋が変わってしまう", reveal_hint: "行事を尋ねる", min_trust: 1, resolved_when: "祭りの行列の経路が確保される" },
    { id: "c3", owner: "mayor", category: "仕事", text: "渡し守の仕事がなくなる", reveal_hint: "渡し守に触れる", min_trust: 3, resolved_when: "渡し守の役割が守られる案が示される" },
    { id: "c4", owner: "mayor", category: "安全", text: "子どもが橋から川へ落ちないか心配だ", reveal_hint: "安全のことを尋ねる", min_trust: 3, resolved_when: "子どもを守る備えが示される" },
    { id: "c5", owner: "mayor", category: "工事", text: "工事のあいだ畑への道がふさがる", reveal_hint: "工事の段取りを尋ねる", min_trust: 4, resolved_when: "工事中の迂回路が示される" },
  ],
  briefing: [
    { label: "計画", text: "県の補助で、来年度中に川へ橋を 1 本かける" },
    { label: "候補地", text: "東の浅瀬と、村の中心に近い西の渡し場の 2 か所" },
    { label: "これまで", text: "村の寄合で 2 回話し合ったが、場所が決まっていない" },
  ],
  opening: [{ speaker: "mayor", text: "橋なら東の浅瀬がよかろう。" }],
};

let callId = 0;
const call = (name: string, input: unknown): AssistantTurn => ({ toolCalls: [{ id: `c${++callId}`, name, input }], text: "" });
const GOOD_KEY = "good-key-0123456789";

/** 401 を返す偽のキー / 接続できない場合 / 通るキー を、作り物の確認で再現する */
async function fakeVerify(_id: ProviderId, key: string) {
  if (key.startsWith("bad")) throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
  if (key.startsWith("offline")) throw new Error("Connection error.");
}

function setup(script: Array<(input: TurnInput) => AssistantTurn> = []) {
  const made: Array<{ id: ProviderId; apiKey?: string }> = [];
  let state: PublicState | null = null;
  const backend = createLocalBackend({
    makeProvider: (id, apiKey) => {
      made.push({ id, apiKey });
      return {
        id,
        newSession: () => ({
          next: async (input: TurnInput) => {
            const step = script.shift();
            if (!step) throw new Error("台本が尽きた");
            return step(input);
          },
        }),
      };
    },
    verify: fakeVerify,
    log: () => {},
  });
  backend.connect((s) => (state = s));
  const send = (action: Action, body?: Record<string, unknown>) => backend.send(action, body);
  return { send, made, state: () => state! };
}

/** AI の処理 (非同期) が終わるのを待つ */
async function until(ok: () => boolean) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ok(), "待っていた状態になりませんでした");
}

test("ブラウザ版: 起動直後は AI 未設定。キーは確かめてから受け付け、状態には出さない", async () => {
  const { send, state } = setup();
  assert.equal(state().ai.mode, "builtin");
  assert.equal(state().ai.label, "未設定");
  assert.ok(state().ai.providers.every((p) => !p.hasKey));
  assert.deepEqual(state().ai.providers.map((p) => p.apiHost), ["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com"]);
  // 専用キーと上限額の設定の手順が、サービスごとに画面へ届く
  assert.ok(state().ai.providers.every((p) => p.keySteps.length >= 2 && p.keySteps.some((s) => /上限/.test(s))));
  assert.match((await send("new", { request: "" })) ?? "", /AI が選ばれていません/);

  assert.match((await send("ai/key", { provider: "gemini", key: "" })) ?? "", /入力してください/);
  assert.match((await send("ai/key", { provider: "gemini", key: "bad-key-0123456789" })) ?? "", /API キーが正しくありません/);
  assert.match((await send("ai/key", { provider: "gemini", key: "offline-key-0123456789" })) ?? "", /キーを確かめられませんでした: AI の会社に接続できませんでした/);
  assert.match((await send("ai/key", { provider: "nope", key: GOOD_KEY })) ?? "", /不明な AI/);
  assert.equal(state().ai.providers.find((p) => p.id === "gemini")?.hasKey, false); // 失敗したキーは持たない

  assert.equal(await send("ai/key", { provider: "gemini", key: ` ${GOOD_KEY} ` }), null);
  assert.equal(state().ai.providers.find((p) => p.id === "gemini")?.hasKey, true);
  assert.ok(!JSON.stringify(state()).includes(GOOD_KEY), "API キーが画面の状態に含まれている");

  assert.match((await send("ai/select", { provider: "openai", model: "gpt-6-luna" })) ?? "", /API キー/);
  assert.equal(await send("ai/select", { provider: "gemini" }), null);
  assert.deepEqual(state().ai.current, { provider: "gemini", model: "gemini-3.5-flash-lite" });
  assert.equal(state().ai.label, "Gemini 3.5 Flash-Lite");
});

test("ブラウザ版: 新しいゲームを AI が作り、入力したキーで AI を呼ぶ。発言・やり直しもできる", async () => {
  const { send, state, made } = setup([() => call("start_scenario", scenario), () => call("reply", { turn: 1, lines: [{ speaker: "mayor", text: "ふむ、そうか。" }] })]);
  await send("ai/key", { provider: "gemini", key: GOOD_KEY });
  await send("ai/select", { provider: "gemini" });
  // シナリオの希望に貼られたキーは、AI に送らない
  assert.match((await send("new", { request: "キーは sk-ant-api03-" + "x".repeat(30) })) ?? "", /AI の設定」でだけ入力/);
  assert.match((await send("new", { request: "", difficulty: "nightmare" })) ?? "", /不明な難易度/);

  assert.equal(await send("new", { request: "橋の話", difficulty: "normal" }), null);
  await until(() => state().phase === "player_turn");
  assert.equal(state().scenario?.title, "橋の場所");
  assert.deepEqual(made, [{ id: "gemini", apiKey: GOOD_KEY }]); // 呼び出しには、このページで入力したキーが使われる

  assert.equal(await send("act", { text: "こんにちは" }), null);
  await until(() => state().phase === "player_turn" && state().turn === 1);
  assert.equal(state().log.at(-1)?.text, "ふむ、そうか。");
  assert.match((await send("act", { text: "AIza" + "B".repeat(35) })) ?? "", /Google の API キー/);
  assert.equal(await send("replay"), null);
  assert.equal(state().turn, 0);
  assert.match((await send("nope" as Action)) ?? "", /不明な操作/);
});

test("ブラウザ版: キーを消すと、そのサービスを使う AI の選択も外れる", async () => {
  const { send, state } = setup();
  await send("ai/key", { provider: "gemini", key: GOOD_KEY });
  await send("ai/key", { provider: "openai", key: GOOD_KEY });
  await send("ai/select", { provider: "gemini" });
  // 使っていないサービスのキーを消しても、選択はそのまま
  assert.equal(await send("ai/forget", { provider: "openai" }), null);
  assert.deepEqual(state().ai.current?.provider, "gemini");
  assert.equal(await send("ai/forget", { provider: "gemini" }), null);
  assert.ok(state().ai.providers.every((p) => !p.hasKey));
  assert.equal(state().ai.current, null);
  assert.equal(state().ai.label, "未設定");
  assert.match((await send("new", { request: "" })) ?? "", /AI が選ばれていません/);
});
