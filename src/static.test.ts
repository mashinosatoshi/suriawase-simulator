// 公開用の静的ファイル配信 (Cloud Run) のテスト。一時フォルダに小さな public/ を作って確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { parseHeaders } from "./headers.js";
import { createStaticHandler } from "./static.js";

const HEADERS = `# コメント
/*
  Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
/admin/*
  X-Robots-Tag: noindex
`;

async function withServer(fn: (get: (path: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "static-"));
  const dir = join(root, "public");
  mkdirSync(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>" + "あ".repeat(500));
  writeFileSync(join(dir, "client.js"), "console.log(1);".repeat(200));
  writeFileSync(join(dir, "_headers"), HEADERS);
  writeFileSync(join(root, "secret.txt"), "外のファイル");
  const server = createServer(createStaticHandler(dir));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  // fetch は URL の ../ を正規化してしまうので、パスをそのまま送れる http.request を使う
  const get = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    await fn(get);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("_headers の「/*」の項だけを読む", () => {
  assert.deepEqual(parseHeaders(HEADERS), { "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" });
});

test("公開用の配信: セキュリティヘッダーを付けて public/ のファイルだけを返す", async () => {
  await withServer(async (get) => {
    const top = await get("/");
    assert.equal(top.status, 200);
    assert.match(top.headers["content-type"] ?? "", /text\/html; charset=utf-8/);
    assert.equal(top.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(top.headers["x-content-type-options"], "nosniff");
    assert.equal(top.headers["cache-control"], "no-cache");
    assert.match(top.body.toString(), /<title>t<\/title>/);
    assert.equal((await get("/client.js?v=1")).status, 200); // クエリは無視する

    // 外のファイル・設定ファイル・無いファイルには届かない (404 にもセキュリティヘッダーを付ける)
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/_headers", "/nope.html", "//etc/passwd"]) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      assert.equal(r.headers["x-content-type-options"], "nosniff", path);
      assert.ok(!r.body.toString().includes("外のファイル"), path);
    }
    // 読み取り以外は受け付けない
    const post = await get("/", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    const head = await get("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
  });
});

test("公開用の配信: 圧縮して返し、変わっていなければ 304", async () => {
  await withServer(async (get) => {
    const plain = await get("/client.js");
    const br = await get("/client.js", { headers: { "Accept-Encoding": "gzip, deflate, br" } });
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(br.headers.vary, "Accept-Encoding");
    assert.ok(br.body.length < plain.body.length);
    assert.deepEqual(brotliDecompressSync(br.body), plain.body);
    const gz = await get("/client.js", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(gz.body), plain.body);
    // 圧縮の有無で ETag を分け、同じものなら 304 (中身は送らない)
    assert.notEqual(br.headers.etag, plain.headers.etag);
    const again = await get("/client.js", { headers: { "Accept-Encoding": "br", "If-None-Match": br.headers.etag! } });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal(again.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
  });
});
