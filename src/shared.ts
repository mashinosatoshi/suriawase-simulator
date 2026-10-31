// サーバーとブラウザで共有する型と定数。
// ここにあるのは「プレイヤーに見えてよいもの」だけ。隠し状態 (本当の懸念・解消条件など) は scenario.ts / engine.ts 側にだけ置く。

// プレイヤーの入力は自由な会話文だけ (行動の種類は選ばない)。
// 質問・共感・提案・譲歩のどれなのかは AI が文面から汲み取る。例外は「持ち帰って終える」ボタンだけ。

export const MAX_TRUST = 5;
export const MAX_PLAYER_TEXT = 500;

export type Phase = "setup" | "player_turn" | "ai_turn" | "ended";
export type ConcernStatus = "hidden" | "revealed" | "proposed" | "resolved";

export const STATUS_LABELS: Record<ConcernStatus, string> = {
  hidden: "未発見",
  revealed: "未解決",
  proposed: "検討中",
  resolved: "解消",
};

export interface Mood {
  emoji: string;
  label: string;
}

export interface PublicCharacter {
  id: string;
  name: string;
  emoji: string;
  role: string;
  mood: Mood;
}

export interface PublicConcern {
  id: string;
  owner: string;
  category: string;
  /** 未発見の懸念は一覧に載らない。hidden になるのは終了後の missed だけ */
  status: ConcernStatus;
  text: string;
  /** 終了後の合意書にだけ載る。ゲーム中は送らない (ボードのカードは本音の内容と状態だけ) */
  agreement?: string;
  missed?: boolean;
}

export interface LogLine {
  id: number;
  // 進行の要約 (本音が見えた・信頼度が上がった等) はログに出さない。会話と地の文だけ
  from: "player" | "character" | "narrator";
  text: string;
  /** character: 話者の id */
  speaker?: string;
  /** player: 宛先 */
  to?: string;
}

export type EndingType = "full_agreement" | "compromise" | "carry_over";
export type EndReason = "all_resolved" | "deferred" | "turn_limit";

export interface Ending {
  type: EndingType;
  reason: EndReason;
  epilogue: string;
  resolved: number;
  total: number;
}

// ---- 難易度 ----------------------------------------------------------------------
// 難易度はパラメータの組 (プリセット)。開始画面の「パラメータ」ウィンドウで見て、微調整できる。
// ふだんの画面 (難易度の説明・懸念ボード) には懸念の数を出さない。見たい人だけがウィンドウを開いて見る

export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard"];

/** 開始画面に出す説明 */
export const DIFFICULTY_INFO: Record<Difficulty, { label: string; summary: string }> = {
  easy: { label: "簡単", summary: "相手は最初から好意的で、こちらの言いたいことを汲み取ってくれる。抱えている本音は少なめ。" },
  normal: { label: "普通", summary: "相手は様子見から始まる。話を重ねれば、相手から歩み寄ってくれることもある。" },
  hard: { label: "難しい", summary: "相手は最初から不信感を持ち、はっきり言わないと伝わらない。抱えている本音も多く、時間の余裕も少ない。" },
};

/** 物わかりの良さ: 提案をどこまで汲み取るか・解消の判定の厳しさ (AI への指示で決まる) */
export type Understanding = "good" | "normal" | "poor";
export const UNDERSTANDING_LABELS: Record<Understanding, string> = { good: "よい", normal: "ふつう", poor: "わるい" };

export interface DifficultyParams {
  /** 懸念 (本音) の数 */
  concerns: number;
  /** そのうち、最初から話してくれる本音の数 (min_trust が初期の信頼度以下)。残りは打ち解けるまで話さない */
  openAtStart: number;
  /** 初期の信頼度 (0 = 険悪 〜 3 = 好意的)。冒頭の口調と気分もこれに合わせる */
  trustStart: number;
  /** ターン数の上限 = 懸念の数 × これ + TURN_BASE */
  turnsPerConcern: number;
  understanding: Understanding;
  /** 相手からの歩み寄り: 本音が見えた後、プレイヤーがその話題に向き合った別々のターンの数 */
  initiativeTurns: number;
  /** 相手からの歩み寄り: 要る信頼度 (その本音の min_trust + 1 のほうが高ければそちら) */
  initiativeTrust: number;
  /** 相手からの歩み寄り: このターン数に 1 回まで */
  initiativeCooldown: number;
}

export const DIFFICULTY_PRESETS: Record<Difficulty, DifficultyParams> = {
  easy: { concerns: 4, openAtStart: 2, trustStart: 3, turnsPerConcern: 4, understanding: "good", initiativeTurns: 1, initiativeTrust: 2, initiativeCooldown: 1 },
  normal: { concerns: 5, openAtStart: 2, trustStart: 2, turnsPerConcern: 3, understanding: "normal", initiativeTurns: 2, initiativeTrust: 3, initiativeCooldown: 2 },
  hard: { concerns: 7, openAtStart: 1, trustStart: 0, turnsPerConcern: 2, understanding: "poor", initiativeTurns: 3, initiativeTrust: 4, initiativeCooldown: 3 },
};

export const TURN_BASE = 4;
export const turnLimitOf = (p: DifficultyParams) => p.concerns * p.turnsPerConcern + TURN_BASE;

type NumericParam = Exclude<keyof DifficultyParams, "understanding">;
/** 数値のパラメータの範囲と説明 (「パラメータ」ウィンドウとサーバーの検証で共通) */
export const PARAM_SPECS: Record<NumericParam, { label: string; min: number; max: number; help: string }> = {
  concerns: { label: "懸念の数", min: 3, max: 8, help: "相手が抱えている本音の数。多いほど難しい" },
  openAtStart: { label: "最初から話せる本音の数", min: 1, max: 8, help: "打ち解けていなくても話してくれる本音の数。残りは信頼関係ができるまで話さない" },
  trustStart: { label: "最初の信頼度", min: 0, max: 3, help: "0 = 険悪 / 1 = 警戒 / 2 = 様子見 / 3 = 好意的 (最大は 5)。冒頭の口調と気分もこれに合わせる" },
  turnsPerConcern: { label: "懸念 1 つあたりのターン数", min: 2, max: 5, help: `ターン数の上限 = 懸念の数 × これ + ${TURN_BASE}` },
  initiativeTurns: { label: "歩み寄りに要るターン数", min: 1, max: 4, help: "本音が見えた後、何ターンその話に向き合えば、相手から歩み寄ってくれるか" },
  initiativeTrust: { label: "歩み寄りに要る信頼度", min: 1, max: 5, help: "相手から歩み寄るのに要る信頼度 (その本音を話し始める信頼度 + 1 のほうが高ければそちら)" },
  initiativeCooldown: { label: "歩み寄りの間隔", min: 1, max: 4, help: "相手からの歩み寄りは、このターン数に 1 回まで" },
};

export const sameParams = (a: DifficultyParams, b: DifficultyParams) => (Object.keys(a) as Array<keyof DifficultyParams>).every((k) => a[k] === b[k]);

// ---- API キーらしい文字列 ------------------------------------------------------------
// チャットやシナリオの希望に貼られたキーは、会話として AI の会社に送られ、記録にも残ってしまう。送る前に止める

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Claude の API キー", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["OpenAI の API キー", /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ["Google の API キー", /AIza[0-9A-Za-z_-]{30,}/],
  ["Google の API キー", /(?<![A-Za-z0-9])AQ\.[0-9A-Za-z_-]{20,}/],
];

/** API キーらしい文字列があれば、その種類を返す */
export function findSecretLike(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name;
  return null;
}

export const secretInTextMessage = (kind: string) =>
  `${kind}のような文字列が含まれています。キーをここに書くと、会話として AI の会社に送られてしまいます。キーは「AI の設定」でだけ入力してください`;

// ---- AI の接続 ------------------------------------------------------------------

export type ProviderId = "anthropic" | "openai" | "gemini";

export interface AiProviderOption {
  id: ProviderId;
  label: string;
  defaultModel: string;
  models: Array<{ id: string; label: string }>;
  /** API キーが入力済みか (キーそのものはブラウザに送らない) */
  hasKey: boolean;
  /** API キーを発行するページ */
  keyUrl: string;
  /** キーと会話の送り先 (ブラウザから直接送る) */
  apiHost: string;
  /** このゲーム専用のキーを作り、使いすぎを防ぐ手順 */
  keySteps: string[];
}

export interface AiStatus {
  /** builtin = サーバーが各社の API を直接呼ぶ / mcp = Claude Code などが MCP 経由で動かす */
  mode: "builtin" | "mcp";
  /** ヘッダーに出す一言 */
  label: string;
  connected: boolean;
  /** builtin: 選べる提供元すべて (キーが未設定のものも含む) */
  providers: AiProviderOption[];
  current: { provider: ProviderId; model: string } | null;
  /** AI の呼び出しに失敗して止まっているとき (再試行を待つ) */
  error: string | null;
}

/** 終了後に AI が書く振り返り */
export interface PublicReview {
  overall: string;
  good: string[];
  improve: string[];
  /** 解消できなかった懸念ごとの助言 */
  concerns: Array<{ id: string; advice: string }>;
}

export interface PublicState {
  /** 新しいゲームを始めるたびに増える。クライアントは変化したら画面を作り直す */
  epoch: number;
  phase: Phase;
  /** いまのゲーム (作成中を含む) の難易度。customized = パラメータを微調整した */
  difficulty: Difficulty;
  customized: boolean;
  /** setup 中に「新しいシナリオを作って」と頼んだ状態 */
  generating: boolean;
  scenario: null | {
    title: string;
    premise: string;
    playerRole: string;
    goal: string;
    /** 前提情報: プレイヤーの立場なら当然知っている事実 (冒頭に表示する) */
    briefing: Array<{ label: string; text: string }>;
    turnLimit: number;
    characters: PublicCharacter[];
  };
  turn: number;
  // 信頼度は隠し状態。現実の対話と同じく数値では見せず、キャラクターの気分 (mood) や口調でだけ伝わる
  concerns: PublicConcern[];
  log: LogLine[];
  ending: Ending | null;
  /** 終了後、AI が書き終えるまでは null */
  review: PublicReview | null;
  ai: AiStatus;
}

export const ENDING_LABELS: Record<EndingType, { icon: string; title: string }> = {
  full_agreement: { icon: "🤝", title: "完全合意" },
  compromise: { icon: "🕊️", title: "妥協案で合意" },
  carry_over: { icon: "📦", title: "持ち帰り" },
};
