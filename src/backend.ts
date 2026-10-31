// 画面 (client.ts) から見たゲームの本体。
// ふだんは local: エンジンと GM をこのページの中で動かし、利用者のキーで AI の会社の API を直接呼ぶ (運営のサーバーを通さない)。
// MCP 版 (Claude Code が GM) だけは remote: ローカルのサーバーと通信する。
import { Engine } from "./engine.js";
import { BuiltinGm } from "./gm.js";
import { CATALOG, checkKeyFormat, createProvider, describeError, isAuthError, PROVIDER_IDS, verifyKey, ApiKeys, type LlmProvider, type ProviderId } from "./llm/index.js";
import { parseNewGame } from "./requests.js";
import type { PublicState } from "./shared.js";

export type Action = "act" | "defer" | "new" | "replay" | "ai/retry" | "ai/select" | "ai/key" | "ai/forget";

export interface Backend {
  /** 操作を送る。うまくいかなければ、画面に出す理由を返す */
  send(action: Action, body?: Record<string, unknown>): Promise<string | null>;
  /** 状態が変わるたびに onState を呼ぶ */
  connect(onState: (s: PublicState) => void): void;
}

interface LocalDeps {
  makeProvider(id: ProviderId, apiKey: string | undefined): LlmProvider;
  verify(id: ProviderId, apiKey: string): Promise<void>;
  log(...a: unknown[]): void;
}

const defaultDeps: LocalDeps = {
  makeProvider: (id, apiKey) => createProvider(id, { apiKey, effort: "medium" }),
  verify: verifyKey,
  log: (...a) => console.info(...a),
};

/** ブラウザの中だけで動くゲーム。API キーはこのページのメモリにだけ置き、AI の会社以外には送らない */
export function createLocalBackend(deps: LocalDeps = defaultDeps): Backend {
  const engine = new Engine();
  const keys = new ApiKeys();
  let listener: ((s: PublicState) => void) | null = null;
  const push = () => listener?.({ ...engine.publicState(), ai: gm.status() });
  const gm = new BuiltinGm(engine, (id) => deps.makeProvider(id, keys.get(id)), keys, null, push, deps.log);
  engine.onChange(push);

  const providerOf = (body: Record<string, unknown>) => (PROVIDER_IDS.includes(body.provider as ProviderId) ? (body.provider as ProviderId) : null);

  /** キーが使えるかを、料金のかからない呼び出しで確かめてから受け付ける */
  async function saveKey(body: Record<string, unknown>): Promise<string | null> {
    const provider = providerOf(body);
    if (!provider) return "不明な AI です";
    const formatError = checkKeyFormat(body.key);
    if (formatError) return formatError;
    const key = (body.key as string).trim();
    try {
      await deps.verify(provider, key);
    } catch (err) {
      return isAuthError(err) ? "API キーが正しくありません。発行したキーをコピーし直して、貼り付けてください" : `キーを確かめられませんでした: ${describeError(err)}`;
    }
    keys.set(provider, key);
    gm.keyChanged(provider);
    push();
    return null;
  }

  const handlers: Record<Action, (body: Record<string, unknown>) => string | null | Promise<string | null>> = {
    act: (b) => engine.act({ text: b.text, to: b.to }),
    defer: (b) => engine.act({ text: b.text, to: b.to }, true),
    new: (b) => {
      if (!gm.status().current) return "AI が選ばれていません。先に「AI の設定」で AI を確定してください";
      const g = parseNewGame(b);
      if ("error" in g) return g.error;
      engine.requestNewGame(g.request, g.level, g.params);
      return null;
    },
    replay: () => engine.replay(),
    "ai/retry": () => (gm.retry(), null),
    "ai/select": (b) => {
      const provider = providerOf(b);
      if (!provider) return "不明な AI です";
      const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : CATALOG[provider].defaultModel;
      const error = gm.select({ provider, model });
      if (!error) push();
      return error;
    },
    "ai/key": saveKey,
    "ai/forget": (b) => {
      const provider = providerOf(b);
      if (!provider) return "不明な AI です";
      keys.delete(provider);
      gm.keyRemoved(provider);
      push();
      return null;
    },
  };

  return {
    async send(action, body = {}) {
      const handler = handlers[action];
      return handler ? handler(body) : "不明な操作です";
    },
    connect(onState) {
      listener = onState;
      push();
    },
  };
}

/** MCP 版: ローカルのサーバー (npm run mcp) と通信する。AI は Claude Code が務める */
export function createRemoteBackend(onWrongServer: () => void): Backend {
  return {
    async send(action, body = {}) {
      const res = await fetch(`/api/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      if (!res) return "ゲームのサーバーに接続できませんでした";
      if (res.ok) return null;
      return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "操作に失敗しました";
    },
    connect(onState) {
      new EventSource("/api/stream").onmessage = (e) => {
        const data = JSON.parse(e.data) as Partial<PublicState>;
        // 別のゲームのサーバーにつながってしまった (同じポートで別のプログラムが動いているなど)
        if (typeof data.phase !== "string" || typeof data.epoch !== "number" || !data.ai) return onWrongServer();
        onState(data as PublicState);
      };
    },
  };
}
