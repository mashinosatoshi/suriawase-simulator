---
description: 自動試遊。AI どうしにゲームを遊ばせ、会話の不自然さをレポートにまとめる。GM は Claude Code (API キー不要) か、Claude・GPT・Gemini の API から選べる
argument-hint: "[ゲーム数 (既定 1)] [難易度 (既定 normal)] [GM (既定 haiku)] [プレイヤー役 (既定 GM と同じ)] [審査役 (既定 sonnet)]"
---

# 自動試遊

引数: `$ARGUMENTS` (空白区切り。省いたものは既定値)

| 位置 | 意味 | 既定 | 書き方 |
|---|---|---|---|
| 1 | ゲーム数 | 1 | 1〜50 |
| 2 | 難易度 | normal | easy / normal / hard / random |
| 3 | GM | haiku | 下の「AI の指定」 |
| 4 | プレイヤー役 | GM と同じ | 下の「AI の指定」 |
| 5 | 審査役 | sonnet | 下の「AI の指定」 |

## AI の指定

- `haiku` / `sonnet` / `opus`: この Claude Code のサブエージェントが務める (API キー不要。Claude Code の利用枠で動く)。Agent ツールの `model` にそのまま渡す。
- `<提供元>:<モデル ID>[:effort]`: 各社の API で動かす (API キーは、起動時にブラウザに開く入力画面でユーザーが貼り付ける)。
  - 提供元は `anthropic` / `openai` / `gemini`。effort は low / medium / high (既定 medium)。
  - 例: `gemini:gemini-3.5-flash-lite`、`openai:gpt-6-luna`、`anthropic:claude-haiku-5-5:low`
  - 選べるモデルは src/llm/catalog.ts の一覧 (一覧に無い ID も使える)。

## どちらの進め方になるか

- **MCP 版**: GM が `haiku` / `sonnet` / `opus` のとき。この Claude Code につながっている MCP 版のサーバー (suriawase-simulator、`http://localhost:3100`) で遊ばせる。プレイヤー役も `haiku` / `sonnet` / `opus` で指定する (API の指定は使えない)。審査役も同じ。
- **API 版**: GM が `<提供元>:<モデル>` のとき。`npm run playtest` で GM とプレイヤー役を各社の API で動かす (エンジンはこのリポジトリのコードがそのまま動くので、MCP の再接続は要らない)。プレイヤー役も `<提供元>:<モデル>` で指定する (省けば GM と同じ)。審査役は `haiku` / `sonnet` / `opus` (試遊の後でサブエージェントが審査) か `<提供元>:<モデル>` (試遊の中で API が審査)。
- 指定の組み合わせが合わないときは、実行せずにユーザーに伝える。

どちらの版でも、ゲームの番号でプレイヤー役の性格とターンの使い方が決まる (性格は「聞き上手・せっかち・押しが強い・話がそれがち」の順。偶数番目のゲームはターンの上限まで使い、奇数番目は 4〜10 回目のどこかで締める)。

## 守ること

- 自分 (このコマンドを実行している Claude) は suriawase-simulator の MCP ツールを呼ばない (MCP 版では GM のサブエージェントと仕事を奪い合う)。
- MCP 版では、試遊の間ブラウザの `localhost:3100` で遊ばないよう、最初にユーザーに一言伝える (同じゲームを使うため)。src/ のエンジンを直した直後なら、MCP のサーバーが古いコードのままのことがある。そのときはユーザーに `/mcp` で再接続してもらってから始める。
- API 版では、API キーの入力画面がブラウザに開くので、そこに貼り付けてもらうようユーザーに伝える。キーの値をたずねたり、ファイルや環境変数から読んだりしない。各社の課金 (無料枠を含む) がかかることも伝える。
- 不自然さを見つけても、ゲームのコードや指示文はユーザーに確かめるまで直さない。
- サブエージェントやバックグラウンドの処理の終了は通知を待つ (ポーリングしない)。
- サブエージェントは `subagent_type: "general-purpose"`, `effort: "medium"`、`model` は指定どおり。

## 結果のフォルダ

`playtest-results/<YYYYMMDD-HHMMSS>-mcp` (MCP 版) / `playtest-results/<YYYYMMDD-HHMMSS>-api` (API 版)。以下 `<dir>`。

## MCP 版の手順

1. ゲーム `n` = 1, 2, … ごとに、次を順に行う:
   1. `npx tsx scripts/playtest/mcp.ts new --difficulty <難易度>` (失敗したら、MCP がつながっているかをユーザーに確かめて止める)
   2. `npx tsx scripts/playtest/mcp.ts player-brief <n>` で、このゲームの性格とターンの使い方 (`--max-turns` に渡す値) を得る
   3. 同じメッセージで 2 体のサブエージェントを起動する (どちらも `run_in_background: true`): 下の「GM への指示」(model = GM の指定) と「プレイヤー役への指示」(model = プレイヤー役の指定)
   4. 2 体とも終わるのを待つ
   5. `npx tsx scripts/playtest/mcp.ts dump <dir> <n>`
   6. `<dir>/game-NN-meta.json` (NN は 2 桁) を Write で書く: `{"style": "<性格の名前>", "turns": <--max-turns の値 (数か "full")>, "difficulty": "<難易度>", "rejections": [{"turn": <ターン>, "message": "<理由>"}], "error": null}`。rejections は GM の報告の `REJECT` 行から。GM が途中で止まったら error に理由を書く
   7. 審査役のサブエージェント (model = 審査役の指定) を起動し、終わるのを待つ: 下の「審査役への指示」。get_state を使うので、次のゲームを頼む前に終わらせる
2. `npx tsx scripts/playtest/mcp.ts report <dir> --label "<役の説明 (例: GM・プレイヤー役は Haiku、審査役は Sonnet)>"`
3. 下の「まとめ方」

## API 版の手順

1. 次を `run_in_background: true` で実行し、ユーザーに「ブラウザに開く画面に API キーを貼り付けてください」と伝える:
   `npm run playtest -- --games <ゲーム数> --difficulty <難易度> --gm <GM> --player <プレイヤー役> --judge <審査役が API の指定ならそれ、サブエージェントなら none> --out <dir>`
2. 終わったら出力を確かめる (止まったゲームがあれば、その理由もまとめに書く)
3. 審査役がサブエージェントのとき: ゲーム `n` ごとに審査役のサブエージェント (model = 審査役の指定) を起動する。API 版の記録はファイルにすべて入っていて get_state を使わないので、3 体ずつ並べて起動してよい。審査役への指示の 2 は省く (judge-brief の出力に「MCP のツールは呼ばない」とある)
4. `npx tsx scripts/playtest/mcp.ts report <dir>` (審査役が API のときは、npm run playtest がすでに report.md を書いているので不要)
5. 下の「まとめ方」

## まとめ方

`<dir>/report.md` を読み、ユーザーに要約する: 不自然さの種類ごとの件数、目立つ実例 (どのゲームの何ターン目か)、エンジンの差し戻し、直し方の候補 (指示文で防ぐか、エンジンで機械的に弾くか)。前回の試遊と比べられるなら比べる (条件が違えば、そのことも書く)。直すかどうかはユーザーに聞く。

## GM への指示 (MCP 版。サブエージェントのプロンプト)

```
あなたは対話ゲーム「すり合わせシミュレーター」の GM 兼 相手役です。MCP のツール (mcp__suriawase-simulator__*) でゲームを進めます。
- ツールが読み込まれていなければ、ToolSearch で "select:mcp__suriawase-simulator__wait_for_player_turn,mcp__suriawase-simulator__start_scenario,mcp__suriawase-simulator__reply,mcp__suriawase-simulator__submit_review,mcp__suriawase-simulator__get_state" を読み込む。
- 最初に src/instructions.ts を読み、MCP 版の指示 (INTRO・MCP_LOOP・RULES) に従う。各ツールの説明にも従う。
- ループ: wait_for_player_turn を呼び、届いた仕事 (new_game → start_scenario / player_action → reply / review → submit_review) を片付ける。ツールがエラーを返したら、理由を読んで直して出し直す。
- submit_review が通ったら、そこで終わり (それ以上 wait しない)。
- wait_for_player_turn が「新しい仕事はありません」を 10 回続けて返したら、止めて報告する。
- ファイルの編集やコマンドの実行はしない。
- 終わったら報告する: 1 行目に「振り返り: 提出した / できなかった (理由)」。続けて、ツールがエラーで差し戻された回ごとに 1 行ずつ「REJECT <ターン番号> <短い理由>」。差し戻しが無ければ「REJECT なし」。
```

## プレイヤー役への指示 (MCP 版。サブエージェントのプロンプト)

`<性格>` と `<ターン>`、`<値>` には player-brief の出力を入れる。

```
あなたは対話ゲーム「すり合わせシミュレーター」のプレイヤー役 (試験用) です。人間のプレイヤーの代わりに話します。
あなたの話し方の傾向: <性格>
このゲームのターン: <ターン>
- 使うのは次の 2 つのコマンドだけ (Bash ツールで、リポジトリのフォルダで実行)。MCP のツールやリポジトリのファイルは見ない (相手の隠れた事情を知らないまま話すため)。
  - 待つ: npx tsx scripts/playtest/mcp.ts wait --max-turns <値>
  - 話す: npx tsx scripts/playtest/mcp.ts say '<発言>' --max-turns <値>   (特定の人に話すときは --to <id>)
- --max-turns が full のゲームでは、自分から締めない (--finish を付けない)。話をまとめて終わらせようとせず、ターンの上限まで話し合いを続ける。数のゲームでは、話し合いがまとまったら --finish で締めてもよい (その数に達すると say が自動で締める)。
- 繰り返し: wait → 出力 (場面・相手の発言・様子・懸念ボード) を読んで次の発言を考える → say → wait …
- 最初の wait は、GM がシナリオを作るまで数分かかることがある (そのまま待つ)。
- 発言は話し言葉で 1〜3 文。日本語として自然に。話し方の傾向を出す。ゲームの仕組みや AI であることには触れない。発言にシングルクォート (') を入れない。
- wait が「ended」と出したら終わり。「時間切れ」や「まだ番ではありません」なら、もう一度 wait する。
- 終わったら、何回発言したかだけを報告する。
```

## 審査役への指示 (サブエージェントのプロンプト)

```
あなたは日本語の会話劇の校閲者 (試験の審査役) です。
1. Bash で `npx tsx scripts/playtest/mcp.ts judge-brief <dir> <n>` を実行し、出力の指示に従って会話を審査する。
2. (MCP 版のときだけ) 設定を見るため、MCP のツール mcp__suriawase-simulator__get_state を 1 回だけ呼ぶ (読み込まれていなければ ToolSearch で "select:mcp__suriawase-simulator__get_state")。ほかの MCP のツールは呼ばない。
3. 結果の JSON を Write でファイルに書き、`npx tsx scripts/playtest/mcp.ts check-judge <dir> <n>` で確かめる。OK になるまで直す。
4. 終わったら「指摘 N 件・自然さ X/5」とだけ報告する。
```
