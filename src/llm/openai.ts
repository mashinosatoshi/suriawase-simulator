// GPT (OpenAI Responses API)。GPT-6 系のツール呼び出しは Responses API でしか使えない
import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, VERIFY_TIMEOUT_MS, type AssistantTurn, type ChatSession, type Effort, type LlmProvider, type SessionOptions, type TurnInput } from "./types.js";

type Client = Pick<OpenAI, "responses">;
type InputItem = OpenAI.Responses.ResponseInputItem;

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 壊れた JSON はそのまま渡し、ツール側の検証エラーとして AI に直させる
    return { _unparsable_arguments: raw };
  }
}

class OpenAiSession implements ChatSession {
  /** 会話の全履歴 (store: false なので、推論アイテムも含めて毎回こちらから送り直す) */
  private history: InputItem[] = [];

  constructor(
    private client: Client,
    private o: SessionOptions,
    private effort: Effort,
  ) {}

  async next(input: TurnInput): Promise<AssistantTurn> {
    const added: InputItem[] = [
      ...(input.toolResults ?? []).map((r) => ({ type: "function_call_output" as const, call_id: r.id, output: r.isError ? `ERROR\n${r.content}` : r.content })),
      ...(input.text ? [{ role: "user" as const, content: input.text }] : []),
    ];

    const res = await this.client.responses.create({
      model: this.o.model,
      instructions: this.o.system,
      input: [...this.history, ...added],
      tools: this.o.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      // 毎回どれかのツールを呼ばせる (テキストだけの返事は画面に出ないため)
      tool_choice: "required",
      reasoning: { effort: this.effort },
      // 会話を OpenAI 側に保存しない
      store: false,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    if (res.status === "incomplete") {
      const reason = res.incomplete_details?.reason;
      return { toolCalls: [], text: "", problem: reason === "max_output_tokens" ? "AI の応答が出力の上限で途切れました" : `AI の応答が途中で止まりました (${reason ?? "不明"})` };
    }

    // 推論アイテムやツール呼び出しを落とさないよう、SDK の変換をそのまま使う
    this.history.push(...added, ...toResponseInputItems(res.output));
    return {
      toolCalls: res.output.flatMap((item) => (item.type === "function_call" ? [{ id: item.call_id, name: item.name, input: parseArguments(item.arguments) }] : [])),
      text: res.output_text ?? "",
    };
  }
}

export function openAiProvider(options: { apiKey?: string; effort: Effort; client?: Client }): LlmProvider {
  // ゲームはブラウザの中で動き、利用者のキーで OpenAI を直接呼ぶ (運営のサーバーを通さない)
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey, timeout: REQUEST_TIMEOUT_MS, dangerouslyAllowBrowser: true });
  return { id: "openai", newSession: (o) => new OpenAiSession(client, o, options.effort) };
}

/** API キーが使えるかを、料金のかからないモデル一覧の取得で確かめる (使えなければ SDK のエラーを投げる) */
export async function verifyOpenAiKey(apiKey: string): Promise<void> {
  await new OpenAI({ apiKey, timeout: VERIFY_TIMEOUT_MS, maxRetries: 0, dangerouslyAllowBrowser: true }).models.list();
}
