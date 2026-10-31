import { config as zodConfig } from "zod";
import { createLocalBackend, createRemoteBackend, type Action, type Backend } from "./backend.js";
import {
  DIFFICULTIES,
  DIFFICULTY_INFO,
  DIFFICULTY_PRESETS,
  PARAM_SPECS,
  sameParams,
  turnLimitOf,
  UNDERSTANDING_LABELS,
  ENDING_LABELS,
  STATUS_LABELS,
  type AiProviderOption,
  type Difficulty,
  type DifficultyParams,
  type LogLine,
  type PublicCharacter,
  type PublicConcern,
  type PublicState,
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
      h("div", { class: "who" }, h("span", { class: "em" }, c.emoji), h("span", {}, c.name, " ", h("small", {}, c.role)), h("span", { class: "mood" }, `${c.mood.emoji} ${c.mood.label}`)),
    ),
  );
  // 空から始まり、本音が見つかった分だけ増える (総数は見せない)
  $("board").replaceChildren(...(s.concerns.length ? s.concerns.map((c) => concernCard(s, c)) : [h("div", { class: "empty" }, "まだ何も見えていません。相手の話を聞いてみましょう。")]));
}

/** ボードのカードは本音の内容と状態だけ。合意内容と助言は、終了後の画面 (withAgreement / advice) にだけ出す */
function concernCard(s: PublicState, c: PublicConcern, withAgreement = false, advice?: string) {
  const owner = charOf(s, c.owner);
  return h(
    "div",
    { class: `concern ${c.status}${c.missed ? " missed" : ""}` },
    h("div", { class: "top" }, h("span", {}, owner?.emoji ?? ""), h("span", { class: "cat" }, c.category), h("span", { class: "st" }, c.missed ? "見つけられなかった" : STATUS_LABELS[c.status])),
    h("div", {}, c.text),
    withAgreement && c.agreement && h("div", { class: "sub" }, `✅ ${c.agreement}`),
    advice && h("div", { class: "sub advice" }, `💡 ${advice}`),
  );
}

// ---- 入力欄 -------------------------------------------------------------------------
function updateComposer() {
  const s = state;
  const can = s?.phase === "player_turn";
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
        : "ここに入力 (Enter で送信 / Shift+Enter で改行)";
  const to = $<HTMLSelectElement>("to");
  const cast = s?.scenario?.characters ?? [];
  const prev = to.value;
  to.replaceChildren(h("option", { value: "" }, "全員"), ...cast.map((c) => h("option", { value: c.id }, `${c.emoji} ${c.name}`)));
  to.value = cast.some((c) => c.id === prev) ? prev : "";
  to.hidden = cast.length < 2;
  to.disabled = !can;
  $<HTMLButtonElement>("replay").disabled = !s?.scenario;
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
  if (!confirm("持ち帰って、この対話を終えます。よろしいですか？")) return;
  const text = $<HTMLTextAreaElement>("text");
  const to = $<HTMLSelectElement>("to").value || undefined;
  if (await post("defer", { text: text.value.trim(), to })) text.value = "";
});
$("text").addEventListener("keydown", (e) => {
  const ke = e as KeyboardEvent;
  // 日本語 IME の変換確定 Enter では送信しない
  if (ke.key === "Enter" && !ke.shiftKey && !ke.isComposing && ke.keyCode !== 229) {
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
$("newgame").addEventListener("click", () => {
  if (state?.scenario && state.phase !== "ended" && !confirm("いまの対話を捨てて、新しいシナリオを作りますか？")) return;
  composeNew = true;
  render();
});

// ---- セットアップ (新しいシナリオ) / 終了画面 ---------------------------------------------
const IDEAS = ["職場の要件すり合わせ", "村の水争いの調停", "宇宙船クルーの方針決め", "引っ越しをめぐる家族会議", "頑固な職人への依頼"];

// ---- AI の接続 (選択・案内・エラー) ---------------------------------------------------
const MCP_MISSING = "AI が接続されていません。Claude Code で suriawase-simulator (MCP) を接続し、GM として待機してもらってください (README 参照)。";

function aiHint(s: PublicState) {
  if (s.ai.mode === "mcp" && !s.ai.connected) return h("p", { class: "warn" }, MCP_MISSING);
  return false;
}

/** AI の呼び出しが失敗して止まっているときの表示と再試行ボタン */
function aiErrorBox(s: PublicState) {
  if (!s.ai.error) return false;
  return h("div", { class: "aierr" }, h("span", {}, `⚠ ${s.ai.error}`), h("button", { type: "button", onclick: () => post("ai/retry") }, "再試行"));
}

const OTHER_MODEL = "__other__";

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
  const modelStep = h("div", { class: "aipick" }, h("label", {}, "モデル", model), custom);
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
    value: () => ({ provider: provider.value, model: model.value === OTHER_MODEL ? custom.value.trim() : model.value }),
  };
}

let setupKey = "";
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
  const show = s.phase === "setup" || composeNew;
  el.hidden = !show;
  const generating = s.phase === "setup" && s.generating && !composeNew;
  const aiStep = s.ai.mode === "builtin" && (aiSetupOpen || !s.ai.current);
  // 入力中のフォームを、無関係な状態更新で作り直さない
  const key = !show
    ? "hidden"
    : generating
      ? `generating:${s.ai.mode}:${s.ai.connected}:${s.ai.error ?? ""}`
      : aiStep
        ? `ai:${!!s.scenario}:${composeNew}`
        : `story:${!!s.scenario}:${composeNew}:${s.ai.mode}:${s.ai.label}`;
  if (key === setupKey) return;
  setupKey = key;
  if (!show) return;
  if (generating) {
    el.replaceChildren(
      h(
        "div",
        { class: "dialog center" },
        !s.ai.error && h("div", { class: "spinner" }),
        h("h2", {}, s.ai.error ? "シナリオを作れませんでした" : "AI がシナリオを考えています…"),
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
      render();
    } else confirm.disabled = false;
  });
  return h(
    "div",
    { class: "dialog" },
    h("h2", {}, "AI の設定"),
    h("p", { class: "muted" }, "シナリオを作り、相手役を演じる AI を選びます。使うサービスを選んで API キーを入力し、「決定」を押すとモデルを選べます。"),
    picker.el,
    h("div", { class: "actions" }, s.ai.current && h("button", { onclick: () => ((aiSetupOpen = false), render()) }, "戻る"), confirm),
  );
}

/** (2) どんな話にするかと難易度 */
function storyDialog(s: PublicState) {
  const area = h("textarea", { rows: 3, maxlength: 300, placeholder: "例: 小さな町の書店を閉めるかどうかで、店主と話し合う (空欄ならおまかせ)" });
  const tuned = h("span", { class: "tuned" });
  const showTuned = () => (tuned.textContent = tunedParams ? "パラメータを調整済み" : "");
  // 難易度を選び直したら、微調整は初期値に戻す
  const level = difficultyPicker(chosenDifficulty ?? s.difficulty ?? "normal", (d) => {
    chosenDifficulty = d;
    tunedParams = null;
    showTuned();
    params.refresh();
  });
  const params = paramsPanel(level.value, showTuned);
  showTuned();
  const start = () => {
    chosenDifficulty = level.value();
    post("new", { request: area.value, difficulty: chosenDifficulty, params: tunedParams ?? undefined }).then((ok) => ok && ((composeNew = false), render()));
  };
  return h(
    "div",
    { class: "dialog" },
    h("h2", {}, "どんな話にしますか？"),
    h("p", { class: "muted" }, "相手にはまだ言えていない本音があります。聞き出して、お互いが納得できる形にすり合わせましょう。シナリオは AI がその場で作ります。"),
    area,
    h("p", { class: "inputnote" }, "個人情報や機密情報は入力しないでください。話題や会話は、選んだ AI の会社に送られます。"),
    h("div", { class: "ideas" }, ...IDEAS.map((i) => h("button", { type: "button", onclick: () => ((area.value = i), area.focus()) }, i))),
    h(
      "div",
      { class: "field diff" },
      h("span", {}, "難易度"),
      h("div", { class: "diffrow" }, level.seg, tuned),
      level.note,
      params.el,
    ),
    s.ai.mode === "builtin" && h("div", { class: "aisum" }, h("span", {}, `AI: ${s.ai.label}`), h("button", { type: "button", onclick: () => ((aiSetupOpen = true), render()) }, "変更")),
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
  ["シナリオ", ["concerns", "openAtStart", "turnsPerConcern"]],
  ["相手", ["trustStart", "understanding"]],
  ["相手からの歩み寄り", ["initiativeTurns", "initiativeTrust", "initiativeCooldown"]],
];

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
  let preset = DIFFICULTY_PRESETS[level()];
  let p: DifficultyParams = { ...(tunedParams ?? preset) };
  const update = (next: DifficultyParams, focusKey?: string) => {
    p = { ...next, openAtStart: Math.min(next.openAtStart, next.concerns) };
    tunedParams = sameParams(p, preset) ? null : { ...p };
    onChange();
    draw();
    if (focusKey) body.querySelector<HTMLSelectElement>(`select[data-key="${focusKey}"]`)?.focus();
  };
  const row = (key: keyof DifficultyParams) => {
    const numeric = key !== "understanding";
    const spec = numeric ? PARAM_SPECS[key] : { label: "物わかり", help: "提案をどこまで汲み取るか、解消の判定をどこまで厳しくするか" };
    const options = numeric
      ? range(PARAM_SPECS[key].min, key === "openAtStart" ? p.concerns : PARAM_SPECS[key].max).map((v) => [String(v), String(v)])
      : Object.entries(UNDERSTANDING_LABELS);
    const select = h("select", { "data-key": key, "aria-label": spec.label }, ...options.map(([v, text]) => h("option", { value: v }, text)));
    select.value = String(p[key]);
    select.addEventListener("change", () => update({ ...p, [key]: numeric ? Number(select.value) : select.value }, key));
    const changed = p[key] !== preset[key];
    const initial = numeric ? String(preset[key]) : UNDERSTANDING_LABELS[preset.understanding];
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
      preset = DIFFICULTY_PRESETS[level()];
      p = { ...(tunedParams ?? preset) };
      draw();
    },
  };
}

function agreementMarkdown(s: PublicState) {
  const e = s.ending!;
  const lines = [`# 合意書: ${s.scenario?.title ?? ""}`, "", `結果: ${ENDING_LABELS[e.type].icon} ${ENDING_LABELS[e.type].title} (解消 ${e.resolved}/${e.total})`, "", e.epilogue, "", "## 合意事項"];
  const done = s.concerns.filter((c) => c.status === "resolved");
  lines.push(...(done.length ? done.map((c) => `- [${c.category}] ${c.text} → ${c.agreement}`) : ["- (なし)"]));
  const rest = s.concerns.filter((c) => c.status !== "resolved");
  if (rest.length) lines.push("", "## 持ち越し", ...rest.map((c) => `- [${c.category}] ${c.text}${c.missed ? " (本音を聞き出せなかった)" : ""}`));
  return lines.join("\n");
}

const sectionTitle = (t: string) => h("h2", { class: "section-title" }, t);

/** AI が書いた振り返り。書き終わるまでは待ち表示 */
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
        h("p", { class: "muted center text-sm" }, `難易度: ${DIFFICULTY_INFO[cur.difficulty]?.label ?? "普通"}${cur.customized ? " (調整あり)" : ""}`),
        h("p", { class: "muted center" }, cur.ending.epilogue),
        reviewBlock(cur),
        h("div", {}, sectionTitle("合意事項"), ...(done.length ? done.map((c) => concernCard(cur, c, true)) : [h("p", { class: "muted" }, "なし")])),
        rest.length > 0 && h("div", {}, sectionTitle("持ち越し・見つけられなかった懸念"), ...rest.map((c) => concernCard(cur, c, false, advice.get(c.id)))),
        h(
          "div",
          { class: "actions" },
          h("button", { onclick: () => navigator.clipboard?.writeText(agreementMarkdown(cur)).then(() => toast("合意書をコピーしました")) }, "合意書をコピー"),
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
        { class: "briefing", open: true },
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
  ai.textContent = `AI: ${s.ai.label}`;
  ai.className = `chip ${s.ai.connected ? "on" : "off"}`;
  // 会話中に AI の呼び出しが止まったら、入力欄の上に知らせる (シナリオ作成中・終了後はそれぞれの画面で出す)
  const banner = $("aierror");
  const showBanner = !!s.ai.error && s.phase === "ai_turn";
  banner.hidden = !showBanner;
  if (showBanner && banner.dataset.msg !== s.ai.error) {
    banner.dataset.msg = s.ai.error!;
    banner.replaceChildren(aiErrorBox(s) || "");
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
  updateComposer();
  renderSetup(s);
  renderEnding(s);
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
