// ローカルで遊ぶためのサーバー。
// - 通常 (npm start): public/ を配信するだけ。ゲームはブラウザの中で動き、利用者のキーで AI の会社の API を直接呼ぶ。
//   このサーバーは API キーも会話も受け取らない (公開するときは public/ を静的ホスティングに置くだけでよい)。
// - MCP (npm run mcp): Claude Code などが GM を務める。ゲームの状態はこのサーバーが持ち、ブラウザとは /api/* で通信する。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Engine } from "./engine.js";
import { parseHeaders } from "./headers.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import { parseNewGame } from "./requests.js";
import type { AiStatus } from "./shared.js";
import { GAME_TOOLS } from "./tools.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

const MCP_MODE = process.argv.includes("--mcp");
/**
 * 実際に使っているポート。npm start のとき 3100 番が使用中 (前に起動したゲームや、Claude Code が起動した MCP サーバーなど) なら、
 * 空いている次の番号に移る。PORT を指定したときと MCP モードでは移らない
 */
let port = Number(process.env.PORT ?? 3100);
const PORT_FIXED = process.env.PORT !== undefined || MCP_MODE;
const MAX_PORT_TRIES = 10;

// MCP モードでは stdout を JSON-RPC が使うため、ログは必ず stderr へ
const info = (...a: unknown[]) => console.error(...a);

/** 公開時と同じセキュリティヘッダー (public/_headers の「/*」の項) を、ローカルでも送る */
const SECURITY_HEADERS = parseHeaders(readFileSync(join(PUBLIC_DIR, "_headers"), "utf8"));

// ---- MCP 版のゲーム ----------------------------------------------------------------
// Claude Code などが wait_for_player_turn を呼んでくる。最後の呼び出しから一定時間で「未接続」とみなす
const engine = MCP_MODE ? new Engine() : null;
const AI_TIMEOUT_MS = 90_000;
let lastMcpActivity = 0;
let mcpConnected = false;

const aiStatus = (): AiStatus => ({ mode: "mcp", label: mcpConnected ? "Claude Code (MCP)" : "未接続", connected: mcpConnected, providers: [], current: null, error: null });

const clients = new Set<ServerResponse>();
const snapshot = (e: Engine) => JSON.stringify({ ...e.publicState(), ai: aiStatus() });
function pushState() {
  if (!engine) return;
  const data = `data: ${snapshot(engine)}\n\n`;
  clients.forEach((res) => res.write(data));
}
engine?.onChange(pushState);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const MAX_BODY = 16 * 1024;
async function readBody(req: IncomingMessage) {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > MAX_BODY) return {};
  }
  try {
    return JSON.parse(s || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** ローカル以外のページ/ホスト名からの操作を弾く (CSRF / DNS rebinding 対策) */
function isLocalRequest(req: IncomingMessage) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  if (!hosts.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return hosts.has(origin.replace(/^https?:\/\//, ""));
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));

/** MCP 版の画面からの操作 */
async function handleApi(e: Engine, req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${snapshot(e)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const body = await readBody(req);
  let error: string | null = null;
  switch (path) {
    case "/api/act":
      error = e.act({ text: body.text, to: body.to });
      break;
    case "/api/defer":
      error = e.act({ text: body.text, to: body.to }, true);
      break;
    case "/api/new": {
      const g = parseNewGame(body);
      if ("error" in g) error = g.error;
      else e.requestNewGame(g.request, g.level, g.params);
      break;
    }
    case "/api/replay":
      error = e.replay();
      break;
    default:
      return json(res, 404, { error: "not found" });
  }
  return error ? json(res, 409, { error }) : void res.writeHead(204).end();
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (!isLocalRequest(req)) return void res.writeHead(403).end("forbidden");
    if (url.pathname.startsWith("/api/")) {
      if (!engine) return json(res, 404, { error: "このサーバーは画面を配信するだけです (ゲームはブラウザの中で動きます)" });
      return await handleApi(engine, req, res, url.pathname);
    }

    // 静的ファイル
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return void res.writeHead(403).end();
    let buf: Buffer | string = await readFile(file);
    // MCP 版では、ページがこのサーバーと通信するよう印を付ける (ふだんはブラウザの中だけで動く)
    if (MCP_MODE && rel === "index.html") buf = buf.toString("utf8").replace("<head>", '<head>\n<meta name="backend" content="server">');
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[extname(file)] ?? "application/octet-stream" }).end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
});

/** 既定のブラウザで開く (OPEN_BROWSER=0 で無効) */
function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // 開けなくても、URL はログに出ている
  }
}

let portTries = 1;
http.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE" && !PORT_FIXED && portTries < MAX_PORT_TRIES) {
    info(`ポート ${port} は使用中のため、${port + 1} を使います`);
    port++;
    portTries++;
    http.listen(port, "127.0.0.1");
    return;
  }
  const hint =
    e.code === "EADDRINUSE"
      ? `。ほかのプログラム (前に起動したゲームや、Claude Code が起動した MCP サーバーなど) がポート ${port} を使っています。それを終了するか、PORT で別の番号を指定してください`
      : "";
  info(`HTTP サーバーの起動に失敗: ${e.message}${hint}`);
});
http.on("listening", () => {
  const url = `http://localhost:${port}`;
  info(`すり合わせシミュレーター: ${url}`);
  if (MCP_MODE) return;
  info("ゲームはブラウザの中で動きます。API キーはブラウザから AI の会社へ直接送られ、このサーバーには届きません");
  if (process.env.OPEN_BROWSER !== "0") openBrowser(url);
});
http.listen(port, "127.0.0.1");

// ---- MCP サーバー (Claude Code などが GM 兼 相手役を務める) ----------------------
if (engine) {
  const game = engine;
  const touchMcp = () => {
    lastMcpActivity = Date.now();
    if (!mcpConnected) {
      mcpConnected = true;
      pushState();
    }
  };
  setInterval(() => {
    const on = Date.now() - lastMcpActivity < AI_TIMEOUT_MS;
    if (on !== mcpConnected) {
      mcpConnected = on;
      pushState();
    }
  }, 5000).unref();

  const mcp = new McpServer({ name: "suriawase-simulator", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });

  const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
  const tool = <S extends z.ZodRawShape>(name: string, description: string, inputSchema: S, fn: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>) =>
    mcp.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>) => {
      touchMcp();
      return text(await fn(args));
    }) as never);

  tool(
    "wait_for_player_turn",
    "プレイヤーの発言 (type=player_action)・新規ゲームの依頼 (type=new_game)・終了後の振り返りの依頼 (type=review) が来るまで待って返す。基本のループ。何も無ければ「新しい仕事はありません」と返るので、そのままもう一度呼ぶ。処理が終わるまで同じ仕事が返り続けるので、コンテキストが失われても詰まらない",
    { timeout_sec: z.number().int().min(1).max(50).default(25) },
    async ({ timeout_sec }) => {
      const work = await game.waitForWork(timeout_sec * 1000);
      touchMcp();
      return work ?? "新しい仕事はありません。もう一度 wait_for_player_turn を呼んでください";
    },
  );

  tool("get_state", "ゲームの全状態を取得する (シナリオの隠し情報を含む。プレイヤーには見えない)。コンテキストを失ったときの復帰用", {}, () => game.fullState());

  // ゲーム用のツールは内蔵 GM と同じ定義を使う。MCP では、次に何をするかの案内を足す
  for (const t of GAME_TOOLS) {
    tool(t.name, t.description, t.shape, (args) => {
      const out = t.run(game, args);
      if (!out.ok) return out.text;
      return `${out.text}。${t.name === "reply" && out.ended ? "wait_for_player_turn を呼ぶと、振り返りの依頼 (type=review) が届きます" : "wait_for_player_turn に戻ってください"}`;
    });
  }

  await mcp.connect(new StdioServerTransport());
  info("MCP サーバー起動 (stdio)");
}
