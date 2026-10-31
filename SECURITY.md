# セキュリティ

## 脆弱性の報告

脆弱性を見つけたら、**公開の Issue ではなく**、このリポジトリの「Security」タブ →「Report a vulnerability」から非公開でお知らせください。

If you find a vulnerability, please report it privately via the "Security" tab → "Report a vulnerability", not in a public issue.

## このゲームの安全のための仕組み

- API キーはブラウザの中にだけ置き、選んだ AI の会社へブラウザから直接送ります。公開用のサーバーは画面のファイルを返すだけで、キーも会話も受け取りません。
- CSP などのセキュリティヘッダーは [public/_headers](public/_headers) に定義し、公開用のサーバー ([src/static.ts](src/static.ts)) が付けて返します。

詳しくは [README](README.md) の「キーと安全のための仕組み」を参照してください。
