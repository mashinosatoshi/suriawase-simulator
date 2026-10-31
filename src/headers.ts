// セキュリティヘッダーの定義 (public/_headers) を読む。公開用のサーバー (static.ts) とローカル用のサーバー (server.ts) で共通。
// _headers は Cloudflare Pages / Netlify と同じ書式なので、そちらに置いた場合もそのまま効く

/** 「/*」(すべてのページ) の項に書かれたヘッダーを返す */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let all = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      all = line.trim() === "/*";
      continue;
    }
    const m = all ? line.trim().match(/^([\w-]+):\s*(.+)$/) : null;
    if (m) out[m[1]] = m[2];
  }
  return out;
}
