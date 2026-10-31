import { anthropicProvider, verifyAnthropicKey } from "./anthropic.js";
import { geminiProvider, verifyGeminiKey } from "./gemini.js";
import { openAiProvider, verifyOpenAiKey } from "./openai.js";
import type { Effort, LlmProvider, ProviderId } from "./types.js";

export * from "./catalog.js";
export * from "./keys.js";
export * from "./types.js";

/** 提供元ごとのクライアントを作る */
export function createProvider(id: ProviderId, options: { apiKey?: string; effort: Effort }): LlmProvider {
  switch (id) {
    case "anthropic":
      return anthropicProvider(options);
    case "openai":
      return openAiProvider(options);
    case "gemini":
      return geminiProvider(options);
  }
}

/** API キーが使えるかを確かめる (料金のかからないモデル一覧の取得で。使えなければ SDK のエラーを投げる) */
export function verifyKey(id: ProviderId, apiKey: string): Promise<void> {
  switch (id) {
    case "anthropic":
      return verifyAnthropicKey(apiKey);
    case "openai":
      return verifyOpenAiKey(apiKey);
    case "gemini":
      return verifyGeminiKey(apiKey);
  }
}

const statusOf = (err: unknown) => (typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : NaN);
const detailOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** キーが無効・権限が無いことを示すエラーか */
export function isAuthError(err: unknown): boolean {
  const status = statusOf(err);
  // Gemini は無効なキーを 400 (理由 API_KEY_INVALID) で返す。SDK に専用のエラー型が無いので理由コードで見分ける
  return status === 401 || status === 403 || (status === 400 && detailOf(err).includes("API_KEY_INVALID"));
}

/** API のエラーを、画面に出せる短い説明にする (各社の SDK のエラーは HTTP の status を持つ) */
export function describeError(err: unknown): string {
  const status = statusOf(err);
  const detail = detailOf(err);
  if (isAuthError(err)) return `API キーが無効か、このモデルを使う権限がありません (${status})`;
  // Anthropic は残高不足を 400 で返す (専用のエラー型が無いので、本文で見分ける)
  if (status === 400 && /credit balance is too low/i.test(detail)) return "API のクレジット残高が足りません。Anthropic Console の「Plans & Billing」でクレジットを購入してください (400)";
  if (status === 404) return `モデルが見つかりません。モデル ID を確認してください (${status})`;
  if (status === 429) return "利用上限 (レート制限または残高) に達しました。しばらく待つか、プランを確認してください (429)";
  if (status >= 500) return `AI のサービス側でエラーが起きました。少し待って再試行してください (${status})`;
  if (status === 400) return `AI への要求が受け付けられませんでした: ${detail.slice(0, 200)}`;
  // ブラウザから直接呼ぶので、通信が止められると status の無いエラーになる
  if (/Connection error|Failed to fetch|NetworkError|Load failed/i.test(detail)) {
    return "AI の会社に接続できませんでした。ネットワークや、広告ブロッカー・セキュリティソフトの設定を確かめてください";
  }
  return `AI の呼び出しに失敗しました: ${detail.slice(0, 200)}`;
}
