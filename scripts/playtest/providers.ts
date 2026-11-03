// 各役 (GM・プレイヤー役・審査役) の AI の接続部を作り、使用量を数える。
// ゲームと同じ接続部 (src/llm/) をそのまま使う。応答に載るトークン数も数える (費用の見積もりと、1 分あたりの上限に合わせるため)
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { anthropicProvider } from "../../src/llm/anthropic.js";
import { geminiProvider } from "../../src/llm/gemini.js";
import type { ChatSession, LlmProvider } from "../../src/llm/index.js";
import { openAiProvider } from "../../src/llm/openai.js";
import { REQUEST_TIMEOUT_MS } from "../../src/llm/types.js";
import type { RoleSpec } from "./config.js";

export interface Usage {
  calls: number;
  /** 入力のトークン数 (Claude はキャッシュ読みを含まない。Gemini と GPT は含む) */
  input: number;
  /** 出力のトークン数 (考える過程の分も含む) */
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** 1 分あたりの上限。0 = 上限なし */
export interface RateLimits {
  calls: number;
  tokens: number;
}

/**
 * 1 分あたりの呼び出し回数とトークン数を、上限より少なく抑える (超えそうなら、空くまで待つ)。
 * 無料枠の上限 (Gemini の Flash-Lite は 1 分 15 回・25 万トークンなど) に当たらないようにする。上限はキー (提供元) ごとなので、
 * GM とプレイヤー役が同じ提供元なら、同じものを共有する。
 * トークン数は呼び出す前には分からないので、見込み (同じ会話の前回の数) で待ち、終わってから実際の数に書き換える
 */
export class RateLimiter {
  private log: Array<{ at: number; tokens: number }> = [];
  constructor(
    private limits: RateLimits,
    private onWait: (ms: number, reason: string) => void = () => {},
    private windowMs = 60_000,
  ) {}

  /** 呼び出しの前に待つ。戻り値は記録で、呼び出しの後に tokens を実際の数に書き換える */
  async take(estimate: number): Promise<{ at: number; tokens: number }> {
    for (;;) {
      const now = Date.now();
      this.log = this.log.filter((e) => now - e.at < this.windowMs);
      const used = this.log.reduce((n, e) => n + e.tokens, 0);
      const callsOk = !this.limits.calls || this.log.length < this.limits.calls;
      // 1 回で上限を超える見込みでも、直近の呼び出しが無ければ通す (いつまでも待たないように)
      const tokensOk = !this.limits.tokens || used + estimate <= this.limits.tokens || this.log.length === 0;
      if (callsOk && tokensOk) {
        const entry = { at: now, tokens: estimate };
        this.log.push(entry);
        return entry;
      }
      const wait = this.windowMs - (now - this.log[0].at) + 200;
      this.onWait(wait, callsOk ? "トークン数" : "回数");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** 会話の最初の呼び出しのトークン数の見込み (指示文とツールの定義で、GM は 1 万前後になる) */
const FIRST_ESTIMATE = 12_000;

/** 応答の数を数え、上限があれば呼び出しの前に待つ (どの提供元でも) */
function counted(provider: LlmProvider, usage: Usage, limiter: RateLimiter | null): LlmProvider {
  return {
    id: provider.id,
    newSession(options) {
      const session = provider.newSession(options);
      // 会話は毎回の呼び出しで履歴ごと送るので、前回より少し多めに見込む
      let last = 0;
      const wrapped: ChatSession = {
        async next(input) {
          const entry = await limiter?.take(last ? Math.round(last * 1.15) + 500 : FIRST_ESTIMATE);
          usage.calls++;
          const before = usage.input + usage.output;
          try {
            return await session.next(input);
          } finally {
            // 呼び出しは 1 つずつ順に行うので、合計の増え分がこの呼び出しのトークン数 (数えられない提供元では見込みのまま)
            const spent = usage.input + usage.output - before;
            if (spent > 0) {
              last = spent;
              if (entry) entry.tokens = spent;
            }
          }
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

function geminiCounted(apiKey: string, spec: RoleSpec, usage: Usage): LlmProvider {
  // 接続の設定はゲームと同じ (src/llm/gemini.ts)。429 などの自動の再試行は 1 回まで
  const real = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 2 } } });
  const generate = real.models.generateContent.bind(real.models);
  const client = {
    models: {
      async generateContent(...args: Parameters<typeof generate>) {
        const res = await generate(...args);
        const u = res.usageMetadata;
        usage.input += u?.promptTokenCount ?? 0;
        usage.output += (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
        usage.cacheRead += u?.cachedContentTokenCount ?? 0;
        return res;
      },
    },
  };
  return geminiProvider({ apiKey, effort: spec.effort, client: client as unknown as Pick<GoogleGenAI, "models"> });
}

function openAiCounted(apiKey: string, spec: RoleSpec, usage: Usage): LlmProvider {
  const real = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  const create = real.responses.create.bind(real.responses);
  const client = {
    responses: {
      async create(...args: Parameters<typeof create>) {
        const res = (await create(...args)) as OpenAI.Responses.Response;
        usage.input += res.usage?.input_tokens ?? 0;
        usage.output += res.usage?.output_tokens ?? 0;
        usage.cacheRead += res.usage?.input_tokens_details?.cached_tokens ?? 0;
        return res;
      },
    },
  };
  return openAiProvider({ apiKey, effort: spec.effort, client: client as unknown as Pick<OpenAI, "responses"> });
}

export function makeProvider(spec: RoleSpec, apiKey: string, usage: Usage, limiter: RateLimiter | null = null): LlmProvider {
  const base = spec.provider === "anthropic" ? anthropicCounted(apiKey, spec, usage) : spec.provider === "gemini" ? geminiCounted(apiKey, spec, usage) : openAiCounted(apiKey, spec, usage);
  return counted(base, usage, limiter);
}
