// API キーの置き場所。キーは開始画面でプレイヤーが入力したものだけを使う (.env や環境変数からは読まない)。
// ブラウザのメモリ (このページ) にだけ置き、どこにも保存しない。ページを閉じるか「消す」で消える。
import { PROVIDER_IDS } from "./catalog.js";
import type { ProviderId } from "./types.js";

export class ApiKeys {
  private entered = new Map<ProviderId, string>();

  get(id: ProviderId): string | undefined {
    return this.entered.get(id);
  }

  has(id: ProviderId): boolean {
    return this.entered.has(id);
  }

  set(id: ProviderId, key: string) {
    this.entered.set(id, key);
  }

  delete(id: ProviderId) {
    this.entered.delete(id);
  }

  /** キーが入力済みの提供元 */
  available(): ProviderId[] {
    return PROVIDER_IDS.filter((id) => this.has(id));
  }
}

/** 各社の API キーは英数字と記号だけ。空白や制御文字の混ざったもの (コピーの失敗) は、送る前に弾く */
const KEY_FORMAT = /^[\x21-\x7e]{8,400}$/;

export function checkKeyFormat(key: unknown): string | null {
  if (typeof key !== "string" || !key.trim()) return "API キーを入力してください";
  if (!KEY_FORMAT.test(key.trim())) return "API キーの形式が正しくありません。空白や改行が混ざっていないか確かめて、貼り付け直してください";
  return null;
}
