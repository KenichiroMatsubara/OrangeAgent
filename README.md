# OrangeAgent

Cloudflare だけで動く AI エージェントです。チャット画面から話しかけても、決めた時刻に自動で動かしてもかまいません。エージェントはブラウザを操作し、コードを実行し、Google のサービスを使って仕事をします。

> Cloudflare の製品を存分に使った AI アプリを作ってみたくて作った、非公式のアプリです。Cloudflare, Inc. が開発・提供するものではありません。

## できること

### エージェントの動かし方

- **チャット**：画面から話しかけると、その場でツールを使って答えます。ツールを使うたびに承認を求めるか、読み取りだけにするかは会話ごとに選べます。
- **定期実行**：「毎朝5時に届いたメールを読んで予定に入れる」のように、時刻と指示（Skill）と使ってよいツールを決めておくと、エージェントが自動で動きます。
- **MCP**：Claude Code などの外部エージェントから、MCP サーバーとして呼び出せます。

### エージェントが使えるツール

- **ブラウザ**：Cloudflare Browser Run の Chrome で Web ページを開き、読み、クリックや入力をします。ログインが必要なサイトは、人がログインした状態を保存しておけます。
- **コード実行**：JavaScript は Dynamic Worker で、Python などは Sandbox SDK のコンテナで実行します。Excel・Word・PowerPoint・PDF も作れます。
- **Google**：Gmail（検索・読む・送る・下書き）、Calendar、Drive、Meet の文字起こし、Tasks。
- **Web**：任意の URL のページや PDF を読みます。
- **記憶**：覚えておくべきことを保存し、言葉と意味の両方で探します（D1 と Vectorize、Workers AI）。
- **サブエージェント**：仕事の一部を別のエージェントに任せます。
- **外部の MCP サーバー**：HTTP や SSE でつながる MCP サーバーを追加すれば、そのツールも使えます。

### 届け先

LINE、Discord、メール、ブラウザの通知（Web Push）に送れます。送る相手は連絡先として登録しておきます。

### Skill

エージェントへの指示は Skill として書きます。Skill は `SKILL.md` と、スクリプトなどのファイルをまとめたものです。定期実行の中身も Skill で決まるので、Skill を書き換えるだけで動作を変えられます。

### モデル

Claude（Anthropic）、OpenAI、Gemini、OpenRouter から選べます。

## 使っている Cloudflare の製品

| 製品 | 用途 |
|---|---|
| Workers | API と管理画面の配信 |
| D1 | データ。管理用に1つと、Account ごとに1つ |
| Durable Objects | チャットの会話とストリーミング、実行中のエージェント |
| R2 | ファイル、録音、実行記録 |
| Browser Run | エージェントのブラウザ |
| Dynamic Worker（Worker Loader） | JavaScript の実行 |
| Containers・Sandbox SDK | Python などの実行 |
| Workers AI・Vectorize | 記憶の検索 |
| Cron Triggers | 定期実行（30分ごと） |

## 構成

- `apps/worker`：Worker（Hono）
- `apps/web`：管理画面（React + Vite）
- `packages/domain`：Worker と管理画面が共有する型
- `packages/t3chat`：チャット画面。[t3code](https://github.com/pingdotgg/t3code)（MIT）から取り込んだもの

## 手元で動かす

Node.js 26 以上が必要です。

```bash
npm install
```

Google のアカウントをつながずに画面だけ見るなら、モックの API で起動します（http://localhost:5199）。

```bash
npm run dev:mock
```

実際に動かすには、`apps/worker/.dev.vars.example` を `apps/worker/.dev.vars` にコピーして値を入れます。Google Cloud の OAuth クライアントには、リダイレクト URI として `http://localhost:8787/oauth/google/callback` を登録します。

```bash
npm run dev
```

http://localhost:8787 で、管理画面と Worker が一緒に起動します。

テストは次のとおりです。

```bash
npm test
```

## デプロイ

Workers Paid プランが必要です。

1. Control 用の D1 を作ります。

   ```bash
   npx wrangler d1 create flarechat-control-apac
   ```

2. Cloudflare の **Workers & Pages → Create → Git repository** でこのリポジトリをつなぎ、次のように設定します。
   - Build command：`npm run build`
   - Deploy command：`npm run deploy:cloudflare`（`wrangler deploy` にしないでください。マイグレーションが飛ばされます）
   - Version command：`npm run deploy:preview`
   - 初回だけ、ビルド変数に `APP_URL`（本番の URL）と `CONTROL_DATABASE_ID`（1で作った D1 の ID）を入れます。
3. Worker の Secrets に次を設定します。
   - 必須：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`CREDENTIAL_MASTER_KEY`、`CREDENTIAL_MASTER_KEY_VERSION`、`CLOUDFLARE_API_TOKEN`（Account ごとの D1 を作るのに使います）
   - 任意：`OPENROUTER_API_KEY`、`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`（通知）、`MICROSOFT_CLIENT_ID`・`MICROSOFT_CLIENT_SECRET`（Office での PDF 化）
4. Google Cloud の OAuth クライアントに `https://<本番のドメイン>/oauth/google/callback` を登録します。

各値の意味は `apps/worker/.dev.vars.example` に書いてあります。

## ライセンス

Apache License 2.0。`packages/t3chat` は MIT（t3code）、`.claude/skills` の一部は MIT（[mattpocock/skills](https://github.com/mattpocock/skills)）です。それぞれの LICENSE と NOTICE を見てください。
