// 公開用の静的ファイル配信 (Cloud Run のコンテナで動かす)。
// public/ の中身だけを、セキュリティヘッダー (public/_headers) を付けて返す。ゲームはブラウザの中で動くので、
// ここは画面のファイルを返すだけで、API キーも会話も通らない。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { parseHeaders } from "./headers.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const COMPRESSIBLE = /^(text\/|image\/svg)/;
// ソースマップ (.map) は開発者ツールを開いたときにしか読まれないのに、10MB ほどあって圧縮に数秒かかる。
// Cloud Run では起動の遅れがそのまま最初の表示の遅れになるので、圧縮しない

interface Variant {
  body: Buffer;
  etag: string;
  encoding?: "br" | "gzip";
}
interface Asset {
  type: string;
  plain: Variant;
  br?: Variant;
  gzip?: Variant;
}

/**
 * 起動時に public/ のファイルを読み込み、圧縮も済ませておく。配信するのはここに読み込んだものだけなので、
 * パスに細工 (../ や %2e%2e) をしても外のファイルには届かない。_headers のような設定ファイルは配信しない
 */
export function loadAssets(dir: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (name.startsWith("_") || name.startsWith(".") || !statSync(file).isFile()) continue;
    const type = MIME[extname(name)] ?? "application/octet-stream";
    const body = readFileSync(file);
    const hash = createHash("sha256").update(body).digest("base64url").slice(0, 22);
    const asset: Asset = { type, plain: { body, etag: `"${hash}"` } };
    if (COMPRESSIBLE.test(type)) {
      // 品質 11 は 1MB を超える client.js で起動が数秒遅れる (Cloud Run のコールドスタートに響く) ので 9 にする
      asset.br = { body: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }), etag: `"${hash}-br"`, encoding: "br" };
      asset.gzip = { body: gzipSync(body, { level: 9 }), etag: `"${hash}-gz"`, encoding: "gzip" };
    }
    assets.set(`/${name}`, asset);
  }
  return assets;
}

/** http.createServer に渡すハンドラー */
export function createStaticHandler(dir: string) {
  const assets = loadAssets(dir);
  const security = parseHeaders(readFileSync(join(dir, "_headers"), "utf8"));
  const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) =>
    res.writeHead(status, { ...security, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra }).end(body);

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "method not allowed", { Allow: "GET, HEAD" });
    const path = (req.url ?? "/").split("?")[0];
    const asset = assets.get(path === "/" ? "/index.html" : path);
    if (!asset) return text(res, 404, "not found");

    const accept = String(req.headers["accept-encoding"] ?? "");
    const variant = (asset.br && /\bbr\b/.test(accept) && asset.br) || (asset.gzip && /\bgzip\b/.test(accept) && asset.gzip) || asset.plain;
    const headers: Record<string, string> = {
      ...security,
      "Content-Type": asset.type,
      // ファイル名にハッシュを付けていないので、毎回新しい版か確かめさせる (変わっていなければ 304 で中身は送らない)
      "Cache-Control": "no-cache",
      ETag: variant.etag,
      Vary: "Accept-Encoding",
    };
    if (variant.encoding) headers["Content-Encoding"] = variant.encoding;
    if (req.headers["if-none-match"] === variant.etag) return void res.writeHead(304, headers).end();
    headers["Content-Length"] = String(variant.body.length);
    res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : variant.body);
  };
}
