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

/** 応答の数を数える (どの提供元でも) */
function counted(provider: LlmProvider, usage: Usage): LlmProvider {
  return {
    id: provider.id,
    newSession(options) {
      const session = provider.newSession(options);
      const wrapped: ChatSession = {
        async next(input) {
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

export function makeProvider(spec: RoleSpec, apiKey: string, usage: Usage): LlmProvider {
  const base = spec.provider === "anthropic" ? anthropicCounted(apiKey, spec, usage) : createProvider(spec.provider, { apiKey, effort: spec.effort });
  return counted(base, usage);
}
