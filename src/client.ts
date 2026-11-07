import { config as zodConfig } from "zod";
import { createLocalBackend, createRemoteBackend, type Action, type Backend } from "./backend.js";
import { encryptScenarioFile, MAX_KEY_CHARS, normalizeKey, openScenarioFile, ScenarioFileError, ScenarioKeyRequired } from "./scenario-crypto.js";
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_EFFORT,
  DIFFICULTIES,
  DIFFICULTY_INFO,
  DIFFICULTY_PRESETS,
  EFFORT_OPTIONS,
  IMPORTANCE_LEVEL_NAMES,
  levelBand,
  NON_NEGOTIABLE,
  OPENNESS_LEVEL_NAMES,
  PARAM_SPECS,
  sameParams,
  TRUST_LEVEL_NAMES,
  turnLimitOf,
  UNDERSTANDING_LEVEL_NAMES,
  ENDING_LABELS,
  STATUS_LABELS,
  type AiProviderOption,
  type AiStatus,
  type Difficulty,
  type DifficultyParams,
  type LogLine,
  type PublicCharacter,
  type PublicConcern,
  type PublicState,
  type GameScore,
} from "./shared.js";

// ---- 小さな DOM ヘルパー (AI やプレイヤーの文字列は必ず textContent で入れる) ----
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// zod の高速化 (実行時のコード生成) は eval を使う。CSP で eval を禁じているので、使わない設定にする
zodConfig({ jitless: true });

/**
 * ゲームの本体。ふだんはこのページの中で動かす (AI の会社の API を直接呼び、キーは運営のサーバーに送らない)。
 * MCP 版のサーバー (npm run mcp) が配信したページだけは、そのサーバーと通信する
 */
const SERVER_MODE = document.querySelector('meta[name="backend"]')?.getAttribute("content") === "server";
const backend: Backend = SERVER_MODE ? createRemoteBackend(() => showWrongServer()) : createLocalBackend();

/** 操作を送る。うまくいかなければ理由を知らせる */
async function post(action: Action, body: Record<string, unknown> = {}) {
  const error = await backend.send(action, body);
  if (error) toast(error);
  return !error;
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

// ---- 状態 ---------------------------------------------------------------------
let state: PublicState | null = null;
let epoch = -1;
let lastLineId = 0;
let initialLoad = true;
let composeNew = false; // 進行中に「新しいシナリオ」を押してフォームを開いている
let endingDismissed = false;

const chat = $("chat");
const typing = h("div", { class: "msg typing" }, h("div", { class: "bubble" }, h("i"), h("i"), h("i")));
typing.hidden = true;
chat.append(typing);

// ---- 会話の描画 (文字送り) -------------------------------------------------------
let queue: Promise<void> = Promise.resolve();
let queued = 0;
let skip = false;
let token = 0; // epoch が変わったら古い演出を捨てるための世代

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
const scrollDown = () => (chat.scrollTop = chat.scrollHeight);

function charOf(s: PublicState, id?: string) {
  return s.scenario?.characters.find((c) => c.id === id);
}

function bubbleFor(s: PublicState, l: LogLine): { el: HTMLElement; body: HTMLElement } {
  if (l.from === "narrator") {
    const el = h("div", { class: "msg narr" });
    return { el, body: el };
  }
  if (l.from === "player") {
    const to = charOf(s, l.to);
    const body = h("div", { class: "bubble" }, l.text);
    return { el: h("div", { class: "msg me" }, h("div", {}, to && h("div", { class: "meta" }, `→ ${to.name}`), body)), body };
  }
  const c = charOf(s, l.speaker);
  const body = h("div", { class: "bubble" });
  return { el: h("div", { class: "msg char" }, h("div", { class: "avatar" }, c?.emoji ?? "💬"), h("div", {}, h("div", { class: "name" }, c?.name ?? l.speaker ?? ""), body)), body };
}

function enqueue(s: PublicState, l: LogLine, animate: boolean) {
  const my = token;
  queued++;
  queue = queue.then(async () => {
    try {
      if (my !== token) return;
      const { el, body } = bubbleFor(s, l);
      const stick = nearBottom();
      chat.insertBefore(el, typing);
      if (stick) scrollDown();
      if (animate && !skip && (l.from === "character" || l.from === "narrator")) {
        const text = [...l.text];
        const delay = Math.min(30, Math.max(8, 2400 / text.length));
        let shown = "";
        for (const ch of text) {
          if (skip || my !== token) break;
          shown += ch;
          body.textContent = shown;
          if (nearBottom()) scrollDown();
          await sleep(delay);
        }
      }
      body.textContent = l.text;
      if (stick) scrollDown();
    } finally {
      // epoch が変わった後の古い演出は、リセット済みのカウンタに触らない
      if (my === token && --queued === 0) skip = false;
    }
  });
}
chat.addEventListener("click", () => {
  if (queued > 0) skip = true;
});

// ---- サイドパネル ------------------------------------------------------------------
function renderSide(s: PublicState) {
  const sc = s.scenario;
  $("goal").replaceChildren(
    h("div", {}, sc?.goal ?? "—"),
    h("div", { class: "muted text-sm mt6" }, sc ? `あなたの立場: ${sc.playerRole}` : ""),
    h("div", { class: "muted text-sm" }, sc ? `難易度: ${DIFFICULTY_INFO[s.difficulty]?.label ?? "普通"}${s.customized ? " (調整あり)" : ""}` : ""),
  );
  const left = sc ? Math.max(0, sc.turnLimit - s.turn) : 0;
  $("turns").textContent = sc ? `${left} / ${sc.turnLimit}` : "";
  $("turnbar").style.width = sc ? `${(left / sc.turnLimit) * 100}%` : "0%";
  $("cast").replaceChildren(
    ...(sc?.characters ?? []).map((c: PublicCharacter) =>
      // 1 段目に名前と気分、2 段目に肩書き (長い肩書きでも、名前の後ろから折り返さない)
      h(
        "div",
        { class: "who" },
        h("span", { class: "em" }, c.emoji),
        h("span", { class: "name" }, c.name),
        h("span", { class: "mood" }, `${c.mood.emoji} ${c.mood.label}`),
        h("small", { class: "role" }, c.role),
      ),
    ),
  );
  // 空から始まり、本音が見つかった分だけ増える (総数は見せない)
  $("board").replaceChildren(...(s.concerns.length ? s.concerns.map((c) => concernCard(s, c)) : [h("div", { class: "empty" }, "まだ何も見えていません。相手の話を聞いてみましょう。")]));
}

/** ボードのカードは本音の内容と状態だけ。重要度・合意内容・助言は、終了後の画面にだけ出す (重要度と合意内容は、終了後にしか届かない) */
function concernCard(s: PublicState, c: PublicConcern, withAgreement = false, advice?: string) {
  const owner = charOf(s, c.owner);
  return h(
    "div",
    { class: `concern ${c.status}${c.missed ? " missed" : ""}` },
    h(
      "div",
      { class: "top" },
      h("span", {}, owner?.emoji ?? ""),
      h("span", { class: "cat" }, c.category),
      c.importance !== undefined && importanceBadge(c.importance),
      h("span", { class: "st" }, c.missed ? "見つけられなかった" : STATUS_LABELS[c.status]),
    ),
    h("div", {}, c.text),
    withAgreement && c.agreement && h("div", { class: "sub" }, `✅ ${c.agreement}`),
    advice && h("div", { class: "sub advice" }, `💡 ${advice}`),
  );
}

/** 本音の重要度 (例: 重要度 9 · 譲れない)。終了後の答え合わせ用。必ず達成したい・譲れないものは目立たせる */
function importanceBadge(v: number) {
  const band = levelBand(v);
  const tone = v >= NON_NEGOTIABLE ? " must" : band === 3 ? " high" : "";
  return h("span", { class: `imp${tone}`, title: "その人にとっての重要度 (1〜10)" }, `重要度 ${v} · ${IMPORTANCE_LEVEL_NAMES[band]}`);
}

// ---- 入力欄 -------------------------------------------------------------------------
/**
 * 指で操作する端末 (スマホ・タブレット)。画面のキーボードには Shift が無く「Shift+Enter で改行」ができないので、
 * Enter は改行にして、送信は送信ボタンで行う
 */
const TOUCH = matchMedia("(pointer: coarse)").matches;
if (TOUCH) $("text").setAttribute("enterkeyhint", "enter");

/** 前回の描画で入力欄が使えたか (自分の番が回ってきた瞬間を見分ける) */
let composerOpen = false;

/** 入力欄を状態に合わせる。自分の番が回ってきた瞬間なら true */
function updateComposer() {
  const s = state;
  const can = s?.phase === "player_turn";
  const opened = can && !composerOpen;
  composerOpen = can;
  const text = $<HTMLTextAreaElement>("text");
  text.disabled = !can;
  $<HTMLButtonElement>("send").disabled = !can;
  $<HTMLButtonElement>("defer").disabled = !can;
  text.placeholder = !s?.scenario
    ? "シナリオの準備中…"
    : s.phase === "ai_turn"
      ? "相手が考えています…"
      : s.phase === "ended"
        ? "対話は終了しました"
        : TOUCH
          ? "ここに入力"
          : "ここに入力 (Enter で送信 / Shift+Enter で改行)";
  const to = $<HTMLSelectElement>("to");
  const cast = s?.scenario?.characters ?? [];
  const prev = to.value;
  to.replaceChildren(h("option", { value: "" }, "全員"), ...cast.map((c) => h("option", { value: c.id }, `${c.emoji} ${c.name}`)));
  to.value = cast.some((c) => c.id === prev) ? prev : "";
  to.hidden = cast.length < 2;
  to.disabled = !can;
  $<HTMLButtonElement>("replay").disabled = !s?.scenario;
  return opened;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $<HTMLTextAreaElement>("text");
  const value = text.value.trim();
  if (state?.phase !== "player_turn" || !value) return;
  const to = $<HTMLSelectElement>("to").value || undefined;
  if (await post("act", { text: value, to })) text.value = "";
});
// 唯一のコマンド: 今回はここまでにして終える (入力欄の文は、別れのひとこととして一緒に送る)
$("defer").addEventListener("click", async () => {
  if (state?.phase !== "player_turn") return;
  if (!confirm("ここで、この対話を締めくくります。よろしいですか？")) return;
  const text = $<HTMLTextAreaElement>("text");
  const to = $<HTMLSelectElement>("to").value || undefined;
  if (await post("defer", { text: text.value.trim(), to })) text.value = "";
});
$("text").addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  // 日本語 IME の変換確定 Enter では送信しない。指で操作する端末では Enter は改行のまま
  if (!TOUCH && ke.key === "Enter" && !ke.shiftKey && !ke.isComposing && ke.keyCode !== 229) {
    ke.preventDefault();
    $<HTMLFormElement>("composer").requestSubmit();
  }
});

// ---- ヘッダー操作 ----------------------------------------------------------------------
$("replay").addEventListener("click", () => {
  if (state?.phase !== "ended" && !confirm("いまの対話を捨てて、同じシナリオで最初からやり直しますか？")) return;
  endingDismissed = false;
  post("replay");
});
$("aichange").addEventListener("click", openAiSetup);
$("exportscenario").addEventListener("click", () => void saveScenario());
$("newgame").addEventListener("click", () => {
  if (state?.scenario && state.phase !== "ended" && !confirm("いまの対話を捨てて、新しいシナリオを作りますか？")) return;
  composeNew = true;
  render();
});

// ---- セットアップ (新しいシナリオ) / 終了画面 ---------------------------------------------

// ---- AI の接続 (選択・案内・エラー) ---------------------------------------------------
const MCP_MISSING = "AI が接続されていません。Claude Code で suriawase-simulator (MCP) を接続し、GM として待機してもらってください (README 参照)。";

function aiHint(s: PublicState) {
  if (s.ai.mode === "mcp" && !s.ai.connected) return h("p", { class: "warn" }, MCP_MISSING);
  return false;
}

/** AI の呼び出しが失敗して止まっているときの表示と再試行ボタン。canSwitch = 別の AI に変えて続けるボタンも出す (会話中の案内) */
function aiErrorBox(s: PublicState, canSwitch = false) {
  if (!s.ai.error) return false;
  return h(
    "div",
    { class: "aierr" },
    h("span", {}, `⚠ ${s.ai.error}`),
    h(
      "span",
      { class: "aierr-actions" },
      canSwitch && s.ai.mode === "builtin" && h("button", { type: "button", onclick: openAiSetup }, "AI を変更"),
      h("button", { type: "button", onclick: () => post("ai/retry") }, "再試行"),
    ),
  );
}

/** 「AI の設定」を開く。対話の途中でも開け、閉じるとそのまま対話に戻る */
function openAiSetup() {
  aiSetupOpen = true;
  render();
}

const OTHER_MODEL = "__other__";

/** ヘッダーなどに出す AI の名前。思考レベルが既定 (Medium) 以外のときは、添えて見せる */
function aiText(ai: AiStatus) {
  const effort = ai.current?.effort;
  if (!effort || effort === DEFAULT_EFFORT) return ai.label;
  return `${ai.label}・思考 ${EFFORT_OPTIONS.find((o) => o.id === effort)?.label ?? effort}`;
}

/** プライバシーポリシー・利用規約へのリンク。対話とキーはこのページの中にしかないので、別のタブで開く */
const policyLink = (text: string, href: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

/**
 * 開始画面の AI の選択 (内蔵 GM のときだけ)。サービスを選んで API キーを入力し、「決定」でキーが使えると確かめられたら、モデルを選べる。
 * キーの確認はサーバーが行う。キーそのものはブラウザに返ってこない
 */
function aiPicker(s: PublicState, onReady: (ready: boolean) => void) {
  const ai = s.ai;
  if (ai.mode !== "builtin") return null;
  // キーの有無は、このフォームの中で入力に成功したら書き換える (サーバーからの状態更新でフォームを作り直さないため)
  const withKey = new Set<string>(ai.providers.filter((p) => p.hasKey).map((p) => p.id));
  const providerOf = (id: string) => ai.providers.find((p) => p.id === id) ?? ai.providers[0];
  const optionText = (p: AiProviderOption) => `${p.label}${withKey.has(p.id) ? " ✓" : ""}`;
  const provider = h("select", { "aria-label": "AI サービス" }, ...ai.providers.map((p) => h("option", { value: p.id }, optionText(p))));

  // API キー: 未設定なら入力欄、設定済みなら「変更」ボタン
  const keyInput = h("input", { type: "password", autocomplete: "off", spellcheck: "false", maxlength: 400, placeholder: "API キーを貼り付け", "aria-label": "API キー" });
  const keyButton = h("button", { type: "button", class: "primary" }, "決定");
  const keyCancel = h("button", { type: "button" }, "やめる");
  const keyMsg = h("p", { class: "keymsg", role: "status" });
  const keyLink = h("a", { target: "_blank", rel: "noopener noreferrer" });
  // キーの扱い (どこに置き、どこへ送るか) を、項目ごとに 1 行ずつ見せる
  const keyFacts = h("ul", { class: "keyfacts" });
  // 漏れても困らないキーを使ってもらう: このゲーム専用のキーと、上限額の設定
  const keySteps = h("ol", {});
  const keySafety = h(
    "details",
    { class: "keysafety" },
    h("summary", {}, "安全に使うために (おすすめ)"),
    h("p", {}, "このゲーム専用のキーを作り、上限額を決めておけば、万一キーが漏れても被害はその範囲で止まります。"),
    keySteps,
    h("p", { class: "muted" }, "遊び終わったら、キーを無効化 (削除) してください。各社の画面の名前や仕様は変わることがあります。"),
  );
  const keyEntry = h(
    "div",
    { class: "keystep" },
    h("div", { class: "row" }, keyInput, keyButton, keyCancel),
    keyMsg,
    keyFacts,
    keySafety,
    h("p", { class: "keyissue" }, "キーの発行: ", keyLink, " ・ ", policyLink("キーと会話の扱い (プライバシーポリシー)", "/privacy.html")),
  );
  const keyDone = h(
    "div",
    { class: "keydone" },
    h("span", {}, "✓ 設定済み"),
    h("button", { type: "button", onclick: () => setEditing(true) }, "変更"),
    h("button", { type: "button", onclick: () => void forgetKey() }, "消す"),
  );

  // モデル: キーが確かめられてから選べる
  const model = h("select", { "aria-label": "モデル" });
  const custom = h("input", { type: "text", maxlength: 100, placeholder: "モデル ID を入力 (例: claude-opus-5-5)", "aria-label": "モデル ID" });
  // 思考レベル: 上ほど、相手の意図を読み違えにくいが、遅く、トークンも増える。軽いモデルで読み違えが目立つときに上げる
  const effort = h("select", { "aria-label": "思考レベル" }, ...EFFORT_OPTIONS.map((o) => h("option", { value: o.id }, o.label)));
  effort.value = ai.current?.effort ?? DEFAULT_EFFORT;
  const modelStep = h(
    "div",
    { class: "modelstep" },
    h("div", { class: "aipick" }, h("label", {}, "モデル", model), custom, h("label", {}, "思考レベル", effort)),
    h("p", { class: "effortnote" }, "高いほど、相手の意図を読み違えにくくなりますが、返答が遅くなり、使うトークン (料金・無料枠の消費) も増えます。軽いモデルで会話が噛み合わないときに上げてみてください。"),
  );
  const fillModels = (id: string, wanted?: string) => {
    const p = providerOf(id);
    model.replaceChildren(...p.models.map((m) => h("option", { value: m.id }, m.label)), h("option", { value: OTHER_MODEL }, "その他 (ID を入力)"));
    const known = !!wanted && p.models.some((m) => m.id === wanted);
    model.value = !wanted ? p.defaultModel : known ? wanted : OTHER_MODEL;
    custom.value = wanted && !known ? wanted : "";
    custom.placeholder = `モデル ID を入力 (例: ${p.defaultModel})`;
    custom.hidden = model.value !== OTHER_MODEL;
  };

  let editing = false;
  const ready = () => withKey.has(provider.value) && !editing;
  function update() {
    const p = providerOf(provider.value);
    keyEntry.hidden = !editing;
    keyDone.hidden = editing;
    keyCancel.hidden = !withKey.has(p.id); // 設定済みのキーを入れ直すときだけ、やめられる
    keyLink.setAttribute("href", p.keyUrl);
    keyLink.textContent = p.keyUrl.replace(/^https:\/\//, "");
    const fact = (icon: string, ...text: Array<Node | string>) => h("li", {}, h("span", { class: "ico" }, icon), h("span", {}, ...text));
    keyFacts.replaceChildren(
      fact("🔒", "キーは、このブラウザの中にだけ置きます。"),
      fact("📤", `送り先は ${p.label.replace(/\s*\(.*\)$/, "")} の API だけです。`, h("br"), h("span", { class: "host" }, p.apiHost)),
      fact("🚫", "このサイトのサーバーには送りません。"),
      fact("🗑", "ページを閉じると消えます。"),
    );
    keySteps.replaceChildren(...p.keySteps.map((step) => h("li", {}, step)));
    modelStep.hidden = !ready();
    onReady(ready());
  }
  /** キーの入力欄を開く/閉じる。キーが未設定のサービスでは閉じられない */
  function setEditing(on: boolean, focus = true) {
    editing = on || !withKey.has(provider.value);
    keyInput.value = "";
    keyMsg.textContent = "";
    keyMsg.className = "keymsg";
    update();
    if (focus) (editing ? keyInput : model).focus();
  }
  async function submitKey() {
    const id = provider.value;
    const key = keyInput.value.trim();
    const say = (text: string, warn = false) => ((keyMsg.textContent = text), (keyMsg.className = warn ? "keymsg warn" : "keymsg"));
    if (!key) return say("API キーを入力してください", true);
    keyButton.disabled = true;
    say("キーが使えるか確かめています…");
    const error = await backend.send("ai/key", { provider: id, key });
    keyButton.disabled = false;
    if (error) {
      say(error, true);
      return keyInput.select();
    }
    keyInput.value = "";
    withKey.add(id);
    relabel(id);
    if (provider.value === id) setEditing(false); // 確かめている間に別のサービスに切り替えていなければ、モデルの選択へ
  }
  /** このページからキーを消す。そのサービスを使っていたら、AI の選択も外れる */
  async function forgetKey() {
    const id = provider.value;
    const error = await backend.send("ai/forget", { provider: id });
    if (error) return toast(error);
    withKey.delete(id);
    relabel(id);
    setEditing(false);
  }
  const relabel = (id: string) => {
    const option = [...provider.options].find((o) => o.value === id);
    if (option) option.textContent = optionText(providerOf(id));
  };

  const first = ai.current?.provider ?? ai.providers.find((p) => p.hasKey)?.id ?? ai.providers[0].id;
  provider.value = first;
  fillModels(first, ai.current?.provider === first ? ai.current.model : undefined);
  provider.addEventListener("change", () => {
    fillModels(provider.value);
    setEditing(false);
  });
  model.addEventListener("change", () => {
    custom.hidden = model.value !== OTHER_MODEL;
    if (!custom.hidden) custom.focus();
  });
  keyButton.addEventListener("click", () => void submitKey());
  keyCancel.addEventListener("click", () => setEditing(false));
  keyInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    void submitKey();
  });
  setEditing(false, false);

  return {
    el: h("div", { class: "aibox" }, h("label", {}, "AI サービス", provider), h("div", { class: "field" }, h("span", {}, "API キー"), keyEntry, keyDone), modelStep),
    ready,
    value: () => ({ provider: provider.value, model: model.value === OTHER_MODEL ? custom.value.trim() : model.value, effort: effort.value }),
  };
}

let setupKey = "";
/** 紹介画面 (最初に開いたときの、題名・概要・リンク) を過ぎたか。過ぎたら、もう出さない (ブラウザの保存領域は使わない) */
let introDone = false;
/** 「AI の設定」画面を開いている (内蔵 GM で AI がまだ確定していなければ、いつもこちらから) */
let aiSetupOpen = false;
/** 最後に選んだ難易度 (次の新しいシナリオでも同じものを選んでおく) */
let chosenDifficulty: Difficulty | null = null;
/** 「パラメータ」ウィンドウで微調整した値 (null = 難易度の初期値のまま) */
let tunedParams: DifficultyParams | null = null;
/** 「パラメータ」の折りたたみ欄を開いているか (新しいシナリオのたびに閉じ直さない) */
let paramsOpen = false;

/**
 * 開始の流れ: (1) AI の設定 (サービス・API キー・モデル) を確定 → (2) どんな話にするか・難易度を選んで「はじめる」。
 * AI を確定した後は (2) から始まる (「変更」で (1) に戻れる)。MCP では AI は Claude Code なので (2) だけ
 */
function renderSetup(s: PublicState) {
  const el = $("setup");
  const aiStep = s.ai.mode === "builtin" && (aiSetupOpen || !s.ai.current);
  // 対話の途中で「AI を変更」を押したときは、AI の設定だけを開く
  const show = s.phase === "setup" || composeNew || (aiStep && aiSetupOpen);
  el.hidden = !show;
  const generating = s.phase === "setup" && s.generating && !composeNew;
  // 最初に開いたとき (シナリオが無く、何も始めていない) は、いきなり設定ではなく、紹介画面を出す
  const intro = !introDone && s.phase === "setup" && !s.scenario && !s.generating && !composeNew && !aiSetupOpen;
  // 入力中のフォームを、無関係な状態更新で作り直さない
  const key = !show
    ? "hidden"
    : intro
      ? `intro:${s.ai.mode}`
      : generating
      ? `generating:${s.ai.mode}:${s.ai.connected}:${s.ai.error ?? ""}:${s.ai.notice ?? ""}`
      : aiStep
        ? `ai:${!!s.scenario}:${composeNew}`
        : `story:${!!s.scenario}:${composeNew}:${s.ai.mode}:${s.ai.label}`;
  if (key === setupKey) return;
  setupKey = key;
  if (!show) return;
  if (intro) {
    el.replaceChildren(introDialog(s));
    return;
  }
  if (generating) {
    el.replaceChildren(
      h(
        "div",
        { class: "dialog center" },
        !s.ai.error && h("div", { class: "spinner" }),
        h("h2", {}, s.ai.error ? "シナリオを作れませんでした" : "AI がシナリオを考えています…"),
        !s.ai.error && s.ai.notice && h("p", { class: "muted text-sm" }, `⏳ ${s.ai.notice}`),
        aiErrorBox(s),
        aiHint(s),
        h(
          "div",
          { class: "actions" },
          s.ai.mode === "builtin" && h("button", { onclick: () => ((composeNew = true), (aiSetupOpen = true), render()) }, "AI を選び直す"),
          h("button", { onclick: () => post("new", { request: "", difficulty: s.difficulty }).then(() => (composeNew = false)) }, "おまかせで作り直す"),
        ),
      ),
    );
    return;
  }
  el.replaceChildren(aiStep ? aiSetupDialog(s) : storyDialog(s));
  if (!aiStep) el.querySelector("textarea")?.focus();
}

const REPO_URL = "https://github.com/mashinosatoshi/suriawase-simulator";

/**
 * 紹介画面: 題名・概要・遊び方・リンク。「ゲームを始める」を押すと、(1) AI の設定 → (2) 話題と難易度 に進む。
 * MCP では AI は Claude Code なので、遊び方から AI を選ぶ手順は除く
 */
function introDialog(s: PublicState) {
  const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
  const builtin = s.ai.mode === "builtin";
  const steps = [
    ...(builtin ? ["使う AI (Claude・GPT・Gemini) を選び、API キーを入力します。"] : []),
    "どんな話にするか (空欄ならおまかせ) と、難易度を選びます。",
    "相手と会話して、本音を聞き出し、すり合わせます。",
  ];
  return h(
    "div",
    { class: "dialog landing" },
    h("div", { class: "big" }, "🤝"),
    h("h1", {}, "すり合わせシミュレーター"),
    h("p", { class: "lead" }, "隠れた課題を聞き出して合意形成する会話ゲームです。"),
    h(
      "ul",
      { class: "points" },
      h("li", {}, "シナリオと相手役は、AI がその場で作るので毎回変わります。"),
      h("li", {}, "自由に会話できます。信頼を築くと、少しずつ本音を話してくれます。"),
      h("li", {}, "具体的な解決案を出して、お互いが納得できる形に落とし込みます。"),
      h("li", {}, "終了時にどれだけ上手に合意形成できたかがスコア化されます。"),
    ),
    h("div", { class: "howto" }, h("h2", {}, "遊び方"), h("ol", { class: "steps" }, ...steps.map((t) => h("li", {}, t)))),
    builtin && h("p", { class: "muted text-sm" }, "API キーはあなたのブラウザの中だけで使われ、このサイトのサーバーには絶対に送られませんが、話題や会話は選んだ AI の会社に送られますので、個人情報や機密情報は絶対に入力しないでください。"),
    h("button", { class: "primary start", onclick: () => ((introDone = true), render()) }, "ゲームを始める"),
    h(
      "p",
      { class: "links text-sm" },
      link(REPO_URL, "ソースコード (GitHub)"),
      " ・ ",
      link("/privacy.html", "プライバシーポリシー"),
      " ・ ",
      link("/terms.html", "利用規約"),
      " ・ ",
      link(`${REPO_URL}/issues`, "お問い合わせ"),
    ),
  );
}

/** (1) AI の設定。確定すると (2) に進む */
function aiSetupDialog(s: PublicState) {
  const confirm = h("button", { class: "primary" }, "確定");
  const picker = aiPicker(s, (ready) => (confirm.disabled = !ready))!;
  confirm.addEventListener("click", async () => {
    if (!picker.ready()) return toast("API キーを入力して「決定」を押してください");
    const choice = picker.value();
    if (!choice.model) return toast("モデル ID を入力してください");
    confirm.disabled = true;
    if (await post("ai/select", choice)) {
      aiSetupOpen = false;
      // 対話の途中で、相手の返答や振り返りを待っている (失敗して止まっている) なら、新しい AI で続きを試す
      const cur = state;
      if (!composeNew && (cur?.phase === "ai_turn" || (cur?.phase === "ended" && !cur.review))) void post("ai/retry");
      render();
    } else confirm.disabled = false;
  });
  const midGame = !!s.scenario && s.phase !== "setup" && !composeNew;
  return h(
    "div",
    { class: "dialog" },
    h("h2", {}, "AI の設定"),
    h("p", { class: "muted" }, "シナリオを作り、相手役を演じる AI を選びます。使うサービスを選んで API キーを入力し、「決定」を押すとモデルを選べます。"),
    midGame && h("p", { class: "muted" }, "対話の途中で変えると、次の返答から新しい AI が相手役を引き継ぎます。これまでの会話と本音の進み具合は、そのまま引き継がれます。"),
    picker.el,
    h("div", { class: "actions" }, s.ai.current && h("button", { onclick: () => ((aiSetupOpen = false), render()) }, "戻る"), confirm),
  );
}

/** (2) どんな話にするかと難易度 */
function storyDialog(s: PublicState) {
  const area = h("textarea", { rows: 3, maxlength: 300, placeholder: "例: 小さな町の書店を閉めるかどうかで、店主と話し合う", "aria-label": "話題" });
  const tuned = h("span", { class: "tuned" });
  const showTuned = () => (tuned.textContent = tunedParams ? "パラメータを調整済み" : "");
  // 難易度を選び直したら、微調整は初期値に戻す
  // まだ選んでいなければ、最初はランダム (遊んでいるゲームがあれば、その難易度)
  const level = difficultyPicker(chosenDifficulty ?? (s.scenario ? s.difficulty : DEFAULT_DIFFICULTY), (d) => {
    chosenDifficulty = d;
    tunedParams = null;
    showTuned();
    params.refresh();
  });
  const params = paramsPanel(level.value, showTuned);
  showTuned();
  const start = () => {
    chosenDifficulty = level.value();
    const params = chosenDifficulty === "random" ? undefined : (tunedParams ?? undefined); // ランダムは、始めるときに決まる
    post("new", { request: area.value, difficulty: chosenDifficulty, params }).then((ok) => ok && ((composeNew = false), render()));
  };
  return h(
    "div",
    { class: "dialog" },
    h("h2", {}, "どんな話にしますか？"),
    h("p", { class: "muted" }, "相手にはまだ言えていない本音があります。聞き出して、お互いが納得できる形にすり合わせましょう。シナリオは AI がその場で作ります。"),
    // 空欄でも始められることは、入力欄の上に目立たせて書く (入力欄の中の例文は、打ち始めると消えてしまう)
    h("div", { class: "topic" }, h("p", { class: "omakase" }, "💡 ", h("strong", {}, "空欄のまま「はじめる」"), "を押すと、おまかせの話題でシナリオを作ります。"), area),
    h("p", { class: "inputnote" }, "個人情報や機密情報は入力しないでください。話題や会話は、選んだ AI の会社に送られます。"),
    h(
      "div",
      { class: "field diff" },
      h("span", {}, "難易度"),
      h("div", { class: "diffrow" }, level.seg, tuned),
      level.note,
      params.el,
    ),
    importRow(),
    s.ai.mode === "builtin" && h("div", { class: "aisum" }, h("span", {}, `AI: ${aiText(s.ai)}`), h("button", { type: "button", onclick: () => ((aiSetupOpen = true), render()) }, "変更")),
    aiHint(s),
    h(
      "div",
      { class: "actions" },
      (s.scenario || (composeNew && s.phase === "setup")) && h("button", { onclick: () => ((composeNew = false), render()) }, "キャンセル"),
      h("button", { class: "primary", onclick: start }, "はじめる"),
    ),
  );
}

/** 難易度の選択 (簡単・普通・難しい)。選んだものの説明を下に出す */
function difficultyPicker(initial: Difficulty, onPick: (d: Difficulty) => void) {
  let value = initial;
  const note = h("p", { class: "diffnote" });
  const buttons = DIFFICULTIES.map((d) => h("button", { type: "button", role: "radio", onclick: () => (set(d), onPick(d)) }, DIFFICULTY_INFO[d].label));
  const set = (d: Difficulty) => {
    value = d;
    buttons.forEach((b, i) => {
      b.classList.toggle("on", DIFFICULTIES[i] === d);
      b.setAttribute("aria-checked", String(DIFFICULTIES[i] === d));
    });
    note.textContent = DIFFICULTY_INFO[d].summary;
  };
  set(initial);
  return { seg: h("div", { class: "seg", role: "radiogroup", "aria-label": "難易度" }, ...buttons), note, value: () => value };
}

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const PARAM_GROUPS: Array<[string, Array<keyof DifficultyParams>]> = [
  ["シナリオ", ["concerns", "openAtStart", "nonNegotiable", "turnsPerConcern"]],
  ["相手 (登場人物の平均)", ["trustStart", "openness", "understanding"]],
  ["相手からの歩み寄り", ["initiativeTurns", "initiativeTrust", "initiativeCooldown"]],
];
/** 1〜10 の段階で表すパラメータは、選択肢に呼び名を添える (例: 5 (様子見)) */
const LEVEL_NAMES: Partial<Record<keyof DifficultyParams, readonly string[]>> = { trustStart: TRUST_LEVEL_NAMES, openness: OPENNESS_LEVEL_NAMES, understanding: UNDERSTANDING_LEVEL_NAMES, initiativeTrust: TRUST_LEVEL_NAMES };
const paramText = (key: keyof DifficultyParams, v: number) => (LEVEL_NAMES[key] ? `${v} (${LEVEL_NAMES[key][levelBand(v)]})` : String(v));

/**
 * 「パラメータ」の折りたたみ欄 (▶ を押すとその場で開く): 難易度の中身を見て、微調整する。
 * 初期値から変えた項目は色を変え、初期値を添える。変えた値は tunedParams に持ち、次の「はじめる」で送る (初期値と同じに戻したら null)。
 * 難易度を選び直したら refresh で、その難易度の初期値を表示し直す
 */
function paramsPanel(level: () => Difficulty, onChange: () => void) {
  const body = h("div", { class: "pbody" });
  const el = h("details", { class: "params" }, h("summary", {}, "パラメータ (難易度の中身を見る・微調整する)"), body);
  el.open = paramsOpen;
  el.addEventListener("toggle", () => (paramsOpen = el.open));
  // ランダムでは、パラメータは始めるときに決まり、調整もできない (何が選ばれたかは終了後に見られる)。欄ごと隠す
  const presetOf = (d: Difficulty) => DIFFICULTY_PRESETS[d === "random" ? "normal" : d];
  let preset = presetOf(level());
  el.hidden = level() === "random";
  let p: DifficultyParams = { ...(tunedParams ?? preset) };
  const update = (next: DifficultyParams, focusKey?: string) => {
    p = { ...next, openAtStart: Math.min(next.openAtStart, next.concerns) };
    tunedParams = sameParams(p, preset) ? null : { ...p };
    onChange();
    draw();
    if (focusKey) body.querySelector<HTMLSelectElement>(`select[data-key="${focusKey}"]`)?.focus();
  };
  const row = (key: keyof DifficultyParams) => {
    const spec = PARAM_SPECS[key];
    const options = range(spec.min, key === "openAtStart" ? p.concerns : spec.max);
    const select = h("select", { "data-key": key, "aria-label": spec.label }, ...options.map((v) => h("option", { value: String(v) }, paramText(key, v))));
    select.value = String(p[key]);
    select.addEventListener("change", () => update({ ...p, [key]: Number(select.value) }, key));
    const changed = p[key] !== preset[key];
    const initial = paramText(key, preset[key]);
    const extra = key === "turnsPerConcern" ? ` → いまは ${turnLimitOf(p)} ターン` : "";
    return h("div", { class: `prow${changed ? " changed" : ""}` }, h("span", { class: "plabel" }, spec.label), select, h("small", {}, `${spec.help}${extra}${changed ? ` (初期値 ${initial})` : ""}`));
  };
  const draw = () =>
    body.replaceChildren(
      h("p", { class: "muted" }, "微調整すると、次に「はじめる」で作るシナリオから使われます。難易度を選び直すと初期値に戻ります。"),
      h("p", { class: "warn" }, "※ 懸念の数など、ふだんは見えない情報も分かります。"),
      ...PARAM_GROUPS.map(([title, keys]) => h("div", { class: "pgroup" }, h("h3", {}, title), ...keys.map(row))),
      h("div", { class: "actions" }, h("button", { type: "button", class: "small", disabled: !tunedParams, onclick: () => update({ ...preset }) }, "初期値に戻す")),
    );
  draw();
  return {
    el,
    refresh() {
      preset = presetOf(level());
      el.hidden = level() === "random";
      p = { ...(tunedParams ?? preset) };
      draw();
    },
  };
}

/** ランダムで選ばれたパラメータ (終了後の答え合わせ)。開くと一覧が出る */
function randomParamsBlock(p: DifficultyParams) {
  return h(
    "details",
    { class: "params" },
    h("summary", {}, "今回のパラメータ (ランダムで選ばれた値)"),
    h(
      "div",
      { class: "pbody" },
      ...PARAM_GROUPS.map(([title, keys]) =>
        h("div", { class: "pgroup" }, h("h3", {}, title), ...keys.map((k) => h("div", { class: "prow" }, h("span", { class: "plabel" }, PARAM_SPECS[k].label), h("span", {}, paramText(k, p[k]))))),
      ),
      h("p", { class: "muted text-sm" }, `ターン数の上限: ${turnLimitOf(p)} ターン + 引き出しにくい本音の分`),
    ),
  );
}

/**
 * 終了後に「会話を書き出す」でコピーする、1 つのテキスト。結果・スコア・合意事項と持ち越し (合意書)・振り返りに、会話の全文を添える。
 * 後から読み返したり、AI に読ませて調べたりできる (見つけられなかった本音も、終了後なので中身が入る)
 */
function exportMarkdown(s: PublicState) {
  const e = s.ending!;
  const nameOf = (id?: string) => s.scenario?.characters.find((c) => c.id === id)?.name ?? id ?? "?";
  const categoryOf = (id: string) => s.concerns.find((c) => c.id === id)?.category ?? id;
  const tag = (c: PublicConcern) => `[${c.category}${c.importance === undefined ? "" : `・重要度 ${c.importance} ${IMPORTANCE_LEVEL_NAMES[levelBand(c.importance)]}`}]`;
  const advice = new Map((s.review?.concerns ?? []).map((c) => [c.id, c.advice]));
  const lines = [
    `# ${s.scenario?.title ?? ""}`,
    "",
    `- 難易度: ${DIFFICULTY_INFO[s.difficulty]?.label ?? ""}${s.customized ? " (調整あり)" : ""}`,
    ...(s.params ? [`- パラメータ: ${(Object.keys(PARAM_SPECS) as Array<keyof DifficultyParams>).map((k) => `${PARAM_SPECS[k].label} ${s.params![k]}`).join(" / ")}`] : []),
    `- ターン: ${s.turn} / ${s.scenario?.turnLimit ?? "?"}`,
    `- 結果: ${ENDING_LABELS[e.type].icon} ${ENDING_LABELS[e.type].title} (解消 ${e.resolved}/${e.total}、重要度 ${e.importance.resolved}/${e.importance.total})`,
    `- スコア: ${e.score.total} / ${e.score.max} 点 (ランク ${e.score.rank})`,
    "",
    e.epilogue,
  ];
  lines.push("", "## スコアの内訳");
  lines.push(...[...e.score.items].sort((x, y) => y.maxPoints - x.maxPoints).map((x) => `- ${categoryOf(x.id)} (重要度 ${x.importance}・引き出しにくさ ${x.revealDifficulty}): ${x.discoverPoints + x.resolvePoints} / ${x.maxPoints} (${x.resolved ? "解決" : x.discovered ? "引き出した" : "見つけられなかった"})`));
  const done = s.concerns.filter((c) => c.status === "resolved");
  lines.push("", "## 合意事項", ...(done.length ? done.map((c) => `- ${tag(c)} ${c.text} → ${c.agreement}`) : ["- (なし)"]));
  const rest = s.concerns.filter((c) => c.status !== "resolved");
  if (rest.length) lines.push("", "## 持ち越し", ...rest.map((c) => `- ${tag(c)} ${c.text}${c.missed ? " (本音を聞き出せなかった)" : ""}${advice.get(c.id) ? `\n  - 💡 ${advice.get(c.id)}` : ""}`));
  if (s.review) lines.push("", "## 振り返り", s.review.overall, ...s.review.good.map((t) => `- 👍 ${t}`), ...s.review.improve.map((t) => `- 🌱 ${t}`));
  // 会話の全文。ターン番号は、プレイヤーの発言ごとに 1 つ進む (冒頭は 0)
  let turn = 0;
  lines.push(
    "",
    "## 会話",
    ...s.log.map((l) => {
      if (l.from === "player") turn++;
      const who = l.from === "player" ? `プレイヤー${l.to ? `→${nameOf(l.to)}` : ""}` : l.from === "narrator" ? "地の文" : nameOf(l.speaker);
      return `- [${turn}] **${who}**: ${l.text.replace(/\n/g, "\n  ")}`;
    }),
  );
  return lines.join("\n");
}

/** 「会話を書き出す」: 会話の全文と結果をクリップボードへ。コピーできなければ、理由を知らせる */
function copyExport(s: PublicState) {
  const ok = () => toast("会話の全文と結果をコピーしました");
  const ng = () => toast("コピーできませんでした。ブラウザの設定で、クリップボードへの書き込みを許可してください");
  if (!navigator.clipboard) return ng();
  navigator.clipboard.writeText(exportMarkdown(s)).then(ok, ng);
}

/** ファイル名に付ける日時 (この端末の時刻。例: 20261105-103015) */
function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 書き出すときの、暗号化のキーの入力。ふつうは空欄のまま「保存」(アプリ標準のキー)。必要なときだけ、自分で決めたキーを入れる。
 * 戻り値: null = やめた / "" = 標準のキー / それ以外 = 自分で決めたキー
 */
function askExportKey(): Promise<string | null> {
  const el = $("keyask");
  return new Promise((resolve) => {
    const input = h("input", { type: "password", id: "exportkey", autocomplete: "new-password", spellcheck: "false", maxlength: MAX_KEY_CHARS, placeholder: "空欄なら、標準のキー" });
    const show = h("input", { type: "checkbox" });
    show.addEventListener("change", () => (input.type = show.checked ? "text" : "password"));
    const finish = (v: string | null) => {
      document.removeEventListener("keydown", onKey);
      el.hidden = true;
      el.replaceChildren();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish(null);
    document.addEventListener("keydown", onKey);
    el.replaceChildren(
      h(
        "form",
        { class: "dialog", onsubmit: (e: Event) => (e.preventDefault(), finish(input.value)) },
        h("h2", {}, "シナリオを書き出す"),
        h("p", {}, "シナリオのファイルは暗号化されます。ふだんはそのまま「保存」で、このアプリ標準のキーを使います。ほかの人に渡すだけなら、これで足ります。"),
        h(
          "div",
          { class: "keyfield" },
          h("label", { for: "exportkey" }, h("strong", { class: "text-sm" }, "自分で決めたキーを使う (任意)")),
          input,
          h("label", { class: "showkey" }, show, "キーを表示する"),
        ),
        h(
          "p",
          { class: "muted text-sm" },
          "キーを決めると、そのキーを知っている人だけが読み込めます (読み込むときに、同じキーを聞かれます)。キーはファイルに残らないので、忘れると読み込めません。ほかのサービスのパスワードは使わないでください。",
        ),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", onclick: () => finish(null) }, "やめる"),
          h("button", { type: "submit", class: "primary" }, "保存"),
        ),
      ),
    );
    el.hidden = false;
    input.focus();
  });
}

/**
 * 「シナリオを書き出す」: いまのシナリオを、暗号化した JSON ファイルにして保存する。別の人が、読み込んで同じシナリオで遊べる。
 * 会話・結果は含まない。隠れた本音や解消条件も入るが、暗号化されているので、遊んでいる最中に書き出しても、中身は見えない。
 * 暗号化のキーは、ふつうはアプリ標準のもの。書き出すときに、自分で決めたキーに変えられる。
 * ファイル名には、書き出した日時が付く
 */
let saving = false;
async function saveScenario() {
  if (saving) return; // キーの入力を待っている間の、二重の起動
  saving = true;
  try {
    await saveScenarioFile();
  } finally {
    saving = false;
  }
}
async function saveScenarioFile() {
  const r = await backend.exportScenario();
  if ("error" in r) return toast(r.error);
  const key = await askExportKey();
  if (key === null) return;
  let encrypted;
  try {
    encrypted = await encryptScenarioFile(r.file, key);
  } catch (err) {
    return toast(err instanceof ScenarioFileError ? err.message : "シナリオを暗号化できませんでした");
  }
  const safe = r.file.scenario.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  const url = URL.createObjectURL(new Blob([JSON.stringify(encrypted)], { type: "application/json" }));
  const a = h("a", { href: url, download: `すり合わせ-${safe}-${stamp()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast(normalizeKey(key) ? "シナリオを、決めたキーで暗号化して保存しました。読み込む人にキーを伝えてください" : "シナリオを暗号化して保存しました");
}

/** 書き出したシナリオのファイルを読み込んで、そのシナリオで遊ぶ。読み込めたら、そのまま始まる (難易度は、ファイルに書かれていたもの) */
function importRow() {
  const err = h("p", { class: "warn importerr" });
  err.hidden = true;
  const show = (m: string) => {
    err.textContent = m;
    err.hidden = !m;
  };
  const input = h("input", { type: "file", accept: ".json,application/json", hidden: true, "aria-label": "シナリオのファイル" });

  // キーを決めて暗号化されたファイルは、キーを聞く。聞いている間は、そのファイルの中身をここに持っておく
  let locked: unknown = null;
  const keyInput = h("input", { type: "password", autocomplete: "off", spellcheck: "false", maxlength: MAX_KEY_CHARS, placeholder: "暗号化のキー", "aria-label": "暗号化のキー" });
  const keyButton = h("button", { type: "button", class: "primary" }, "開く");
  const keyRow = h("div", { class: "importkey" }, keyInput, keyButton);
  keyRow.hidden = true;
  const closeKeyRow = () => {
    locked = null;
    keyInput.value = "";
    keyRow.hidden = true;
  };

  /** 復号して、ゲームの本体に渡す。暗号化されたファイルは復号し (暗号化していない JSON は、そのまま)、中身の検査は、ゲームの本体がする */
  const load = async (data: unknown, key?: string) => {
    try {
      data = await openScenarioFile(data, key);
    } catch (e) {
      if (e instanceof ScenarioKeyRequired) {
        locked = data;
        keyRow.hidden = false;
        keyInput.focus();
      } else if (locked) keyInput.select(); // キーが違った: もう一度入力できるように、欄は残す
      return show(e instanceof ScenarioFileError ? e.message : "シナリオのファイルを開けませんでした");
    }
    closeKeyRow();
    const error = await backend.send("import", { file: data });
    if (error) return show(error);
    composeNew = false;
    render();
  };

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    show("");
    closeKeyRow();
    if (file.size > 1024 * 1024) return show("ファイルが大きすぎます");
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return show("JSON として読み込めませんでした。書き出したシナリオのファイルを選んでください");
    }
    await load(data);
  });
  const submitKey = () => {
    if (!locked) return;
    if (!keyInput.value.trim()) return show("キーを入力してください");
    show("");
    void load(locked, keyInput.value);
  };
  keyButton.addEventListener("click", submitKey);
  keyInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return; // 日本語の変換の確定の Enter では送らない
    e.preventDefault();
    submitKey();
  });
  return h(
    "div",
    { class: "importrow" },
    h("span", {}, "書き出したシナリオで遊ぶ"),
    h("button", { type: "button", onclick: () => input.click() }, "シナリオを読み込む…"),
    input,
    h("small", { class: "muted" }, "ほかの人が遊んだシナリオと同じ内容で始まります。難易度も、ファイルに書かれたものになります。書き出した人がキーを決めていたときは、そのキーを聞かれます。知らない人のファイルは、内容を確かめてから読み込んでください。"),
    keyRow,
    err,
  );
}

const sectionTitle = (t: string) => h("h2", { class: "section-title" }, t);

/** AI が書いた振り返り。書き終わるまでは待ち表示 */
/**
 * スコア: どれだけ重要で引き出しにくい本音を引き出し、解決に導いたか (引き出すほうを重く見る)。
 * 内訳は点の大きい本音から順に、取れた点 / 取れた最高点と、引き出しにくさ・解決の難しさを出す
 */
function scoreBlock(s: PublicState, score: GameScore) {
  const rate = (r: number) => `×${(r / 100).toFixed(2).replace(/0$/, "")}`;
  const rows = [...score.items]
    .sort((a, b) => b.maxPoints - a.maxPoints)
    .map((x) => {
      const c = s.concerns.find((k) => k.id === x.id);
      const got = x.discoverPoints + x.resolvePoints;
      const state = x.resolved ? "解決" : x.discovered ? "引き出した" : "見つけられなかった";
      return h(
        "div",
        { class: `srow${got ? "" : " zero"}` },
        h("span", { class: "sname" }, `${c?.category ?? x.id} (重要度 ${x.importance}・引き出しにくさ ${x.revealDifficulty})`),
        h("span", { class: "spts" }, `${got} / ${x.maxPoints}`),
        h("small", {}, `${state} — 引き出し ${x.discoverPoints} 点 · 解決 ${x.resolvePoints} 点 (難しさ ${rate(x.resolveRate)})`),
      );
    });
  return h(
    "div",
    { class: "score" },
    h("div", { class: "shead" }, h("span", { class: `rank r${score.rank}` }, score.rank), h("span", { class: "stotal" }, `${score.total}`, h("small", {}, ` / ${score.max} 点 (${score.percent}%)`))),
    h(
      "p",
      { class: "muted text-sm" },
      "相手の隠れた本音を引き出すと「引き出し点」が入ります。重要な本音ほど、引き出しにくい本音 (打ち解けるまで話さない・頑なな人の本音) ほど高い点です。解決に導くと「解決点」も入ります。",
    ),
    h("details", {}, h("summary", {}, "スコアの内訳"), ...rows),
  );
}

function reviewBlock(s: PublicState) {
  const r = s.review;
  if (!r) {
    if (s.ai.error) return h("div", { class: "review" }, sectionTitle("振り返り"), aiErrorBox(s));
    return h(
      "div",
      { class: "review waiting" },
      h("div", { class: "spinner" }),
      h("div", {}, "AI が振り返りを書いています…", aiHint(s)),
    );
  }
  const list = (items: string[]) => h("ul", {}, ...items.map((t) => h("li", {}, t)));
  return h(
    "div",
    { class: "review" },
    sectionTitle("振り返り"),
    h("p", {}, r.overall),
    h("div", {}, h("strong", {}, "👍 良かった点"), list(r.good)),
    h("div", {}, h("strong", {}, "🌱 次に活かせること"), list(r.improve)),
  );
}

let endingKey = "";
let reviewToasted = false;
function renderEnding(s: PublicState) {
  const el = $("ending");
  const e = s.ending;
  $("showending").hidden = !e || !endingDismissed;
  // シナリオは、遊び始めてから、終わった後まで書き出せる (作っている最中・遊ぶ前は、まだ無い)
  $("exportscenario").hidden = !s.scenario;
  if (!e || endingDismissed) {
    // 会話を読み返している間に振り返りが届いたら知らせる
    if (e && s.review && !reviewToasted) toast("振り返りができました (右上の「結果・振り返り」から見られます)");
    if (s.review) reviewToasted = true;
    endingKey = "";
    return void (el.hidden = true);
  }
  // 結果は一度、振り返りが届いたらもう一度描く (入力中のものは無いので作り直してよい)
  const key = s.review ? "review" : `pending:${s.ai.error ?? ""}`;
  if (key === endingKey) return;
  endingKey = key;
  const myToken = token;
  // 最後のセリフを読み終えてから出す
  queue = queue.then(() => {
    const cur = state;
    if (myToken !== token || endingDismissed || !cur?.ending) return;
    const label = ENDING_LABELS[cur.ending.type];
    const done = cur.concerns.filter((c) => c.status === "resolved");
    const rest = cur.concerns.filter((c) => c.status !== "resolved");
    const advice = new Map((cur.review?.concerns ?? []).map((c) => [c.id, c.advice]));
    el.replaceChildren(
      h(
        "div",
        { class: "dialog" },
        h("div", { class: "big" }, label.icon),
        h("h2", { class: "center" }, `${label.title} (${cur.ending.resolved}/${cur.ending.total})`),
        h("p", { class: "muted center text-sm" }, `解消した本音の重要度: ${cur.ending.importance.resolved} / ${cur.ending.importance.total}　難易度: ${DIFFICULTY_INFO[cur.difficulty]?.label ?? "普通"}${cur.customized ? " (調整あり)" : ""}`),
        cur.ending.nonNegotiableLeft > 0 && h("p", { class: "center warn" }, `譲れない本音が ${cur.ending.nonNegotiableLeft} つ残ったため、合意には至りませんでした。`),
        cur.difficulty === "random" && cur.params && randomParamsBlock(cur.params),
        scoreBlock(cur, cur.ending.score),
        h("p", { class: "muted center" }, cur.ending.epilogue),
        reviewBlock(cur),
        h("div", {}, sectionTitle("合意事項"), ...(done.length ? done.map((c) => concernCard(cur, c, true)) : [h("p", { class: "muted" }, "なし")])),
        rest.length > 0 && h("div", {}, sectionTitle("持ち越し・見つけられなかった懸念"), ...rest.map((c) => concernCard(cur, c, false, advice.get(c.id)))),
        h(
          "div",
          { class: "actions" },
          h("button", { onclick: () => copyExport(state?.ending ? state : cur) }, "会話を書き出す"),
          h("button", { onclick: () => void saveScenario() }, "シナリオを書き出す"),
          h("button", { onclick: () => ((endingDismissed = true), render()) }, "会話を読み返す"),
          h("button", { onclick: () => ((endingDismissed = true), post("replay")) }, "同じシナリオでもう一度"),
          h("button", { class: "primary", onclick: () => ((endingDismissed = true), (composeNew = true), render()) }, "新しいシナリオ"),
        ),
      ),
    );
    el.hidden = false;
  });
}
$("showending").addEventListener("click", () => {
  endingDismissed = false;
  endingKey = "";
  render();
});

/** 会話欄の上: 状況説明と前提情報 (プレイヤーの立場なら知っている事実)。開閉の状態を保つため、ゲームが変わったときだけ作り直す */
let premiseKey = "";
function renderPremise(s: PublicState) {
  const el = $("premise");
  el.hidden = !s.scenario;
  const key = s.scenario ? `${s.epoch}:${s.scenario.title}` : "";
  if (key === premiseKey) return;
  premiseKey = key;
  el.replaceChildren();
  if (!s.scenario) return;
  el.append(h("div", {}, s.scenario.premise));
  const facts = s.scenario.briefing ?? []; // 前提情報を持たない以前のサーバーでも動くように
  if (facts.length) {
    el.append(
      h(
        "details",
        // スマホでは会話欄を広く使うため、最初は閉じておく (「前提」を押せば開く)
        { class: "briefing", open: !matchMedia("(max-width: 860px)").matches },
        h("summary", {}, "前提 (あなたが知っていること)"),
        h("dl", {}, ...facts.flatMap((f) => [h("dt", {}, f.label), h("dd", {}, f.text)])),
      ),
    );
  }
}

// ---- 全体 ----------------------------------------------------------------------------------
function render() {
  const s = state;
  if (!s) return;

  if (s.epoch !== epoch) {
    epoch = s.epoch;
    token++;
    skip = false;
    queued = 0;
    queue = Promise.resolve();
    lastLineId = 0;
    endingDismissed = false;
    endingKey = "";
    reviewToasted = false;
    setupKey = "";
    chat.querySelectorAll(".msg:not(.typing)").forEach((n) => n.remove());
  }

  const ai = $("ai");
  ai.textContent = `AI: ${aiText(s.ai)}`;
  ai.className = `chip ${s.ai.connected ? "on" : "off"}`;
  // 対話の途中でも AI を変えられる (内蔵 GM のとき。MCP 版の AI は Claude Code 側で決まる)
  $("aichange").hidden = s.ai.mode !== "builtin";
  // 会話中に AI の呼び出しが止まったら、入力欄の上に知らせる (シナリオ作成中・終了後はそれぞれの画面で出す)
  const banner = $("aierror");
  const bannerMsg = s.phase === "ai_turn" ? (s.ai.error ?? s.ai.notice) : null;
  banner.hidden = !bannerMsg;
  if (bannerMsg && banner.dataset.msg !== bannerMsg) {
    banner.dataset.msg = bannerMsg;
    // 止まっているときは再試行ボタンつき。自動で再試行している間は、案内だけ (止まってはいない)
    banner.replaceChildren(s.ai.error ? aiErrorBox(s, true) || "" : h("div", { class: "aierr info" }, h("span", {}, `⏳ ${bannerMsg}`)));
  }
  $("title").textContent = s.scenario?.title ?? "";
  renderPremise(s);

  for (const l of s.log) {
    if (l.id <= lastLineId) continue;
    lastLineId = l.id;
    enqueue(s, l, !initialLoad);
  }
  initialLoad = false;
  typing.hidden = s.phase !== "ai_turn";
  if (!typing.hidden && nearBottom()) scrollDown();

  renderSide(s);
  const turnStarted = updateComposer();
  renderSetup(s);
  renderEnding(s);
  // 相手が返したら、クリックしなくてもそのまま打ち始められるようにする (考えている間は入力欄を無効にするので、カーソルが外れている)。
  // 画面のキーボードが届いたばかりの返答を隠す端末と、開始・結果の画面を開いているときは動かさない
  if (turnStarted && !TOUCH && $("setup").hidden && $("ending").hidden && $("keyask").hidden) $("text").focus({ preventScroll: true });
}

/** MCP 版で、別のゲームのサーバーにつながってしまった場合 (同じポートで別のプログラムが動いているなど) */
function showWrongServer() {
  setupKey = "wrong-server";
  const el = $("setup");
  el.hidden = false;
  el.replaceChildren(
    h(
      "div",
      { class: "dialog" },
      h("h2", {}, "別のサーバーにつながっています"),
      h("p", {}, "このページは「すり合わせシミュレーター」のサーバーではなく、別のプログラムのサーバーに接続されています。"),
      h("p", {}, "「すり合わせシミュレーター」は既定でポート 3100 で動きます。次のアドレスを開き直してください。"),
      h("p", {}, h("a", { href: "http://localhost:3100/", class: "accent" }, "http://localhost:3100/")),
      h("p", { class: "muted text-sm" }, `(いま開いているのは ${location.host})`),
    ),
  );
}

backend.connect((s) => {
  state = s;
  render();
});

// このページの中で動いているときは、閉じたり再読み込みしたりすると対話と API キーが消える。対話中は確かめる
if (!SERVER_MODE) {
  window.addEventListener("beforeunload", (e) => {
    const s = state;
    if (s && (s.phase === "player_turn" || s.phase === "ai_turn" || (s.phase === "setup" && s.generating))) e.preventDefault();
  });
}
