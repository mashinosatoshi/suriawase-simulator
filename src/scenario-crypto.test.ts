import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "./engine.js";
import { ENCRYPTED_FORMAT, encryptScenarioFile, MAX_KEY_CHARS, normalizeKey, openScenarioFile, ScenarioFileError, ScenarioKeyRequired } from "./scenario-crypto.js";

/** 書き出し用のシナリオの見本 (隠し情報つき) */
const SAMPLE = {
  format: "suriawase-simulator/scenario",
  version: 1,
  difficulty: "normal",
  params: { concerns: 5 },
  scenario: { title: "橋の場所", concerns: [{ text: "村の蓄えが少なく大きな橋は作れない", resolved_when: "村の予算内に収まる規模の案が示される" }] },
};

test("暗号化: 中身は、そのままでは読めない (隠れた本音も、題名も、形式の名前も平文では出ない)", async () => {
  const enc = await encryptScenarioFile(SAMPLE);
  assert.deepEqual(Object.keys(enc).sort(), ["algorithm", "data", "format", "iv", "version"]);
  assert.deepEqual([enc.format, enc.version, enc.algorithm], [ENCRYPTED_FORMAT, 1, "AES-256-GCM"]);
  const text = JSON.stringify(enc);
  for (const secret of ["村の蓄え", "resolved_when", "橋の場所", "suriawase-simulator/scenario\"", "concerns"]) assert.ok(!text.includes(secret), `${secret} が平文で見える`);
  // base64 の文字だけで、暗号文は中身より少し (認証タグの 16 バイト分) 長い
  assert.match(enc.data, /^[A-Za-z0-9+/]+=*$/);
  assert.match(enc.iv, /^[A-Za-z0-9+/]+=*$/);
});

test("復号: 暗号化したものを、そのまま取り出せる (日本語も、長い文も)", async () => {
  assert.deepEqual(await openScenarioFile(await encryptScenarioFile(SAMPLE)), SAMPLE);
  const long = { text: "あ".repeat(100_000), emoji: "📚🤝" };
  assert.deepEqual(await openScenarioFile(await encryptScenarioFile(long)), long); // base64 を、かたまりに分けて作っても壊れない
  // ファイルに保存して読み込む流れ (JSON を通す)
  assert.deepEqual(await openScenarioFile(JSON.parse(JSON.stringify(await encryptScenarioFile(SAMPLE)))), SAMPLE);
});

test("暗号化のたびに、違う乱数 (iv) を使う: 同じ中身でも出力は変わる", async () => {
  const a = await encryptScenarioFile(SAMPLE);
  const b = await encryptScenarioFile(SAMPLE);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test("書き換えを検出する: 暗号文・乱数・版のどれを変えても、復号できない / 理由は画面に出せる文", async () => {
  const enc = await encryptScenarioFile(SAMPLE);
  const flip = (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    bytes[0] ^= 1;
    return btoa(String.fromCharCode(...bytes));
  };
  await assert.rejects(openScenarioFile({ ...enc, data: flip(enc.data) }), (e) => e instanceof ScenarioFileError && /復号できませんでした.*書き換えられています/.test(e.message));
  await assert.rejects(openScenarioFile({ ...enc, iv: flip(enc.iv) }), /復号できませんでした/);
  await assert.rejects(openScenarioFile({ ...enc, data: enc.data.slice(0, -8) }), /復号できませんでした/); // 途切れている
  await assert.rejects(openScenarioFile({ ...enc, data: "!!!壊れている!!!" }), /復号できませんでした/);
  await assert.rejects(openScenarioFile({ ...enc, version: 2 }), /新しい版/);
  await assert.rejects(openScenarioFile({ ...enc, version: 0 }), /対応していない版/);
  await assert.rejects(openScenarioFile({ ...enc, algorithm: "ROT13" }), /形式が正しくありません/);
  const { iv: _drop, ...noIv } = enc;
  await assert.rejects(openScenarioFile(noIv), /形式が正しくありません/);
});

test("暗号化していない JSON は、そのまま通す (自分で書いたシナリオなど。中身の検査はエンジンがする)", async () => {
  assert.deepEqual(await openScenarioFile(SAMPLE), SAMPLE);
  assert.equal(await openScenarioFile("ただの文字列"), "ただの文字列");
  assert.equal(await openScenarioFile(null), null);
});

test("復号できても、中身の検査はエンジンがする (暗号化は、検査の代わりにならない)", async () => {
  const opened = await openScenarioFile(await encryptScenarioFile({ format: "suriawase-simulator/scenario", version: 1 }));
  assert.match(new Engine().importScenario(opened) ?? "", /difficulty が不明/);
});

// ---- 自分で決めたキー (標準のキーの代わりに、書き出すときに指定する) ----

const flip = (b64: string) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  return btoa(String.fromCharCode(...bytes));
};

test("キーを指定して暗号化: 同じキーで開ける。ファイルには kdf があり、中身も、キーも、平文では出ない", async () => {
  const enc = await encryptScenarioFile(SAMPLE, "ひみつの合言葉");
  assert.deepEqual(Object.keys(enc).sort(), ["algorithm", "data", "format", "iv", "kdf", "version"]);
  assert.deepEqual([enc.kdf?.name, enc.kdf?.iterations], ["PBKDF2-SHA256", 600_000]);
  const text = JSON.stringify(enc);
  for (const secret of ["村の蓄え", "橋の場所", "ひみつの合言葉"]) assert.ok(!text.includes(secret), `${secret} が平文で見える`);
  assert.deepEqual(await openScenarioFile(JSON.parse(text), "ひみつの合言葉"), SAMPLE); // ファイルに保存して読み込む流れ
});

test("キーが要るファイル: キー無しは「キーが要る」(画面が尋ねる)、違うキーは復号できない、標準のキーでも開けない", async () => {
  const enc = await encryptScenarioFile(SAMPLE, "correct horse");
  await assert.rejects(openScenarioFile(enc), (e) => e instanceof ScenarioKeyRequired && e instanceof ScenarioFileError && /キーを入力/.test(e.message));
  await assert.rejects(openScenarioFile(enc, ""), ScenarioKeyRequired);
  await assert.rejects(openScenarioFile(enc, "   "), ScenarioKeyRequired); // 空白だけは、空欄と同じ
  await assert.rejects(openScenarioFile(enc, "wrong horse"), (e) => e instanceof ScenarioFileError && !(e instanceof ScenarioKeyRequired) && /キーが違うか/.test(e.message));
  // kdf の欄を消して標準のキーに見せかけても、開けない (別のキーで暗号化されている)
  const { kdf: _kdf, ...stripped } = enc;
  await assert.rejects(openScenarioFile(stripped), /復号できませんでした/);
});

test("キーの扱い: 全角と半角・前後の空白は区別しない。大文字と小文字は区別する", async () => {
  assert.equal(normalizeKey("  ＡＢＣ１２３ "), "ABC123");
  assert.equal(normalizeKey(undefined), "");
  const enc = await encryptScenarioFile(SAMPLE, "Pass123");
  assert.deepEqual(await openScenarioFile(enc, "　Ｐａｓｓ１２３　"), SAMPLE);
  await assert.rejects(openScenarioFile(enc, "pass123"), /キーが違うか/);
});

test("キーが空欄なら、標準のキーで暗号化する (kdf は付かず、キー無しで開ける)", async () => {
  for (const blank of [undefined, "", "   ", "　"]) {
    const enc = await encryptScenarioFile(SAMPLE, blank);
    assert.ok(!("kdf" in enc));
    assert.deepEqual(await openScenarioFile(enc), SAMPLE);
  }
  // 標準のキーのファイルを開くとき、キーを渡しても使わない (邪魔にならない)
  assert.deepEqual(await openScenarioFile(await encryptScenarioFile(SAMPLE), "使われない"), SAMPLE);
});

test("キーが長すぎたら断る", async () => {
  await assert.rejects(encryptScenarioFile(SAMPLE, "あ".repeat(MAX_KEY_CHARS + 1)), (e) => e instanceof ScenarioFileError && /100 文字以内/.test(e.message));
  assert.ok((await encryptScenarioFile(SAMPLE, "あ".repeat(MAX_KEY_CHARS))).kdf);
});

test("同じキーでも、書き出すたびに乱数 (salt・iv) が変わる", async () => {
  const a = await encryptScenarioFile(SAMPLE, "same key");
  const b = await encryptScenarioFile(SAMPLE, "same key");
  assert.notEqual(a.kdf?.salt, b.kdf?.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.data, b.data);
});

test("キーが要るファイルの書き換え: 暗号文・salt・iv のどれを変えても開けない", async () => {
  const enc = await encryptScenarioFile(SAMPLE, "my key");
  assert.ok(enc.kdf);
  await assert.rejects(openScenarioFile({ ...enc, data: flip(enc.data) }, "my key"), /復号できませんでした/);
  await assert.rejects(openScenarioFile({ ...enc, iv: flip(enc.iv) }, "my key"), /復号できませんでした/);
  await assert.rejects(openScenarioFile({ ...enc, kdf: { ...enc.kdf, salt: flip(enc.kdf.salt) } }, "my key"), /復号できませんでした/);
});

test("kdf の欄が正しくないファイルは、鍵を作る前に断る (繰り返し回数が極端でも、画面を固めない)", async () => {
  const enc = await encryptScenarioFile(SAMPLE, "my key");
  assert.ok(enc.kdf);
  const k = enc.kdf;
  const bads: unknown[] = [
    null,
    "PBKDF2",
    {},
    { ...k, name: "scrypt" },
    { ...k, iterations: 1 }, // 弱すぎる
    { ...k, iterations: 2_000_001 }, // 大きすぎる (画面が固まる)
    { ...k, iterations: 1_000_000_000 },
    { ...k, iterations: 600_000.5 },
    { ...k, iterations: "600000" },
    { ...k, salt: "" },
    { ...k, salt: "!!!" },
    { ...k, salt: "A".repeat(200) },
    { ...k, salt: 12 },
  ];
  for (const kdf of bads) {
    const started = Date.now();
    await assert.rejects(openScenarioFile({ ...enc, kdf }, "my key"), (e) => e instanceof ScenarioFileError && /形式が正しくありません/.test(e.message), JSON.stringify(kdf));
    assert.ok(Date.now() - started < 200, `${JSON.stringify(kdf)}: 鍵を作ってから断っている`);
  }
});
