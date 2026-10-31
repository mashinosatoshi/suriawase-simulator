# 公開用のコンテナ (Google Cloud Run)。画面をビルドし、public/ を配信する小さなサーバー (src/serve.ts) と一緒に詰める。
# ゲームはブラウザの中で動くので、このコンテナは画面のファイルを返すだけ (API キーも会話も通らない)。
#   docker build -t suriawase-simulator .
#   docker run --rm -p 8080:8080 suriawase-simulator   → http://localhost:8080

# ベースイメージは版まで固定する (Node.js のセキュリティ修正を確実に含め、ビルドのたびに中身が変わらないように)。
# 新しい版は Dependabot が pull request で知らせる
# ---- ビルド ----
FROM node:24.22.2-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY public ./public
RUN npm run build:client && npm run build:serve

# ---- 実行 (配信に要るものだけ。ソースや node_modules は入れない) ----
FROM node:24.22.2-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/public ./public
COPY --from=build /app/dist/serve.mjs ./serve.mjs
# root では動かさない
USER node
EXPOSE 8080
CMD ["node", "serve.mjs"]
