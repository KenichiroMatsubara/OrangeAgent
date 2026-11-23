# OrangeAgent の開発ルール

コーディングエージェント（Claude Code、Codex など）がこのリポジトリで作業するときのルールです。アプリが何をするかは `README.md`、いまどう動くかは `CONTEXT.md` を読んでください。

## 守ること

- Cloudflare だけで動かします。MongoDB、Redis、Meilisearch、Node のサーバーなど、Cloudflare の外のものに依存させません。
- Workers は子プロセスを起動できません。そのため、つなげる MCP サーバーは HTTP か SSE のものだけです。
- コードはすべて strict な TypeScript です。`any` は使いません。
- 関数は平らに書き、型は明示し、早めに return します。ファイル名は1単語にします。

## 構成

- `apps/worker`：Worker（Hono、D1、Durable Objects、R2、Cron）
- `apps/web`：管理画面（React + Vite）
- `packages/domain`：Worker と管理画面の取り決め。route が返す形はここで一度だけ宣言し、両方から読み込みます
- `packages/t3chat`：チャット画面。t3code（MIT）から一度だけ取り込んだもので、上流には合わせません。上の書き方のルールは当てはめず、Tailwind、Base UI、Effect atoms、複数単語のファイル名をそのまま使います。LICENSE と NOTICE は消しません
- `redirect`：旧 URL（`flarechat.<subdomain>.workers.dev`）に置く転送用の Worker。`npx wrangler deploy -c redirect/wrangler.jsonc` で出します
- `docs/adr`：元に戻しにくい少数の決定
- `CONTEXT.md`：いまの仕様

## Skill のスクリプト

Skill に入れるスクリプトは JavaScript の ES モジュール（`.mjs`）で書きます。Office ファイルや PDF を作るものも同じです。

- `code.run` の Dynamic Worker が `./skills/<name>/` から読み込みます。Run のツールは `tools` から呼びます。
- 使えるライブラリは `apps/worker/src/lent.ts` にあるものです（exceljs、docx、pptxgenjs、pdf-lib、fflate、@xmldom/xmldom）。npm の名前で読み込みます。
- 足りないライブラリは `lent.ts` に足して `npm run lent` で束ねます。Skill の中にコピーしません。
- 元の Skill が Python で書かれていても、JavaScript で書き直します。コンテナの Python は、エージェントがその場で書くコードのためだけにあります。

## 画面

- 1つの設定は1つの画面だけで行います。その画面に、足りないときの表示と、足りないと何が起きるかを書きます。
- 言葉で言えるものは、内部の識別子を出しません（`apps/web/src/labels.ts`）。
- 時刻はすべて Asia/Tokyo で出します（`apps/web/src/time.ts`）。
- loader はすぐに返し、各部分はデータが届いたところから埋めます。

## 仕様と決定の書き方

- 動作を変えたら、同じ pull request で `CONTEXT.md` も直します。
- ADR は、次の3つをすべて満たす決定だけに書きます（`.claude/skills/domain-modeling/ADR-FORMAT.md`）：元に戻しにくい、背景を知らない人が驚く、本当に選択肢があった。
- それ以外（既定値、上限、画面の配置、モジュールの形、リファクタ、バグ修正）は、動作が変わるなら `CONTEXT.md` に、変わらないならコミットメッセージと pull request の説明に書きます。変更のたびに ADR を書かないでください。

## マイグレーションとリリース

- マイグレーションは本番データとの約束です（ADR 0174）。列や JSON の項目を読むマイグレーションを書く前に、それを書いたことのあるコードの git の履歴を読みます。昔の形の行が本番に残っているからです。
- どの行でも失敗しないように書きます。NOT NULL の値はすべて coalesce し、一意の索引とぶつかりうる書き換えには `UPDATE OR IGNORE` を使い、JSON の関数は `json_valid` で守ります。
- pull request ごとに CI が `npm run db:rehearse:remote` を走らせ、本番の全 D1 を書き出してマイグレーションを試します。失敗したらマージできません。この検査を飛ばしたり、弱めたり、回避したりしません。
- 本番へは `npm run deploy:cloudflare` でだけデプロイします。本番に直接 `wrangler deploy` しません。Workers Builds の Deploy command がこれと違っていたら、先にそれを直します。
- 本番の `d1_migrations` に名前が載ったマイグレーションは変えません。変更は新しいファイルで行います。

## URL の確かめ方

スマートフォンのアドレスバーは、URL の一部を省いて表示することがあります。スクリーンショットに `chat.<subdomain>.workers.dev` と見えても、`orangeagent.<subdomain>.workers.dev`（Worker 名は `orangeagent`）の後ろだけかもしれません。

- 本番の URL は、本番の Workers Builds の `APP_URL` 変数です。`npm run deploy:config` がそれを `apps/worker/wrangler.deploy.json` に書きます。リポジトリには入っていません。
- ユーザーが URL をそのまま書いたら、それを正とします。
- スクリーンショットに見える URL の一部だけを根拠に、ドメイン、リダイレクト、Worker などを作ったり、変えたり、消したりしません。
- URL がはっきりしないときは、ブラウザの状態やデプロイの設定から完全な URL を確かめてから動きます。

## Issue

Issue と PRD は、このリポジトリの GitHub Issues で管理します。どこで管理するかを聞く必要はありません（`docs/agents/issue-tracker.md`）。triage のラベルは `docs/agents/triage-labels.md` にあります。

## コマンド

- `npm run dev`：ローカルのマイグレーションを適用し、管理画面と Worker を http://localhost:8787 で起動します
- `npm run dev:mock`：管理画面だけをモックの API で http://localhost:5199 に起動します。Google の許可なしにすべての画面を見られます。`MOCK_DELAY=<ms>` で応答を遅らせ、`MOCK_STATE=signed_out|unassigned|no_mailbox` でログアウト・Account なし・メールボックスなしの状態から始めます
- `npm run build`：型チェックとビルド
- `npm test`：単体テスト、D1 のテスト、workerd で Worker と Durable Objects を動かすテスト（`npm run test:do`）
- `npm run lint`：Oxlint。`any` だけがエラーで、ほかは警告です（`packages/t3chat` では `any` も警告）
- `npm run db:local`：ローカルの Control と Account の D1 にマイグレーションを適用します
- `npm run deploy`：ビルドしてから `npm run deploy:cloudflare` を実行します
