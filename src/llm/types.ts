// 各社の LLM API を同じ形で扱うための最小限の型。会話の履歴は各社の形式のまま、セッションの中に持つ
// (Claude の thinking ブロック、OpenAI の reasoning アイテム、Gemini の thought signature を、そのまま返し直すため)。

import type { ProviderId } from "../shared.js";

export type { ProviderId };
export type Effort = "low" | "medium" | "high";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** AI への 1 回の送信: 前回のツール呼び出しへの結果と、続けて渡す文 */
export interface TurnInput {
  toolResults?: ToolResult[];
  text?: string;
}

export interface AssistantTurn {
  toolCalls: ToolCall[];
  text: string;
  /**
   * 応答が正常に終わらなかった理由 (出力の上限・安全上の拒否など)。
   * これがあるとき、セッションの履歴には何も追加されていない (同じ入力で送り直せる)。
   */
  problem?: string;
}

export interface ChatSession {
  next(input: TurnInput): Promise<AssistantTurn>;
}

export interface SessionOptions {
  system: string;
  tools: ToolSpec[];
  model: string;
}

export interface LlmProvider {
  id: ProviderId;
  newSession(options: SessionOptions): ChatSession;
}

/** API キーの確認 (モデル一覧の取得) を待つ上限 */
export const VERIFY_TIMEOUT_MS = 20_000;

/** 応答の出力上限。台詞とツール引数には十分な量 */
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * 1 回の API 呼び出しの時間切れ。各 SDK の既定 (10 分など) だと、詰まったときに画面が長く「考え中」のまま固まる。
 * 失敗したら GM が画面に知らせ、プレイヤーの「再試行」に任せる
 */
export const REQUEST_TIMEOUT_MS = 240_000;
