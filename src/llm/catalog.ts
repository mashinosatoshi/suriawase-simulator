// 選べる AI の提供元とモデル。モデル ID は 2026-10 時点の各社の公式資料に基づく。
// ここに無いモデルも、開始画面の「その他」でモデル ID を入力すれば使える。
import type { ProviderId } from "./types.js";

export interface CatalogEntry {
  label: string;
  /** API キーを発行するページ (開始画面に案内として出す) */
  keyUrl: string;
  /** キーと会話の送り先 (ブラウザから直接送る。開始画面に出す) */
  apiHost: string;
  /**
   * このゲーム専用のキーを作り、使いすぎを防ぐ手順 (開始画面の「安全に使うために」に出す)。
   * 各社の公式ドキュメント (2026-10 時点) に基づく。管理画面の名前や仕様は変わるので、ときどき見直す
   */
  keySteps: string[];
  defaultModel: string;
  models: Array<{ id: string; label: string }>;
}

export const CATALOG: Record<ProviderId, CatalogEntry> = {
  anthropic: {
    label: "Claude (Anthropic)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    apiHost: "api.anthropic.com",
    keySteps: [
      "Claude Console の「Workspaces」で、このゲーム用のワークスペースを作る (最初からある Default ワークスペースには上限を設定できない)",
      "そのワークスペースの「Spend limits」で、月の上限額を設定する",
      "そのワークスペースで API キーを発行して、ここに貼り付ける (キーは作ったワークスペースの上限の中でしか使えない)",
    ],
    defaultModel: "claude-opus-5-5",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5 (高性能)" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (バランス)" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (低コスト)" },
    ],
  },
  openai: {
    label: "GPT (OpenAI)",
    keyUrl: "https://platform.openai.com/api-keys",
    apiHost: "api.openai.com",
    keySteps: [
      "OpenAI Platform で、このゲーム用のプロジェクトを作る",
      "プロジェクトの月の上限額 (spend limit) を設定し、「Enforce a hard limit」を有効にする (上限に達すると呼び出しが止まる)",
      "そのプロジェクトで API キーを発行する。権限を絞れる場合は、モデル一覧の読み取りと応答の作成 (Responses) だけにする",
    ],
    defaultModel: "gpt-6-astra",
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra (高性能)" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol (バランス)" },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra (高速)" },
      { id: "gpt-6-luna", label: "GPT-6 Luna (低コスト)" },
    ],
  },
  gemini: {
    label: "Gemini (Google)",
    keyUrl: "https://aistudio.google.com/apikey",
    apiHost: "generativelanguage.googleapis.com",
    keySteps: [
      "Google AI Studio で、このゲーム用のプロジェクトを作ってキーを発行する (AI Studio で作ったキーは、最初から Gemini API 専用に制限されている)",
      "請求 (課金) を設定していないプロジェクトなら無料枠だけで動き、料金はかからない。ただし無料枠では、入力と応答が Google のサービス改善に使われ、人が読むことがある",
      "有料で使う場合は、AI Studio の「Spend」でプロジェクトの月の上限額を設定する (反映に時間差があり、少し超えることがある)",
    ],
    // 無料枠で 1 ゲーム (API 呼び出し 20 回以上) を無理なく遊べるのは Flash-Lite だけなので、既定にする。
    // 3.8 Flash は無料枠の 1 日の回数が少なく、最上位の gemini-4-argon は無料枠では使えない (上限 0)
    defaultModel: "gemini-3.5-flash-lite",
    models: [
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (おすすめ・無料枠で遊びやすい)" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (無料枠は 1 日の回数が少ない)" },
      { id: "gemini-4-argon", label: "Gemini 4 Argon (高性能・有料枠のみ)" },
    ],
  },
};

export const PROVIDER_IDS = Object.keys(CATALOG) as ProviderId[];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
export const isValidModelId = (m: string) => MODEL_ID.test(m);
