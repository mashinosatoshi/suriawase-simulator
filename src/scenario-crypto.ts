// シナリオのファイルの暗号化 (画面の「シナリオを書き出す」「シナリオを読み込む」で使う)。
// ファイルには、隠れた本音や解消条件などの隠し情報が入る。そのまま保存すると、エディタで開いただけでネタバレになる
// (遊んでいる最中にも書き出せるため) ので、AES-256-GCM で暗号化する。GCM は、書き換えられたことも検出できる。
//
// 鍵は 2 通り:
//  - 標準のキー (ふつうはこちら): このアプリに組み込んだ文言から作る。キーを共有しなくても、同じアプリで読み込める代わりに、
//    ソースコードは公開されているので、「ネタバレの防止」と「書き換えの検出」のためのもの。
//    アプリのソースを読んだ人から、内容を完全に秘密にするものではない。
//  - 自分で決めたキー (書き出すときに指定したときだけ): キーから PBKDF2 で鍵を作る。読み込む人も、同じキーを知っている必要がある。
//    ファイルに kdf の欄があれば、キーが要るファイル。キーを知らない人には読めない (短い・推測されやすいキーは、総当たりで破られうる)。
//
// エンジンとサーバーは、暗号化を知らない (読み込むのは、復号した後の中身)。暗号化は、ファイルを出し入れする画面側だけ。
// ブラウザ標準の WebCrypto を使う (https か localhost のページで使える。Node でも同じ API がある)

export const ENCRYPTED_FORMAT = "suriawase-simulator/scenario-encrypted";
export const ENCRYPTED_VERSION = 1;
const ALGORITHM = "AES-256-GCM";
/** 標準のキーのもとになる文言 (アプリに組み込み。秘密ではない) */
const KEY_PHRASE = "suriawase-simulator/scenario-file/v1";
const IV_BYTES = 12;

/** 自分で決めたキーから鍵を作る方法 (PBKDF2 + SHA-256) */
const KDF_NAME = "PBKDF2-SHA256";
const KDF_ITERATIONS = 600_000;
/** 読み込むファイルに書かれた繰り返し回数の範囲 (悪意のあるファイルで、画面を固めさせないため) */
const KDF_ITERATIONS_MIN = 100_000;
const KDF_ITERATIONS_MAX = 2_000_000;
const SALT_BYTES = 16;
/** キーの長さの上限 (画面の入力欄と同じ) */
export const MAX_KEY_CHARS = 100;

export interface ScenarioKdf {
  name: typeof KDF_NAME;
  iterations: number;
  /** 書き出すたびに作る乱数 (base64) */
  salt: string;
}

export interface EncryptedScenarioFile {
  format: typeof ENCRYPTED_FORMAT;
  version: typeof ENCRYPTED_VERSION;
  algorithm: typeof ALGORITHM;
  /** 自分で決めたキーで暗号化したときだけ。標準のキーのファイルには無い */
  kdf?: ScenarioKdf;
  /** 暗号化のたびに作る乱数 (base64) */
  iv: string;
  /** 暗号文と認証タグ (base64) */
  data: string;
}

/** 画面に出せる理由つきの失敗 */
export class ScenarioFileError extends Error {}
/** キーが要るファイルを、キー無しで開こうとした (画面は、キーの入力を求める) */
export class ScenarioKeyRequired extends ScenarioFileError {}

const encoder = new TextEncoder();
const aad = () => encoder.encode(`${ENCRYPTED_FORMAT}/${ENCRYPTED_VERSION}`);

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ScenarioFileError("このページでは暗号化を使えません。https か localhost で開いてください");
  return s;
}

const BASE64 = /^[A-Za-z0-9+/]+=*$/;
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** 入力されたキーを整える: 全角・半角の違い (ａｂｃ と abc) と、前後の空白は区別しない。空になったら「標準のキー」 */
export const normalizeKey = (key: string | undefined) => (key ?? "").normalize("NFKC").trim();

async function defaultKey(): Promise<CryptoKey> {
  const raw = await subtle().digest("SHA-256", encoder.encode(KEY_PHRASE));
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function passwordKey(key: string, kdf: ScenarioKdf): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", encoder.encode(key), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64(kdf.salt), iterations: kdf.iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** ファイルに書かれた kdf の欄を確かめる (形が正しくなければ、鍵を作る前に断る) */
function readKdf(raw: unknown): ScenarioKdf {
  const bad = () => new ScenarioFileError("暗号化されたシナリオのファイルの形式が正しくありません");
  if (!raw || typeof raw !== "object") throw bad();
  const k = raw as Partial<ScenarioKdf>;
  if (k.name !== KDF_NAME) throw bad();
  if (!Number.isInteger(k.iterations) || k.iterations! < KDF_ITERATIONS_MIN || k.iterations! > KDF_ITERATIONS_MAX) throw bad();
  if (typeof k.salt !== "string" || k.salt.length > 100 || !BASE64.test(k.salt)) throw bad();
  return { name: KDF_NAME, iterations: k.iterations!, salt: k.salt };
}

/**
 * シナリオのファイルの中身 (JSON にできるもの) を暗号化する。毎回、違う乱数を使うので、同じ中身でも出力は変わる。
 * key を渡すと、そのキーで暗号化する (読み込む人も、同じキーが要る)。渡さない・空欄なら、標準のキー
 */
export async function encryptScenarioFile(content: unknown, key?: string): Promise<EncryptedScenarioFile> {
  const pw = normalizeKey(key);
  if (pw.length > MAX_KEY_CHARS) throw new ScenarioFileError(`キーは ${MAX_KEY_CHARS} 文字以内にしてください`);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const kdf: ScenarioKdf | undefined = pw ? { name: KDF_NAME, iterations: KDF_ITERATIONS, salt: toBase64(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES))) } : undefined;
  const aesKey = kdf ? await passwordKey(pw, kdf) : await defaultKey();
  const cipher = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad() }, aesKey, encoder.encode(JSON.stringify(content)));
  return { format: ENCRYPTED_FORMAT, version: ENCRYPTED_VERSION, algorithm: ALGORITHM, ...(kdf && { kdf }), iv: toBase64(iv), data: toBase64(new Uint8Array(cipher)) };
}

/**
 * 読み込んだファイルの中身を、エンジンに渡せる形にする。暗号化されたファイルなら復号して返し、そうでなければ (暗号化していない JSON) そのまま返す。
 * キーが要るファイル (kdf がある) は、key で復号する。key が無ければ ScenarioKeyRequired (画面がキーを尋ねる)。標準のキーのファイルでは、key は使わない。
 * 復号できなければ (壊れている・書き換えられている・別の版・キーが違う)、画面に出せる理由つきで ScenarioFileError を投げる
 */
export async function openScenarioFile(input: unknown, key?: string): Promise<unknown> {
  if (!input || typeof input !== "object" || (input as { format?: unknown }).format !== ENCRYPTED_FORMAT) return input;
  const f = input as Partial<EncryptedScenarioFile>;
  if (f.version !== ENCRYPTED_VERSION) {
    throw new ScenarioFileError(typeof f.version === "number" && f.version > ENCRYPTED_VERSION ? "新しい版のシナリオのファイルです。アプリを最新にしてから読み込んでください" : "対応していない版のシナリオのファイルです");
  }
  if (f.algorithm !== ALGORITHM || typeof f.iv !== "string" || typeof f.data !== "string") throw new ScenarioFileError("暗号化されたシナリオのファイルの形式が正しくありません");
  const kdf = f.kdf === undefined ? undefined : readKdf(f.kdf);
  const pw = normalizeKey(key);
  if (kdf && !pw) throw new ScenarioKeyRequired("このシナリオのファイルは、キーを決めて暗号化されています。書き出した人から聞いたキーを入力してください");
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(f.iv), additionalData: aad() }, kdf ? await passwordKey(pw, kdf) : await defaultKey(), fromBase64(f.data));
  } catch (err) {
    if (err instanceof ScenarioFileError) throw err;
    throw new ScenarioFileError(kdf ? "シナリオのファイルを復号できませんでした。キーが違うか、ファイルが壊れているか、書き換えられています" : "シナリオのファイルを復号できませんでした。ファイルが壊れているか、書き換えられています");
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new ScenarioFileError("シナリオのファイルの中身を読み取れませんでした");
  }
}
