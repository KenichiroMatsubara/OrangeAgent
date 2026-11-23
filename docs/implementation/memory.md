# Memory 2: 根拠から抽出し、審査してから覚える

ステータス: 提案（ADR 0197）／作成: 2026-11-05
元資料: 「cf-memory（仮称）設計書」2026-11-05 ドラフト

この文書は、cf-memory 設計書を FlareChat の Memory に適用するための設計である。cf-memory は単独の MCP サーバーとして書かれているが、FlareChat にはすでに Account ごとの Memory（ADR 0195、mcp-memory 互換）、Account ごとの D1、記憶画面、Operator Chat、Operator Token による CLI 接続、OAuth（ADR 0196）がある。ここでは cf-memory の原則と品質ゲートをそのまま採り、保存先・非同期処理・保守・ツールの形を FlareChat の既存の仕組みに合わせて置き換える。

現在の動作は `CONTEXT.md` が正であり、この文書は実装予定を示す。各段階を実装するプルリクエストが `CONTEXT.md` の Memory の記述を同時に書き換える。

---

## 1. 何が変わるか

| | 現在（ADR 0195） | Memory 2 |
|---|---|---|
| 何を覚えるか | AI が `addToMCPMemory` に渡した文をそのまま | 会話の原文（エピソード）から抽出した事実のうち、根拠照合と審査を通ったもの |
| 誰が覚える内容を決めるか | AI（「毎回のメッセージの後に使え」という説明文） | 抽出パイプライン。Operator Chat では完了した各やり取りが自動でエピソードになる |
| 重複・矛盾 | 同じ文が何度でも入る。古い事実と新しい事実が並ぶ | 重複は統合、置き換えは旧を `superseded` にして履歴を残す |
| 正本 | Vectorize が先、D1 が後（Vectorize に本文） | Account D1 が正本。Vectorize は D1 から作り直せる索引 |
| 検索 | 意味検索のみ、上位10件、0.5 超 | 意味・キーワード（バイグラム）・エンティティの融合、棄権あり、出典・信頼度・履歴付き |
| 失敗の扱い | 失敗は文字列で返るだけ | 棄却理由・判定確率・全変更を記録し、記憶画面で見て直せる |
| 削除 | 行と索引を物理削除 | 既定はソフト削除。完全削除は確認必須で、根拠の原文も伏せ字にする |

変わらないこと（ADR 0195 から引き継ぐ）:

- Memory は Account に1つ。Account の会員が共有する。
- 記憶を増やせるのは人がその場にいる実行だけ（Operator Chat、Operator Token の CLI、記憶画面の会員）。
- Automation は読むだけ（Tool Grant に `memory.search` があるとき）。Planned Write としても書かない。
- Access Token はどちらも使えない。
- Run Transcript（Automation の実行記録）は記憶の材料にしない（ADR 0150）。

---

## 2. 原則（cf-memory から採用）

| # | 原則 | FlareChat での具体化 |
|---|---|---|
| P1 | 正本は1つ、索引は派生物 | Account D1 が正本。Vectorize は `indexed_at IS NULL` を走査して再投入でき、全量再構築も D1 から行える |
| P2 | 生データから抽出し、記憶から再抽出しない | Operator Chat のやり取り・CLI が渡した会話・会員の入力をエピソードとして不変保存し、抽出は常にエピソードから |
| P3 | 根拠のない事実は保存しない | 全候補に原文の根拠スパンを必須とし、Worker で機械照合 |
| P4 | 消さずに置き換える | 矛盾時は旧事実に `valid_to` と `supersedes` リンク |
| P5 | 黙って捨てない・黙って壊れない | 棄却も `rejected` として理由付きで残す。判定確率と全変更を記録 |
| P6 | 分からないときは分からないと言う | 閾値未満なら「確かな記憶はありません」を返す |
| P7 | 判断は判断専用モデル、決まらない判断は人 | Clef-flash 一次審査 → Clef 再審査 → 記憶画面の「確認待ち」。品質ゲートに生成 LLM を使わない |
| P8 | 破壊的操作は回復経路を確保してから | ソフト削除が既定。D1 Time Travel で時点復旧できる |

---

## 3. cf-memory からの置き換え

cf-memory 設計書の構成要素を、FlareChat では次のように置き換える。理由は各行の右端。

| cf-memory | FlareChat | 理由 |
|---|---|---|
| ユーザー別 Durable Object の SQLite が正本 | **Account D1 が正本** | Account ごとに D1 が1つあり、物理分離はすでに成り立つ。D1 Time Travel が PITR を、`batch()` がトランザクションを与える。記憶はチャット（`chat_turns`）と外部キーで結ばれ、記憶画面も D1 を読む。DO に置くと、移行リハーサル（ADR 0174）と本番エクスポートの外に第二の正本ができる |
| FTS5 仮想テーブル（バイグラム） | **通常テーブル `memory_terms` によるバイグラム転置索引** | 移行リハーサルは本番 D1 を `wrangler d1 export` で書き出して再生する。D1 は仮想テーブル（FTS5 を含む）を持つ DB のエクスポートに対応しておらず（公式ドキュメントの Import and export data に明記。`--table` で絞っても回避できないという報告もある）、1つの Account に入れただけで全 PR がマージ不能になる。通常テーブルなら制約がない |
| Workflows（書き込みパイプライン） | **Workflows を採用**。ただしエピソード行の `state` を正とし、既存の30分 cron が取り残しを再起動する | 既存の Account Job（`jobs` テーブル）は30分 cron で回るため、書き込みから検索可能までが最大30分になる。Workflows は即時に始まり、ステップ単位で再試行する |
| DO Alarm による夜間保守 | **Account Job `memory.maintenance`** を毎日 3:00（Asia/Tokyo）に積み、既存の cron が実行 | 既存の背景処理の入口（`runBackgroundWork`）に揃える。保守は遅れても害がない |
| `memories` / `entities` の2索引 | **2索引**。記憶は既存の `flarechat-memory`、エンティティは新しい `flarechat-memory-entities`。どちらも namespace は `<accountId>` | Vectorize の namespace は1索引あたり 50,000 まで（Workers Paid）。1索引の中で Account ごとに2つ使うと、収容できる Account 数が半分になる。`deploy:cloudflare` が既存索引と同じ手順（1024次元・cosine、なければ作る、設定が違えば止める）で2つめも作る |
| 埋め込み PLaMo-Embedding-1B | **当面 `@cf/baai/bge-m3` のまま**。PLaMo（`@cf/pfnet/plamo-embedding-1b`）は §12 の評価で比較 | bge-m3 は多言語で日本語も扱え、既存索引（1024次元）がそのまま使える。切り替えるときは新索引を作り D1 から再構築する |
| 生成 LLM は利用者が選ぶ | **Workers AI のモデル**（Account の AI Connection ではない） | 記憶の品質ゲートは製品の基盤であり、Account ごとに違うモデルで判定が変わると較正が成り立たない。埋め込みですでに Workers AI に依存している |
| userId 単位の記憶 | **Account 単位の記憶 + 発話した会員（subject）** | Memory は会員が共有する。「私は和食が好き」が誰の好みかを残さないと、別の会員の好みとして返る |
| MCP ツール8種 | **AI のツール5種 + 記憶画面**（§8） | レビュー・健全性・エクスポートは人が画面で行う操作であり、AI に渡す必要がない |
| OAuth 認証 | **既存の OAuth（ADR 0196）と Operator Token（ADR 0193）** | 追加の認証は不要 |

---

## 4. データモデル（Account D1）

移行は1本（`0050_memory_episodes.sql` 想定）。時刻はこのリポジトリの慣例どおり ISO 8601 の text。

### 4.1 新しいテーブル

```sql
-- 生入力（不変）。抽出は常にここから行う。
CREATE TABLE memory_episodes (
  id               text PRIMARY KEY NOT NULL,
  source           text NOT NULL,          -- chat | cli | person | legacy
  member_identity  text,                   -- 発話した会員の Control Identity（不明なら NULL）
  member_name      text DEFAULT '' NOT NULL,
  conversation_id  text REFERENCES chat_conversations(id) ON DELETE SET NULL,
  turn_id          text REFERENCES chat_turns(id) ON DELETE SET NULL,
  content          text NOT NULL,          -- 資格情報を伏せ字にした原文。発話者ラベル付き
  content_hash     text NOT NULL UNIQUE,   -- 完全重複の排除
  state            text NOT NULL,          -- received | extracting | committed | skipped | failed
  extractor_version text,
  attempts         integer DEFAULT 0 NOT NULL,
  last_error       text,
  received_at      text NOT NULL,
  processed_at     text,
  CHECK (source IN ('chat','cli','person','legacy')),
  CHECK (state IN ('received','extracting','committed','skipped','failed'))
);
CREATE INDEX memory_episodes_state_idx ON memory_episodes(state, received_at);

CREATE TABLE memory_entities (
  id        text PRIMARY KEY NOT NULL,
  name      text NOT NULL,
  norm_name text NOT NULL UNIQUE,          -- NFKC・かな正規化後
  type      text,                          -- person | place | org | product | concept ...
  indexed_at text
);
CREATE TABLE memory_entity_links (
  memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id text NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

-- 記憶間の関係
CREATE TABLE memory_links (
  src_id     text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  dst_id     text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  rel        text NOT NULL,                -- supersedes | contradicts | duplicate_of | derived_from
  created_at text NOT NULL,
  PRIMARY KEY (src_id, dst_id, rel),
  CHECK (rel IN ('supersedes','contradicts','duplicate_of','derived_from'))
);

-- キーワード検索用のバイグラム転置索引（FTS5 の代わり）
CREATE TABLE memory_terms (
  term      text NOT NULL,                 -- 正規化後の文字バイグラム。英数字は単語
  memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  count     integer NOT NULL,
  PRIMARY KEY (term, memory_id)
);
CREATE INDEX memory_terms_memory_idx ON memory_terms(memory_id);

-- 品質ゲートの判定記録
CREATE TABLE memory_judgements (
  id          text PRIMARY KEY NOT NULL,
  memory_id   text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  question    text NOT NULL,               -- evidence | specificity | source | duplicate | relation | durability
  model       text NOT NULL,
  probs_json  text NOT NULL,               -- 全選択肢の確率
  escalated   integer NOT NULL,
  verdict     text NOT NULL,
  reason      text,
  decided_at  text NOT NULL
);
CREATE INDEX memory_judgements_memory_idx ON memory_judgements(memory_id);

-- 監査ログ（全変更）
CREATE TABLE memory_changes (
  id         integer PRIMARY KEY AUTOINCREMENT,
  at         text NOT NULL,
  actor_kind text NOT NULL,                -- pipeline | member | chat | cli | maintenance
  actor_name text DEFAULT '' NOT NULL,
  action     text NOT NULL,                -- add | reject | supersede | correct | forget | erase | restore | merge | expire | approve | import
  memory_id  text,                         -- 完全削除後も残すため外部キーにしない
  detail     text                          -- JSON
);
CREATE INDEX memory_changes_memory_idx ON memory_changes(memory_id, at);
```

### 4.2 既存テーブル `memories` への列追加

既存の列（`content`, `author_kind`, `author_name`, `conversation_id`, `turn_id`, `edited_by`, `created_at`, `updated_at`）は残す。`content` が記憶の本文、`author_*` は「誰が記録させたか」として引き続き画面に出す。`ALTER TABLE ... ADD COLUMN` で以下を足す（0043 と同じく既定値と CHECK を付ける）。

| 列 | 型 | 既定 | 意味 |
|---|---|---|---|
| `episode_id` | text | NULL | 根拠のエピソード |
| `kind` | text | `'fact'` | fact / preference / event / instruction / task / derived |
| `speaker` | text | `'agent'` | user / agent / tool |
| `subject_identity` | text | NULL | 誰についての記憶か（会員）。Account 全体なら NULL |
| `provenance` | integer | 3 | 1 会員の発言 / 2 エージェントの実行確認 / 3 エージェントの提案 / 4 推論 / 5 外部資料 |
| `status` | text | `'active'` | candidate / active / superseded / rejected / forgotten |
| `confidence` | real | NULL | ゲート判定由来 |
| `evidence_start`, `evidence_end` | integer | NULL | エピソード内の根拠スパン（UTF-16 オフセット） |
| `event_time`, `event_precision`, `event_state` | text | NULL | 出来事の時刻・精度・状態 |
| `valid_from` | text | `''`（移行で `created_at` を入れる） | 有効開始 |
| `valid_to` | text | NULL | 置き換え・失効で設定 |
| `indexed_at` | text | NULL | Vectorize 反映時刻 |

索引: `(status, valid_to)`、`(indexed_at) WHERE indexed_at IS NULL`、`(episode_id)`。

### 4.3 `chat_turns` への列追加

今は、やり取りにも Run にも、送った会員が残っていない（`chat_turns`, `runs`, `ChatExchangeRequest` のどれにもない）。「私は〜」が誰のことかを決めるため、`chat_turns` に `asked_by_identity`（text, NULL 可）と `asked_by_name`（text, 既定 `''`）を足し、チャットのルートがセッションの会員を入れる。既存の行は NULL のままで、そのやり取りから作るエピソードは発話者不明（`member_identity = NULL`）として扱う。

### 4.4 既存の記憶の移し替え（ADR 0174）

本番にはすでに `memories` の行がある。`0048_memories.sql` 以後に書いたのは `saveMemory` と記憶画面の更新だけで、`content` は NOT NULL、`author_kind` は CHECK で3値に限られている。移行は次のとおり、どの行でも失敗しない形にする。

1. 各行から `memory_episodes` を1件作る: `id = 'legacy-' || memories.id`、`source = 'legacy'`、`content = memories.content`、`content_hash = 'legacy:' || memories.id`（同じ文が複数行あっても UNIQUE に衝突しない）、`state = 'committed'`、`received_at = coalesce(created_at, '')`。`INSERT OR IGNORE` を使う。
2. 各行を更新: `episode_id`、`evidence_start = 0`、`evidence_end = length(content)`、`speaker = CASE author_kind WHEN 'person' THEN 'user' ELSE 'agent' END`、`provenance = CASE author_kind WHEN 'person' THEN 1 ELSE 3 END`、`status = 'active'`、`valid_from = coalesce(created_at, '')`、`indexed_at = NULL`（新しいメタデータで再投入させる）。
3. `memory_changes` に `action = 'import'` を1行ずつ記録。
4. `memory_terms` はコード側で作る（SQL ではバイグラム化できない）。保守の整合性検査が `memory_terms` を持たない active 記憶を見つけて作る。

既存のベクトルは ID が記憶 ID と同じなので、そのまま使える。`indexed_at = NULL` の行は保守が新しいメタデータ（本文を持たない）で上書きする。重複している既存記憶は、初回の保守の「統合」で `duplicate_of` にまとまる。

`automation_tools` の `searchMCPMemory` は `UPDATE OR IGNORE ... SET tool = 'memory.search'` で書き換え、残った行を消す。`automation_revisions.tools` は不変の記録なので書き換えない（読み返すコードはないので読み替えも要らない）。

### 4.5 Vectorize

| 索引 / namespace | ID | メタデータ | 中身 |
|---|---|---|---|
| `flarechat-memory` / `<accountId>` | memory id | `{ kind }` | `status = 'active'` の記憶だけ |
| `flarechat-memory-entities` / `<accountId>` | entity id | `{ type }` | エンティティ名 |

本文はメタデータに持たない（P1）。検索でヒットした ID は必ず D1 で引き直し、`status` と `valid_to` を D1 で判定する。`superseded`・`forgotten`・`rejected` になった記憶は索引から消す（失敗しても `indexed_at` を NULL に戻し、保守が再試行する）。

### 4.6 日本語の正規化

- NFKC、全角半角の統一、カタカナ→ひらがなの揺れ吸収、英字は小文字化
- キーワード索引は文字バイグラム（「東京に引っ越し」→「東京 京に に引 引っ っ越 越し」）。英数字の連続は単語として1語
- 1文字の語（「猫」）はバイグラムを作れないので、単独文字も1語として索引する
- クエリも同じ処理を通す。D1 は1文に100値までしか束縛できないので、語は90個ずつに分けて引く

---

## 5. 書き込みパイプライン

### 5.1 エピソードの入口

| 入口 | エピソードの中身 | いつ |
|---|---|---|
| Operator Chat | 完了した1つのやり取り（会員のメッセージと答えの文。ADR 0201 以降は Operator Chat の会話のイベント `chat_events` にあり、旧チャットの `chat_turns` は読まない）。「会員: …」「AI: …」と発話者ラベルを付け、直前のやり取り1件を文脈として添える（文脈部分からは抽出しない） | やり取りが `completed` になった直後。Account の「会話から覚える」が有効なときだけ |
| CLI（Operator Token） | `memory.add` に渡された会話チャンク | ツール呼び出し時 |
| 記憶画面 | 会員が入力した文 | 追加ボタン |

Operator Chat では AI に記憶させるツールを渡さない。会員が「覚えておいて」と言えば、その発言自体がエピソードに入り、抽出が `instruction` として拾う。これにより、AI が要約した文（幻覚を含みうる）ではなく会員の実際の発言が根拠になる（P2, P3）。

「会話から覚える」は記憶画面で切り替える Account の設定で、既定は有効。無効のとき、Operator Chat のやり取りはエピソードにならない（CLI の `memory.add` と画面からの追加は有効のまま）。

### 5.2 ステップ

`MemoryIngest` Workflow（インスタンス ID = エピソード ID）が行う。各ステップは個別に再試行される。

| Step | 処理 | 担当 |
|---|---|---|
| 1 | 資格情報らしき文字列を伏せ字にしてエピソードを保存。`content_hash` が既存なら `skipped` で終了 | Worker / D1 |
| 2 | 選別: 自明な発話（挨拶だけ、短い相づち、ツール出力だけ）を規則で除き、残りは「後で役立つ事実・好み・予定・指示を含むか」を Clef-flash に聞く。確率が低い（初期値 0.1 未満）ものは `skipped`（確率をエピソードに残す） | Worker（決定的）/ Clef-flash |
| 3 | 事実候補の抽出: 本文・種類・発話者・対象会員・エンティティ・根拠の引用文を JSON で | 生成 LLM（軽量） |
| 4 | 時間メタデータの型付き抽出（`event_time` / precision / state）。`reference_date` にエピソードの受信日（Asia/Tokyo）を渡す | Clairic |
| 5 | 根拠照合: 引用文を正規化して原文の中で探し、根拠スパン（位置）を Worker が求める。見つからなければ棄却。候補と根拠の埋め込み類似度が下限以上か、資格情報を含まないか。不合格は `rejected` | Worker（決定的） |
| 6 | 近傍取得: 候補ごとに既存の active 記憶を意味・キーワードで最大5件 | Vectorize / D1 |
| 7 | 一次審査（§5.4） | Clef-flash |
| 8 | 関係判定と再審査: 近傍との関係（常に）と、一次審査で拮抗した質問 | Clef |
| 9 | D1 の `batch()` で一括コミット: 記憶・リンク・エンティティ・`memory_terms`・判定記録・変更記録・旧記憶の `superseded` 化・エピソードの `committed` 化・`memory_uses`（Operator Chat なら `saved`） | D1 |
| 10 | 埋め込みを作り Vectorize に upsert、旧記憶を索引から削除、`indexed_at` 更新 | Workers AI / Vectorize |

Step 9 までは D1 にしか書かない。Step 10 が失敗しても記憶は D1 にあり、検索は §6 の「未索引分」で拾える。

取り残し対策: 30分 cron が `state IN ('received','extracting')` かつ受信から15分以上の経過したエピソードについて Workflow を作り直す（インスタンス ID が同じなので二重には走らない）。5回失敗したら `failed` にして記憶画面に出す。

### 5.3 抽出（Step 3）

- ADD-only。既存記憶の書き換えは抽出では行わず、Step 7〜9 の関係判定だけが行う
- 会員の発言だけでなく、AI の「予約しました」「送信しました」などの実行確認も対象（provenance 2）。AI の提案（「〜はいかがでしょう」）は provenance 3 で、会員が同意した場合だけ採る
- 「私」「自分」は発話した会員に解決し `subject_identity` に入れる。Account 全体のこと（「うちの会社は」）は NULL
- 対象外: 雑談・挨拶・作業途中の一時的な状態・資格情報（パスワード、API キー、口座番号、ワンタイムコード）
- ツールが読んだメールや文書の内容は provenance 5。会員の事実には昇格させない（記憶汚染対策）。その中の指示は実行も記憶もしない
- システムプロンプトは固定し、プロンプトキャッシュが効く形にする。版を `extractor_version` に記録する

### 5.4 品質ゲート

品質ゲートは判断だけで、文章を生成しない。判断は Clef 系（選択肢ごとの確率を返す判断専用モデル）に任せ、生成 LLM は使わない。全質問の全選択肢の確率を `memory_judgements` に残す。

**一次審査（Clef-flash）** — 候補ごとに1回の呼び出しで聞く。

| キー | type | 選択肢 |
|---|---|---|
| `specificity` | choice | 具体的 / 曖昧 / 無意味 |
| `source` | choice | 会員本人 / エージェント実行確認 / エージェント提案 / 外部資料 |
| `duplicate` | choice | 近傍の記憶 ID のいずれか / 重複なし |
| `durability` | choice | 恒常的 / 一時的 |

**関係判定（Clef）** — 近傍の既存記憶ごとに、関係を1問で聞かずに分けて聞く。Clef は1回の読み取りで確率を返すモデルなので、「暗黙の矛盾」のように何段かの推論が要る判断は、推論の各段を質問に分け、組み合わせを Worker が決める。state には新旧両方の本文・根拠の引用文・記録日時・出来事の時刻・発話した会員・対象の会員を入れる。

| キー | type | 中身 |
|---|---|---|
| `same_subject_<n>` | noul | 同じ人・物・組織についての記述か |
| `same_attribute_<n>` | noul | 同じ属性（住所、勤務先、好み、予定の日時など）についての記述か |
| `both_true_<n>` | noul | 両方が同時に真でありうるか |
| `states_change_<n>` | noul | 新しい方が変化・訂正・取り消しを述べているか（「引っ越した」「やめた」「間違いだった」） |
| `relation_<n>` | choice | 両立 / 置き換え / 矛盾 / 無関係（照合用） |

Worker の組み合わせ:

- 置き換え: 同じ対象 ∧ 同じ属性 ∧ 同時には成り立たない ∧（新しい方が変化を述べている ∨ 出来事の時刻が新しい方が後）
- 矛盾: 同じ対象 ∧ 同じ属性 ∧ 同時には成り立たない ∧ どちらが新しいか決まらない
- 両立: それ以外で同じ対象
- 無関係: 同じ対象でない

**エスカレーション**

- 一次審査の質問で、最大確率と次点の差が閾値未満のものは、同じ質問を Clef でもう一度聞く
- 関係判定で、分けた質問の組み合わせと `relation_<n>` が食い違う、または使った質問のどれかが閾値付近なら、決めずに「確認待ち」へ
- 置き換えは記憶を壊しうるので、採用より高い確信度（初期値: 使った各質問の確率 0.9 以上）を求め、満たさなければ「確認待ち」へ
- 閾値は質問ごとに §12 の検証セットで較正する。初期値は差 0.2（仮置き）
- 生成 LLM の再審査は既定では使わない。§12 の知識更新シナリオで、Clef だけでは見逃す矛盾が測れた場合に限り、関係判定の「確認待ち」の手前に足す

**結果**

| 判定 | 扱い |
|---|---|
| 採用 | `status = 'active'` |
| 置き換え | 新を active、旧に `valid_to` と `supersedes` リンク、旧は `superseded` |
| 矛盾（どちらが正しいか決まらない） | 新を `candidate` にし、`contradicts` リンクを張って記憶画面の「確認待ち」へ |
| 重複 | 保存せず、既存記憶との `duplicate_of` を判定記録に残す（記憶は増やさない） |
| Clef の再審査でも拮抗、関係判定の食い違い、置き換えの確信度不足 | `candidate` として「確認待ち」へ |
| 棄却 | `status = 'rejected'` として理由付きで保存（索引には入れない） |
| 一時的 | active にし、Clairic で推定した失効日を保守が `valid_to` に設定 |

---

## 6. 検索

```
query
 ├─ 正規化（NFKC・かな）／時間表現の解析（「先月」「去年の夏」→ 期間。Asia/Tokyo 基準）
 ├─ 並列取得（各最大50件）
 │   ├─ 意味: Vectorize flarechat-memory namespace=<accountId>
 │   ├─ キーワード: memory_terms（一致したバイグラムの IDF 重み付き合計）
 │   ├─ エンティティ: Vectorize flarechat-memory-entities namespace=<accountId> → memory_entity_links で展開
 │   └─ 未索引分: D1 で indexed_at IS NULL かつ active の直近記憶をキーワードで評価
 ├─ D1 で引き直してフィルタ: status='active' かつ（現在有効 or 指定期間に該当）
 ├─ 融合: RRF（k=60 から）× 時間減衰（event の種類のみ）
 ├─ 再ランク（実験的・既定無効）: Clef-flash で関連度判定
 └─ 棄権: 最上位の融合スコアが閾値未満なら「確かな記憶はありません」
```

### 6.1 AI への返却形式

`memory.search` は、AI が読む前提の短いテキストを返す。

```
確かな記憶: 3件
1. [m_8f2…] 山田さんは2026年10月に前の家から新居へ引っ越した（出来事 2026-10・完了）
   出典: 山田さんの発言 / 2026-10-12 Operator Chat / 信頼度 0.93
   以前: 「山田さんは前の家に住んでいる」（2026-10-12 に置き換え）
2. …
```

- 各記憶に本文、種類、記録日時、出来事の時刻と精度、出典（発話者・provenance・会話）、信頼度、置き換え履歴を付ける
- `maxTokens`（既定 1500）を超える分は下位から切り詰め、切り詰めたことを末尾に書く
- 時刻はすべて Asia/Tokyo
- Operator Chat の検索は `memory_uses` に `recalled` として記録し、回答の下に記憶へのリンクを出す（ADR 0201 の Operator Chat は、まだ記録もリンクもしない）

---

## 7. 保守（Account Job `memory.maintenance`）

30分 cron の中で、Account ごとに毎日 3:00（Asia/Tokyo）を `availableAt` とする Job を1つ積む（冪等キー `memory-maintenance:<日付>`）。全処理を `memory_changes` に `actor_kind = 'maintenance'` で記録し、可逆な形で行う。1回の実行で扱う件数に上限を設け、残りは翌日に回す。

| 処理 | 内容 |
|---|---|
| 整合性検査 | `indexed_at IS NULL` の再投入、active なのに索引にない・索引にあるのに active でない ID の突き合わせ、`memory_terms` の欠けの補充 |
| 統合 | 意味的に重複した active 記憶を Clef で判定して統合。どちらを残すかも Clef の choice で選び、新しい文は作らない（敗者は `superseded` + `duplicate_of`） |
| 失効 | 一時的な記憶に推定失効日で `valid_to` を設定 |
| 派生記憶（後回し） | 繰り返しパターンから傾向を生成（`derived_from` リンク必須、provenance 4）。文章を作るので生成 LLM を使う唯一の保守処理 |
| 自己診断 | 固定の合成エピソード（例: 「好きな色は群青」）を**保存せずに**抽出・照合・審査に通し、期待する事実が出るかを見る。さらに直近の active 記憶を数件選び、その本文で検索して上位に返るかを見る（サイレント失敗の検出）。Account の記憶は汚さない |
| 再抽出（任意） | 抽出の版を上げたとき、エピソードから再抽出した差分を「確認待ち」に積む |

---

## 8. ツールと権限

### 8.1 AI のツール

`addToMCPMemory` と `searchMCPMemory` は廃止する。既存の命名（`mail.search`, `skill.read`）に揃える。

| ツール | 説明 | Operator Chat | CLI | Automation | Access Token |
|---|---|---|---|---|---|
| `memory.search` | 検索。棄権あり、出典・信頼度・履歴付き | ○ | ○ | Tool Grant で許可時 | × |
| `memory.add` | 会話チャンクを渡してエピソードにする。受付 ID を返す | ×（自動で入るため） | ○ | × | × |
| `memory.correct` | 指定記憶を訂正。新記憶を作り旧を置き換える（根拠は会員の訂正発言） | ○ | ○ | × | × |
| `memory.forget` | ソフト削除（`forgotten`、索引から除外） | ○ | ○ | × | × |
| `memory.explain` | なぜそう覚えているか: 根拠の原文、判定確率、置き換え履歴 | ○ | ○ | × | × |

完全削除は AI のツールにしない。記憶画面で会員が確認してから行う。

### 8.2 記憶画面

設定と操作は記憶画面1つにまとめる（「ある設定は1つの画面で行う」）。読み込みはすぐ返し、各区画がデータの到着順に埋まる。

| 区画 | 内容 |
|---|---|
| 記憶 | active な記憶の一覧と検索（AI と同じ検索、各ヒットの根拠付き）。追加・訂正・忘れる |
| 確認待ち | `candidate`（矛盾・拮抗・再抽出の差分）。並べて見て採用・棄却・どちらが新しいかを選ぶ |
| 棄却・忘却 | `rejected` と `forgotten`。理由を見て戻せる。ここから完全削除（確認ダイアログ） |
| 記憶の詳細 | `memory.explain` と同じ内容: 根拠の原文（該当箇所を強調）、判定と確率、置き換えの連鎖、変更履歴、使われた回答 |
| 健全性 | 直近30日の棄却率・重複率・確認待ち件数・未索引件数・失敗エピソード・自己診断の結果 |
| 設定 | 「会話から覚える」の有効・無効。無効だと何が起きないかを書く |
| エクスポート | 全記憶・エピソード・リンクを JSON でダウンロード |

### 8.3 完全削除

`forgotten` からの完全削除は、記憶の行・リンク・語・判定を消し、Vectorize から消し、**根拠スパンをエピソード上で伏せ字にする**。伏せ字にしないと再抽出で同じ事実が戻るため。変更記録には本文を残さず「完全削除」とだけ残す。D1 Time Travel（30日）で復旧はできるので、画面の確認ダイアログにその旨を書く。

---

## 9. セキュリティ

- 分離: Account ごとの D1、Vectorize は namespace 分離（変わらず）
- 書ける人: 人がその場にいる実行だけ（変わらず）。Automation の実行記録は材料にしない
- 記憶汚染: 外部資料由来（provenance 5）は会員の事実に昇格させない。読んだ内容の中の指示は抽出対象にしない
- 資格情報: エピソード保存前に伏せ字、抽出段階でも検出して棄却
- 削除: ソフト削除が既定、完全削除は画面での確認必須
- 量: 1 Account あたりの1日のエピソード数に上限を設け、超えたら受け付けずに理由を返す

---

## 10. モデル

Workers AI のモデル ID は `apps/worker/src/memory/models.ts` 相当の1か所に置き、評価結果で差し替える。

| 役割 | 第一候補 | 代替 |
|---|---|---|
| 抽出 | 評価で決める。候補は `@cf/qwen/qwen3.8-27b`（推論 `low`）、`@cf/google/gemma-4-26b-a4b-it`、`@cf/zai-org/glm-4.7-flash` | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` |
| 取り込み前の選別・一次審査 | `@cf/cloudflare/clef-flash` | `@cf/cloudflare/clef` |
| 関係判定・再審査・統合 | `@cf/cloudflare/clef` | なし（確認待ちへ） |
| 派生記憶（保守、後回し） | `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | 抽出と同じ軽量モデル |
| 時間メタデータ | `@cf/cloudflare/clairic`（プレビュー） | 抽出 LLM の出力に含める |
| 再ランク（実験的） | `@cf/cloudflare/clef-flash` | なし（RRF のみ） |
| 埋め込み | `@cf/baai/bge-m3`（現行） | `@cf/pfnet/plamo-embedding-1b`, Qwen3-Embedding-0.6B |

Clairic はプレビューなので、抽出 LLM の JSON にも時間情報の欄を持たせ、Clairic が使えないときはそちらを使う。

抽出を軽量モデルに任せる理由:

- 呼ぶ回数が最も多いのは抽出で、エピソードごとに必ず1回呼ぶ。Workers Paid が必要なモデル（DeepSeek V4 系、GLM-5.3 系、Kimi）は Account あたり・モデルあたり 20 req/分に制限され、全 Account の自動取り込みが同じ枠を取り合う。必要としないモデル（Qwen3.8 27B、Gemma 4 26B A4B、GLM-4.7 Flash）は文章生成の既定の 300 req/分
- 保存してよいかを決めるのは抽出モデルではない。根拠照合（Worker、決定的）と一次審査（Clef）が誤りを棄却するので、抽出モデルが弱いと増えるのは「取りこぼし」であって「ゴミ」ではない。取りこぼしは評価セットの抽出漏れ率で測れる
- 弱いモデルが最も間違えやすい「文字位置」は出させない。抽出モデルには根拠の**引用文**を出させ、原文の中での位置は Worker が正規化した上で文字列照合して求める。見つからなければ棄却する

判断を Clef 系に任せる理由:

- 品質ゲートの質問はどれも閉じた選択肢で、文章を書く必要がない。Clef は全選択肢の確率を1回の読み取りで返すので、P5（判定確率の記録）と閾値によるエスカレーションがそのまま作れる。生成 LLM の答えには確率がなく、自分で書いた理由を検証する手段もない
- 出力トークンに課金されない（Clef 入力 $0.24、Clef-flash 入力 $0.038／100万トークン）。state を 1,500 トークンとすると、一次審査は1候補あたり約 $0.00006、関係判定は約 $0.0004
- Workers Paid が必要なモデルではないので、20 req/分の制限を受けない（モデルページに Paid 必須の表示がない。段階0で確認する）
- 弱点は、多段の推論を1問で聞いたときの判断。これは質問を推論の段ごとに分け、組み合わせを Worker が決めることで補う。それでも決まらないものは人に回す（P6）

生成 LLM が要るのは、文章を作る2か所だけになる: 抽出（エピソードごと）と派生記憶（保守、低頻度）。

1候補あたりの判断費用の目安: 選別（エピソードごと）約 $0.00006、一次審査 約 $0.00006、関係判定（近傍5件）約 $0.0004。選別で多くのやり取りが抽出の前に落ちるので、抽出の呼び出し回数も減る。

1エピソード（入力 約4,000・出力 約500トークン）の抽出費用の目安（キャッシュなし）: GLM-4.7 Flash 約 $0.0004、Gemma 4 26B A4B 約 $0.0006、DeepSeek V4.1 Flash 約 $0.0018、Qwen3.8 27B 約 $0.0034（推論トークンを除く）。Qwen3.8 はトークン単価では DeepSeek V4.1 Flash より高い。

費用は Account ごとではなくデプロイの Cloudflare アカウントに乗る。cf-memory 設計書 §12 の試算（標準構成で1利用者あたり月 $2.2〜2.6）は、ここでは1 Account あたりとして読み、会員数に応じて書き込み回数が増える分を見込む。

---

## 11. 実装の段階

各段階は単独でマージでき、その時点の動作を `CONTEXT.md` に書く。PR 単位の作業・テスト・完了条件は `docs/implementation/memory-plan.md`。

1. **正本の移し替えと検索**: 移行 0050（`chat_turns` の発話者列を含む）、既存記憶の取り込み、`memory_terms`、D1 を正本にした融合検索と棄権、ツール名の変更（`memory.search` / `memory.add` は当面エピソードを作らず1記憶として保存）、Tool Grant の書き換え、記憶画面の一覧と詳細
2. **エピソードと抽出**: `MemoryIngest` Workflow、Operator Chat の自動取り込みと設定、抽出と根拠照合（Step 1〜5, 9, 10）、取り残しの再起動
3. **審査**: Clef-flash 一次審査、Clef の関係判定と再審査、確認待ち、棄却の表示
4. **訂正と削除**: 置き換えリンク、`memory.correct` / `memory.forget` / `memory.explain`、完全削除
5. **保守と健全性**: `memory.maintenance`、統合・失効・自己診断、健全性区画、エクスポート
6. **評価とモデル確定**: §12 を回して閾値と構成を決める（2 以降の各段階の前提として評価セットは段階1と並行して作る）

---

## 12. 評価

cf-memory 設計書 §13 をそのまま採る。FlareChat 固有に加えるのは次の点。

- テストセットは日本語の Operator Chat 形式（会員・AI の発話者ラベル付き）で作り、`test/memory-eval/` に置く。実行は Workers AI を呼ぶので CI には入れず、`npm run eval:memory` で手動実行する
- 「複数会員」のシナリオ: 会員 A と B の好みが混ざらないか
- 「外部資料」のシナリオ: 読んだメールの中の「この人は〜が好き」が会員の事実にならないか
- 既存の mcp-memory 互換 Memory（現行実装）を比較対象にする

勝利条件（暫定）: ゴミ率 5% 未満、知識更新シナリオで旧事実の返却 0 件、記憶にない質問への誤答率が現行より低い、日本語の抽出漏れ率が Mem0 OSS 以下。

---

## 13. リスクと未確認事項

| 項目 | 内容 | 対応 |
|---|---|---|
| 仮想テーブルの混入 | 将来だれかが FTS5 を足すと、移行リハーサルのエクスポートが全 Account で止まる | Account D1 の移行に `CREATE VIRTUAL TABLE` を含めないことを移行のテストで検査する |
| Workflows の追加 | 新しいバインディングと Worker 内のクラス。デプロイ手順（`deploy:cloudflare`）とプレビュービルドへの影響 | 段階2の PR でリリース手順の検証まで含める |
| Vectorize の namespace 数 | 1索引 50,000 まで。Account 数がこれに近づくと記憶もエンティティも置けなくなる（現行の Memory も同じ制約を持つ） | Account 数を健全性の監視に入れる。近づいたら索引を Account の範囲で分ける |
| 発話者不明の過去のやり取り | §4.3 の列を足す前のやり取りは送った会員が分からない | `member_identity` を NULL にし、「私」を含む事実には `subject_identity` を付けず `candidate` にして確認待ちへ回す |
| 抽出モデルのレート制限 | Workers Paid が必要なモデルは Account あたり・モデルあたり 20 req/分 | 抽出は 300 req/分の軽量モデル、判断は Clef 系にする（§10）。20 req/分のモデルは保守の派生記憶だけで、Workflow のステップ再試行で 429 を吸収する |
| ツール名の衝突 | `memory` という名前の MCP サーバーがあると `memory.search` が重なる（`resolveTools` は重複を除かない） | 製品ツールの名前空間を予約し、既存の衝突は製品ツールを優先して報告する |
| Clef の日本語性能 | 公式の評価は英語のみで、日本語の判定精度は不明 | 段階0で日本語の評価セットに対する確率の較正を測る。必要なら Clef の RL 微調整サービスで特化 |
| 暗黙の矛盾の見逃し | Clef は1回の読み取りで答えるので、多段の推論が要る矛盾を1問では見逃しうる | 質問を推論の段に分けて Worker で組み合わせ、決まらなければ確認待ちへ。知識更新シナリオで見逃しが測れたら、生成 LLM の再審査を関係判定にだけ足す |
| Clairic がプレビュー | 仕様変更・提供終了 | 抽出 LLM 側でも時間情報を出す |
| 自動取り込みの量と費用 | Operator Chat の全やり取りが LLM 処理に回る | 自明な発話の除外、1日の上限、プロンプトキャッシュ |
| 会話削除との関係 | エピソードは原文を複写して持つため、会話を消しても記憶は残る | 記憶画面と会話の削除確認に明記する。会話ごと記憶も消す操作は需要を見て追加 |
| mcp-memory 互換の終了 | CLI で `addToMCPMemory` を前提にした手順が動かなくなる | ツール一覧は MCP の `tools/list` で都度取得されるため、クライアントは新しい名前を見る。リリースノートに書く |
