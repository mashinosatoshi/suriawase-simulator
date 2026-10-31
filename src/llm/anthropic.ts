// Claude (Anthropic Messages API)
import Anthropic from "@anthropic-ai/sdk";
import { MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, VERIFY_TIMEOUT_MS, type AssistantTurn, type ChatSession, type Effort, type LlmProvider, type SessionOptions, type TurnInput } from "./types.js";

/** サーバー側のフォールバック (安全上の拒否のとき別モデルで続ける) が使えるモデル。Haiku 5.5 には無い */
const SERVER_FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

type Client = Pick<Anthropic, "beta">;
type Block = Anthropic.Beta.BetaContentBlock;

/**
 * フォールバックが応答の途中で起きた場合、境界 (最後の fallback ブロック) より前の
 * thinking / tool_use などは返し直さない。テキストと境界以降はそのまま返す。
 */
export function echoable(content: Block[]): Block[] {
  const boundary = content.map((b) => b.type).lastIndexOf("fallback");
  if (boundary < 0) return content;
  return content.filter((b, i) => i >= boundary || b.type === "text");
}

class AnthropicSession implements ChatSession {
  private messages: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(
    private client: Client,
    private o: SessionOptions,
    private effort: Effort,
  ) {}

  async next(input: TurnInput): Promise<AssistantTurn> {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...(input.toolResults ?? []).map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
    ];
    const user: Anthropic.Beta.BetaMessageParam = { role: "user", content };
    const fallback = SERVER_FALLBACK_MODELS.has(this.o.model);

    const res = await this.client.beta.messages.create({
      model: this.o.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: this.o.system,
      tools: this.o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema })),
      messages: [...this.messages, user],
      // 思考は既定 (adaptive) のまま、深さを effort で決める
      output_config: { effort: this.effort },
      // 指示とツール定義、それまでの会話をキャッシュする (毎ターン同じ先頭が続く)
      cache_control: { type: "ephemeral" },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (res.stop_reason === "refusal") return { toolCalls: [], text: "", problem: "安全上の理由で、AI が応答を止めました" };
    if (res.stop_reason === "max_tokens") return { toolCalls: [], text: "", problem: "AI の応答が出力の上限で途切れました" };

    const kept = echoable(res.content);
    // 会話は追記だけ (thinking ブロックは受け取ったまま返し直す)
    this.messages.push(user, { role: "assistant", content: kept });
    return {
      toolCalls: kept.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
      text: kept.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
    };
  }
}

export function anthropicProvider(options: { apiKey?: string; effort: Effort; client?: Client }): LlmProvider {
  // ゲームはブラウザの中で動き、利用者のキーで Anthropic を直接呼ぶ (運営のサーバーを通さない)
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey, timeout: REQUEST_TIMEOUT_MS, dangerouslyAllowBrowser: true });
  return { id: "anthropic", newSession: (o) => new AnthropicSession(client, o, options.effort) };
}

/**
 * API キーが使えるかを、料金のかからないトークン数の計算で確かめる (使えなければ SDK のエラーを投げる)。
 * モデル一覧の取得はブラウザから呼べない (CORS) ので使わない
 */
export async function verifyAnthropicKey(apiKey: string, client?: Pick<Anthropic, "messages">): Promise<void> {
  const c = client ?? new Anthropic({ apiKey, timeout: VERIFY_TIMEOUT_MS, maxRetries: 0, dangerouslyAllowBrowser: true });
  await c.messages.countTokens({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "キーの確認" }] });
}
