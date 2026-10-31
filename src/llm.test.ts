// 各社の接続部のテスト。作り物のクライアントを差し込み、送る要求と会話履歴の積み方を確かめる (実際の API は呼ばない)
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicProvider, echoable, verifyAnthropicKey } from "./llm/anthropic.js";
import { ApiKeys, checkKeyFormat, describeError, isAuthError } from "./llm/index.js";
import { geminiProvider } from "./llm/gemini.js";
import { openAiProvider } from "./llm/openai.js";
import type { SessionOptions } from "./llm/types.js";

const options = (model: string): SessionOptions => ({
  system: "あなたは GM です",
  model,
  tools: [{ name: "reply", description: "返答する", parameters: { type: "object", properties: { turn: { type: "number" } }, required: ["turn"] } }],
});

/** 呼ばれた引数を記録し、用意した応答を順に返す */
function recorder<T>(responses: T[]) {
  const calls: any[] = [];
  return {
    calls,
    fn: async (params: unknown) => {
      calls.push(structuredClone(params));
      const r = responses.shift();
      if (!r) throw new Error("応答が尽きた");
      return r;
    },
  };
}

// ---- Claude ---------------------------------------------------------------------

test("Claude: ツール定義・effort・キャッシュ・フォールバックを付けて送り、thinking ブロックはそのまま返し直す", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const rec = recorder<any>([
    { stop_reason: "tool_use", content: [thinking, { type: "tool_use", id: "tu_1", name: "reply", input: { turn: 1 } }] },
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_2", name: "reply", input: { turn: 2 } }] },
  ]);
  const s = anthropicProvider({ effort: "medium", client: { beta: { messages: { create: rec.fn } } } as never }).newSession(options("claude-opus-5-5"));

  const t1 = await s.next({ text: "仕事 1" });
  assert.deepEqual(t1.toolCalls, [{ id: "tu_1", name: "reply", input: { turn: 1 } }]);
  const p1 = rec.calls[0];
  assert.equal(p1.model, "claude-opus-5-5");
  assert.equal(p1.system, "あなたは GM です");
  assert.deepEqual(p1.tools[0].input_schema.required, ["turn"]);
  assert.deepEqual(p1.output_config, { effort: "medium" });
  assert.deepEqual(p1.cache_control, { type: "ephemeral" });
  assert.equal(p1.fallbacks, "default");
  assert.deepEqual(p1.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal("tool_choice" in p1, false); // Opus 5.5 では強制できないので、指示で呼ばせる

  await s.next({ toolResults: [{ id: "tu_1", name: "reply", content: "ok", isError: false }], text: "仕事 2" });
  const msgs = rec.calls[1].messages;
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[1].content[0], thinking); // 受け取ったまま
  assert.deepEqual(msgs[2].content, [
    { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
    { type: "text", text: "仕事 2" },
  ]);
});

test("Claude: Haiku 5.5 にはフォールバックを付けない / エラーの結果は is_error / 拒否は履歴に入れない", async () => {
  const rec = recorder<any>([
    { stop_reason: "refusal", content: [] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "はい" }] },
  ]);
  const s = anthropicProvider({ effort: "low", client: { beta: { messages: { create: rec.fn } } } as never }).newSession(options("claude-haiku-5-5"));
  const refused = await s.next({ toolResults: [{ id: "tu_9", name: "reply", content: "だめ", isError: true }] });
  assert.match(refused.problem ?? "", /安全上の理由/);
  assert.equal("fallbacks" in rec.calls[0], false);
  assert.equal("betas" in rec.calls[0], false);
  assert.equal(rec.calls[0].messages[0].content[0].is_error, true);
  // 拒否された送信は履歴に入らないので、送り直しても同じ要求になる
  await s.next({ toolResults: [{ id: "tu_9", name: "reply", content: "だめ", isError: true }] });
  assert.deepEqual(rec.calls[1].messages, rec.calls[0].messages);
});

test("Claude: キーの確認はトークン数の計算で行う (料金がかからず、ブラウザからも呼べる)", async () => {
  const rec = recorder<any>([{ input_tokens: 5 }]);
  await verifyAnthropicKey("k", { messages: { countTokens: rec.fn } } as never);
  assert.equal(rec.calls[0].model, "claude-haiku-5-5");
  assert.equal(rec.calls[0].messages.length, 1);
});

test("Claude: 途中でフォールバックが起きたら、境界より前の thinking と tool_use は返し直さない", () => {
  const content: any[] = [
    { type: "thinking", thinking: "", signature: "a" },
    { type: "text", text: "前半" },
    { type: "tool_use", id: "x", name: "reply", input: {} },
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
    { type: "tool_use", id: "y", name: "reply", input: {} },
  ];
  assert.deepEqual(echoable(content).map((b) => b.type), ["text", "fallback", "tool_use"]);
  const plain: any[] = [{ type: "thinking", thinking: "", signature: "a" }, { type: "tool_use", id: "y", name: "reply", input: {} }];
  assert.equal(echoable(plain), plain);
});

// ---- GPT (OpenAI) -------------------------------------------------------------------

test("GPT: Responses API に保存なしで送り、推論アイテムとツール呼び出しを履歴に残して結果を返す", async () => {
  const rec = recorder<any>([
    {
      status: "completed",
      output_text: "",
      output: [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: "reply", arguments: '{"turn":1}', status: "completed" },
      ],
    },
    { status: "completed", output_text: "", output: [{ type: "function_call", id: "fc_2", call_id: "call_2", name: "reply", arguments: "{壊れた", status: "completed" }] },
  ]);
  const s = openAiProvider({ effort: "high", client: { responses: { create: rec.fn } } as never }).newSession(options("gpt-6-astra"));

  const t1 = await s.next({ text: "仕事 1" });
  assert.deepEqual(t1.toolCalls, [{ id: "call_1", name: "reply", input: { turn: 1 } }]);
  const p1 = rec.calls[0];
  assert.equal(p1.instructions, "あなたは GM です");
  assert.equal(p1.store, false);
  assert.equal(p1.tool_choice, "required");
  assert.deepEqual(p1.reasoning, { effort: "high" });
  assert.deepEqual(p1.tools[0], { type: "function", name: "reply", description: "返答する", parameters: options("x").tools[0].parameters, strict: false });
  assert.deepEqual(p1.input, [{ role: "user", content: "仕事 1" }]);

  const t2 = await s.next({ toolResults: [{ id: "call_1", name: "reply", content: "検証エラー", isError: true }] });
  const input = rec.calls[1].input;
  assert.deepEqual(input.map((i: any) => i.type ?? i.role), ["user", "reasoning", "function_call", "function_call_output"]);
  assert.equal(input[1].encrypted_content, "enc"); // 推論はそのまま返し直す
  assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "ERROR\n検証エラー" });
  // 壊れた JSON は、ツール側の検証で AI に直させる
  assert.deepEqual(t2.toolCalls[0].input, { _unparsable_arguments: "{壊れた" });
});

test("GPT: 出力の上限で途切れたら、問題として返し履歴には入れない", async () => {
  const rec = recorder<any>([
    { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], output_text: "" },
    { status: "completed", output: [], output_text: "" },
  ]);
  const s = openAiProvider({ effort: "medium", client: { responses: { create: rec.fn } } as never }).newSession(options("gpt-6-luna"));
  const t = await s.next({ text: "仕事" });
  assert.match(t.problem ?? "", /出力の上限/);
  await s.next({ text: "仕事" });
  assert.deepEqual(rec.calls[1].input, rec.calls[0].input);
});

// ---- Gemini -------------------------------------------------------------------------

test("Gemini: 関数呼び出しを強制し、モデルの応答は署名ごと履歴に残して結果を返す", async () => {
  const modelContent = { role: "model", parts: [{ functionCall: { id: "f1", name: "reply", args: { turn: 1 } }, thoughtSignature: "sig" }] };
  const rec = recorder<any>([
    { candidates: [{ content: modelContent, finishReason: "STOP" }], functionCalls: [{ id: "f1", name: "reply", args: { turn: 1 } }] },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "reply", args: { turn: 2 } } }] }, finishReason: "STOP" }], functionCalls: [{ name: "reply", args: { turn: 2 } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "了解" }] }, finishReason: "STOP" }], functionCalls: undefined },
  ]);
  const s = geminiProvider({ effort: "low", client: { models: { generateContent: rec.fn } } as never }).newSession(options("gemini-4-argon"));

  const t1 = await s.next({ text: "仕事 1" });
  assert.deepEqual(t1.toolCalls, [{ id: "f1", name: "reply", input: { turn: 1 } }]);
  const c1 = rec.calls[0].config;
  assert.equal(c1.systemInstruction, "あなたは GM です");
  assert.equal(c1.toolConfig.functionCallingConfig.mode, "ANY");
  assert.equal(c1.thinkingConfig.thinkingLevel, "LOW");
  assert.deepEqual(c1.tools[0].functionDeclarations[0].parametersJsonSchema.required, ["turn"]);

  const t2 = await s.next({ toolResults: [{ id: "f1", name: "reply", content: "ok", isError: false }], text: "仕事 2" });
  const contents = rec.calls[1].contents;
  assert.deepEqual(contents[1], modelContent); // 署名 (thoughtSignature) ごと
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { id: "f1", name: "reply", response: { output: "ok" } } }, { text: "仕事 2" }] });
  // id の無い呼び出しには仮の id を付け、返すときは付けない
  assert.match(t2.toolCalls[0].id, /^local-/);
  await s.next({ toolResults: [{ id: t2.toolCalls[0].id, name: "reply", content: "だめ", isError: true }] });
  assert.deepEqual(rec.calls[2].contents.at(-1), { role: "user", parts: [{ functionResponse: { name: "reply", response: { error: "だめ" } } }] });
});

test("Gemini: 安全上の理由などで止まったら、問題として返し履歴には入れない", async () => {
  const rec = recorder<any>([
    { candidates: [{ finishReason: "SAFETY" }], functionCalls: undefined },
    { candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }], functionCalls: [] },
  ]);
  const s = geminiProvider({ effort: "medium", client: { models: { generateContent: rec.fn } } as never }).newSession(options("gemini-3.8-flash"));
  const t = await s.next({ text: "仕事" });
  assert.match(t.problem ?? "", /SAFETY/);
  await s.next({ text: "仕事" });
  assert.deepEqual(rec.calls[1].contents, rec.calls[0].contents);
});

// ---- 共通 --------------------------------------------------------------------------

test("API のエラーを、画面に出せる短い説明にする", () => {
  const err = (status: number) => Object.assign(new Error("raw message"), { status });
  assert.match(describeError(err(401)), /API キーが無効/);
  // Gemini は無効なキーを 400 で返す (実際の API で確認した応答の形)
  const gemini = Object.assign(new Error('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'), { status: 400 });
  assert.match(describeError(gemini), /API キーが無効/);
  // Anthropic の残高不足は 400 (実際の API で確認した応答の形)
  const credit = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
  assert.match(describeError(credit), /クレジット残高が足りません/);
  assert.match(describeError(err(404)), /モデルが見つかりません/);
  assert.match(describeError(err(429)), /利用上限/);
  assert.match(describeError(err(503)), /サービス側/);
  assert.match(describeError(err(400)), /受け付けられませんでした: raw message/);
  assert.match(describeError(new Error("ECONNREFUSED")), /呼び出しに失敗しました: ECONNREFUSED/);
  // ブラウザから直接呼んで、通信を止められたとき (広告ブロッカーなど)
  assert.match(describeError(new Error("Connection error.")), /AI の会社に接続できませんでした/);
  assert.match(describeError(new TypeError("Failed to fetch")), /広告ブロッカー/);
  // キーの誤りかどうか (開始画面でキーを確かめるときに使う)
  assert.ok(isAuthError(err(401)) && isAuthError(err(403)) && isAuthError(gemini));
  assert.ok(!isAuthError(err(429)) && !isAuthError(credit) && !isAuthError(new Error("ECONNREFUSED")));
});

test("API キーの置き場所: 入力されたキーだけを持つ (環境変数のキーは読まない)", () => {
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "env-key-g";
  try {
    const keys = new ApiKeys();
    assert.deepEqual(keys.available(), []);
    assert.equal(keys.get("gemini"), undefined);
    keys.set("gemini", "typed-key-g");
    keys.set("openai", "typed-key-o");
    keys.set("gemini", "typed-key-g2"); // 入れ直したら新しいキー
    assert.equal(keys.get("gemini"), "typed-key-g2");
    assert.ok(keys.has("openai") && !keys.has("anthropic"));
    assert.deepEqual(keys.available(), ["openai", "gemini"]);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test("API キーの形式: 空・空白や改行の混ざったもの・短すぎるものは、API に送る前に弾く", () => {
  assert.equal(checkKeyFormat("sk-test-0123456789abcdef"), null);
  assert.equal(checkKeyFormat("  AIzaTest0123456789  "), null); // 前後の空白は許す (貼り付けで付きがち)
  assert.match(checkKeyFormat("") ?? "", /入力してください/);
  assert.match(checkKeyFormat(undefined) ?? "", /入力してください/);
  assert.match(checkKeyFormat("sk-test 0123456789") ?? "", /形式が正しくありません/);
  assert.match(checkKeyFormat("sk-test\n0123456789") ?? "", /形式/);
  assert.match(checkKeyFormat("short") ?? "", /形式/);
  assert.match(checkKeyFormat("sk-テスト0123456789") ?? "", /形式/);
});
