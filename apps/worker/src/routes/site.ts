/**
 * The pages anyone may open without signing in: the homepage that says what
 * OrangeAgent is, and its privacy policy. Google's OAuth consent screen links
 * to both, so they are plain HTML the Worker answers before the single-page
 * app and its Service Worker do (`run_worker_first` in wrangler.jsonc, and
 * the Worker's paths in the web app's cache.ts), and so they read the same
 * to a reviewer or a crawler that runs no script.
 *
 * Each page says everything in Japanese and then in English.
 */

import { Hono } from 'hono';

import type { Bindings } from '../types';

/** Every path this module answers. */
export const SITE_PATHS = ['/about', '/privacy'] as const;

const REPOSITORY = 'https://github.com/KenichiroMatsubara/OrangeAgent';
const ISSUES = `${REPOSITORY}/issues`;
const USER_DATA_POLICY = 'https://developers.google.com/terms/api-services-user-data-policy';
const GOOGLE_CONNECTIONS = 'https://myaccount.google.com/connections';

/** When the privacy policy last changed, in Asia/Tokyo. */
const UPDATED = { ja: '2026年11月23日', en: 'November 23, 2026' } as const;

const STYLE = `
:root { color-scheme: light dark; --text: #1f2328; --muted: #59636e; --line: #d1d9e0; --accent: #c2410c; --back: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --text: #e6edf3; --muted: #9198a1; --line: #3d444d; --accent: #fb923c; --back: #0d1117; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--back); color: var(--text); font: 16px/1.75 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
header { display: flex; align-items: center; gap: .75rem; }
header img { width: 2.5rem; height: 2.5rem; }
header strong { font-size: 1.25rem; }
nav { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0 2rem; }
a { color: var(--accent); }
h1 { font-size: 1.75rem; line-height: 1.4; margin: 2rem 0 1rem; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
section + section { border-top: 1px solid var(--line); margin-top: 3rem; }
p.note { color: var(--muted); }
blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 3px solid var(--accent); }
footer { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 1rem; color: var(--muted); }
`;

const layout = (title: string, body: string): string => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/favicon.ico">
<style>${STYLE}</style>
</head>
<body>
<main>
<header><img src="/icon.svg" alt=""><strong>OrangeAgent</strong></header>
<nav><a href="/about">ホーム / Home</a><a href="/privacy">プライバシーポリシー / Privacy Policy</a><a href="/">アプリを開く / Open the app</a></nav>
${body}
<footer>OrangeAgent · <a href="${REPOSITORY}">${REPOSITORY}</a></footer>
</main>
</body>
</html>
`;

const ABOUT = layout('OrangeAgent', `
<section lang="ja">
<h1>OrangeAgent</h1>
<p>OrangeAgent は、Gmail・Google カレンダー・Google ドライブ・Google Meet・Google Tasks を使って仕事を手伝う AI エージェントです。Cloudflare の上で動きます。<a href="#en">English</a></p>
<h2>できること</h2>
<ul>
<li>チャットで頼むと、メールを探して読み、予定やタスクを作り、メールを書いて送り、ファイルをドライブに保存します。</li>
<li>決めた時刻に自動で動きます。たとえば毎朝、届いたメールを読んで、予定とタスクに取り込みます。</li>
<li>メールの送信などの書き込みの前に、人の承認を求めるように設定できます。</li>
<li>結果や予定のリマインドを、LINE・Discord・メールで届けます。</li>
<li>Claude などのアプリから、MCP で呼び出せます。</li>
</ul>
<h2>Google のデータの扱い</h2>
<p>Google から受け取ったデータは、利用者が頼んだことと、利用者が設定した定期実行を行うためだけに使います。広告や、AI モデルの学習には使いません。詳しくは<a href="/privacy">プライバシーポリシー</a>に書いています。</p>
<h2>運営者</h2>
<p>OrangeAgent は、<a href="https://github.com/KenichiroMatsubara">KenichiroMatsubara</a> が個人で運営するオープンソースのアプリです。ソースコードは <a href="${REPOSITORY}">GitHub</a> で公開しています。問い合わせは <a href="${ISSUES}">GitHub の Issues</a> で受け付けます。</p>
</section>
<section lang="en" id="en">
<h1>OrangeAgent</h1>
<p>OrangeAgent is an AI agent that helps with your work through Gmail, Google Calendar, Google Drive, Google Meet, and Google Tasks. It runs on Cloudflare.</p>
<h2>What it does</h2>
<ul>
<li>Ask it in a chat, and it searches and reads your email, creates events and tasks, writes and sends email, and saves files to Drive.</li>
<li>It runs on its own at the times you choose. For example, every morning it reads the email that arrived and turns it into events and tasks.</li>
<li>You can have it ask a person for approval before it writes anything, such as sending an email.</li>
<li>It delivers results and reminders through LINE, Discord, and email.</li>
<li>Apps such as Claude can call it over MCP.</li>
</ul>
<h2>How it handles your Google data</h2>
<p>Data received from Google is used only to do what you ask and to run the scheduled tasks you set up. It is never used for advertising or to train AI models. See the <a href="/privacy">Privacy Policy</a> for details.</p>
<h2>Who runs it</h2>
<p>OrangeAgent is an open-source app run by an individual, <a href="https://github.com/KenichiroMatsubara">KenichiroMatsubara</a>. Its source code is public on <a href="${REPOSITORY}">GitHub</a>. Questions are welcome on <a href="${ISSUES}">GitHub Issues</a>.</p>
</section>
`);

const PRIVACY = layout('プライバシーポリシー / Privacy Policy · OrangeAgent', `
<section lang="ja">
<h1>プライバシーポリシー</h1>
<p class="note">最終更新日：${UPDATED.ja}　<a href="#en">English</a></p>
<p>このページは、OrangeAgent（以下「このアプリ」）が、どんなデータを受け取り、何に使い、誰に渡し、どう守り、いつまで残すかを説明します。</p>

<h2>運営者と問い合わせ先</h2>
<p>このアプリは <a href="https://github.com/KenichiroMatsubara">KenichiroMatsubara</a> が個人で運営しています。問い合わせは <a href="${ISSUES}">GitHub の Issues</a> で受け付けます。Issues は公開の場なので、メールアドレスなどの個人情報は書かないでください。本人の確認が要るときは、運営者から方法を返します。</p>

<h2>受け取るデータ</h2>
<p><strong>Google でログインするとき</strong>：名前、メールアドレス、プロフィール画像、Google アカウントの識別子。</p>
<p><strong>Google アカウントをエージェントにつないだとき</strong>：エージェントが次のことを行うための許可を求め、その結果のデータを受け取ります。</p>
<ul>
<li>Gmail：メールの検索、本文と添付ファイルの読み取り、メールの送信、下書きの保存。</li>
<li>Google カレンダー：利用者のカレンダーの予定の読み取り、作成、変更、取りやめ。</li>
<li>Google ドライブ：ファイルとフォルダの検索、読み取り、作成、移動、名前の変更。ファイルは消さず、専用のフォルダに移します。</li>
<li>Google Meet：会議の情報と文字起こしの読み取り、自動文字起こしの設定。</li>
<li>Google Tasks：タスクの読み取り、作成、変更。</li>
</ul>
<p><strong>使っているうちに作られるもの</strong>：チャットの会話と添付ファイル、エージェントの実行の記録（使ったツールとその結果）、連絡先、エージェントへの指示（Skill）、エージェントが覚えた事柄、定期実行の設定、届けたメッセージの記録、上げた録音とその文字起こし、エージェントが使うブラウザのログイン状態。</p>
<p><strong>利用者がつないだ外部サービス</strong>：LINE、Discord、AI モデルの提供元などの認証情報。Microsoft アカウントをつないだときは、名前、メールアドレス、OneDrive のこのアプリ専用のフォルダへの許可。</p>

<h2>データの使い方</h2>
<p>受け取ったデータは、利用者が頼んだことと、利用者が設定した定期実行を、エージェントが行うためだけに使います。たとえば、届いたメールを読んで予定やタスクを作る、内容をまとめて知らせる、頼まれたメールを送る、などです。</p>
<ul>
<li>広告には使いません。データを売りません。</li>
<li>信用の判断や貸し付けには使いません。</li>
<li>汎用の AI モデル（特定の利用者向けではないモデル）を作ったり、学習させたり、改善したりするためには使いません。</li>
<li>運営者は、利用者のデータを読みません。ただし、利用者が求めたとき、不正な利用や障害を調べるのに要るとき、法令で求められたときは除きます。</li>
</ul>

<h2>データを渡す相手</h2>
<p>エージェントが利用者の頼んだことを行うために、次の相手にデータを渡します。それ以外の相手には渡しません。</p>
<ul>
<li><strong>Cloudflare</strong>：このアプリが動き、データを保存する場所です。入力の候補を作る、記憶を検索するための索引を作る（Workers AI）、エージェントがウェブページを開く（Browser Run）ことにも Cloudflare を使います。</li>
<li><strong>AI モデルの提供元</strong>（Anthropic、OpenAI、Google の Gemini API、OpenRouter のうち、利用者が選んだもの）：エージェントの答えを作るために、会話とツールの結果（メールやファイルの内容を含むことがあります）を、利用者が設定した API キーで送ります。</li>
<li><strong>OpenRouter</strong>：利用者が文字起こしを設定したとき、上げた録音を送ります。</li>
<li><strong>Microsoft</strong>：利用者が Microsoft アカウントをつないだとき、Word・Excel・PowerPoint のファイルを PDF にするために、OneDrive のこのアプリ専用のフォルダに一時的に置き、変換が終わったら消します。</li>
<li><strong>メッセージの届け先</strong>：エージェントが LINE・Discord・メールで送るとき、その内容を届け先に渡します。</li>
<li><strong>利用者がつないだ外部のサービス</strong>：利用者がつないだ MCP サーバーや、エージェントがブラウザで開くサイトに、そのツールの実行に要る内容を渡します。</li>
<li><strong>法令で求められたとき</strong>：法令に基づく求めがあれば、それに応じます。</li>
</ul>

<h2>データの守り方</h2>
<ul>
<li>通信はすべて HTTPS で暗号化します。</li>
<li>保存するデータは、Cloudflare が保存時に暗号化します。Google の許可を含む外部サービスの認証情報は、利用者ごとの鍵でさらに暗号化します。</li>
<li>データベースは利用者（Account）ごとに分けています。</li>
<li>Google の認証情報は、このアプリのサーバーの外に出しません。</li>
</ul>

<h2>残す期間と消し方</h2>
<ul>
<li>データは、利用者がこのアプリを使っている間残します。会話、記憶、連絡先、Skill などは、画面から消せます。</li>
<li>消したデータも、障害から戻すための仕組みに最大35日残ります（データベースの巻き戻しは30日、外部への書き込みの受領記録は35日）。</li>
<li>ログインは、最後に使ってから30日で切れます。</li>
<li>Google のデータへの許可は、<a href="${GOOGLE_CONNECTIONS}">Google アカウントの「サードパーティ製のアプリとサービス」</a>からいつでも取り消せます。取り消したあとは、Google のデータを読みません。</li>
<li>Account とすべてのデータを消したいときは、<a href="${ISSUES}">GitHub の Issues</a> で知らせてください。本人を確認してから30日以内に消します。</li>
</ul>

<h2>Google API Services User Data Policy への準拠</h2>
<p>このアプリが Google の API から受け取った情報の利用と、ほかのアプリへの移転は、<a href="${USER_DATA_POLICY}">Google API Services User Data Policy</a>（Limited Use の要件を含む）に従います。</p>

<h2>このポリシーの変更</h2>
<p>このポリシーを変えるときは、このページを書き直し、最終更新日を改めます。</p>
</section>

<section lang="en" id="en">
<h1>Privacy Policy</h1>
<p class="note">Last updated: ${UPDATED.en}</p>
<p>This page explains what data OrangeAgent ("the app") receives, how it uses that data, whom it shares it with, how it protects it, and how long it keeps it.</p>

<h2>Who runs the app, and how to reach us</h2>
<p>The app is run by an individual, <a href="https://github.com/KenichiroMatsubara">KenichiroMatsubara</a>. Questions are welcome on <a href="${ISSUES}">GitHub Issues</a>. Issues are public, so please do not write your email address or other personal information there. When your identity needs to be confirmed, we will reply with how to do so.</p>

<h2>Data we receive</h2>
<p><strong>When you sign in with Google</strong>: your name, email address, profile picture, and Google account identifier.</p>
<p><strong>When you connect a Google account to the agent</strong>: the app asks for permission to do the following, and receives the data that results.</p>
<ul>
<li>Gmail: search email, read messages and their attachments, send email, and save drafts.</li>
<li>Google Calendar: read, create, change, and cancel events on your calendars.</li>
<li>Google Drive: search, read, create, move, and rename files and folders. Files are never deleted; they are moved to a dedicated folder instead.</li>
<li>Google Meet: read meeting information and transcripts, and turn on automatic transcription.</li>
<li>Google Tasks: read, create, and change tasks.</li>
</ul>
<p><strong>Data created as you use the app</strong>: chat conversations and their attachments, records of the agent's runs (the tools it used and their results), contacts, instructions for the agent (Skills), things the agent remembers, scheduled task settings, records of delivered messages, recordings you upload and their transcripts, and the sign-in state of the browser the agent uses.</p>
<p><strong>External services you connect</strong>: credentials for LINE, Discord, AI model providers, and similar services. If you connect a Microsoft account: your name, email address, and permission for the app's own folder in OneDrive.</p>

<h2>How we use data</h2>
<p>Data is used only for the agent to do what you ask and to run the scheduled tasks you set up — for example, reading email that arrived to create events and tasks, summarizing it for you, or sending an email you asked for.</p>
<ul>
<li>We do not use data for advertising, and we do not sell it.</li>
<li>We do not use data to determine creditworthiness or for lending.</li>
<li>We do not use data to develop, train, or improve generalized AI models (models that are not specific to you).</li>
<li>The operator does not read your data, except when you ask us to, when it is needed to investigate abuse or a failure, or when the law requires it.</li>
</ul>

<h2>Whom we share data with</h2>
<p>To do what you ask, the agent shares data with the following, and with no one else.</p>
<ul>
<li><strong>Cloudflare</strong>: where the app runs and stores data. Cloudflare also suggests what you may type next and indexes memories for search (Workers AI), and runs the browser the agent opens web pages with (Browser Run).</li>
<li><strong>AI model providers</strong> (whichever of Anthropic, OpenAI, Google's Gemini API, and OpenRouter you choose): to write the agent's answers, the conversation and tool results — which may include the content of email and files — are sent with the API key you set up.</li>
<li><strong>OpenRouter</strong>: if you set up transcription, the recordings you upload.</li>
<li><strong>Microsoft</strong>: if you connect a Microsoft account, Word, Excel, and PowerPoint files are placed briefly in the app's own OneDrive folder to be converted to PDF, and are deleted once the conversion ends.</li>
<li><strong>Message recipients</strong>: when the agent sends a message through LINE, Discord, or email, its content goes to the recipient.</li>
<li><strong>External services you connect</strong>: MCP servers you connect, and websites the agent opens in its browser, receive what the tool needs to run.</li>
<li><strong>When the law requires it</strong>: we respond to requests made under the law.</li>
</ul>

<h2>How we protect data</h2>
<ul>
<li>All traffic is encrypted with HTTPS.</li>
<li>Stored data is encrypted at rest by Cloudflare. Credentials for external services, including your Google authorization, are additionally encrypted with a key of your own account.</li>
<li>Each account has a database of its own.</li>
<li>Google credentials never leave the app's servers.</li>
</ul>

<h2>Retention and deletion</h2>
<ul>
<li>Data is kept while you use the app. You can delete conversations, memories, contacts, Skills, and more from the app.</li>
<li>Deleted data may remain for up to 35 days in the systems used to recover from failures (30 days of database point-in-time recovery, and 35 days of receipts for writes to external services).</li>
<li>Sign-ins expire 30 days after they were last used.</li>
<li>You can revoke the app's access to your Google data at any time from <a href="${GOOGLE_CONNECTIONS}">"Third-party apps &amp; services" in your Google Account</a>. After that, the app no longer reads your Google data.</li>
<li>To delete your account and all of its data, let us know on <a href="${ISSUES}">GitHub Issues</a>. We delete it within 30 days after confirming your identity.</li>
</ul>

<h2>Compliance with the Google API Services User Data Policy</h2>
<blockquote>OrangeAgent's use and transfer to any other app of information received from Google APIs will adhere to the <a href="${USER_DATA_POLICY}">Google API Services User Data Policy</a>, including the Limited Use requirements.</blockquote>

<h2>Changes to this policy</h2>
<p>When this policy changes, we update this page and its "Last updated" date.</p>
</section>
`);

const SECURITY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

export const siteRoutes = new Hono<{ Bindings: Bindings }>();

siteRoutes.get('/about', (context) => context.body(ABOUT, 200, SECURITY_HEADERS));
siteRoutes.get('/privacy', (context) => context.body(PRIVACY, 200, SECURITY_HEADERS));
