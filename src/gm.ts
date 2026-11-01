// 内蔵 GM: Claude Code (MCP) の代わりに、サーバー自身が各社の LLM API を呼んで GM を務める。
// エンジンの「AI の仕事」(pendingWork) を見張り、ツール呼び出しで片付ける。ルールの検証はすべてエンジン任せ。
import type { Engine, Work } from "./engine.js";
import { BUILTIN_INSTRUCTIONS } from "./instructions.js";
import { CATALOG, describeError, isValidModelId, PROVIDER_IDS, type AssistantTurn, type ChatSession, type LlmProvider, type ProviderId, type ToolCall, type ToolResult, type TurnInput } from "./llm/index.js";
import type { AiStatus } from "./shared.js";
import { GAME_TOOLS, toolJsonSchema, type GameToolName } from "./tools.js";

/** 1 つの仕事に使う API 呼び出しの上限。超えたら止めて、プレイヤーの「再試行」を待つ (際限なく課金しない) */
export const MAX_ATTEMPTS = 4;

const EXPECTED: Record<Work["type"], GameToolName> = { new_game: "start_scenario", player_action: "reply", review: "submit_review" };
const TOOL_SPECS = GAME_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toolJsonSchema(t) }));

export interface Selection {
  provider: ProviderId;
  model: string;
}

/** API キーが入力済みか (キーそのものは GM には要らない。クライアントを作る makeProvider が持つ) */
export interface KeyState {
  has(id: ProviderId): boolean;
}

function renderWork(work: Work): string {
  const what = work.type === "new_game" ? "新しいゲームの依頼です。" : work.type === "player_action" ? "プレイヤーの発言です。" : "対話が終わりました。";
  return `【仕事 type=${work.type}】${what}${EXPECTED[work.type]} を呼んでください。\n${JSON.stringify(work)}`;
}

/** ヘッダーに出すモデル名 (一覧に無いモデルは ID のまま) */
function labelOf(sel: Selection) {
  const entry = CATALOG[sel.provider];
  const known = entry.models.find((m) => m.id === sel.model);
  return known ? known.label.replace(/\s*\(.*\)$/, "") : `${entry.label} · ${sel.model}`;
}

const shorten = (t: string, n = 300) => (t.length > n ? `${t.slice(0, n)}…` : t);

export class BuiltinGm {
  private session: ChatSession | null = null;
  /** セッションが知っているゲームの世代。違えば会話を作り直す */
  private sessionEpoch = -1;
  /** セッションを作ったときの仕事 (同じ新規ゲームの再試行なら、同じ会話を続ける) */
  private sessionKey: string | null = null;
  /** 前回のツール呼び出しへの結果。次の送信で必ず返す (返さないと各社の API が履歴を受け付けない) */
  private pending: ToolResult[] = [];
  /** 実行中の処理と、その後に予約された処理 (重ねて走らせず、要求は取りこぼさない) */
  private current: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private failedKey: string | null = null;
  private error: string | null = null;

  constructor(
    private engine: Engine,
    private makeProvider: (id: ProviderId) => LlmProvider,
    private keys: KeyState,
    /** null = まだ選ばれていない (起動直後は、どの API キーも入力されていない) */
    private selection: Selection | null,
    private onStatus: () => void,
    private log: (...a: unknown[]) => void = () => {},
  ) {
    engine.onChange(() => void this.tick());
  }

  /** この AI を使う (次の呼び出しから。対話の途中なら、新しい会話に全状態を渡して引き継ぐ) */
  select(sel: Selection): string | null {
    if (!this.keys.has(sel.provider)) return "その AI の API キーが設定されていません。キーを入力して「決定」を押してください";
    if (!isValidModelId(sel.model)) return "モデル ID の形式が正しくありません";
    if (this.selection?.provider === sel.provider && this.selection.model === sel.model) return null; // 同じなら会話はそのまま
    this.selection = { ...sel };
    this.session = null;
    this.setError(null, null);
    return null;
  }

  /** API キーが入力された (入れ直された)。使っている提供元なら、次の呼び出しから新しいキーで作り直す */
  keyChanged(id: ProviderId) {
    if (this.selection?.provider !== id) return;
    this.session = null;
    // キーの誤りで止まっていたなら、新しいキーで続きを試す
    if (this.error) this.retry();
  }

  /** API キーが消された。使っていた提供元なら、AI の選択も外す (次は「AI の設定」から選び直す) */
  keyRemoved(id: ProviderId) {
    if (this.selection?.provider !== id) return;
    this.selection = null;
    this.session = null;
    this.onStatus();
  }

  /** 失敗で止まっている仕事を、もう一度試す */
  retry() {
    this.setError(null, null);
    void this.tick();
  }

  status(): AiStatus {
    const sel = this.selection;
    return {
      mode: "builtin",
      label: sel ? labelOf(sel) : "未設定",
      connected: !!sel,
      providers: PROVIDER_IDS.map((id) => {
        const { label, defaultModel, models, keyUrl, apiHost, keySteps } = CATALOG[id];
        return { id, label, defaultModel, models, keyUrl, apiHost, keySteps, hasKey: this.keys.has(id) };
      }),
      current: sel && { ...sel },
      error: this.error,
    };
  }

  /**
   * 仕事があれば片付ける。呼ばれた時点より後に始まる処理を予約し、その完了で解決する
   * (処理の終わり際に届いた仕事も、必ず次の処理で拾う)
   */
  tick(): Promise<void> {
    this.queued ??= this.current.then(() => {
      this.queued = null;
      this.current = this.drain().catch((err) => this.log("内蔵 GM の処理中にエラー:", err));
      return this.current;
    });
    return this.queued;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const work = this.engine.pendingWork();
      const key = work && this.keyOf(work);
      // 止まっていた仕事が無くなった (プレイヤーが最初からやり直した等) なら、エラー表示も消す
      if (this.failedKey && key !== this.failedKey) this.setError(null, null);
      if (!work || key === this.failedKey) return;
      await this.handle(work, key!);
    }
  }

  private keyOf(work: Work | null): string | null {
    if (!work) return null;
    return `${this.engine.epoch}:${work.type}:${work.type === "player_action" ? work.turn : ""}`;
  }

  private async handle(work: Work, key: string): Promise<void> {
    if (!this.selection) return this.setError(key, "AI が選ばれていません。開始画面で API キーを入力して、AI を選んでください");
    const fresh = !this.session || this.sessionEpoch !== this.engine.epoch || (work.type === "new_game" && this.sessionKey !== key);
    if (fresh) {
      this.session = this.makeProvider(this.selection.provider).newSession({ system: BUILTIN_INSTRUCTIONS, tools: TOOL_SPECS, model: this.selection.model });
      this.sessionEpoch = this.engine.epoch;
      this.sessionKey = key;
      this.pending = [];
    }
    const session = this.session!;
    // 会話の途中から引き継ぐとき (同じシナリオでやり直し・対話の途中で AI を変えた等) は、隠し情報と会話全体を含む全状態を最初に渡す
    const primer = fresh && work.type !== "new_game" ? `これは進行中のゲームです。いまの全状態 (隠し情報を含む):\n${JSON.stringify(this.engine.fullState({ wholeLog: true }))}\n\n` : "";
    let input: TurnInput = { toolResults: this.pending, text: primer + renderWork(work) };
    this.pending = [];
    let lastProblem = "";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let turn: AssistantTurn;
      try {
        turn = await session.next(input);
      } catch (err) {
        // 送れなかった入力は履歴に入っていない。返すべきツール結果は持ち越す
        this.pending = input.toolResults ?? [];
        // エラーの中身 (応答ヘッダーや、キーの一部を含むメッセージ) は出さず、説明だけをログに残す
        const message = describeError(err);
        this.log(`AI の呼び出しに失敗: ${message}`);
        return this.setError(key, message);
      }
      if (turn.problem) {
        lastProblem = turn.problem; // 履歴には入っていないので、同じ入力で送り直す
        continue;
      }
      if (!turn.toolCalls.length) {
        lastProblem = "AI がツールを呼びませんでした";
        input = { text: `${EXPECTED[work.type]} を呼んでください。テキストだけの返事は画面に表示されません。` };
        continue;
      }

      const results = turn.toolCalls.map((c) => this.run(c));
      if (this.keyOf(this.engine.pendingWork()) !== key) {
        if (results.some((r) => !r.isError)) {
          this.pending = results;
          this.sessionEpoch = this.engine.epoch;
        } else {
          // 応答を待つ間に仕事が変わった (プレイヤーが最初からやり直した等)。古い会話は捨てる
          this.session = null;
          this.pending = [];
        }
        return this.setError(null, null);
      }
      lastProblem = results.filter((r) => r.isError).map((r) => r.content).join("\n");
      this.log(`AI の返答を差し戻しました (${attempt}/${MAX_ATTEMPTS}): ${shorten(lastProblem.replace(/\s+/g, " "), 160)}`);
      input = { toolResults: results };
    }

    this.pending = input.toolResults ?? [];
    this.setError(key, `AI が有効な返答を作れませんでした (${MAX_ATTEMPTS} 回試行)。${shorten(lastProblem)}`);
  }

  private run(call: ToolCall): ToolResult {
    const tool = GAME_TOOLS.find((t) => t.name === call.name);
    if (!tool) return { id: call.id, name: call.name, content: `不明なツールです: ${call.name}。使えるのは ${GAME_TOOLS.map((t) => t.name).join(" / ")}`, isError: true };
    try {
      const out = tool.run(this.engine, call.input);
      return { id: call.id, name: call.name, content: out.text, isError: !out.ok };
    } catch (err) {
      return { id: call.id, name: call.name, content: `ツールの実行中にエラー: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private setError(key: string | null, message: string | null) {
    const changed = this.error !== message;
    this.failedKey = key;
    this.error = message;
    if (changed) this.onStatus();
  }
}
