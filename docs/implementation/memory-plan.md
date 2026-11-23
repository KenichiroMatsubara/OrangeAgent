# Memory 2 実装計画

対象: `docs/implementation/memory.md`（設計）と ADR 0197（proposed）
作成: 2026-11-05

設計書の §11「実装の段階」を、PR 単位の作業・触るファイル・テスト・完了条件・戻し方まで落としたもの。各段階は単独でマージでき、マージした時点の動作を `CONTEXT.md` に書く。

---

## 0. 計画を左右する事実（調査済み）

設計書を書いた後に確認した事実で、計画に直接効くもの。

| 事実 | 出典 | 計画への影響 |
|---|---|---|
| Workers Paid が必要なモデル（DeepSeek V4 系・GLM-5.3 系・Kimi）は Account あたり・モデルあたり **20 req/分**（前払いクレジットで 50）。それ以外の文章生成モデルは **300 req/分** | Workers AI Limits | 抽出（エピソードごとに必ず呼ぶ）は 300 req/分の軽量モデルにする。20 req/分のモデルは保守の派生記憶（低頻度）だけに使う |
| 300 req/分の軽量候補: `@cf/qwen/qwen3.8-27b`（$0.45/$3.20、推論 low〜xhigh、262K）、`@cf/google/gemma-4-26b-a4b-it`（$0.10/$0.30、256K、35言語以上）、`@cf/zai-org/glm-4.7-flash`（$0.06/$0.40、131K、100言語以上）。いずれも Batch 対応 | Workers AI モデルページ・Pricing | 段階0でこの3つと DeepSeek V4.1 Flash を同じ評価セットで比べる。Qwen3.8 はトークン単価が DeepSeek V4.1 Flash より高いので、品質で上回る場合だけ選ぶ |
| Clef / Clef-flash は全選択肢の確率を返す判断専用モデル。入力のみ課金（$0.24 / $0.038）、出力課金なし。モデルページに Paid 必須の表示はない。公式の評価は英語のみ | Clef モデルページ・changelog | 品質ゲート（選別・一次審査・関係判定・再審査・統合）を Clef 系だけで組み、生成 LLM の二次審査をやめる。多段の推論は質問を分けて Worker で組み合わせる |
| Clef は `questions` に最大64問、`choice` は選択肢2〜255、答えは選択肢ごとの確率と `confidence` | Workers AI モデルページ（Clef） | 1候補の審査（具体性・出典・重複・持続性＋近傍5件との関係）を1回の呼び出しに収められる |
| Clairic の text 型の答えは `span`（入力内の位置）付き。`p_null`・`confidence` が返る。日付は `reference_date` で基準日を与える | Workers AI モデルページ（Clairic） | 根拠スパンの照合と時間メタデータに使える。プレビューなので抽出 LLM 側にも同じ欄を残す |
| Workers AI の JSON Mode 対応モデル一覧に DeepSeek V4.1 Flash は載っていない | Workers AI JSON Mode | 構造化出力の方法は段階0で実測して決める（`response_format` が効かなければ JSON 指示＋検証＋再試行） |
| Workflows のインスタンス ID は100文字以内・`^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`。同じ ID で `create` すると例外。ステップの既定は5回の指数バックオフ再試行・10分タイムアウト | Workflows Workers API / Limits | エピソード ID（UUID）をそのままインスタンス ID にでき、二重起動は例外で防げる |
| Workflow を `exports` で宣言するには wrangler 4.139 以上、Vitest で Workflow を検査するには `@cloudflare/vitest-plugin` 1.x が要る。このリポジトリは wrangler `^4.26`、`@cloudflare/vitest-pool-workers` `^0.12` | Workflows changelog / package.json | 段階2では従来の `workflows` バインディングで宣言する。Workflow クラスは薄くし、各ステップの中身を通常の関数として既存の node 側 Vitest で試験する |
| D1 は仮想テーブルを含む DB をエクスポートできない | D1 Import and export | FTS5 は使わない（設計どおり） |
| Vectorize の namespace は1索引あたり 50,000 まで | Vectorize limits | エンティティは別索引（設計どおり） |
| `automation_revisions.tools` を読み返すコードはない | コード調査 | 旧名の読み替えコードは不要。`automation_tools` の行だけ書き換える |
| `storedTools()` は知らない名前のツールを残す | `apps/worker/src/automations.ts:65` | `searchMCPMemory` を書き換えないと、Automation が黙って記憶検索を失う。移行で必ず書き換える |
| MCP サーバー名は `/^[a-z0-9_-]+$/` だけで検査され、`resolveTools` は名前の重複を除かない | `routes/servers.ts:35`, `turns.ts:165` | `memory` という名前のサーバーがあると `memory.search` が衝突する（`mail` などでも同じ）。製品ツールの名前空間を予約する |
| `dispatchDueAccountJobs` は Account ごとの try/catch がなく、1 Account の失敗で残りが止まる | `job-dispatch.ts:73` | 保守ジョブを足す前に直す |
| 新しい移行には、SQL ファイル・`schema-lifecycle.ts` の import とマニフェスト・`schema.test.ts` のファイル一覧の3か所が要る | `schema-lifecycle.ts:115`, `storage/schema.test.ts:53` | 各段階の移行作業に含める |
| `deploy:cloudflare` の手順は `schema.test.ts` と `deployment-contract.test.ts` が文字列で固定している | 同左 | 索引作成スクリプトを2索引に広げるときはテストも直す |

---

## 1. 着手前に決めたこと

2026-11-05 にユーザーが3件とも推奨どおりに決めた。

| # | 決めたこと | 決定 | 効く段階 |
|---|---|---|---|
| D1 | ADR 0197 を受け入れ、mcp-memory 互換をやめるか | 受け入れる。ADR 0197 を accepted、ADR 0195 を superseded にした | 段階1 |
| D2 | Operator Chat のやり取りを自動で取り込むか、既定を有効にするか | 取り込む・既定有効（記憶画面で切替） | 段階2 |
| D3 | 抽出・審査を Workers AI で行い、費用をデプロイ側で持つか | Workers AI で行い、デプロイ側で持つ。抽出は 300 req/分の軽量モデル、判断は Clef 系。有料モデルは保守の派生記憶だけ | 段階2 |

---

## 2. 段階0: 実測と評価セット（製品コードは変えない）

段階1と並行して進め、段階2の着手前に終える。Cloudflare の認証情報が要るので、手元か CI の手動実行で回す。

**作るもの**

- `test/memory-eval/cases/*.json`: 日本語の Operator Chat 形式の会話と期待結果。最初は60件
  - 抽出（残すべき事実・残してはいけない雑談）20件
  - 知識更新（引っ越し・転職・訂正）10件
  - 棄権（記憶にない質問）10件
  - 複数会員（A と B の好みが混ざらない）10件
  - 外部資料（読んだメール中の記述を会員の事実にしない）・資格情報 10件
- `scripts/memory-spike.ts`: 1件の会話を、抽出（候補モデルを引数で選ぶ）・Clairic・Clef に通し、生の応答・所要時間・トークン数を JSON で出す

**確かめること（結果は PR の説明に書く）**

1. 抽出候補（Qwen3.8 27B・Gemma 4 26B A4B・GLM-4.7 Flash・DeepSeek V4.1 Flash）の、評価セットの抽出20件での取りこぼし数・雑談の混入数・1件あたりの費用と時間。Qwen3.8 は推論 `low` と `medium` の両方
2. 各候補で `response_format: json_schema` が効くか。効かなければ JSON 指示＋スキーマ検証＋1回の再試行で何%通るか
3. 根拠の引用文が原文に（正規化後の文字列照合で）見つかる割合
4. `reasoning_effort: low` と `none` で抽出の質と時間がどう違うか
5. 日本語の会話で Clef の choice の確率がどれくらい割れるか（閾値の初期値の根拠）
6. Clairic が「先月」「来週の金曜」を `reference_date` から正しく解決するか、text 型の `span` が日本語でずれないか
7. 1エピソードあたりのモデル呼び出し回数（選別1＋抽出0〜1＋Clairic 0〜1＋一次審査・関係判定）と、Clef / Clef-flash の実際のレート制限
8. 選別（Clef-flash）で落とすやり取りの割合と、それで失う「残すべき事実」の数（閾値 0.05 / 0.1 / 0.2）
9. 知識更新10件での関係判定: 1問で聞く `relation` だけの場合と、分けた質問を組み合わせる場合と、生成 LLM（DeepSeek V4.1 Flash）で判定する場合の正解数
10. `workflows` バインディングを足した Worker が `wrangler versions upload`（プレビュー）で通るか

**完了条件**: 上の10点の答えと、それに基づく抽出モデル・段階2の構造化出力の方式・選別と段階3の閾値の初期値・生成 LLM の再審査が要るかどうかが決まっている。

---

## 3. 段階1: 正本の移し替えと検索（LLM なし）

**実装状況（2026-11-05）**: このブランチで実装した。計画から変えた点:

- 移行 0050 は段階1が使うものだけを作る（`memory_episodes`・`memory_terms`・`memory_changes`、`memories` の列のうち `episode_id` `kind` `speaker` `provenance` `status` `evidence_*` `valid_from` `valid_to` `indexed_at`、`chat_turns.asked_by_*`）。`memory_entities` `memory_entity_links` `memory_links` `memory_judgements` と `subject_identity` `confidence` `event_*` は、それを使う段階の移行で足す。段階0の結果で形が変わりうるのに、移行は一度本番に入ると変えられないため
- `memory.reindex` ジョブは積まない。移行がジョブ行を入れると新しい Account の DB にも入り、ジョブを数える既存の試験が崩れる。代わりに30分の背景処理が Account ごとに `indexed_at IS NULL` の active な記憶を200件まで索引する（`memory/upkeep.ts`）。保存時に Vectorize が失敗した記憶もこれで直る
- ファイルは `memory/store.ts`・`terms.ts`・`search.ts`・`vectors.ts`（Vectorize。`index.ts` だと `./memory` の解決先になるため改名）・`answer.ts`・`upkeep.ts`
- 削除は段階1では完全削除のまま（ソフト削除は段階4）。ただし根拠のエピソード（訂正前のものを含む）の該当箇所を伏せ字にし、変更記録の本文も消し、ハッシュを外して同じ文の再登録で伏せ字のエピソードを再利用しない
- 同じ文の二重登録は、エピソードの `content_hash`（NFKC・小文字・かな・空白除去後の SHA-256）で防ぐ
- 棄権の判定は「融合スコアの閾値」ではなく、各候補が「意味の近さ > 0.5」か「語の重なり ≥ 0.6」を満たすかで決める。RRF は順位だけを見るので、無関係な質問でも最上位のスコアが下がらないため。閾値は段階0・6で較正する
- 記憶画面の詳細はシート（「根拠」ボタン）で出す

**目的**: D1 を正本にし、検索を融合検索＋棄権に替え、ツール名を変える。記憶の中身の作り方（AI が渡した文を1件の記憶にする）はまだ変えない。

**移行 `0050_memory_episodes.sql`**（ADR 0174 に従い、どの行でも失敗しない形）

- 新テーブル: `memory_episodes`, `memory_entities`, `memory_entity_links`, `memory_links`, `memory_terms`, `memory_judgements`, `memory_changes`（設計書 §4.1）
- `memories` に列追加（§4.2）。0043 と同じく既定値と CHECK を付ける
- `chat_turns` に `asked_by_identity`, `asked_by_name`（§4.3）
- 既存の記憶の取り込み（§4.4）: `memories` の各行から `legacy-<id>` のエピソードを `INSERT OR IGNORE` で作り、根拠を全文、`status='active'`、`indexed_at=NULL` に更新し、`memory_changes` に `import` を記録
- `automation_tools`: `UPDATE OR IGNORE automation_tools SET tool='memory.search' WHERE tool='searchMCPMemory'`、続けて残った `searchMCPMemory` 行を削除（同じ Automation に両方あった場合）
- `jobs` に `memory.reindex` を1件 `INSERT OR IGNORE`（冪等キー `memory-reindex:0050`）。`memory_terms` はバイグラム化が要るので SQL では作れず、次の cron でこのジョブが作る
- 移行を足す3か所（SQL・`schema-lifecycle.ts`・`schema.test.ts`）と `account-schema.ts`（drizzle 型）を同じ PR で揃える

**Worker**

- `apps/worker/src/memory.ts` を `apps/worker/src/memory/` に分ける: `store.ts`（D1 の読み書き）、`terms.ts`（正規化とバイグラム）、`search.ts`（融合と棄権）、`index.ts`（Vectorize）、`answer.ts`（AI への返却文）
- Vectorize のメタデータから本文を外し `{ kind }` にする。検索は D1 で引き直し、`status='active'` と `valid_to` を D1 で判定する
- `memory.reindex` のハンドラ: active な記憶の `memory_terms` を作り、索引に上書きし、`indexed_at` を入れる。1回の上限件数を決め、残りがあれば自分を積み直す
- ツール: `packages/domain/src/tools.ts` で `searchMCPMemory` → `memory.search`、`addToMCPMemory` → `memory.add`。`apps/worker/src/tools.ts` の説明文を新しいものに。`memory.add` はこの段階ではエピソードを1件作り、渡された文をそのまま1件の記憶として保存する（Operator Chat も CLI も使える）
- 製品ツールの名前空間（`memory`, `mail`, `calendar`, `drive`, `meet`, `skill`, `web` …）を予約し、`routes/servers.ts` で同名のサーバー登録を拒む。既にある同名サーバーは `resolveTools` で製品ツールを優先し、衝突したツールを `failures` として報告する
- 答えを依頼した会員を記録する。段階2で使うが、データは今から貯める（旧チャットのルート `routes/chat.ts` は ADR 0201 で消え、今は Operator Chat の会話 `conversation.ts` が送った会員を持つ）
- 記憶画面の API: 一覧に `status`・種類・出典を足す。詳細 API（根拠の原文と変更履歴）を足す

**GUI**

- `apps/web/src/screens/memory.tsx`: 検索結果に根拠と出典を出す。棄権したら「確かな記憶はありません」。`searchMCPMemory` の名前を出している説明文を直す
- 記憶の詳細（根拠の原文の該当箇所を強調、変更履歴）
- `labels.ts` のツール名、`mock.ts`、`fixtures.ts`

**テスト**

- `memory.test.ts`: mcp-memory の文言を固定している試験を新しい返却形式に書き換える。融合検索・棄権・D1 での status 判定・本文を持たない索引
- `terms.test.ts`: NFKC、かな、1文字語、英数字、90語ずつの分割
- `schema-lifecycle.test.ts`: 0048 時点の行（3種の `author_kind`、同じ文が複数行）を入れて 0050 を流し、取り込み結果と `automation_tools` の書き換えを確かめる
- `tools.test.ts`（domain）: 呼び出し元ごとのツール（Automation は `memory.search` だけ、Access Token は無し）
- `authorization.test.ts:184`: OAuth の CLI の `tools/list`
- 予約名のサーバー登録拒否、衝突時の優先

**ドキュメント**: `CONTEXT.md` の 27行・210行・241〜243行を書き換える（ADR の状態は D1 の決定時に変えた）。

**完了条件**: 既存の記憶がすべて新しい検索で引け、`memory.reindex` 後に未索引が0件。Automation の Tool Grant が `memory.search` になっている。リハーサルが通る。

**戻し方**: 移行は追加だけなので、コードを戻せば旧ツールで動く（新しい列とテーブルは使われずに残る）。`automation_tools` の書き換えだけは、戻すコードが `memory.search` を知らないと Automation が記憶検索を失うので、戻す場合は逆向きの移行を書く。

---

## 4. 段階2: エピソードと抽出

**目的**: 記憶を AI が渡した文からではなく、エピソードの原文から抽出して作る。

**Cloudflare**

- `wrangler.jsonc` に `workflows` バインディング `MEMORY_INGEST`（class `MemoryIngest`）。`env.local` にも置くか、ローカルでは Workflow を使わず同期実行にするかを段階0の結果で決める
- `apps/worker/src/types.ts` の Bindings に追加（任意のバインディングとし、無ければ取り込みは `received` のまま残る）
- `deployment-contract.test.ts` にバインディングの存在を足す

**Worker**

- `memory/ingest.ts`: Workflow クラス。各ステップは下の関数を `step.do` で呼ぶだけ。モデルを呼ぶステップは再試行を `limit: 10, delay: '30 seconds', backoff: 'exponential'` にし、429 を吸収する
- `memory/episode.ts`: 保存（資格情報の伏せ字、`content_hash` での重複排除）、自明な発話の除外規則と Clef-flash による選別（確率をエピソードに残す）
- `memory/extract.ts`: 抽出プロンプト（固定、版番号付き）と出力の検証。会員の「私」を `subject_identity` に解決
- `memory/evidence.ts`: 根拠スパンの照合（位置の実在、埋め込み類似度の下限、資格情報の検出）
- `memory/time.ts`: Clairic の呼び出し（`reference_date` = 受信日の Asia/Tokyo）。失敗時は抽出結果の時間欄を使う
- `memory/commit.ts`: `batch()` での一括コミット
- 入口:
  - Operator Chat の答えが完了したところ（`conversation.ts`。旧チャットの `chat-exchange.ts` は ADR 0201 で消えた）で、設定が有効ならエピソードを作り Workflow を起動する
  - `memory.add`（CLI）はエピソードを作って受付 ID を返す
  - 記憶画面の追加も同じ入口
- Operator Chat から `memory.add` を外す（`OPERATOR_CHAT_RUN` と `OPERATOR_TOKEN_RUN` を分ける）
- 設定: `settings` テーブルのキー `memory.learn_from_chat`（無ければ有効）。記憶画面の「設定」で切り替える
- 1 Account・1日あたりのエピソード上限。超えたら `skipped`（理由付き）
- 取り残しの再起動: 30分 cron で、`received` / `extracting` のまま15分を過ぎたエピソードの Workflow を作り直す（同じ ID なので二重にはならない）。5回で `failed`

この段階の審査は決定的な照合（根拠スパン）だけで、根拠が合えば `active`、合わなければ `rejected` にする。Clef は段階3で入る。

**GUI**: 記憶画面に「設定」（会話から覚える）、エピソードの処理状況（受付・処理中・失敗）、棄却の一覧（理由付き）。

**テスト**（モデルは既存の `vi.stubGlobal('fetch')` と `test/memory.ts` の偽 AI・偽 Vectorize に倣った偽物で返す）

- 根拠照合: 存在しないスパン、ずれたスパン、全角半角の違い、資格情報
- 抽出結果の検証: 壊れた JSON、欠けた欄、スパンが原文外
- 自明な発話の除外と、選別の確率が閾値未満のやり取りが `skipped` になること
- 会員の解決: `asked_by` あり・なし
- コミットが途中で失敗したとき D1 に何も残らない
- 取り残しの再起動と5回での `failed`
- 設定が無効のとき、Operator Chat のやり取りがエピソードにならない
- Workflow クラス自体は、各ステップ関数を順に呼ぶことだけを1本の試験で確かめる（`introspectWorkflow` は vitest-plugin 1.x への更新後に足す）

**ドキュメント**: `CONTEXT.md` の Memory を「エピソードから抽出」に書き換える。

**完了条件**: 評価セットの抽出20件で、残すべき事実の取りこぼしと雑談の混入を数え、現行（段階1）より少ない。20 req/分の枠の中で、評価セットを流しても `failed` が出ない。

**戻し方**: 記憶画面の設定を無効にすればチャットからの取り込みは止まる。Workflow の不具合なら、エピソードは `received` のまま D1 に残るので、直した後に取り残しの再起動で処理される。

---

## 5. 段階3: 審査（Clef 系だけで判断する）

**Worker**

- `memory/judge.ts`: 設計書 §5.4 のとおり、候補ごとに Clef-flash で一次審査（`specificity` / `source` / `duplicate` / `durability`）を1回、Clef で関係判定を1回（近傍5件 × 5問 = 25問、上限64問の内）呼ぶ
- `memory/relation.ts`: 分けた質問（同じ対象・同じ属性・同時に成り立つか・変化を述べているか）と出来事の時刻から、置き換え / 矛盾 / 両立 / 無関係を決める純粋関数。`relation_<n>` との食い違いを返す
- 全質問の確率を `memory_judgements` に保存する
- エスカレーション: 一次審査で差が閾値未満の質問は Clef で聞き直す。関係判定の食い違い・閾値付近・置き換えの確信度不足は `candidate` にして確認待ちへ。生成 LLM は呼ばない
- 判定結果の適用（設計書 §5.4 の表）: 置き換えは旧を `superseded` にして `supersedes` リンクを張り、索引から消す
- `provenance=5`（外部資料）は会員の事実に昇格させない

**GUI**: 記憶画面に「確認待ち」（並べて比較し、採用・棄却・どちらが新しいかを選ぶ）。記憶の詳細に判定と確率を出す。

**テスト**: `relation.ts` は真理値表どおりの全組み合わせ。Clef の応答の偽物で、各判定の分岐、Clef-flash から Clef への聞き直し、食い違いと確信度不足で `candidate` になること、置き換えの連鎖（A→B→C）、外部資料が昇格しないこと。

**完了条件**: 評価セットの知識更新10件で、旧事実を返すのが0件。ゴミ率（評価セットで残してはいけないもの）が5%未満。

---

## 6. 段階4: 訂正・忘却・説明・完全削除

- ツール: `memory.correct`、`memory.forget`、`memory.explain`（Operator Chat と CLI のみ。domain の `tools.ts` で `write` / `read` として宣言し、`automation.ts` の `AUTOMATION_WRITES` の Exclude に足す）
- `memory.correct` は訂正発言を根拠にした新しい記憶を作り、旧を `superseded` にする
- `memory.forget` は `forgotten` にして索引から消す
- 完全削除（記憶画面のみ）: 行・リンク・語・判定を消し、Vectorize から消し、エピソード上の根拠スパンを伏せ字にする。`memory_changes` には本文を残さない
- 「棄却・忘却」から戻す操作

**テスト**: 完全削除の後に同じエピソードを再抽出しても事実が戻らないこと。忘れた記憶が検索に出ないこと。Automation がこれらのツールを持たないこと。

---

## 7. 段階5: 保守・健全性・エンティティ検索

- ~~先に `dispatchDueAccountJobs` に Account ごとの try/catch を入れる~~（実装済み）
- Account Job `memory.maintenance`: `runDueAutomations` の Account ごとのループで、翌 3:00（Asia/Tokyo）を `availableAt` に冪等キー `memory-maintenance:<日付>` で積む。処理は設計書 §7（整合性検査・統合・失効・自己診断）。1回の件数に上限を設ける
- エンティティ検索:
  - `scripts/memory-index.ts` を2索引（`flarechat-memory`, `flarechat-memory-entities`）に対応させ、`deploy:cloudflare` の手順と、それを固定している2つのテストを直す
  - `wrangler.jsonc` に `MEMORY_ENTITY_INDEX`
  - プレビュービルドより先に索引を作る（`CONTEXT.md` 27行末の注意と同じ）
- 記憶画面に「健全性」とエクスポート
- 再ランク（Clef-flash）は既定で無効のまま、評価で効けば有効にする

---

## 8. 段階6: 評価とモデル確定

- `npm run eval:memory`: 評価セットを本番と同じパイプラインに通し、ゴミ率・抽出漏れ率・知識更新・棄権・複数会員・外部資料の各指標と、1エピソードあたりの呼び出し回数・トークン・所要時間を出す
- 比較対象: 段階1の状態（AI が渡した文をそのまま保存）、抽出モデルの候補（V4.1 Flash / V4 Pro / GLM-5.3 Flash / Kimi K2.6）、埋め込み（bge-m3 / PLaMo）
- 結果で `memory/models.ts` の既定と閾値を決め、`CONTEXT.md` に書く

---

## 9. 段階の依存関係

```
段階0（実測・評価セット） ─┐
段階1（正本・検索） ───────┼─→ 段階2（抽出） → 段階3（審査） → 段階4（訂正・削除）
                           │                                    ↘
                           └──────────────────────────────────→ 段階5（保守・エンティティ） → 段階6（確定）
```

- 段階1は D1 の判断だけで着手できる
- 段階2は D2・D3 と段階0の結果が要る
- 段階5の try/catch 修正は実装済み
