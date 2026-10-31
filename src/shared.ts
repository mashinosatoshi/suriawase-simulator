// サーバーとブラウザで共有する型と定数。
// ここにあるのは「プレイヤーに見えてよいもの」だけ。隠し状態 (本当の懸念・解消条件など) は scenario.ts / engine.ts 側にだけ置く。

// プレイヤーの入力は自由な会話文だけ (行動の種類は選ばない)。
// 質問・共感・提案・譲歩のどれなのかは AI が文面から汲み取る。例外は「持ち帰って終える」ボタンだけ。

export const MAX_PLAYER_TEXT = 500;

// 信頼度と物わかりは 1〜10 の 10 段階で、登場人物ごとに持つ (難易度のパラメータは、その平均の目安)
export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;
/** 1〜10 を 2 段階ずつ 5 つに分けた呼び名 (パラメータ欄と AI への説明で使う) */
export const TRUST_LEVEL_NAMES = ["険悪", "警戒", "様子見", "好意的", "信頼"] as const;
export const UNDERSTANDING_LEVEL_NAMES = ["とても悪い", "悪い", "ふつう", "よい", "とてもよい"] as const;
/** 本音の重要度 (1〜10) の呼び名。要望の緩急 */
export const IMPORTANCE_LEVEL_NAMES = ["譲ってもよい", "できれば", "大事", "必ず達成したい", "譲れない"] as const;
/** この重要度以上の本音は「これだけは譲れない」。1 つでも解消できないと、合意にはならない (持ち帰り) */
export const NON_NEGOTIABLE = 9;
/** 段階 (1〜10) が、呼び名のどれにあたるか (0〜4) */
export const levelBand = (v: number) => Math.min(4, Math.max(0, Math.floor((v - MIN_LEVEL) / 2)));

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
  /** その人にとっての重要度 (1〜10)。終了後の答え合わせにだけ載る (現実と同じく、相手の思いの強さは数値では見えない) */
  importance?: number;
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
  /** 解消した本音の重要度の合計 / すべての本音の重要度の合計。妥協案で合意できるのは、半分以上のとき */
  importance: { resolved: number; total: number };
  /** 解消できなかった「譲れない」本音の数。1 つでも残ると持ち帰り */
  nonNegotiableLeft: number;
  /** スコア (エンジンが計算する。score.ts) */
  score: GameScore;
}

export type ScoreRank = "S" | "A" | "B" | "C" | "D";

/** 本音 1 つぶんの得点 */
export interface ScoreItem {
  id: string;
  importance: number;
  discovered: boolean;
  resolved: boolean;
  /** 引き出しの難しさ (%)。打ち解けるまで話してくれない本音ほど高い */
  discoverRate: number;
  /** 解決の難しさ (%)。物わかりが悪く、最初から信頼されていない相手ほど高い */
  resolveRate: number;
  /** 引き出し点 (重要度 × 引き出しの難しさ)。引き出せなかったら 0 */
  discoverPoints: number;
  /** 解決点 (重要度 × 解決の難しさ)。解決できなかったら 0 */
  resolvePoints: number;
  /** この本音で取れた最高点 (引き出し点 + 解決点) */
  maxPoints: number;
}

/** どれだけ重要な本音を、手ごわい相手から引き出し、解決に導いたか */
export interface GameScore {
  total: number;
  /** このシナリオの満点 (すべて引き出して解決し、完全合意したとき) */
  max: number;
  /** 満点に対する割合 (%、切り捨て) */
  percent: number;
  rank: ScoreRank;
  /** 完全合意のボーナス (完全合意でなければ 0) */
  bonus: number;
  items: ScoreItem[];
}

// ---- 難易度 ----------------------------------------------------------------------
// 難易度はパラメータの組 (プリセット)。開始画面の「パラメータ」ウィンドウで見て、微調整できる。
// ふだんの画面 (難易度の説明・懸念ボード) には懸念の数を出さない。見たい人だけがウィンドウを開いて見る

/** random = パラメータを毎回ランダムに決める (何が選ばれたかは、終了後に分かる) */
export type Difficulty = "easy" | "normal" | "hard" | "random";
/** パラメータの組 (プリセット) がある難易度 */
export type PresetDifficulty = Exclude<Difficulty, "random">;
export const DIFFICULTIES: Difficulty[] = ["easy", "normal", "hard", "random"];
/** 開始画面で最初に選ばれている難易度 (プレイヤーがまだ選んでいないとき) */
export const DEFAULT_DIFFICULTY: Difficulty = "random";

/** 開始画面に出す説明 */
export const DIFFICULTY_INFO: Record<Difficulty, { label: string; summary: string }> = {
  easy: { label: "簡単", summary: "相手は最初から好意的で、こちらの言いたいことを汲み取ってくれる。抱えている本音は少なめ。" },
  normal: { label: "普通", summary: "相手は様子見から始まる。話を重ねれば、相手から歩み寄ってくれることもある。" },
  hard: { label: "難しい", summary: "相手は最初から不信感を持ち、はっきり言わないと伝わらない。抱えている本音も多く、時間の余裕も少ない。" },
  random: { label: "ランダム", summary: "パラメータ (本音の数・相手の打ち解けやすさや物わかり・ターン数など) を毎回ランダムに決める。どんな相手かは、話してみるまで分からない。何が選ばれたかは、終わった後に見られる。" },
};

export interface DifficultyParams {
  /** 懸念 (本音) の数 */
  concerns: number;
  /** そのうち、最初から話してくれる本音の数 (min_trust が初期の信頼度以下)。残りは打ち解けるまで話さない */
  openAtStart: number;
  /** そのうち、これだけは譲れない本音 (重要度 9〜10) の数 */
  nonNegotiable: number;
  /** 登場人物の最初の信頼度の平均 (1 = 険悪 〜 10 = 信頼)。各キャラの値は人柄に合わせてばらつく。冒頭の口調と気分もこれに合わせる */
  trustStart: number;
  /** ターン数の上限 = 懸念の数 × これ + TURN_BASE */
  turnsPerConcern: number;
  /** 登場人物の物わかりの平均 (1〜10): 提案をどこまで汲み取るか・解消の判定の厳しさ (AI への指示で決まる) */
  understanding: number;
  /** 相手からの歩み寄り: 本音が見えた後、プレイヤーがその話題に向き合った別々のターンの数 */
  initiativeTurns: number;
  /** 相手からの歩み寄り: その本音を持つ人に要る信頼度 (その本音の min_trust + 1 のほうが高ければそちら) */
  initiativeTrust: number;
  /** 相手からの歩み寄り: このターン数に 1 回まで */
  initiativeCooldown: number;
}

export const DIFFICULTY_PRESETS: Record<PresetDifficulty, DifficultyParams> = {
  easy: { concerns: 4, openAtStart: 2, nonNegotiable: 1, trustStart: 7, turnsPerConcern: 4, understanding: 8, initiativeTurns: 1, initiativeTrust: 5, initiativeCooldown: 1 },
  normal: { concerns: 5, openAtStart: 2, nonNegotiable: 1, trustStart: 5, turnsPerConcern: 3, understanding: 5, initiativeTurns: 2, initiativeTrust: 7, initiativeCooldown: 2 },
  hard: { concerns: 7, openAtStart: 1, nonNegotiable: 2, trustStart: 2, turnsPerConcern: 2, understanding: 2, initiativeTurns: 3, initiativeTrust: 8, initiativeCooldown: 3 },
};

export const TURN_BASE = 4;
export const turnLimitOf = (p: DifficultyParams) => p.concerns * p.turnsPerConcern + TURN_BASE;

/** パラメータの範囲と説明 (「パラメータ」ウィンドウとサーバーの検証で共通) */
export const PARAM_SPECS: Record<keyof DifficultyParams, { label: string; min: number; max: number; help: string }> = {
  concerns: { label: "懸念の数", min: 3, max: 8, help: "相手が抱えている本音の数。多いほど難しい" },
  openAtStart: { label: "最初から話せる本音の数", min: 1, max: 8, help: "打ち解けていなくても話してくれる本音の数。残りは信頼関係ができるまで話さない" },
  nonNegotiable: { label: "譲れない本音の数", min: 0, max: 3, help: "重要度 9〜10 (これだけは譲れない) の本音の数。1 つでも解消できないと、合意にはならず持ち帰りになる。残りの本音の重要度は 1〜8 で緩急がつく" },
  trustStart: { label: "最初の信頼度 (平均)", min: MIN_LEVEL, max: MAX_LEVEL - 1, help: "1〜10 (1〜2 険悪 / 3〜4 警戒 / 5〜6 様子見 / 7〜8 好意的 / 9〜10 信頼)。登場人物ごとに人柄に合わせてばらつき、その平均がこの値になる。冒頭の口調と気分もこれに合わせる" },
  understanding: { label: "物わかり (平均)", min: MIN_LEVEL, max: MAX_LEVEL, help: "1 = 字面どおりにしか受け取らない 〜 10 = 言いたいことを汲み取ってくれる。提案をどこまで汲み取るか、解消の判定の厳しさ。登場人物ごとにばらつき、その平均がこの値になる" },
  turnsPerConcern: { label: "懸念 1 つあたりのターン数", min: 2, max: 5, help: `ターン数の上限 = 懸念の数 × これ + ${TURN_BASE}` },
  initiativeTurns: { label: "歩み寄りに要るターン数", min: 1, max: 4, help: "本音が見えた後、何ターンその話に向き合えば、相手から歩み寄ってくれるか" },
  initiativeTrust: { label: "歩み寄りに要る信頼度", min: MIN_LEVEL, max: MAX_LEVEL, help: "相手から歩み寄るのに要る、その人の信頼度 (1〜10。その本音を話し始める信頼度 + 1 のほうが高ければそちら)" },
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
  /** 終了後だけ: このゲームのパラメータ (ランダムのとき、何が選ばれたかの答え合わせ)。ゲーム中は null */
  params: DifficultyParams | null;
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
