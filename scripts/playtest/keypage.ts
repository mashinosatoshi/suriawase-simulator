// 自動試遊で使う API キーを、ブラウザの入力画面で受け取る。
// ゲームと同じく、キーはファイルや環境変数からは読まない。このプロセスのメモリにだけ置き、画面にもログにも出さない。
// 入力画面は 127.0.0.1 だけで待ち受け、推測できない URL (使い捨ての合言葉つき) でだけ開く
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApiKeys, CATALOG, checkKeyFormat, describeError, isAuthError, verifyKey, type ProviderId } from "../../src/llm/index.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  // no-referrer にすると、ブラウザはフォームの送信に Origin: null を付ける (送信元を確かめられず、受け付けられない)。
  // 同じ画面の中でだけ送信元を付ける same-origin にする (外のサイトへは何も送らない)
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const STYLE = "body{font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;line-height:1.7;color:#23252f}label{display:block;margin-top:14px;font-weight:600}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}button{margin-top:18px;padding:8px 18px;font:inherit}.err{color:#c2461f}.muted{color:#686c7e;font-size:13px}";

function page(body: string) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>自動試遊: API キー</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function form(providers: ProviderId[], errors: Partial<Record<ProviderId, string>> = {}) {
  const fields = providers
    .map((id) => {
      const err = errors[id];
      return `<label for="${id}">${esc(CATALOG[id].label)} の API キー</label><input id="${id}" name="${id}" type="password" autocomplete="off" spellcheck="false" maxlength="400" required>${err ? `<p class="err">${esc(err)}</p>` : ""}`;
    })
    .join("");
  return page(
    `<h1>自動試遊: API キーの入力</h1><p>自動試遊で AI を呼ぶためのキーを貼り付けてください。キーは試遊のプロセスのメモリにだけ置き、ファイルには書きません。終わると消えます。</p>` +
      `<p class="muted">ゲーム専用のキー (上限額を設定したもの) をおすすめします。</p><form method="post">${fields}<button type="submit">決定</button></form>`,
  );
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // 開けなくても、URL はログに出ている
  }
}

async function readForm(req: IncomingMessage) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 8 * 1024) return new URLSearchParams();
  }
  return new URLSearchParams(s);
}

/** 入力画面を開き、すべての提供元のキーが確かめられるまで待つ。open = false はブラウザを開かない (アドレスを出すだけ) */
export function askKeys(providers: ProviderId[], open = true): Promise<ApiKeys> {
  const token = randomBytes(16).toString("hex");
  const keys = new ApiKeys();
  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const port = (server.address() as AddressInfo).port;
      const host = `127.0.0.1:${port}`;
      const origin = req.headers.origin;
      // ほかのページ・ホスト名からの送信は受け付けない (CSRF / DNS rebinding 対策)
      if (req.headers.host !== host || (origin !== undefined && origin !== `http://${host}`) || (req.url ?? "").split("?")[0] !== `/${token}`) {
        return void res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      }
      if (req.method === "GET") return void res.writeHead(200, HEADERS).end(form(providers));
      if (req.method !== "POST") return void res.writeHead(405).end();

      const body = await readForm(req);
      const errors: Partial<Record<ProviderId, string>> = {};
      for (const id of providers) {
        const value = body.get(id);
        const formatError = checkKeyFormat(value);
        if (formatError) {
          errors[id] = formatError;
          continue;
        }
        try {
          await verifyKey(id, value!.trim());
          keys.set(id, value!.trim());
        } catch (err) {
          errors[id] = isAuthError(err) ? "API キーが正しくありません" : `キーを確かめられませんでした: ${describeError(err)}`;
        }
      }
      if (Object.keys(errors).length) return void res.writeHead(200, HEADERS).end(form(providers, errors));
      res.writeHead(200, HEADERS).end(page("<h1>受け付けました</h1><p>このタブは閉じてかまいません。試遊はターミナルで進みます。</p>"));
      server.close();
      resolve(keys);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;
      console.log(`API キーの入力画面を開きます。開かなければ、このアドレスをブラウザで開いてください:\n  ${url}`);
      if (open) openBrowser(url);
    });
  });
}
