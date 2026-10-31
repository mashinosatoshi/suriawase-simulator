// 公開用のサーバーの入口 (Cloud Run のコンテナで動かす)。public/ を配信するだけ。
//   PORT       待ち受けるポート (Cloud Run が渡す。既定 8080)
//   PUBLIC_DIR 配信するフォルダ (既定: 実行したフォルダの public/)
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createStaticHandler } from "./static.js";

const dir = resolve(process.env.PUBLIC_DIR ?? "public");
const port = Number(process.env.PORT ?? 8080);
const server = createServer(createStaticHandler(dir));
server.listen(port, "0.0.0.0", () => console.log(`すり合わせシミュレーター: ${dir} を :${port} で配信しています`));

// Cloud Run はインスタンスを止める前に SIGTERM を送る。受け付け中の要求を返し終えてから閉じる
process.on("SIGTERM", () => server.close(() => process.exit(0)));
