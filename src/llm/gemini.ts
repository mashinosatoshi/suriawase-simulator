// Gemini (Google GenAI SDK の generateContent)
import { FinishReason, FunctionCallingConfigMode, GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import { MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS, VERIFY_TIMEOUT_MS, type AssistantTurn, type ChatSession, type Effort, type LlmProvider, type SessionOptions, type TurnInput } from "./types.js";

type Client = Pick<GoogleGenAI, "models">;

const THINKING: Record<Effort, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };
/** id の無い関数呼び出しに付ける仮の id (Gemini に返すときは付けない) */
const LOCAL_ID = "local-";

class GeminiSession implements ChatSession {
  /** 会話の全履歴。モデルの応答は受け取った Content のまま積む (thought signature を保つため) */
  private contents: Content[] = [];
  private calls = 0;

  constructor(
    private client: Client,
    private o: SessionOptions,
    private effort: Effort,
  ) {}

  async next(input: TurnInput): Promise<AssistantTurn> {
    const parts: Part[] = [
      ...(input.toolResults ?? []).map((r) => ({
        functionResponse: {
          ...(r.id.startsWith(LOCAL_ID) ? {} : { id: r.id }),
          name: r.name,
          response: r.isError ? { error: r.content } : { output: r.content },
        },
      })),
      ...(input.text ? [{ text: input.text }] : []),
    ];
    const user: Content = { role: "user", parts };

    const res = await this.client.models.generateContent({
      model: this.o.model,
      contents: [...this.contents, user],
      config: {
        systemInstruction: this.o.system,
        tools: [{ functionDeclarations: this.o.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        // 毎回どれかの関数を呼ばせる (テキストだけの返事は画面に出ないため)
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
        thinkingConfig: { thinkingLevel: THINKING[this.effort] },
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    });

    const candidate = res.candidates?.[0];
    const content = candidate?.content;
    const calls = res.functionCalls ?? [];
    if (!content || (!calls.length && candidate?.finishReason && candidate.finishReason !== FinishReason.STOP)) {
      const reason = candidate?.finishReason ?? res.promptFeedback?.blockReason ?? "応答なし";
      return { toolCalls: [], text: "", problem: reason === FinishReason.MAX_TOKENS ? "AI の応答が出力の上限で途切れました" : `AI の応答が途中で止まりました (${reason})` };
    }

    this.contents.push(user, content);
    return {
      toolCalls: calls.map((c) => ({ id: c.id ?? `${LOCAL_ID}${++this.calls}`, name: c.name ?? "", input: c.args ?? {} })),
      // res.text は関数呼び出しを含む応答で警告を出すので、テキスト部分だけを自分で集める
      text: (content.parts ?? []).flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join(""),
    };
  }
}

export function geminiProvider(options: { apiKey?: string; effort: Effort; client?: Client }): LlmProvider {
  // SDK の既定は 429 などで最大 5 回 (間隔は最長 60 秒) 自動で再試行し、その間画面が固まる。1 回の再試行までにとどめる
  const client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 2 } } });
  return { id: "gemini", newSession: (o) => new GeminiSession(client, o, options.effort) };
}

/** API キーが使えるかを、料金のかからないモデル一覧の取得で確かめる (使えなければ SDK のエラーを投げる) */
export async function verifyGeminiKey(apiKey: string): Promise<void> {
  await new GoogleGenAI({ apiKey, httpOptions: { timeout: VERIFY_TIMEOUT_MS, retryOptions: { attempts: 1 } } }).models.list({ config: { pageSize: 1 } });
}
