// 各役 (GM・プレイヤー役・審査役) の AI の接続部を作り、使用量を数える。
// ゲームと同じ接続部 (src/llm/) をそのまま使う。Claude だけは応答に載るトークン数も数える (費用の見積もり用)
import Anthropic from "@anthropic-ai/sdk";
import { anthropicProvider } from "../../src/llm/anthropic.js";
import { createProvider, type ChatSession, type LlmProvider } from "../../src/llm/index.js";
import { REQUEST_TIMEOUT_MS } from "../../src/llm/types.js";
import type { RoleSpec } from "./config.js";

export interface Usage {
  calls: number;
  /** 以下は Claude のときだけ数える (ほかの提供元は 0 のまま) */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * 1 分あたりの呼び出し回数を上限より少なく抑える (超えそうなら、空くまで待つ)。
 * 無料枠の上限 (Gemini の Flash-Lite は 1 分 15 回など) に当たらないようにする。上限はキー (提供元) ごとなので、
 * GM とプレイヤー役が同じ提供元なら、同じものを共有する
 */
export class RateLimiter {
  private times: number[] = [];
  constructor(
    private perWindow: number,
    private onWait: (ms: number) => void = () => {},
    private windowMs = 60_000,
  ) {}

  async take() {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((t) => now - t < this.windowMs);
      if (this.times.length < this.perWindow) {
        this.times.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.times[0]) + 200;
      this.onWait(wait);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** 応答の数を数え、上限があれば呼び出しの前に待つ (どの提供元でも) */
function counted(provider: LlmProvider, usage: Usage, limiter: RateLimiter | null): LlmProvider {
  return {
    id: provider.id,
    newSession(options) {
      const session = provider.newSession(options);
      const wrapped: ChatSession = {
        async next(input) {
          await limiter?.take();
          usage.calls++;
          return session.next(input);
        },
      };
      return wrapped;
    },
  };
}

function anthropicCounted(apiKey: string, spec: RoleSpec, usage: Usage): LlmProvider {
  const real = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  const create = real.beta.messages.create.bind(real.beta.messages);
  const client = {
    beta: {
      messages: {
        async create(...args: Parameters<typeof create>) {
          const res = (await create(...args)) as Anthropic.Beta.BetaMessage;
          usage.input += res.usage.input_tokens;
          usage.output += res.usage.output_tokens;
          usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
          usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;
          return res;
        },
      },
    },
  };
  return anthropicProvider({ apiKey, effort: spec.effort, client: client as unknown as Pick<Anthropic, "beta"> });
}

export function makeProvider(spec: RoleSpec, apiKey: string, usage: Usage, limiter: RateLimiter | null = null): LlmProvider {
  const base = spec.provider === "anthropic" ? anthropicCounted(apiKey, spec, usage) : createProvider(spec.provider, { apiKey, effort: spec.effort });
  return counted(base, usage, limiter);
}
