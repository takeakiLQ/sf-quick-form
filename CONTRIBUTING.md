# コントリビューションガイド

SF登録早期化プロジェクトへの参加にあたっての手引きです。共同開発を円滑に進めるためのルールと作法をまとめています。

---

## はじめに

このプロジェクトは社内ツールですが、コードリポジトリは Public で運用しています。秘密情報の取り扱いに特に注意が必要です（後述）。

迷ったらまず Issue を立てて議論しましょう。直接 PR でも構いませんが、大きな変更は事前合意があると手戻りが少なくて済みます。

---

## 開発環境のセットアップ

詳細はルートの [README.md「開発環境の構築」](./README.md#開発環境の構築) を参照してください。要約すると：

```bash
git clone https://github.com/takeakiLQ/sf-quick-form.git
cd sf-quick-form/worker
npm install
wrangler login
```

ローカル動作確認は `cd worker && npm run dev` で `http://localhost:8787` に Worker が起動します。

---

## ブランチ命名規則

`main` ブランチには直接 push しません。必ず feature ブランチを切って PR を出してください。

| プレフィックス | 用途 | 例 |
|----------------|------|-----|
| `feature/` | 新機能・改善 | `feature/admin-bulk-action` |
| `fix/` | バグ修正 | `fix/12-login-redirect-loop` |
| `docs/` | ドキュメントのみ | `docs/architecture-update` |
| `refactor/` | 動作を変えないリファクタ | `refactor/extract-firestore-helpers` |
| `chore/` | 雑事（依存更新、設定変更等） | `chore/update-wrangler` |

ハイフン区切りの英小文字で簡潔に。Issue 番号がある場合は `fix/<issue番号>-...` の形でも可。

---

## コミットメッセージ

英語または日本語、命令形（"Add ..."、"追加"、"修正"）が好まれます。1行サマリは50文字以内が目安。

良い例：

```
Add admin endpoint for bulk receipt review

複数の受付を一括でレビュー中／登録済に遷移できる API を追加。
管理画面の操作工数を削減するため。

Closes #42
```

避けたい例：

```
fix
update
WIP
```

詳細を本文に書く時は1行目との間に空行を入れてください。

---

## Pull Request の出し方

### 基本フロー（GitHub Flow）

```
1. main から feature ブランチを切る
   git checkout main && git pull
   git checkout -b feature/<short-description>

2. 変更を加える、コミット

3. push
   git push -u origin feature/<short-description>

4. PR を作成（GitHub Web UI または gh CLI）

5. CI（PR Checks）の結果を確認

6. レビュアーから承認をもらう

7. Squash and merge

8. ブランチ削除（マージ後）

9. ローカルの main を同期
   git checkout main && git pull
   git branch -d feature/<short-description>
```

### PR の Title

「何をしたか」が一目で分かる動詞始まり。日本語OK。

良い例：
- `Add 営管T 受付一覧に CSV エクスポート機能`
- `Fix Firebase ID トークンが期限切れの時のリトライ処理`
- `Refactor Worker 内の Firestore ヘルパーを別ファイルに分離`

### PR の Description

`.github/pull_request_template.md` のテンプレが自動入力されます。各セクションを埋めてください：

- **概要**：このPRで何を解決するか
- **変更内容**：実装の要点
- **動作確認**：何をどう確認したか
- **レビュー観点**：レビュアーに特に見てほしい点
- **関連 Issue**：あれば `Closes #N` の形で

### 関連 Issue があれば紐付け

PR 本文で `Closes #42` または `Fixes #42` と書くと、PR がマージされた時に自動的に Issue #42 がクローズされます。

---

## コードレビューの作法

### レビュアーとして

- **タイミング**：通常24時間以内に最初の反応をする
- **何を見るか**：
  - 動作は正しいか（テストや手動確認の方法を読む）
  - セキュリティ的に問題ないか（特に Worker のコード）
  - 可読性・保守性は確保されているか
  - 不要なコードや TODO が混じっていないか
- **指摘の仕方**：
  - 提案は「こうしたほうが良いかも？」のような柔らかい言い方を
  - 必須の修正は明確に「マージ前に修正してほしい」と伝える
  - 良いところも積極的にコメントで褒める
- **承認の判断**：
  - 致命的な問題なし → Approve
  - 軽微な指摘あり → Comment（任意修正）
  - 必須修正あり → Request changes

### レビュイー（PR の作者）として

- レビューの指摘には全件返信する（受け入れる／反論する／別 Issue にする）
- 大きな修正は別コミットで追加（強制 push よりレビュアーが追いやすい）
- 議論が長引きそうなら Issue や Slack に切り出す

---

## セキュリティ・秘密情報の取り扱い

### 絶対にコミットしない

- Salesforce Connected App の **Consumer Secret**
- Firebase サービスアカウントの **private_key**
- Cloudflare API トークン
- 個人のメアドや電話番号（テストデータ含む）
- `.secrets/` 配下のすべて

### コミット可能

- Salesforce **Consumer Key（Client ID）**：OAuth 標準で公開可
- Firebase の **`apiKey`**：OAuth Client ID と同様、識別子であり秘密ではない
- Cloudflare KV ネームスペース ID：API トークンがないと触れない
- 公開URL、プロジェクトID、ドメイン名

### 機密値の管理

| 種類 | 保管先 |
|------|--------|
| Worker 用 Secret（SF_CLIENT_SECRET など） | Cloudflare Workers Secret |
| GitHub Actions 用トークン | GitHub Repository Secrets |
| ローカル開発用の Firebase service account | リポジトリ外（`D:\...\.secrets\` 等） |

### もし誤って秘密情報をコミットしてしまったら

すぐに Issue を立てて報告してください。秘密の種類によって対処が変わります：

- **コミットしただけで push 前** → `git reset HEAD~1` で取り消し
- **push してしまった** → 当該の値を**直ちにローテーション**（Cloudflare/Firebase/Salesforce で再発行）し、`git filter-repo` 等で履歴から削除を試みる
- リポジトリが Public のため、push された秘密は**漏洩した前提**で対処する

---

## バグ報告と機能要望

`.github/ISSUE_TEMPLATE/` に2種類のテンプレがあります：

- **バグ報告**：再現手順、期待と実際、環境（ブラウザ、OS）
- **機能要望**：何を解決したいか、なぜ必要か、想定する利用者

Issue を作る前に、既存 Issue で同じものが議論されていないか検索してください。

---

## 質問や相談

- 技術的な質問：GitHub Discussions（追加予定）または Issue
- それ以外：チームの Slack チャネル（運用ルール固まり次第追記）

---

## ライセンス・著作権

社内利用のみ。再配布・二次利用は不可。コミットしたコードの著作権は会社に帰属します。
