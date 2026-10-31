import { defaultParams, difficultyBrief, difficultyLabel, isCustomized, trustName, understandingNote, type DifficultyBrief } from "./difficulty.js";
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
  type PublicState,
  findSecretLike,
  secretInTextMessage,
  turnLimitOf,
} from "./shared.js";
import { checkScenario, findSteering, findUnsafeOutput, leaksSecret, reviewSchema, scenarioSchema, steeringMessage, unsafeMessage, type ReplyInput, type Scenario } from "./scenario.js";

const MAX_LOG = 400;
const NEUTRAL_MOOD: Mood = { emoji: "😐", label: "ふつう" };
/** 引用の照合は空白 (全角含む) を無視する */
const squash = (t: string) => t.replace(/\s+/g, "");
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
/** 1 回の返答で新しく見つかる本音の数 (軽いモデルほど、一般的な質問で本音を次々に出してしまうため) */
const MAX_REVEALS_PER_REPLY = 1;

/**
 * 台詞に、ツール引数の JSON の切れ端が混ざっていないか。軽いモデルが引数の組み立てに失敗すると、
 * 「…なんです。」}],moods:[{character: のように、後ろの項目が台詞に流れ込むことがある
 */
const ARGUMENT_DEBRIS = /[{}[\]]\s*,?\s*"?[A-Za-z_]+"?\s*:|"?\b(?:speaker|text|moods|character|emoji|label|concern_updates|trust_changes|delta|reason|epilogue|note|asked|quote|evidence|initiative)\b"?\s*:/;
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

/** 懸念が 1 ターンに進める段階 */
const STEPS: Record<ConcernStatus, ConcernStatus[]> = {
  hidden: ["revealed", "proposed"],
  revealed: ["proposed"],
  proposed: ["resolved", "revealed"],
  resolved: [],
};

interface ConcernRuntime {
  status: ConcernStatus;
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
  /** 「持ち帰って終える」ボタンで送られた */
  defer: boolean;
}

/** AI がやるべき仕事。状態から導出するので、何度 wait しても同じものが返る (コンテキストが飛んでも詰まらない) */
export type Work =
  | { type: "new_game"; request: string; difficulty: DifficultyBrief }
  | {
      type: "player_action";
      turn: number;
      turns_left: number;
      final_turn: boolean;
      /** 「持ち帰って終える」が押された */
      defer: boolean;
      to: string | null;
      text: string;
      note: string;
      /** 難易度の名前。相手の物わかりの良さ (提案の受け取り方・解消の判定) は、キャラクターごとに digest.characters にある */
      difficulty: string;
      digest: Digest;
      /** 口調の手本。毎ターン渡して、日本語と口調がぶれないようにする */
      voices: Array<{ id: string; name: string; speech: string; sample_lines: string[] }>;
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
        proposal?: string;
        /** player = プレイヤーの提案 / character = 相手からの歩み寄り */
        proposed_by?: "player" | "character";
        agreement?: string;
      }>;
      /** 登場人物ごとの信頼度 (最初と最後) と物わかり */
      characters: Array<{ id: string; name: string; trust_start: number; trust_end: number; understanding: number }>;
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
   * 登場人物ごとの、いまの信頼度 (1〜10) と物わかり (1〜10)。本音を話すか・歩み寄るかは、その本音を持つ人 (owner) の信頼度で決まる。
   * 提案をどこまで汲み取るか・解消の判定の厳しさは、owner の物わかりに合わせる
   */
  characters: Array<{ id: string; trust: number; trust_level: string; understanding: number; understanding_note: string }>;
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
    /** revealed のとき: 本音が見えたターン。歩み寄りの根拠にできるのは、これより後のプレイヤーの発言 */
    since_turn?: number;
    /** 歩み寄るのに要る、owner の信頼度 */
    initiative_trust: number;
  }>;
}

export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; errors: string[] };
const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export class Engine {
  phase: Phase = "setup";
  epoch = 0;

  private generating = false;
  private request = "";
  /** 新しいゲームを頼んだときに選ばれた難易度とパラメータ (やり直しでも変わらない) */
  private difficulty: Difficulty = "normal";
  private params: DifficultyParams = { ...DIFFICULTY_PRESETS.normal };
  /** ターン数の上限 (パラメータから決まる) */
  private turnLimit = turnLimitOf(DIFFICULTY_PRESETS.normal);
  private scenario: Scenario | null = null;
  private turn = 0;
  /** キャラクターごとの信頼度 (1〜10)。プレイヤーには見せない */
  private trust = new Map<string, number>();
  private trustHistory: TrustChange[] = [];
  private concerns: ConcernRuntime[] = [];
  private concernSeq = 0;
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
  /** 「新しいシナリオを作って」。AI の wait_for_player_turn に new_game が届く。params を省くと、その難易度の初期値 (ランダムなら、ここで決める) */
  requestNewGame(request: string, difficulty: Difficulty = "normal", params: DifficultyParams = defaultParams(difficulty)) {
    this.resetRuntime();
    this.scenario = null;
    this.phase = "setup";
    this.generating = true;
    this.request = request.trim().slice(0, 300);
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
    this.trust = new Map();
    this.trustHistory = [];
    this.concerns = [];
    this.concernSeq = 0;
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
  }

  private begin() {
    const s = this.scenario!;
    this.resetRuntime();
    this.turnLimit = turnLimitOf(this.params);
    this.concerns = s.concerns.map(() => ({ status: "hidden" as const }));
    for (const c of s.characters) {
      this.trust.set(c.id, c.trust_start);
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
  /** 発言を送る。defer=true は「持ち帰って終える」ボタン (発言は任意) */
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
    const shown = text || "今日はここまでにして、いったん持ち帰らせてください。";
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

    // 信頼度 (キャラクターごと) は先に適用し、その値で本音の解禁を判定する
    const trustAfter = new Map(this.trust);
    const trustSeen = new Set<string>();
    for (const t of r.trust_changes ?? []) {
      const now = this.trust.get(t.character);
      if (now === undefined) {
        errors.push(`trust_changes: キャラクター "${t.character}" は存在しません`);
        continue;
      }
      if (trustSeen.has(t.character)) {
        errors.push(`trust_changes: "${t.character}" が重複しています (1 人 1 つまで)`);
        continue;
      }
      trustSeen.add(t.character);
      trustAfter.set(t.character, clamp(now + t.delta, MIN_LEVEL, MAX_LEVEL));
    }
    // 信頼度は画面に出ないので、動いた人の気分の更新が唯一の手がかりになる
    const moodOf = new Set((r.moods ?? []).map((m) => m.character));
    for (const [id, v] of trustAfter) {
      if (v !== this.trust.get(id) && !moodOf.has(id)) errors.push(`"${id}" の信頼度が動くターンは、その人の moods も更新してください (プレイヤーに見える唯一の手がかりです。口調の変化も lines に込めてください)`);
    }

    const planned: Array<{ index: number; from: ConcernStatus; to: ConcernStatus; note: string; by: "player" | "character" }> = [];
    const seen = new Set<string>();
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
      const ownerTrust = trustAfter.get(c.owner) ?? MIN_LEVEL;
      if (from === "hidden" && ownerTrust < c.min_trust) {
        errors.push(`懸念 "${u.id}" は、まだ ${c.owner} が本音を話せるほど信頼されていません (${c.owner} の信頼度 ${ownerTrust} < 必要 ${c.min_trust})。本音は出さず、信頼度が上がる聞き方を待ってください`);
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
      let by: "player" | "character" = "player";
      if (u.to === "proposed") {
        if (action.defer) {
          errors.push(`懸念 "${u.id}": 持ち帰って終えるターンでは proposed に進められません`);
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
        } else {
          // プレイヤーの提案: 今回の発言で実際に言ったことでなければならない (AI が提案を作って進めるのを防ぐ)
          const quote = squash(u.quote ?? "");
          if (quote.length < MIN_QUOTE) {
            errors.push(`懸念 "${u.id}" を proposed にするには quote が必要です。プレイヤーの今回の発言から、提案・条件提示にあたる部分を一字一句そのまま ${MIN_QUOTE} 文字以上引用してください`);
            continue;
          }
          if (!squash(action.text).includes(quote)) {
            errors.push(`懸念 "${u.id}" の quote がプレイヤーの今回の発言に見つかりません。言い換えず、発言の該当部分をそのまま引用してください。発言に具体的な提案が無ければ proposed にはできません (積み重ねを根拠に相手から歩み寄るなら、quote ではなく initiative=true と evidence を使います)`);
            continue;
          }
        }
      }
      if ((u.to === "proposed" || u.to === "resolved" || (from === "proposed" && u.to === "revealed")) && note.length < 4) {
        errors.push(`懸念 "${u.id}" → ${u.to} には note (対処案の要約 / 合意内容 / 足りない点) が必要です`);
        continue;
      }
      planned.push({ index, from, to: u.to, note, by });
    }

    // 見つかる本音は 1 回の返答で 1 つまで (提案が当たって未発見からいきなり検討中になる場合も数える)
    const reveals = planned.filter((p) => p.from === "hidden");
    if (reveals.length > MAX_REVEALS_PER_REPLY) {
      errors.push(
        `1 回の返答で見つけられる本音は ${MAX_REVEALS_PER_REPLY} つまでです (今回 ${reveals.length} つ: ${reveals.map((p) => s.concerns[p.index].id).join(", ")})。プレイヤーの発言にいちばん自然に応える 1 つだけにして、残りは次のターン以降、聞き方に応じて出してください`,
      );
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
      const from = this.trust.get(id)!;
      if (to === from) continue;
      // プレイヤーには見せない。AI が get_state で振り返れるように記録だけしておく
      this.trustHistory.push({ turn: this.turn, character: id, from, to, reason: r.trust_changes?.find((t) => t.character === id)?.reason ?? "" });
      this.trust.set(id, to);
    }

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
      } else if (p.to === "resolved") rt.agreement = p.note;
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
        : `ok。残りターン ${this.turnLimit - this.turn}、信頼度 ${[...this.trust].map(([id, v]) => `${id} ${v}`).join(" / ")}、解消 ${resolved}/${this.concerns.length}`,
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

  /** 歩み寄るのに要る信頼度 */
  private initiativeTrust(minTrust: number) {
    return Math.max(this.params.initiativeTrust, minTrust + 1);
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
    this.ending = { type, reason, epilogue, resolved, total, importance, nonNegotiableLeft };
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
        const trust = this.trust.get(c.id)!;
        return { id: c.id, trust, trust_level: trustName(trust), understanding: c.understanding, understanding_note: understandingNote(c.understanding) };
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
          since_turn: rt.status === "revealed" ? rt.sinceTurn : undefined,
          initiative_trust: this.initiativeTrust(c.min_trust),
        };
      }),
    };
  }

  /** いま AI がやるべきこと。無ければ null */
  pendingWork(): Work | null {
    if (this.phase === "setup" && this.generating) return { type: "new_game", request: this.request, difficulty: difficultyBrief(this.difficulty, this.params) };
    if (this.phase === "ai_turn" && this.current && this.scenario) {
      const a = this.current;
      const left = this.turnLimit - a.turn;
      const notes: string[] = [];
      if (a.defer) notes.push("プレイヤーは「持ち帰って終える」を押しました。この返答で対話を締めくくってください (epilogue 必須)");
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
        note: "対話が終わりました。プレイヤーへの振り返りを submit_review で書いてください。transcript の実際の発言を引いて具体的に。励ましつつ、次に活かせる形で。解消できなかった懸念すべてに、どんな聞き方・どんな案なら届いたかを (reveal_hint / resolved_when を踏まえて) 書くこと。重要度 (importance) の高い本音を優先できたかにも触れる。ending.nonNegotiableLeft が 1 以上なら、譲れない本音が残ったことが持ち帰りの理由。プレイヤーには信頼度の数値は見えていないので、数値ではなく相手の反応で説明する。concerns[].proposed_by が character の懸念は、プレイヤーの積み重ねで相手から歩み寄ってくれたもの。何が効いたかを具体的に褒める",
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
          proposal: this.concerns[i].proposal,
          proposed_by: this.concerns[i].proposedBy,
          agreement: this.concerns[i].agreement,
        })),
        characters: s.characters.map((c) => ({ id: c.id, name: c.name, trust_start: c.trust_start, trust_end: this.trust.get(c.id)!, understanding: c.understanding })),
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

  /** AI 用の完全な状態 (隠し情報を含む。ブラウザには絶対に送らない) */
  fullState() {
    const s = this.scenario;
    return {
      phase: this.phase,
      difficulty: this.difficulty,
      params: this.params,
      turn_limit: this.turnLimit,
      turn: this.turn,
      trust: Object.fromEntries(this.trust),
      trust_history: this.trustHistory.slice(-8),
      scenario: s,
      concerns: s?.concerns.map((c, i) => ({
        id: c.id,
        status: this.concerns[i].status,
        proposal: this.concerns[i].proposal,
        proposed_by: this.concerns[i].proposedBy,
        agreement: this.concerns[i].agreement,
      })),
      moods: Object.fromEntries(this.moods),
      ending: this.ending,
      review: this.review,
      pending: this.pendingWork(),
      recent_log: this.log.slice(-12),
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
      log: this.log,
      ending: this.ending,
      review: this.review,
    };
  }
}
