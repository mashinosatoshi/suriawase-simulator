import { defaultParams, difficultyBrief, difficultyLabel, isCustomized, opennessNote, probesNeeded, revealDifficulty, trustGainRate, trustName, understandingNote, type DifficultyBrief } from "./difficulty.js";
import {
  DIFFICULTY_PRESETS,
  MAX_LEVEL,
  MAX_PLAYER_TEXT,
  MIN_LEVEL,
  NON_NEGOTIABLE,
  type ConcernStatus,
  type Difficulty,
  type DifficultyParams,
  type Ending,
  type EndReason,
  type LogLine,
  type Mood,
  type Phase,
  type PublicConcern,
  type PublicReview,
  type PublicRoot,
  type PublicState,
  findSecretLike,
  secretInTextMessage,
  turnLimitOf,
} from "./shared.js";
import { scoreGame } from "./score.js";
import {
  checkScenario,
  findSteering,
  findUnsafeOutput,
  findVerdict,
  leaksSecret,
  reviewSchema,
  scenarioSchema,
  steeringMessage,
  unsafeMessage,
  verdictMessage,
  type ReplyInput,
  type Scenario,
} from "./scenario.js";
import { pickTheme, type Theme } from "./themes.js";

const MAX_LOG = 400;
const NEUTRAL_MOOD: Mood = { emoji: "😐", label: "ふつう" };
/** 引用の照合は空白 (全角含む) を無視する */
const squash = (t: string) => t.replace(/\s+/g, "");
/** 解消条件との照らし合わせに使わない記号を除く */
const plain = (t: string) => squash(t).replace(/[、。，．,.・「」『』（）()!?！？…]/g, "");
/** 解消のときの照らし合わせ (checks) は、解消条件のこれだけを覆っていればよい (語尾の「〜が示される」などは除いてよい) */
const MIN_CHECK_COVERAGE = 0.6;
const MIN_QUOTE = 4;

// 相手からの歩み寄り (initiative): 条件がそろったとき、キャラクターの側から「私はこうしたい」と着地点を示す。
// プレイヤーの積み重ねが根拠になっていることを、エンジンが確かめられる範囲で確かめる。
// 条件 (信頼度・根拠のターン数・間隔) は難易度のパラメータで決まる。
// しゃべりすぎを防ぐ。台詞の長さと数に上限が無いと、軽いモデルほど、聞かれていない事情や本音まで続けて話してしまう
/** 1 回の返答でしゃべるキャラクターの数 (話しかけられた人と、割り込む 1 人まで) */
const MAX_SPEAKERS = 2;
/** 1 回の返答の台詞の数 (地の文を除く) */
const MAX_CHARACTER_LINES = 3;
/** 1 つの台詞の長さ (空白を除いた文字数。短い話し言葉の 2〜3 文に収まる) */
const MAX_LINE_CHARS = 120;
/** 1 回の返答の台詞の長さの合計 */
const MAX_REPLY_CHARS = 240;
/** 地の文 (場面転換や時間の経過だけに使う) */
const MAX_NARRATOR_LINES = 1;
const MAX_NARRATOR_CHARS = 80;

// 本音を話す条件は厳密に確かめる (軽いモデルほど、一般的な質問で本音を次々に出してしまうため)。
// 1 回の返答で見つかる本音の数は縛らない (発言の中身が濃ければ、いくつ出てもよい) 代わりに、本音ごとに
// 「発言のどの部分が、本音のきっかけ (reveal_hint) のどの話題に触れたか」を引用させて照合し、発言の同じ部分を複数の本音に使わせない
/** 本音のきっかけ (hint) から除くと、話題そのものが残るか (「尋ねる」「話題」だけでは、どの本音の話題かが分からない) */
const GENERIC_HINT = /尋ね|たずね|聞[かきくけこい]|訊|触れ|ふれ|話題|話|こと|事情|について|に関して|質問|する|られ|[をにのやとへがはもで]/g;
const MIN_HINT = 2;
/** 本質的な課題を言い当てた発言の引用 (仮説として言葉にした部分) の最短の長さ */
const MIN_ROOT_QUOTE = 8;

/** 本音のきっかけの照らし合わせ (hint) が、reveal_hint の話題を抜き出しているか。だめなら理由を返す (reveal_hint の中身は書かない。エラーはプレイヤーの画面に出ることがある) */
function hintError(head: string, revealHint: string, hint: string | undefined): string | null {
  const h = plain(hint ?? "");
  if (!h) return `${head}: hint が必要です。その本音の reveal_hint のうち、プレイヤーの今回の発言が触れた話題を、一字一句そのまま抜き出してください。抜き出せないなら、発言はこの本音の話題に触れていないので、本音は話さず、聞かれたことにだけ答えてください`;
  if (!plain(revealHint).includes(h)) return `${head}: hint がその本音の reveal_hint に見つかりません。言い換えず、reveal_hint からそのまま抜き出してください`;
  if (h.replace(GENERIC_HINT, "").length < MIN_HINT) return `${head}: hint に話題そのものが入っていません (「尋ねる」「話題」のような言葉だけでは、どの本音の話題か分かりません)。reveal_hint から、発言が触れた話題 (人・物・事柄) を含めて抜き出してください`;
  return null;
}

/**
 * 台詞に、ツール引数の JSON の切れ端が混ざっていないか。軽いモデルが引数の組み立てに失敗すると、
 * 「…なんです。」}],moods:[{character: のように、後ろの項目が台詞に流れ込むことがある
 */
const ARGUMENT_DEBRIS = /[{}[\]]\s*,?\s*"?[A-Za-z_]+"?\s*:|"?\b(?:speaker|text|moods|character|emoji|label|concern_updates|trust_changes|delta|reason|epilogue|note|asked|hint|quote|evidence|initiative|checks|point|probes|root_reach)\b"?\s*:/;
/** 台詞全体を囲むかぎ括弧は外す (吹き出しで話者が分かるので不要) */
const unwrapQuotes = (t: string) => (/^「[^「」]*」$/.test(t) ? t.slice(1, -1) : t);

/**
 * 台詞の頭の名乗り (「鈴木です。」) を外す。話者の名前は吹き出しに出るので不要。
 * フルネーム・空白を詰めた名前・名字 (空白の前) のどれで名乗っても外す。名乗りしか無い台詞はそのまま
 */
export function stripSelfIntro(text: string, name: string): string {
  const parts = name.split(/[\s　・]+/).filter(Boolean);
  const names = [...new Set([name, parts.join(""), parts[0]])].filter(Boolean).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const out = text.replace(new RegExp(`^(?:${escaped.join("|")})(?:です|だ|でございます|と申します)[。、！!]\\s*`), "");
  return out.trim() ? out : text;
}

/**
 * 懸念が 1 ターンに進める段階。revealed → resolved は「案が出たその場で合意」(即決) で、
 * プレイヤーの今回の発言から案を引用できるときだけ。譲れない本音 (NON_NEGOTIABLE 以上) は即決させない
 */
const STEPS: Record<ConcernStatus, ConcernStatus[]> = {
  hidden: ["revealed", "proposed"],
  revealed: ["proposed", "resolved"],
  proposed: ["resolved", "revealed"],
  resolved: [],
};

interface ConcernRuntime {
  status: ConcernStatus;
  /** 未発見のうちに、プレイヤーがその話題に触れたターンの数 (本音を話さなかったターン)。引き出しにくい本音は、これが足りるまで話さない */
  probes: number;
  /** 見つかった順 (ボードの並び) */
  seq?: number;
  /** 本音が見えた (または案が差し戻された) ターン。歩み寄りの根拠は、これより後のプレイヤーの発言に限る */
  sinceTurn?: number;
  proposal?: string;
  /** 案を出したのがプレイヤーか、キャラクターの歩み寄りか */
  proposedBy?: "player" | "character";
  agreement?: string;
}

interface CurrentAction {
  turn: number;
  to?: string;
  text: string;
  /** 「締める」ボタンで送られた */
  defer: boolean;
}

/** AI がやるべき仕事。状態から導出するので、何度 wait しても同じものが返る (コンテキストが飛んでも詰まらない) */
export type Work =
  | { type: "new_game"; request: string; /** request が空のときのお題 */ theme?: Theme; difficulty: DifficultyBrief }
  | {
      type: "player_action";
      turn: number;
      turns_left: number;
      final_turn: boolean;
      /** 「締める」が押された */
      defer: boolean;
      to: string | null;
      text: string;
      note: string;
      /** 難易度の名前。相手の物わかりの良さ (提案の受け取り方・解消の判定) は、キャラクターごとに digest.characters にある */
      difficulty: string;
      digest: Digest;
      /** 口調の手本。毎ターン渡して、日本語と口調がぶれないようにする */
      voices: Array<{ id: string; name: string; speech: string; sample_lines: string[] }>;
      /** 毎ターンの確認事項 (指示文の決まりのうち、軽いモデルが破りやすいもの。自動の試遊で見つかった) */
      checklist: string[];
    }
  | {
      type: "review";
      difficulty: string;
      ending: Ending;
      note: string;
      transcript: string[];
      concerns: Array<{
        id: string;
        owner: string;
        category: string;
        text: string;
        importance: number;
        status: ConcernStatus;
        reveal_hint: string;
        resolved_when: string;
        min_trust: number;
        /** 引き出しにくさ (1〜10) */
        reveal_difficulty: number;
        /** 未発見のうちに話題に触れられたターンの数 / 本音を話すのに要った数 */
        probes: number;
        probes_needed: number;
        proposal?: string;
        /** player = プレイヤーの提案 / character = 相手からの歩み寄り */
        proposed_by?: "player" | "character";
        agreement?: string;
      }>;
      /** 本質的な課題と、届いたか (届いていなければ、どの本音をつなげば届いたかを振り返りに書く) */
      root_issue: { owner: string; text: string; awareness: "unaware" | "unspoken"; reach_when: string; linked: string[]; clues_found: number; clues_needed: number; reached: boolean; note?: string };
      /** 登場人物ごとの信頼度 (最初と最後) と物わかり */
      characters: Array<{ id: string; name: string; trust_start: number; trust_end: number; openness: number; understanding: number }>;
      trust_history: TrustChange[];
    };

interface TrustChange {
  turn: number;
  character: string;
  from: number;
  to: number;
  reason: string;
}

export interface Digest {
  /**
   * 登場人物ごとの、いまの信頼度 (1〜10、小数。判定には整数部分を使う)・打ち解けやすさ・物わかり (1〜10)。本音を話すか・歩み寄るかは、その本音を持つ人 (owner) の信頼度で決まる。
   * 提案をどこまで汲み取るか・解消の判定の厳しさは、owner の物わかりに合わせる
   */
  characters: Array<{ id: string; trust: number; trust_level: string; openness: number; openness_note: string; understanding: number; understanding_note: string }>;
  /** 相手からの歩み寄りを、直近の発言で続けて使っていないか */
  initiative_cooldown_ok: boolean;
  /** 歩み寄りの根拠に要る、本音が見えた後の別々のターンの数 (evidence の引用もこの数以上) */
  initiative_min_turns: number;
  concerns: Array<{
    id: string;
    owner: string;
    status: ConcernStatus;
    /** owner にとっての重要度 (1〜10)。高いほど、解消の判定を厳しくする。9〜10 が残ったまま終わると持ち帰り */
    importance: number;
    min_trust: number;
    /** hidden のとき: どんな聞き方・話題で本音が出るか。本音を話すときは、このどの部分に触れたかを hint で示す */
    reveal_hint?: string;
    /** hidden のとき: 引き出しにくさ (1〜10)。持ち主が頑なで、打ち解けるまで話さない本音ほど高い */
    reveal_difficulty?: number;
    /** hidden のとき: これまでに話題に触れられたターンの数 (本音を話さなかったターン。probes で記録したもの) */
    probes?: number;
    /** hidden のとき: 本音を話すのに要る、話題に触れられたターンの数 (今回を含む)。probes + 1 がこれに届くまでは話さない */
    probes_needed?: number;
    /** revealed のとき: 本音が見えたターン。歩み寄りの根拠にできるのは、これより後のプレイヤーの発言 */
    since_turn?: number;
    /** 歩み寄るのに要る、owner の信頼度 */
    initiative_trust: number;
  }>;
  /**
   * 本質的な課題 (いくつもの本音の根っこ。owner 本人も言葉にできていない)。キャラクターからは言わず、匂わせない。
   * プレイヤーが言い当て、clues_found が clues_needed 以上で、reach_when のすべての点を言い当てたときだけ root_reach を付ける
   */
  root: {
    owner: string;
    text: string;
    awareness: "unaware" | "unspoken";
    reach_when: string;
    linked: string[];
    /** つながる本音のうち、見つかっている数 (この返答より前) */
    clues_found: number;
    /** 言い当てに要る、見つかっている、つながる本音の数 */
    clues_needed: number;
    reached: boolean;
  };
}

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; errors: string[] };
const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/**
 * 信頼度は 100 倍の整数で持つ (打ち解けやすさで縮めた上がり幅を、小数のまま積み上げるため)。
 * 本音の解禁・歩み寄りの判定と、気分の更新が要るかどうかは、整数部分 (段階) で決める
 */
/**
 * 毎ターン AI に渡す確認事項。指示文に書いてあっても、長い指示文の中の決まりは軽いモデルほど守りきれない
 * (自動の試遊で、聞かれていない本音を自分から話す・不十分な案で解消にする・自分で解決策を足す、が多かった)。
 * エンジンでは中身までは確かめられない (引用が実在するかまで) ので、直前に思い出させる
 */
const TURN_CHECKLIST = [
  "本音 (未発見の懸念) を話すのは、次のすべてを満たすときだけ: 今回のプレイヤーの発言が、その本音の reveal_hint の話題に具体的に触れている (触れた話題を hint で reveal_hint から抜き出せる) / owner の信頼度が min_trust 以上 / probes + 1 が probes_needed 以上。話題に触れたが信頼度か回数が足りなければ、probes に記録して表向きの事情だけを答える。別の話題への返事や一般的な質問で、自分から打ち明けない (「実は」「本音を言うと」と切り出さない)。",
  "解消 (resolved) にするのは、resolved_when のすべての点について、それを満たしたプレイヤーの発言を checks で示せるときだけ。足りない点があれば、キャラクターの言葉でそう伝える。プレイヤーが言っていない解決策や約束を、キャラクターが自分で足さない。",
  "地の文と epilogue では、結末を言い切らない (「すべての懸念が解消された」「完全な合意が成立した」など)。会話で実際に決まったことだけを書く。",
  "本質的な課題 (digest.root) は、キャラクターから言わず、匂わせない。root_reach を付けるのは、今回のプレイヤーの発言が仮説として言い当て、clues_found が clues_needed 以上で、reach_when のすべての点を checks で示せるときだけ。一般論や要素の欠けた仮説では付けない。",
];

const levelOf = (pts: number) => Math.floor(pts / 100);
const trustValue = (pts: number) => pts / 100;

export class Engine {
  phase: Phase = "setup";
  epoch = 0;

  private generating = false;
  private request = "";
  /** 希望が空欄のときにゲーム側で選んだお題 (AI に任せきりだと、毎回ありがちな舞台に寄る) */
  private theme: Theme | null = null;
  /** 新しいゲームを頼んだときに選ばれた難易度とパラメータ (やり直しでも変わらない) */
  private difficulty: Difficulty = "normal";
  private params: DifficultyParams = { ...DIFFICULTY_PRESETS.normal };
  /** ターン数の上限 (パラメータから決まる) */
  private turnLimit = turnLimitOf(DIFFICULTY_PRESETS.normal);
  private scenario: Scenario | null = null;
  private turn = 0;
  /** キャラクターごとの信頼度 (1〜10) の 100 倍 (levelOf)。プレイヤーには見せない */
  private trustPts = new Map<string, number>();
  private trustHistory: TrustChange[] = [];
  private concerns: ConcernRuntime[] = [];
  private concernSeq = 0;
  /** 本質的な課題に届いたか (届いたターンと、何を言い当てたかの記録) */
  private root: { reached: boolean; turn?: number; note?: string } = { reached: false };
  /** プレイヤーの発言とそのターン (歩み寄りの根拠の照合用。ブラウザには送らない) */
  private playerTexts: Array<{ turn: number; text: string }> = [];
  private lastInitiativeTurn: number | null = null;
  private moods = new Map<string, Mood>();
  private log: LogLine[] = [];
  private nextLine = 1;
  private ending: Ending | null = null;
  private review: PublicReview | null = null;
  private current: CurrentAction | null = null;

  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();

  // ---- 変更通知 -----------------------------------------------------------
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    this.listeners.forEach((fn) => fn());
    this.waiters.forEach((fn) => fn());
  }
  /** 外部 (接続状態の更新など) から通知だけしたいとき */
  touch() {
    this.changed();
  }

  // ---- ログ ---------------------------------------------------------------
  private addLog(line: Omit<LogLine, "id">) {
    this.log.push({ id: this.nextLine++, ...line });
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  private get difficultyName() {
    return difficultyLabel(this.difficulty, this.params);
  }

  // ---- ゲームの開始・リセット ---------------------------------------------
  /**
   * 「新しいシナリオを作って」。AI の wait_for_player_turn に new_game が届く。params を省くと、その難易度の初期値 (ランダムなら、ここで決める)。
   * theme は話題が空欄のときのお題 (省くとここで選ぶ。自動の試遊では、同じ条件で繰り返せるよう外から渡す)
   */
  requestNewGame(request: string, difficulty: Difficulty = "normal", params: DifficultyParams = defaultParams(difficulty), theme: Theme = pickTheme()) {
    this.resetRuntime();
    this.scenario = null;
    this.phase = "setup";
    this.generating = true;
    this.request = request.trim().slice(0, 300);
    this.theme = this.request ? null : theme;
    this.difficulty = difficulty;
    this.params = { ...params };
    this.changed();
  }

  /** 同じシナリオで最初から。AI の手は要らない (opening はシナリオに入っている) */
  replay(): string | null {
    if (!this.scenario) return "シナリオがまだありません";
    this.begin();
    this.changed();
    return null;
  }

  private resetRuntime() {
    this.epoch++;
    this.turn = 0;
    this.trustPts = new Map();
    this.trustHistory = [];
    this.concerns = [];
    this.concernSeq = 0;
    this.root = { reached: false };
    this.playerTexts = [];
    this.lastInitiativeTurn = null;
    this.moods.clear();
    this.log = [];
    this.nextLine = 1;
    this.ending = null;
    this.review = null;
    this.current = null;
    this.generating = false;
    this.request = "";
    this.theme = null;
  }

  private begin() {
    const s = this.scenario!;
    this.resetRuntime();
    this.concerns = s.concerns.map(() => ({ status: "hidden" as const, probes: 0 }));
    // 引き出しにくい本音は話題に何度も触れる必要がある。その分のターンを足す (本音ごとに、話すまでに要る回数 - 1)
    this.turnLimit = turnLimitOf(this.params) + s.concerns.reduce((n, _, i) => n + this.probesNeededOf(i) - 1, 0);
    for (const c of s.characters) {
      this.trustPts.set(c.id, c.trust_start * 100);
      this.moods.set(c.id, { ...NEUTRAL_MOOD });
    }
    for (const m of s.opening_moods ?? []) this.moods.set(m.character, { emoji: m.emoji, label: m.label });
    for (const o of s.opening) {
      const who = s.characters.find((c) => c.id === o.speaker);
      const text = unwrapQuotes(o.text.trim());
      this.addLog({ from: o.speaker === "narrator" ? "narrator" : "character", speaker: o.speaker, text: who ? stripSelfIntro(text, who.name) : text });
    }
    this.phase = "player_turn";
  }

  /** AI が作ったシナリオを検証して採用する */
  startScenario(input: unknown): Result<{ title: string }> {
    if (this.phase !== "setup") return fail(`いまはシナリオを開始できません (phase=${this.phase})。プレイヤーが「新しいシナリオ」を選ぶと setup に戻ります`);
    const parsed = scenarioSchema.safeParse(input);
    if (!parsed.success) return fail(...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    const errors = checkScenario(parsed.data, difficultyBrief(this.difficulty, this.params));
    if (errors.length) return fail(...errors);
    this.scenario = parsed.data;
    this.begin();
    this.changed();
    return { ok: true, title: parsed.data.title };
  }

  // ---- プレイヤーの手番 ---------------------------------------------------
  /** 発言を送る。defer=true は「締める」ボタン (発言は任意) */
  act(input: { text?: unknown; to?: unknown }, defer = false): string | null {
    if (this.phase === "ended") return "対話は終了しています。「最初から」か「新しいシナリオ」を選んでください";
    if (this.phase === "setup" || !this.scenario) return "シナリオの準備中です";
    if (this.phase === "ai_turn") return "相手が考え中です。返事が来るまで待ってください";
    const text = (typeof input.text === "string" ? input.text : "").trim().slice(0, MAX_PLAYER_TEXT);
    if (!defer && !text) return "発言を入力してください";
    const secret = findSecretLike(text);
    if (secret) return secretInTextMessage(secret);
    const to = typeof input.to === "string" && this.scenario.characters.some((c) => c.id === input.to) ? input.to : undefined;

    this.turn++;
    const shown = text || "今日はここまでにしましょう。";
    this.current = { turn: this.turn, to, text: shown, defer };
    this.playerTexts.push({ turn: this.turn, text: shown });
    this.addLog({ from: "player", text: shown, to });
    this.phase = "ai_turn";
    this.changed();
    return null;
  }

  // ---- AI の手番 ----------------------------------------------------------
  reply(r: ReplyInput): Result<{ summary: string }> {
    const s = this.scenario;
    const action = this.current;
    if (this.phase !== "ai_turn" || !s || !action) return fail(`いまは AI の手番ではありません (phase=${this.phase})。wait_for_player_turn で最新の状況を確認してください`);
    if (r.turn !== this.turn) return fail(`turn が古いです (受け取った ${r.turn} / 現在 ${this.turn})。wait_for_player_turn をやり直してください`);

    const errors: string[] = [];
    const charIds = new Set(s.characters.map((c) => c.id));
    const seenLines = new Set<string>();
    r.lines.forEach((l, i) => {
      if (l.speaker !== "narrator" && !charIds.has(l.speaker)) errors.push(`lines[${i}].speaker "${l.speaker}" は存在しません (使えるのは ${[...charIds, "narrator"].join(" / ")})`);
      // 仕草で隠し事を匂わせて、プレイヤーを誘導しない
      const hit = findSteering(l.text);
      if (hit) errors.push(steeringMessage(`lines[${i}]`, hit));
      const unsafe = findUnsafeOutput(l.text);
      if (unsafe) errors.push(unsafeMessage(`lines[${i}]`, unsafe));
      if (ARGUMENT_DEBRIS.test(l.text)) {
        errors.push(`lines[${i}] の台詞に、ツール引数の JSON の切れ端 (「${l.text.match(ARGUMENT_DEBRIS)![0]}」など) が混ざっています。台詞の text には台詞だけを入れ、moods などは別の項目として渡してください`);
      }
      // 引数の組み立てに失敗すると、同じ台詞を上限の数だけ並べてしまうことがある
      const key = `${l.speaker}\u0000${squash(l.text)}`;
      if (seenLines.has(key)) errors.push(`lines[${i}] は、同じ返答の中の別の台詞とまったく同じです。同じ台詞を繰り返さないでください`);
      seenLines.add(key);
      const len = squash(l.text).length;
      if (l.speaker === "narrator" && len > MAX_NARRATOR_CHARS) errors.push(`lines[${i}] の地の文が長すぎます (${len} 文字 > ${MAX_NARRATOR_CHARS})。場面転換や時間の経過を 1 文で`);
      if (l.speaker !== "narrator" && len > MAX_LINE_CHARS) errors.push(`lines[${i}] の台詞が長すぎます (${len} 文字 > ${MAX_LINE_CHARS})。聞かれたことにだけ、短く 1〜2 文で答えてください`);
    });
    // しゃべりすぎ: 聞かれていない事情まで話し出さないよう、1 回の返答の量に上限を設ける
    const spoken = r.lines.filter((l) => l.speaker !== "narrator");
    const speakers = new Set(spoken.map((l) => l.speaker));
    const total = spoken.reduce((n, l) => n + squash(l.text).length, 0);
    if (speakers.size > MAX_SPEAKERS) errors.push(`1 回の返答でしゃべるのは ${MAX_SPEAKERS} 人までです (今回 ${speakers.size} 人)。話しかけられた人が答え、ほかの人は割り込む必要があるときに 1 人だけ`);
    if (spoken.length > MAX_CHARACTER_LINES) errors.push(`台詞は 1 回の返答で ${MAX_CHARACTER_LINES} つまでです (今回 ${spoken.length} つ)`);
    if (total > MAX_REPLY_CHARS) errors.push(`返答の台詞が長すぎます (合計 ${total} 文字 > ${MAX_REPLY_CHARS})。プレイヤーが聞いたことにだけ答え、聞かれていない事情や背景は話さないでください`);
    if (r.lines.length - spoken.length > MAX_NARRATOR_LINES) errors.push(`地の文 (narrator) は 1 回の返答で ${MAX_NARRATOR_LINES} つまでです`);
    for (const m of r.moods ?? []) {
      if (!charIds.has(m.character)) errors.push(`moods: キャラクター "${m.character}" は存在しません`);
      const hit = findSteering(m.label);
      if (hit) errors.push(steeringMessage(`moods (${m.character}) の label`, hit));
    }

    // 信頼度 (キャラクターごと) は先に適用し、その値で本音の解禁を判定する。
    // 上がるときは、AI の評価 (+1 / +2) を、その人の打ち解けやすさで縮める (頑な人は、良い発言を重ねないと打ち解けない)。下がるときはそのまま
    const trustAfter = new Map(this.trustPts);
    const trustSeen = new Set<string>();
    for (const t of r.trust_changes ?? []) {
      const now = this.trustPts.get(t.character);
      const who = s.characters.find((c) => c.id === t.character);
      if (now === undefined || !who) {
        errors.push(`trust_changes: キャラクター "${t.character}" は存在しません`);
        continue;
      }
      if (trustSeen.has(t.character)) {
        errors.push(`trust_changes: "${t.character}" が重複しています (1 人 1 つまで)`);
        continue;
      }
      trustSeen.add(t.character);
      const change = t.delta > 0 ? t.delta * trustGainRate(who.openness) : t.delta * 100;
      trustAfter.set(t.character, clamp(now + change, MIN_LEVEL * 100, MAX_LEVEL * 100));
    }
    // 信頼度は画面に出ないので、段階 (整数部分) が変わった人の気分の更新が唯一の手がかりになる
    const moodOf = new Set((r.moods ?? []).map((m) => m.character));
    for (const [id, v] of trustAfter) {
      const before = levelOf(this.trustPts.get(id)!);
      if (levelOf(v) !== before && !moodOf.has(id)) {
        errors.push(`"${id}" の信頼度が ${before} → ${levelOf(v)} に変わるターンは、その人の moods も更新してください (プレイヤーに見える唯一の手がかりです。口調の変化も lines に込めてください)`);
      }
    }

    const planned: Array<{ index: number; from: ConcernStatus; to: ConcernStatus; note: string; by: "player" | "character" }> = [];
    const seen = new Set<string>();
    /** 未発見の本音に触れた発言の部分 (本音を話したもの・probes に記録したもの)。同じ部分を複数の本音に使わせない */
    const touches: Array<{ id: string; quote: string }> = [];
    let initiatives = 0;
    for (const u of r.concern_updates ?? []) {
      const index = s.concerns.findIndex((c) => c.id === u.id);
      if (index < 0) {
        errors.push(`concern_updates: 懸念 "${u.id}" は存在しません`);
        continue;
      }
      if (seen.has(u.id)) {
        errors.push(`懸念 "${u.id}" を 1 回の返答で複数回更新することはできません (1ターン1段階)`);
        continue;
      }
      seen.add(u.id);
      const c = s.concerns[index];
      const from = this.concerns[index].status;
      const note = (u.note ?? "").trim();
      if (u.initiative && u.to !== "proposed") {
        errors.push(`懸念 "${u.id}": initiative (相手からの歩み寄り) が使えるのは to=proposed のときだけです`);
        continue;
      }
      if (!STEPS[from].includes(u.to)) {
        errors.push(`懸念 "${u.id}" は ${from} から ${u.to} へ進められません (進めるのは ${STEPS[from].join(" / ") || "なし"})`);
        continue;
      }
      // 本音を話すか・歩み寄るかは、その本音を持つ人の信頼度で決まる
      const ownerTrust = levelOf(trustAfter.get(c.owner) ?? MIN_LEVEL * 100);
      if (from === "hidden" && ownerTrust < c.min_trust) {
        errors.push(`懸念 "${u.id}" は、まだ ${c.owner} が本音を話せるほど信頼されていません (${c.owner} の信頼度 ${ownerTrust} < 必要 ${c.min_trust})。本音は出さず、信頼度が上がる聞き方を待ってください。今回の発言がその話題に触れているなら、probes に記録して、表向きの事情だけを答えてください`);
        continue;
      }
      // 本音を話すのは、プレイヤーがその話題に触れたときだけ。きっかけになった発言を引用させる (聞かれていない本音を自分から話させない)
      if (from === "hidden" && u.to === "revealed") {
        const asked = squash(u.asked ?? "");
        if (asked.length < MIN_QUOTE) {
          errors.push(`懸念 "${u.id}" を revealed にするには asked が必要です。プレイヤーの今回の発言から、この本音を話すきっかけになった部分 (その話題に触れた質問など) を一字一句そのまま ${MIN_QUOTE} 文字以上引用してください。きっかけが無ければ、本音は話さず、聞かれたことにだけ答えてください`);
          continue;
        }
        if (!squash(action.text).includes(asked)) {
          errors.push(`懸念 "${u.id}" の asked がプレイヤーの今回の発言に見つかりません。言い換えず、発言の該当部分をそのまま引用してください。プレイヤーがその話題に触れていないなら、本音は話さないでください`);
          continue;
        }
      }
      // 歩み寄りは未発見の本音には使えない (initiativeError が理由を返す)
      if (from === "hidden" && !u.initiative) {
        // 発言が、本音のきっかけ (reveal_hint) のどの話題に触れたかを照らし合わせさせる (一般的な質問や別の話題への返事で本音を出させない)
        const why = hintError(`懸念 "${u.id}"`, c.reveal_hint, u.hint);
        if (why) {
          errors.push(why);
          continue;
        }
        // 引き出しにくい本音は、別々のターンで何度か話題に触れられて、はじめて話す
        const needed = this.probesNeededOf(index);
        const probes = this.concerns[index].probes;
        if (probes + 1 < needed) {
          errors.push(
            `懸念 "${u.id}" は引き出しにくい本音です。話題に触れられたターンは、今回を含めて ${probes + 1} (話すのに要るのは ${needed})。今回は本音を話さず、probes に { id, asked, hint } を記録して、表向きの事情だけを答えてください (触れられた回数が増えるほど、少しずつ具体的にしてよい。本音そのものはまだ言わない)`,
          );
          continue;
        }
      }
      // 案が出たその場で合意する (検討中を挟まない)。譲れない本音は、一度「本当に大丈夫か」と確かめてから
      const instant = from === "revealed" && u.to === "resolved";
      if (instant && c.importance >= NON_NEGOTIABLE) {
        errors.push(`懸念 "${u.id}" は譲れない本音なので、案が出たその場では解消できません。to=proposed (検討中) にして、${c.owner} の言葉で「本当にそれで大丈夫か」と一度確かめてください。解消は、プレイヤーがその疑念に答えた次のターン以降です`);
        continue;
      }
      let by: "player" | "character" = "player";
      if (u.to === "proposed" && action.defer) {
        errors.push(`懸念 "${u.id}": 「締める」のターンでは proposed に進められません`);
        continue;
      }
      if (u.initiative) {
        // 相手からの歩み寄り: プレイヤーの積み重ねが根拠でなければならない
        const why = this.initiativeError(u.id, u.evidence ?? [], from, ownerTrust, initiatives > 0);
        if (why) {
          errors.push(why);
          continue;
        }
        initiatives++;
        by = "character";
      } else if (u.to === "proposed" || instant) {
        // プレイヤーの提案: 今回の発言で実際に言ったことでなければならない (AI が提案を作って進めるのを防ぐ)
        const quote = squash(u.quote ?? "");
        const goal = instant ? "その場で resolved (即決)" : "proposed";
        if (quote.length < MIN_QUOTE) {
          errors.push(`懸念 "${u.id}" を ${goal} にするには quote が必要です。プレイヤーの今回の発言から、提案・条件提示にあたる部分を一字一句そのまま ${MIN_QUOTE} 文字以上引用してください`);
          continue;
        }
        if (!squash(action.text).includes(quote)) {
          errors.push(`懸念 "${u.id}" の quote がプレイヤーの今回の発言に見つかりません。言い換えず、発言の該当部分をそのまま引用してください。発言に具体的な提案が無ければ ${goal} にはできません (積み重ねを根拠に相手から歩み寄るなら、quote ではなく initiative=true と evidence を使います)`);
          continue;
        }
      }
      // 解消には、解消条件のどの点をプレイヤーのどの発言が満たしたかの照らし合わせが要る (不十分な案での解消・自分で足した解決策を防ぐ)
      if (u.to === "resolved") {
        const why = this.checksError(u.id, c.resolved_when, u.checks ?? []);
        if (why) {
          errors.push(why);
          continue;
        }
      }
      if ((u.to === "proposed" || u.to === "resolved" || (from === "proposed" && u.to === "revealed")) && note.length < 4) {
        errors.push(`懸念 "${u.id}" → ${u.to} には note (対処案の要約 / 合意内容 / 足りない点) が必要です`);
        continue;
      }
      planned.push({ index, from, to: u.to, note, by });
      // 未発見から進めた本音: 話題に触れた発言の部分 (案が当たったときは、その案)
      if (from === "hidden") touches.push({ id: u.id, quote: squash((u.to === "revealed" ? u.asked : u.quote) ?? "") });
    }

    // 話題に触れられたが、まだ本音を話さない (信頼度か、触れられた回数が足りない)。触れられたターンとして数える
    const probed: number[] = [];
    for (const p of r.probes ?? []) {
      const index = s.concerns.findIndex((c) => c.id === p.id);
      const head = `probes: 懸念 "${p.id}"`;
      if (index < 0) {
        errors.push(`${head} は存在しません`);
        continue;
      }
      if (this.concerns[index].status !== "hidden") {
        errors.push(`${head} は、もう本音が見えています。probes に入れるのは、未発見 (hidden) の本音だけです`);
        continue;
      }
      if (seen.has(p.id)) {
        errors.push(`${head} は concern_updates でも進めています。本音を話すなら concern_updates だけ、まだ話さないなら probes だけにしてください`);
        continue;
      }
      if (probed.includes(index)) {
        errors.push(`${head} が重複しています (1 つの本音につき 1 つまで)`);
        continue;
      }
      const asked = squash(p.asked);
      if (asked.length < MIN_QUOTE || !squash(action.text).includes(asked)) {
        errors.push(`${head} の asked が、プレイヤーの今回の発言に見つかりません。発言のうち、この本音の話題に触れた部分を一字一句そのまま ${MIN_QUOTE} 文字以上引用してください。触れていないなら probes に入れないでください`);
        continue;
      }
      const why = hintError(head, s.concerns[index].reveal_hint, p.hint);
      if (why) {
        errors.push(why);
        continue;
      }
      probed.push(index);
      touches.push({ id: p.id, quote: asked });
    }

    // 発言の同じ部分を、複数の本音のきっかけにしない (一般的な質問 1 つで、本音をまとめて出させない)。
    // 発言の中身が濃く、別々の話題に触れていれば、いくつ出てもよい
    touches.forEach((a, i) => {
      for (const b of touches.slice(i + 1)) {
        if (a.quote.includes(b.quote) || b.quote.includes(a.quote)) {
          errors.push(
            `懸念 "${a.id}" と "${b.id}" のきっかけ (asked / quote) が、プレイヤーの発言の同じ部分です。発言の 1 つの部分で触れられる本音は 1 つだけ。それぞれの話題に触れた別の部分を引用してください (片方の話題にしか触れていなければ、もう片方は話さず、probes にも入れない)`,
          );
        }
      }
    });

    // 本質的な課題: プレイヤーが手がかり (つながる本音) をそろえたうえで、仮説として言い当てたときだけ届く。キャラクターからは言わない
    const reachesRoot = !!r.root_reach;
    if (r.root_reach) {
      const why = this.rootReachError(r.root_reach, action.text);
      if (why) errors.push(why);
      // 届いたターンは、本質を抱えていた人が、つながりを自分の言葉で語り直す
      else if (!r.lines.some((l) => l.speaker === s.root_issue.owner)) errors.push(`本質的な課題に届いたターンは、owner (${s.root_issue.owner}) が台詞で応じてください (言い当てられて気づいたこと・認めたことを、その人の言葉で)`);
    }
    if (!this.root.reached && !reachesRoot) {
      r.lines.forEach((l, li) => {
        if (leaksSecret(l.text, s.root_issue.text)) {
          errors.push(`lines[${li}] に、まだ届いていない本質的な課題がほぼそのまま出ています。本質的な課題はキャラクターから言いません。プレイヤーが言い当てたときだけ root_reach で届いたことにしてください`);
        }
      });
    }

    // この返答で対話が終わるか
    const after = this.concerns.map((c) => c.status);
    for (const p of planned) after[p.index] = p.to;
    // この返答の後も見つかっていない本音を、台詞でほぼそのまま話していないか (言い換えまでは見分けられない)
    s.concerns.forEach((c, ci) => {
      if (after[ci] !== "hidden") return;
      r.lines.forEach((l, li) => {
        if (leaksSecret(l.text, c.text)) {
          errors.push(
            `lines[${li}] に、まだ見つかっていない本音 "${c.id}" がほぼそのまま出ています。本音を話してよい (聞き方と信頼度の条件を満たす) なら concern_updates で revealed にし、そうでなければ表向きの事情だけを話してください`,
          );
        }
      });
    });
    const reason: EndReason | null = after.every((x) => x === "resolved") ? "all_resolved" : action.defer ? "deferred" : this.turn >= this.turnLimit ? "turn_limit" : null;
    const epilogue = (r.epilogue ?? "").trim();
    if (reason && !epilogue) errors.push("この返答で対話が終わります。epilogue (締めくくりの一文) を付けてください");
    const epilogueHit = findSteering(epilogue);
    if (epilogueHit) errors.push(steeringMessage("epilogue", epilogueHit));
    if (ARGUMENT_DEBRIS.test(epilogue)) errors.push("epilogue に、ツール引数の JSON の切れ端が混ざっています。締めくくりの一文だけにしてください");
    const epilogueUnsafe = findUnsafeOutput(epilogue);
    if (epilogueUnsafe) errors.push(unsafeMessage("epilogue", epilogueUnsafe));
    // 結末はエンジンが判定する。地の文と締めくくりの一文で言い切らせない
    const epilogueVerdict = findVerdict(epilogue);
    if (epilogueVerdict) errors.push(verdictMessage("epilogue", epilogueVerdict));
    r.lines.forEach((l, i) => {
      const hit = l.speaker === "narrator" ? findVerdict(l.text) : null;
      if (hit) errors.push(verdictMessage(`lines[${i}] (地の文)`, hit));
    });

    if (errors.length) return fail(...errors);

    // ---- ここから反映 (検証はすべて通過済み) ----
    for (const l of r.lines) {
      // 台詞の頭の名乗りは外す (話者の名前は吹き出しに出る)
      const who = s.characters.find((c) => c.id === l.speaker);
      const text = unwrapQuotes(l.text.trim());
      this.addLog({ from: l.speaker === "narrator" ? "narrator" : "character", speaker: l.speaker, text: who ? stripSelfIntro(text, who.name) : text });
    }
    for (const m of r.moods ?? []) this.moods.set(m.character, { emoji: m.emoji, label: m.label });

    for (const [id, to] of trustAfter) {
      const from = this.trustPts.get(id)!;
      if (to === from) continue;
      // プレイヤーには見せない。AI が get_state で振り返れるように記録だけしておく
      this.trustHistory.push({ turn: this.turn, character: id, from: trustValue(from), to: trustValue(to), reason: r.trust_changes?.find((t) => t.character === id)?.reason ?? "" });
      this.trustPts.set(id, to);
    }

    for (const i of probed) this.concerns[i].probes++;
    if (r.root_reach) this.root = { reached: true, turn: this.turn, note: r.root_reach.note.trim() };
    // 進行の要約はチャットには出さない (現実の対話では見えないため)。懸念ボードの状態だけが変わる
    for (const p of planned) {
      const rt = this.concerns[p.index];
      rt.status = p.to;
      if (p.from === "hidden") rt.seq = ++this.concernSeq; // 見つかった順にボードへ並べる
      if (p.to === "revealed") rt.sinceTurn = this.turn; // 歩み寄りの根拠は、これより後の発言だけ
      if (p.to === "proposed") {
        rt.proposal = p.note;
        rt.proposedBy = p.by;
        if (p.by === "character") this.lastInitiativeTurn = this.turn;
      } else if (p.to === "revealed") {
        rt.proposal = undefined;
        rt.proposedBy = undefined;
      } else if (p.to === "resolved") {
        rt.agreement = p.note;
        if (p.from === "revealed") rt.proposedBy = p.by; // 即決: プレイヤーの案にその場で合意した
      }
    }

    if (reason) this.finish(reason, epilogue);
    else {
      this.phase = "player_turn";
      this.current = null;
    }
    this.changed();

    const resolved = this.concerns.filter((c) => c.status === "resolved").length;
    return {
      ok: true,
      summary: reason
        ? `対話が終了しました (${this.ending!.type}, 解消 ${resolved}/${this.concerns.length})。続けて振り返りの依頼 (type=review) が届きます`
        : `ok。残りターン ${this.turnLimit - this.turn}、信頼度 ${[...this.trustPts].map(([id, v]) => `${id} ${trustValue(v)}`).join(" / ")}、解消 ${resolved}/${this.concerns.length}`,
    };
  }

  /**
   * 相手からの歩み寄り (initiative) を認めてよいか。認められなければ理由を返す。
   * 確かめられるのは「本音が見えていて案が無い」「信頼度」「プレイヤーの発言が根拠として実在し、
   * 本音が見えた後の別々のターン (数は難易度で決まる) にある」「ペース」まで。その発言が解消条件を本当に満たすかは AI の判断。
   */
  private initiativeError(id: string, evidence: string[], from: ConcernStatus, ownerTrust: number, alreadyThisReply: boolean): string | null {
    const s = this.scenario!;
    const index = s.concerns.findIndex((c) => c.id === id);
    const c = s.concerns[index];
    const rt = this.concerns[index];
    const head = `懸念 "${id}" の歩み寄り (initiative)`;
    if (from !== "revealed") return `${head}: 使えるのは、本音が見えていて案がまだ出ていない懸念 (revealed) だけです (現在 ${from})`;
    const { initiativeCooldown: cooldown, initiativeTurns: minTurns } = this.params;
    const needTrust = this.initiativeTrust(c.min_trust);
    if (ownerTrust < needTrust) return `${head}: まだ ${c.owner} から歩み寄るほどの信頼関係がありません (${c.owner} の信頼度 ${ownerTrust} < 必要 ${needTrust})。プレイヤーの発言に応じて会話を続けてください`;
    if (alreadyThisReply) return `${head}: 歩み寄りは 1 回の返答で 1 つの懸念までです`;
    if (!this.initiativeCooldownOk()) return `${head}: 直前のターンで歩み寄ったばかりです。${cooldown} ターンに 1 回までです`;
    const since = rt.sinceTurn ?? 0;
    const quotes = evidence.map(squash).filter((q) => q.length >= MIN_QUOTE);
    if (quotes.length < minTurns) {
      return `${head}: evidence に、プレイヤーの発言からの引用 (${MIN_QUOTE} 文字以上、一字一句そのまま) を ${minTurns} つ以上${minTurns > 1 ? "、別のターンから" : ""}挙げてください`;
    }
    const turns = new Set<number>();
    for (const q of quotes) {
      const hit = this.playerTexts.find((p) => p.turn > since && squash(p.text).includes(q));
      if (!hit) return `${head}: evidence「${q.slice(0, 20)}」が、本音が見えた後 (ターン ${since} より後) のプレイヤーの発言に見つかりません。言い換えず、発言をそのまま引用してください`;
      turns.add(hit.turn);
    }
    if (turns.size < minTurns) {
      return `${head}: 根拠の発言が ${turns.size} つのターンにしかありません。本音が見えた後、プレイヤーが ${minTurns} ターン以上その話題に向き合ってから歩み寄ってください`;
    }
    return null;
  }

  /**
   * 解消 (resolved) の照らし合わせ。解消条件のどの点を、プレイヤーのどの発言が満たしたかを並べさせる
   * (自動の試遊で、不十分な案で解消にする・プレイヤーが言っていない解決策を相手が足す、が軽いモデルに多かった)。
   * 確かめられるのは、点が解消条件からの抜き出しであること・条件のほぼ全体を覆っていること・引用がプレイヤーの発言に実在することまで。
   * その発言が本当に条件を満たすかは AI の判断
   */
  private checksError(id: string, resolvedWhen: string, checks: Array<{ point: string; quote: string }>): string | null {
    const how =
      "解消条件 (resolved_when) の点ごとに、{ point: 解消条件からそのまま抜き出した部分, quote: それを満たしたプレイヤーの発言からそのまま抜き出した部分 } を並べてください。満たしていない点があるなら resolved にせず、足りない点をキャラクターの言葉で伝えてください";
    return this.coverageError(`懸念 "${id}" を resolved にする照らし合わせ (checks)`, "解消条件", resolvedWhen, checks, how, true);
  }

  /**
   * 照らし合わせ (checks) が、条件 (懸念の解消条件・本質的な課題への到達の条件) のほぼ全体を、実在するプレイヤーの発言で覆っているか。
   * だめなら理由を返す。show = false なら、条件の中身をエラーに書かない (本質的な課題の答えになるため。エラーはプレイヤーの画面に出ることがある)
   */
  private coverageError(head: string, name: string, conditionText: string, checks: Array<{ point: string; quote: string }>, how: string, show: boolean): string | null {
    if (!checks.length) return `${head}が必要です。${how}`;
    const condition = plain(conditionText);
    const covered: boolean[] = new Array(condition.length).fill(false);
    for (const ch of checks) {
      const point = plain(ch.point);
      const at = point.length >= 2 ? condition.indexOf(point) : -1;
      if (at < 0) return `${head}: point「${ch.point.slice(0, 30)}」が${name}${show ? `「${conditionText}」` : ""}の中に見つかりません。言い換えず、${name}からそのまま抜き出してください`;
      covered.fill(true, at, at + point.length);
      const quote = squash(ch.quote);
      if (quote.length < MIN_QUOTE) return `${head}: point「${ch.point.slice(0, 30)}」の quote が短すぎます。プレイヤーの発言から ${MIN_QUOTE} 文字以上、一字一句そのまま引用してください`;
      if (!this.playerTexts.some((p) => squash(p.text).includes(quote))) {
        return `${head}: quote「${ch.quote.slice(0, 30)}」がプレイヤーの発言に見つかりません。言い換えず、発言をそのまま引用してください。プレイヤーが言っていないことは根拠にできません`;
      }
    }
    if (covered.filter(Boolean).length < condition.length * MIN_CHECK_COVERAGE) {
      const missing = [...condition].filter((_, i) => !covered[i]).join("");
      return `${head}: ${name}の一部の点にしか、プレイヤーの発言が挙がっていません${show ? ` (挙がっていない部分:「${missing.slice(0, 40)}」)` : ""}。${how}`;
    }
    return null;
  }

  /** 本質的な課題につながる本音のうち、この返答より前に見つかっている数 (本質を言い当てる手がかり) */
  private rootCluesFound() {
    const s = this.scenario!;
    return [...new Set(s.root_issue.linked)].filter((id) => this.concerns[s.concerns.findIndex((c) => c.id === id)].status !== "hidden").length;
  }

  /** 本質的な課題を言い当てたとしてよいか。だめなら理由を返す (本質の中身は書かない) */
  private rootReachError(reach: NonNullable<ReplyInput["root_reach"]>, text: string): string | null {
    const s = this.scenario!;
    const head = "本質的な課題への到達 (root_reach)";
    if (this.root.reached) return `${head}: すでに本質的な課題に届いています。root_reach は付けないでください`;
    const found = this.rootCluesFound();
    const needed = this.params.rootClues;
    if (found < needed) {
      return `${head}: 手がかりが足りません (本質につながる本音のうち、見つかっているのは ${found} / 必要 ${needed})。手がかりがそろう前の言い当ては、当てずっぽうと同じです。今回は到達にせず、owner はぴんと来ていない反応で、その人の言葉で返してください (答えは言わない)`;
    }
    const quote = squash(reach.quote);
    if (quote.length < MIN_ROOT_QUOTE || !squash(text).includes(quote)) {
      return `${head}: quote が、プレイヤーの今回の発言に見つかりません。発言のうち、本質的な課題を仮説として言い当てた部分を一字一句そのまま ${MIN_ROOT_QUOTE} 文字以上引用してください。今回の発言が言い当てていないなら、root_reach は付けないでください`;
    }
    const how =
      "到達の条件 (root_issue.reach_when) の点ごとに、{ point: reach_when からそのまま抜き出した部分, quote: それを言い当てたプレイヤーの発言からそのまま抜き出した部分 } を並べてください。言い当てていない点があるなら到達にせず、owner はぴんと来ていない反応で返してください (答えは言わない)";
    const why = this.coverageError(`${head}の照らし合わせ (checks)`, "到達の条件", s.root_issue.reach_when, reach.checks, how, false);
    if (why) return why;
    if (squash(reach.note).length < 4) return `${head}: note (プレイヤーが何を言い当てたか) が必要です`;
    return null;
  }

  /** 歩み寄るのに要る信頼度 */
  private initiativeTrust(minTrust: number) {
    return Math.max(this.params.initiativeTrust, minTrust + 1);
  }

  /** 本音の引き出しにくさ (1〜10)。持ち主の最初の信頼度・打ち解けやすさと、本音を話し始める信頼度から決まる */
  private revealDifficultyOf(index: number) {
    const s = this.scenario!;
    const c = s.concerns[index];
    const owner = s.characters.find((ch) => ch.id === c.owner)!;
    return revealDifficulty(c.min_trust, owner.trust_start, owner.openness);
  }

  /** 本音を話すのに要る、話題に触れられたターンの数 (本音を話すターンを含む) */
  private probesNeededOf(index: number) {
    return probesNeeded(this.revealDifficultyOf(index));
  }

  private initiativeCooldownOk() {
    return this.lastInitiativeTurn === null || this.turn - this.lastInitiativeTurn >= this.params.initiativeCooldown;
  }

  /**
   * 結末: すべて解消なら完全合意。妥協案で合意できるのは、譲れない本音がすべて解消し、
   * 解消した本音の重要度の合計が全体の半分以上のとき。それ以外は持ち帰り
   */
  private finish(reason: EndReason, epilogue: string) {
    const s = this.scenario!;
    const done = (i: number) => this.concerns[i].status === "resolved";
    const total = this.concerns.length;
    const resolved = this.concerns.filter((c) => c.status === "resolved").length;
    const importance = {
      resolved: s.concerns.reduce((n, c, i) => n + (done(i) ? c.importance : 0), 0),
      total: s.concerns.reduce((n, c) => n + c.importance, 0),
    };
    const nonNegotiableLeft = s.concerns.filter((c, i) => c.importance >= NON_NEGOTIABLE && !done(i)).length;
    const type = resolved === total ? "full_agreement" : nonNegotiableLeft === 0 && importance.resolved * 2 >= importance.total ? "compromise" : "carry_over";
    const score = scoreGame(s, this.concerns.map((c) => c.status), this.root.reached);
    this.ending = { type, reason, epilogue, resolved, total, importance, nonNegotiableLeft, score };
    this.phase = "ended";
    this.current = null;
    this.addLog({ from: "narrator", text: epilogue });
  }

  /** 終了後の振り返りを受け取る。解消できなかった懸念すべてに助言が要る */
  submitReview(input: unknown): Result {
    const s = this.scenario;
    if (this.phase !== "ended" || !s) return fail(`振り返りを出せるのは対話の終了後だけです (phase=${this.phase})`);
    if (this.review) return fail("振り返りはすでに提出済みです");
    const parsed = reviewSchema.safeParse(input);
    if (!parsed.success) return fail(...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
    const unresolved = new Set(s.concerns.filter((_, i) => this.concerns[i].status !== "resolved").map((c) => c.id));
    const errors: string[] = [];
    const given = new Set<string>();
    for (const c of parsed.data.concerns) {
      if (!unresolved.has(c.id)) errors.push(`concerns: "${c.id}" は存在しないか、すでに解消済みです (解消済みの懸念は含めないでください)`);
      else if (given.has(c.id)) errors.push(`concerns: "${c.id}" が重複しています`);
      given.add(c.id);
    }
    for (const id of unresolved) if (!given.has(id)) errors.push(`concerns: 未解消の懸念 "${id}" への助言がありません`);
    const r = parsed.data;
    const texts: Array<[string, string]> = [["overall", r.overall], ...r.good.map((t, i): [string, string] => [`good[${i}]`, t]), ...r.improve.map((t, i): [string, string] => [`improve[${i}]`, t]), ...r.concerns.map((c, i): [string, string] => [`concerns[${i}].advice`, c.advice])];
    for (const [where, text] of texts) {
      const kind = findUnsafeOutput(text);
      if (kind) errors.push(unsafeMessage(where, kind));
    }
    if (errors.length) return fail(...errors);
    this.review = parsed.data;
    this.changed();
    return { ok: true };
  }

  // ---- AI 向けの情報 ------------------------------------------------------
  private digest(): Digest {
    const s = this.scenario!;
    return {
      characters: s.characters.map((c) => {
        const pts = this.trustPts.get(c.id)!;
        return {
          id: c.id,
          trust: trustValue(pts),
          trust_level: trustName(levelOf(pts)),
          openness: c.openness,
          openness_note: opennessNote(c.openness),
          understanding: c.understanding,
          understanding_note: understandingNote(c.understanding),
        };
      }),
      initiative_cooldown_ok: this.initiativeCooldownOk(),
      initiative_min_turns: this.params.initiativeTurns,
      concerns: s.concerns.map((c, i) => {
        const rt = this.concerns[i];
        return {
          id: c.id,
          owner: c.owner,
          status: rt.status,
          importance: c.importance,
          min_trust: c.min_trust,
          ...(rt.status === "hidden" && { reveal_hint: c.reveal_hint, reveal_difficulty: this.revealDifficultyOf(i), probes: rt.probes, probes_needed: this.probesNeededOf(i) }),
          since_turn: rt.status === "revealed" ? rt.sinceTurn : undefined,
          initiative_trust: this.initiativeTrust(c.min_trust),
        };
      }),
      root: {
        owner: s.root_issue.owner,
        text: s.root_issue.text,
        awareness: s.root_issue.awareness,
        reach_when: s.root_issue.reach_when,
        linked: s.root_issue.linked,
        clues_found: this.rootCluesFound(),
        clues_needed: this.params.rootClues,
        reached: this.root.reached,
      },
    };
  }

  /** いま AI がやるべきこと。無ければ null */
  pendingWork(): Work | null {
    if (this.phase === "setup" && this.generating)
      return { type: "new_game", request: this.request, ...(this.theme && { theme: this.theme }), difficulty: difficultyBrief(this.difficulty, this.params) };
    if (this.phase === "ai_turn" && this.current && this.scenario) {
      const a = this.current;
      const left = this.turnLimit - a.turn;
      const notes: string[] = [];
      if (a.defer) notes.push("プレイヤーは「締める」を押しました。この返答で対話を締めくくってください (epilogue 必須)");
      if (left <= 0) notes.push("これが最終ターンです。この返答で対話を締めくくってください (epilogue 必須)");
      else if (left <= 2) notes.push(`残り ${left} ターンです`);
      return {
        type: "player_action",
        turn: a.turn,
        turns_left: left,
        final_turn: left <= 0,
        defer: a.defer,
        to: a.to ?? null,
        text: a.text,
        note: notes.join(" / "),
        difficulty: this.difficultyName,
        digest: this.digest(),
        voices: this.scenario.characters.map((c) => ({ id: c.id, name: c.name, speech: c.speech, sample_lines: c.sample_lines })),
        checklist: TURN_CHECKLIST,
      };
    }
    if (this.phase === "ended" && !this.review && this.scenario && this.ending) {
      const s = this.scenario;
      const name = (l: LogLine) => {
        if (l.from === "narrator") return "(地の文)";
        if (l.from === "player") return l.to ? `プレイヤー→${s.characters.find((c) => c.id === l.to)?.name ?? l.to}` : "プレイヤー";
        return s.characters.find((c) => c.id === l.speaker)?.name ?? l.speaker ?? "?";
      };
      return {
        type: "review",
        difficulty: this.difficultyName,
        ending: this.ending,
        note: "対話が終わりました。プレイヤーへの振り返りを submit_review で書いてください。transcript の実際の発言を引いて具体的に。励ましつつ、次に活かせる形で。解消できなかった懸念すべてに、どんな聞き方・どんな案なら届いたかを (reveal_hint / resolved_when を踏まえて) 書くこと。重要度 (importance) の高い本音を優先できたかにも触れる。ending.nonNegotiableLeft が 1 以上なら、譲れない本音が残ったことが持ち帰りの理由。ending.score はエンジンが出したスコアで、プレイヤーにも見えている。このゲームの目的は隠れた本音をあぶり出すことで、重要で引き出しにくい (score.items の revealDifficulty が高い) 本音を引き出すほど高く、解決に導くと解決点も入る。overall でスコアとランクに一言触れ、どの本音で点を伸ばせたか (score.items で取りこぼした、重要度や引き出しにくさの高い本音) を示す。点数は書き換えられない。見つけられなかった本音のうち、話題に触れていたもの (concerns[].probes が 1 以上) は、あと何回 (probes_needed まで) 踏み込めば届いたか、信頼度が足りなかったのかを助言に書く。本質的な課題 (root_issue) は、表の本音の奥にある、本人も言葉にできていなかった課題で、スコアの 4 分の 1 を占める。届いた (reached) なら、どの発言で点と点をつなげたかを具体的に褒める。届かなかったなら、overall か improve で必ず触れ、どの本音 (linked) を見比べれば、どんな仮説にたどり着けたかを書く (終了後なので中身に触れてよい)。プレイヤーには信頼度の数値は見えていないので、数値ではなく相手の反応で説明する。concerns[].proposed_by が character の懸念は、プレイヤーの積み重ねで相手から歩み寄ってくれたもの。何が効いたかを具体的に褒める",
        transcript: this.log.map((l) => `${name(l)}: ${l.text}`),
        concerns: s.concerns.map((c, i) => ({
          id: c.id,
          owner: c.owner,
          category: c.category,
          text: c.text,
          importance: c.importance,
          status: this.concerns[i].status,
          reveal_hint: c.reveal_hint,
          resolved_when: c.resolved_when,
          min_trust: c.min_trust,
          reveal_difficulty: this.revealDifficultyOf(i),
          probes: this.concerns[i].probes,
          probes_needed: this.probesNeededOf(i),
          proposal: this.concerns[i].proposal,
          proposed_by: this.concerns[i].proposedBy,
          agreement: this.concerns[i].agreement,
        })),
        root_issue: { ...s.root_issue, clues_found: this.rootCluesFound(), clues_needed: this.params.rootClues, reached: this.root.reached, note: this.root.note },
        characters: s.characters.map((c) => ({ id: c.id, name: c.name, trust_start: c.trust_start, trust_end: trustValue(this.trustPts.get(c.id)!), openness: c.openness, understanding: c.understanding })),
        trust_history: this.trustHistory,
      };
    }
    return null;
  }

  /** 仕事が来るまで最大 timeoutMs 待つ */
  waitForWork(timeoutMs: number): Promise<Work | null> {
    return new Promise((resolve) => {
      const now = this.pendingWork();
      if (now) return resolve(now);
      const finish = (w: Work | null) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(w);
      };
      const check = () => {
        const w = this.pendingWork();
        if (w) finish(w);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.waiters.add(check);
    });
  }

  /**
   * AI 用の完全な状態 (隠し情報を含む。ブラウザには絶対に送らない)。
   * wholeLog = 会話をすべて含める (対話の途中から別の AI が引き継ぐとき。ふだんは直近だけ)
   */
  fullState({ wholeLog = false } = {}) {
    const s = this.scenario;
    return {
      phase: this.phase,
      difficulty: this.difficulty,
      params: this.params,
      turn_limit: this.turnLimit,
      turn: this.turn,
      trust: Object.fromEntries([...this.trustPts].map(([id, v]) => [id, trustValue(v)])),
      trust_history: this.trustHistory.slice(-8),
      scenario: s,
      concerns: s?.concerns.map((c, i) => ({
        id: c.id,
        status: this.concerns[i].status,
        probes: this.concerns[i].probes,
        proposal: this.concerns[i].proposal,
        proposed_by: this.concerns[i].proposedBy,
        agreement: this.concerns[i].agreement,
      })),
      root: this.root,
      moods: Object.fromEntries(this.moods),
      ending: this.ending,
      review: this.review,
      pending: this.pendingWork(),
      recent_log: wholeLog ? this.log : this.log.slice(-12),
    };
  }

  // ---- ブラウザ向けの公開状態 (AI の接続状態 ai はサーバーが足す) ------------------
  publicState(): Omit<PublicState, "ai"> {
    const s = this.scenario;
    const ended = this.phase === "ended";
    // 懸念ボードは空から始まり、見つけた分だけ増える。未発見の懸念は存在も分類も一切送らない
    // (終了後だけ、見つけられなかった懸念を答え合わせとして公開する)
    const concerns: PublicConcern[] = [];
    if (s) {
      const all = s.concerns.map((c, i) => ({ c, rt: this.concerns[i] }));
      const found = all.filter((x) => x.rt.status !== "hidden").sort((a, b) => (a.rt.seq ?? 0) - (b.rt.seq ?? 0));
      for (const { c, rt } of found) {
        const pc: PublicConcern = { id: c.id, owner: c.owner, category: c.category, status: rt.status, text: c.text };
        // 重要度と合意内容は、終了後の答え合わせと合意書にだけ載せる。ゲーム中は送らない
        if (ended) pc.importance = c.importance;
        if (ended && rt.status === "resolved") pc.agreement = rt.agreement;
        concerns.push(pc);
      }
      if (ended) for (const { c, rt } of all) if (rt.status === "hidden") concerns.push({ id: c.id, owner: c.owner, category: c.category, status: "hidden", text: c.text, importance: c.importance, missed: true });
    }
    return {
      epoch: this.epoch,
      phase: this.phase,
      difficulty: this.difficulty,
      customized: isCustomized(this.difficulty, this.params),
      params: ended ? { ...this.params } : null,
      generating: this.generating,
      scenario: s && {
        title: s.title,
        premise: s.premise,
        playerRole: s.player_role,
        goal: s.goal,
        briefing: s.briefing,
        turnLimit: this.turnLimit,
        characters: s.characters.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, role: c.role, mood: this.moods.get(c.id) ?? NEUTRAL_MOOD })),
      },
      turn: this.turn,
      concerns,
      root: s && this.publicRoot(s, ended),
      log: this.log,
      ending: this.ending,
      review: this.review,
    };
  }

  /** 本質的な課題: ゲーム中、届いていなければ枠だけ (中身も持ち主も送らない)。終了後は、届かなくても答え合わせとして公開する */
  private publicRoot(s: Scenario, ended: boolean): PublicRoot {
    const r = s.root_issue;
    if (!this.root.reached && !ended) return { status: "hidden" };
    return { status: this.root.reached ? "reached" : "hidden", owner: r.owner, text: r.text, ...(ended && { linked: r.linked }), ...(ended && !this.root.reached && { missed: true }) };
  }
}
