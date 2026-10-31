import { z } from "zod";
import type { DifficultyBrief } from "./difficulty.js";
import { findSecretLike, MAX_TRUST, PARAM_SPECS } from "./shared.js";

const MAX_CONCERNS = PARAM_SPECS.concerns.max;

// ---- シナリオ (AI が生成する) ---------------------------------------------
// 「AI専用」の項目はブラウザに送られない。解消条件 (resolved_when) は開始時に確定し、以後 AI も変更できない。

const id = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, "英小文字で始まる英数字/アンダースコア 16文字以内");

export const characterSchema = z.object({
  id: id.describe("キャラクター識別子 (例: mayor)。'narrator' は使えない"),
  name: z.string().min(1).max(20),
  emoji: z.string().min(1).max(8).describe("アイコン用の絵文字1つ"),
  role: z.string().min(1).max(40).describe("プレイヤーに見える肩書き・立場 (例: 村長)"),
  persona: z
    .string()
    .min(10)
    .max(400)
    .describe("【AI専用】性格・価値観・何を大事にしているか。口調は speech に書く。「黙り込む」「言い淀む」など、隠し事を匂わせる振る舞いは書かない"),
  speech: z
    .string()
    .min(10)
    .max(200)
    .describe("【AI専用】口調の決まり。一人称・相手の呼び方・文体 (です/ます調かくだけた口調か)・語尾や口癖を具体的に。例: 「一人称は『わたし』、相手は『先生』。丁寧だが距離がある。語尾は『〜ですよ』『〜でしょう』」"),
  sample_lines: z
    .array(z.string().min(5).max(80))
    .min(2)
    .max(3)
    .describe("【AI専用】このキャラの口調がよく出ている短いセリフの例 (2〜3個)。毎ターン AI に渡され、口調を保つ手本になる。隠し事を匂わせない普通のセリフにする"),
});

export const concernSchema = z.object({
  id: id.describe("懸念の識別子 (例: c1)"),
  owner: id.describe("この懸念を持つキャラクターの id"),
  category: z.string().min(1).max(8).describe("懸念ボードに載るタグ。本音が見つかるまでプレイヤーには見えない (例: お金 / 時間 / 気持ち / 周囲への影響)"),
  text: z.string().min(6).max(120).describe("本当の懸念を一文で。発見されるまで非公開"),
  reveal_hint: z.string().min(6).max(200).describe("【AI専用】どんな聞き方・話題で本音が出るか"),
  min_trust: z
    .number()
    .int()
    .min(0)
    .max(MAX_TRUST - 1)
    .describe("本音を話し始める最低信頼度 (0〜4)。難易度の open_at_start 個だけを trust_start 以下 (最初から話せる) にし、残りは trust_start より上でばらつかせる"),
  resolved_when: z
    .string()
    .min(10)
    .max(250)
    .describe("【AI専用・解消後に公開】解消の条件。具体的で後から検証できる形に (例: 「渡し守が仕事を失わない案が示される」)。「納得したら」のような曖昧な書き方は不可"),
});

export const scenarioShape = {
  title: z.string().min(1).max(30),
  premise: z.string().min(10).max(300).describe("【公開】状況説明。プレイヤーが最初に読む"),
  player_role: z.string().min(1).max(80).describe("【公開】プレイヤーの立場 (例: 隣村から来た調停役)"),
  goal: z.string().min(1).max(120).describe("【公開】ゴール。懸念の中身は書かない (例: 橋の建設場所について村長と合意する)"),
  briefing: z
    .array(
      z.object({
        label: z.string().min(1).max(16).describe("項目名 (例: サービス / 顧客 / 期限 / 体制 / これまでの経緯 / 予算)"),
        text: z.string().min(4).max(160).describe("具体的な事実。固有名詞・数字・日付を入れる"),
      }),
    )
    .min(3)
    .max(8)
    .describe(
      "【公開】前提情報。プレイヤーの立場 (player_role) なら当然知っている事実を、対話の冒頭で伝える。例: 新サービスのリリース延期の調停なら、どんなサービスか・相手はどんな顧客か・期限と残り日数・チームの体制・これまでの経緯。隠された懸念 (本音) は書かない",
    ),
  characters: z.array(characterSchema).min(1).max(4),
  concerns: z
    .array(concernSchema)
    .min(PARAM_SPECS.concerns.min)
    .max(MAX_CONCERNS)
    .describe("隠された懸念。数は難易度で決まる (new_game の difficulty.concerns ちょうど)。互いに少しトレードオフになると面白い"),
  opening: z
    .array(z.object({ speaker: z.string(), text: z.string().min(1).max(400) }))
    .min(1)
    .max(3)
    .describe("対話の最初の発言。表向きの要望だけを話し、本音(懸念)は出さない。口調は難易度の mood (冒頭の雰囲気) に合わせる"),
  opening_moods: z
    .array(z.object({ character: z.string(), emoji: z.string().min(1).max(8), label: z.string().min(1).max(12) }))
    .max(4)
    .optional()
    .describe("【公開】冒頭の各キャラクターの気分 (絵文字と感情の名前)。難易度の mood に合わせる (例: 😊 好意的 / 😐 様子見 / 😠 不信感)。省略すると「ふつう」"),
};
export const scenarioSchema = z.object(scenarioShape);
export type Scenario = z.infer<typeof scenarioSchema>;

// ---- 誘導的な描写の検出 ----------------------------------------------------------
// 「何か言いかけて口をつぐんだ」のような、隠し事や言いたいことがあることを仕草で匂わせる描写は、
// プレイヤーを誘導してしまうので出させない。網羅はできないので、よくある言い回しだけ拾い、
// 原則は AI への指示 (server.ts) で伝える。
const STEERING: RegExp[] = [
  /言いかけ|言い淀|言いよど|口をつぐ|口を噤|口ごも|口を閉ざ|言葉を(?:飲み込|呑み込|濁|切)|言葉に詰ま/,
  /言いたげ|言いたそう|含みのある|意味ありげ|思わせぶり/,
  /(?:目|視線)を(?:伏せ|そらし|逸らし|落と|泳が)|うつむ|俯/,
  /黙り込|押し黙|沈黙が|ためらいがち|ためらうよう|ためらっ(?:た|て)|躊躇|はっとし|ハッとし|息を(?:のん|呑ん|飲ん)/,
  /[（(][^）)]{1,60}[）)]|[＊*][^＊*\n]{1,40}[＊*]/, // (うつむく) や *うつむく* のような括弧書きの動作
];

/** 誘導的な描写があれば、見つかった部分を返す */
export function findSteering(text: string): string | null {
  for (const re of STEERING) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

export const steeringMessage = (where: string, hit: string) =>
  `${where} に、相手を誘導する描写「${hit}」があります。仕草や括弧書きの動作 (言いかけてやめる・黙る・目をそらす等) で、隠し事や言いたいことがあることを匂わせてはいけません。台詞だけで、いまの発言に自然に答えてください`;

// ---- 画面に出してはいけないもの ---------------------------------------------------------
// AI の出力は吹き出しの文字として出すだけで、リンクにはしない。それでも URL や「API キーを入力して」のような文面は、
// ゲームの画面を装った誘導 (フィッシング) に使えるので出させない。
// 「API キー」という語そのものは IT が題材のシナリオで普通に出るので、入力・共有を求める言い方だけを対象にする
const UNSAFE_OUTPUT: Array<[string, RegExp]> = [
  ["URL", /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|ai|jp|co)\b/i],
  ["秘密情報の入力や共有を求める文面", /(?:API\s*キー|api[\s_-]?key|アクセストークン|パスワード|password|暗証番号|クレジットカード|カード番号)[^。\n]{0,12}(?:入力|教え|送っ|送信|貼|入れ|共有|書い|知らせ)/i],
];

/** 画面に出してはいけないものがあれば、その種類を返す */
export function findUnsafeOutput(text: string): string | null {
  for (const [name, re] of UNSAFE_OUTPUT) if (re.test(text)) return name;
  return findSecretLike(text) ? "API キーらしい文字列" : null;
}

export const unsafeMessage = (where: string, kind: string) =>
  `${where} に${kind}が含まれています。台詞や説明には URL を書かず、API キー・パスワードなどの入力や共有を求めないでください (ゲームの画面を装った誘導に使われるおそれがあるため)`;

// ---- 本音の漏れ ---------------------------------------------------------------------
// まだ見つかっていない本音を、台詞でほぼそのまま話してしまっていないか。言い換えまでは見分けられないので、
// 句読点と空白を除いた本音の文のうち 7 割以上が、台詞にも出てくる 4 文字の並びで覆えたら漏れとみなす
// (「少なく大きな」→「少なくて、大きな」のように、間に 1 文字入っただけの漏れも拾える)
const plain = (t: string) => t.replace(/[\s、。，．,.!！?？「」『』（）()…・"'“”‘’]/g, "");
const GRAM = 4;
const LEAK_RATIO = 0.7;

export function leaksSecret(text: string, secret: string): boolean {
  const t = plain(text);
  const s = plain(secret);
  if (!s) return false;
  if (s.length <= GRAM) return t.includes(s);
  const covered = new Array<boolean>(s.length).fill(false);
  for (let i = 0; i + GRAM <= s.length; i++) if (t.includes(s.slice(i, i + GRAM))) covered.fill(true, i, i + GRAM);
  return covered.filter(Boolean).length / s.length >= LEAK_RATIO;
}

/** zod で拾えない整合性チェック。エラーが空なら採用できる。d は依頼された難易度 */
export function checkScenario(s: Scenario, d: DifficultyBrief): string[] {
  const errors: string[] = [];
  s.characters.forEach((c, ci) =>
    c.sample_lines.forEach((t, i) => {
      const hit = findSteering(t);
      if (hit) errors.push(steeringMessage(`characters[${ci}].sample_lines[${i}]`, hit));
    }),
  );
  s.opening.forEach((o, i) => {
    const hit = findSteering(o.text);
    if (hit) errors.push(steeringMessage(`opening[${i}]`, hit));
    for (const c of s.concerns) if (leaksSecret(o.text, c.text)) errors.push(`opening[${i}] に、隠された懸念 "${c.id}" の本音がほぼそのまま出ています。冒頭では表向きの要望だけを話してください`);
  });
  // プレイヤーに見える文には、URL や秘密情報を求める文面を入れない
  const shown: Array<[string, string]> = [
    ["premise", s.premise],
    ["goal", s.goal],
    ["player_role", s.player_role],
    ...s.briefing.map((b, i): [string, string] => [`briefing[${i}]`, `${b.label} ${b.text}`]),
    ...s.opening.map((o, i): [string, string] => [`opening[${i}]`, o.text]),
  ];
  for (const [where, text] of shown) {
    const kind = findUnsafeOutput(text);
    if (kind) errors.push(unsafeMessage(where, kind));
  }
  const charIds = new Set<string>();
  for (const c of s.characters) {
    if (c.id === "narrator") errors.push(`キャラクター id に "narrator" は使えません`);
    if (charIds.has(c.id)) errors.push(`キャラクター id "${c.id}" が重複しています`);
    charIds.add(c.id);
  }
  const concernIds = new Set<string>();
  for (const c of s.concerns) {
    if (concernIds.has(c.id)) errors.push(`懸念 id "${c.id}" が重複しています`);
    concernIds.add(c.id);
    if (!charIds.has(c.owner)) errors.push(`懸念 "${c.id}" の owner "${c.owner}" がキャラクターに存在しません`);
    if (c.text === c.resolved_when) errors.push(`懸念 "${c.id}" の text と resolved_when が同じです`);
    // 前提情報は公開される。隠された本音をそのまま書いてしまっていないか (言い換えまでは見分けられない)
    s.briefing.forEach((b, i) => {
      if (leaksSecret(b.text, c.text)) errors.push(`briefing[${i}] に、隠された懸念 "${c.id}" の本音がそのまま書かれています。前提情報には、誰もが知っている事実だけを書いてください`);
    });
  }
  s.opening.forEach((o, i) => {
    if (o.speaker !== "narrator" && !charIds.has(o.speaker)) errors.push(`opening[${i}].speaker "${o.speaker}" が存在しません`);
  });
  for (const m of s.opening_moods ?? []) {
    if (!charIds.has(m.character)) errors.push(`opening_moods: キャラクター "${m.character}" は存在しません`);
    const hit = findSteering(m.label);
    if (hit) errors.push(steeringMessage(`opening_moods (${m.character}) の label`, hit));
  }
  if (s.concerns.length !== d.concerns) errors.push(`難易度「${d.label}」では、懸念はちょうど ${d.concerns} 個にしてください (いま ${s.concerns.length} 個)`);
  const open = s.concerns.filter((c) => c.min_trust <= d.trust_start).length;
  if (open !== d.open_at_start) {
    errors.push(
      `難易度「${d.label}」では、最初から話せる本音 (min_trust が初期の信頼度 ${d.trust_start} 以下) をちょうど ${d.open_at_start} 個にしてください (いま ${open} 個)。残りの min_trust は ${d.trust_start + 1}〜${MAX_TRUST - 1} にする`,
    );
  }
  return errors;
}

// ---- AI の返答 (1ターン = reply 1回) -------------------------------------

export const replyShape = {
  turn: z.number().int().describe("wait_for_player_turn で受け取った turn をそのまま返す"),
  lines: z
    .array(z.object({ speaker: z.string().describe("キャラクター id か 'narrator'"), text: z.string().min(1).max(400) }))
    .min(1)
    .max(4)
    .describe("このターンの発言。セリフ中心、1〜3個が目安"),
  trust_delta: z.number().int().min(-1).max(1).optional().describe("信頼度の増減。1ターンに ±1 まで。先に適用され、その後の信頼度で本音の解禁を判定する。信頼度はプレイヤーには見えないので、変化は口調や moods で表現する"),
  trust_reason: z.string().max(80).optional().describe("信頼度を動かした理由 (プレイヤーには表示されない。get_state で振り返るための記録)"),
  concern_updates: z
    .array(
      z.object({
        id: z.string(),
        to: z.enum(["revealed", "proposed", "resolved"]),
        note: z
          .string()
          .max(200)
          .optional()
          .describe("resolved=何で合意したか (終了時の合意書に載る) / proposed=出された対処案の要約 / proposed→revealed(差し戻し)=何が足りないか。後の2つは AI の記録用でプレイヤーには見えない"),
        quote: z
          .string()
          .max(200)
          .optional()
          .describe(
            "to=proposed (プレイヤーの提案) のとき必須。プレイヤーの今回の発言から、具体的な対処案・条件の提示にあたる部分を一字一句そのまま抜き出す (空白は無視して照合される)。発言に無い提案を作って進めることはできない。質問・共感・要約確認・雑談は提案ではない",
          ),
        initiative: z
          .boolean()
          .optional()
          .describe(
            "true = 相手 (キャラクター) の側からの歩み寄り。to=proposed のときだけ。本音が見えた後、プレイヤーが積み重ねた発言で解消条件 (resolved_when) がそろったと判断したとき、「条件がそろったので、私はこうしたい」と着地点を自分から示す。quote の代わりに evidence を使う。条件はエンジンが確認する",
          ),
        evidence: z
          .array(z.string().max(200))
          .max(4)
          .optional()
          .describe(
            "initiative=true のとき必須。歩み寄りの根拠にしたプレイヤーの発言を、一字一句そのまま引用する (4 文字以上、digest.initiative_min_turns 個以上、本音が見えた後の別々のターンから)。プレイヤーが言っていない解決策を、相手が自分で作ることはできない",
          ),
      }),
    )
    .max(MAX_CONCERNS)
    .optional()
    .describe("懸念の進行。1つの懸念は1ターンに1段階だけ動かせる"),
  moods: z
    .array(z.object({ character: z.string(), emoji: z.string().min(1).max(8), label: z.string().min(1).max(12) }))
    .max(4)
    .optional()
    .describe("キャラクターの現在の気分 (表情の絵文字と一言)。「ふつう」「少し安心」「困惑」のような感情の名前だけ。「隠している」「言い淀む」など、隠し事を匂わせる言葉は使わない"),
  epilogue: z.string().max(300).optional().describe("この返答で対話が終わる場合は必須。締めくくりの一文"),
};
export const replySchema = z.object(replyShape);
export type ReplyInput = z.infer<typeof replySchema>;

// ---- 終了後の振り返り -------------------------------------------------------

export const reviewShape = {
  overall: z.string().min(10).max(300).describe("総評。この対話全体の印象と、結果を分けた一番の分かれ目"),
  good: z.array(z.string().min(5).max(160)).min(1).max(4).describe("良かった点。プレイヤーの実際の発言を引いて具体的に"),
  improve: z.array(z.string().min(5).max(160)).min(1).max(4).describe("改善できる点。次はこう聞く/こう言うとよい、と具体的に。責める書き方は避ける"),
  concerns: z
    .array(z.object({ id: z.string(), advice: z.string().min(5).max(200) }))
    .max(MAX_CONCERNS)
    .describe("解消できなかった (見つけられなかった・案が届かなかった) すべての懸念について、どんな聞き方・どんな案なら届いたか。解消済みの懸念は含めない"),
};
export const reviewSchema = z.object(reviewShape);
export type ReviewInput = z.infer<typeof reviewSchema>;
