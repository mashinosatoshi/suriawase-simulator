// 画面から届く「新しいゲーム」の依頼の検証。ブラウザ版 (local.ts) と MCP 版のサーバー (server.ts) で共通
import { parseDifficulty } from "./difficulty.js";
import { findSecretLike, secretInTextMessage, type Difficulty, type DifficultyParams } from "./shared.js";

export function parseNewGame(body: Record<string, unknown>): { request: string; level: Difficulty; params: DifficultyParams } | { error: string } {
  const d = parseDifficulty(body.difficulty, body.params);
  if ("error" in d) return d;
  const request = typeof body.request === "string" ? body.request : "";
  // シナリオの希望に貼られたキーは、そのまま AI の会社に送られてしまう
  const secret = findSecretLike(request);
  if (secret) return { error: secretInTextMessage(secret) };
  return { request, level: d.level, params: d.params };
}
