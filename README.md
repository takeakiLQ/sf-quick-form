# SF登録早期化プロジェクト — 簡易フォーム

[![Deploy Worker](https://github.com/takeakiLQ/sf-quick-form/actions/workflows/deploy-worker.yml/badge.svg)](https://github.com/takeakiLQ/sf-quick-form/actions/workflows/deploy-worker.yml)


営業の Salesforce 入力負荷を軽減する社内ツール。営業はスマホで必須項目だけ入力し、営業管理チーム（営管T）が SF への正式登録を代行する運用を支える。

> ステータス：**PoC（概念実証）動作中**。本番 SF と疎通済み、営業／営管T の両画面が動作確認済み。

---

## 目次

- [概要](#概要)
- [技術スタック](#技術スタック)
- [アーキテクチャ](#アーキテクチャ)
- [ディレクトリ構成](#ディレクトリ構成)
- [主要URL](#主要url)
- [開発環境の構築](#開発環境の構築)
- [開発フロー（GitHub Flow）](#開発フローgithub-flow)
- [デプロイ](#デプロイ)
- [設定値と秘密情報](#設定値と秘密情報)
- [関連ドキュメント](#関連ドキュメント)

---

## 概要

営業が SF の案件オブジェクトを直接入力する運用では入力項目が多く、商談時間を圧迫していた。本プロジェクトは「**営業はスマホで簡易フォームに必要項目のみ入力 → 営管T が SF へ正式登録**」というワークフローを Web アプリで提供する。

### 対応シナリオ

- **新規案件**：新規取引先・取引先責任者と案件の作成
- **増車案件**：既存取引先からの追加案件
- **条件変更**：現案件の条件（単価／期間／稼働曜日 等）の変更、履歴保持コピー
- **稼働者入替**：マッチング済み稼働者の差し替え

### ユーザー種別

- **営業**：簡易フォームから案件種別を選んで必須項目を入力・送信、自分の申請ステータスを確認
- **営管T**：受付一覧から内容をレビュー、SFへ転記、ステータス遷移管理（確認中／差戻し／SF登録済／配車済）

---

## 技術スタック

| レイヤ | 技術 | 役割 |
|--------|------|------|
| フロントエンド | HTML / CSS / Vanilla JS | GitHub Pages で配信 |
| 認証 | Firebase Authentication（Google SSO） | `@logiquest.co.jp` ドメイン制限 |
| データ保管 | Cloud Firestore | 受付データ・操作履歴 |
| BFF（バックエンド） | Cloudflare Workers + TypeScript | OAuth 中継・SF API プロキシ・Firestore 中継 |
| ホスティング | GitHub Pages（フロント） / Cloudflare Workers（BFF） | 全て無料枠 |
| SF 連携 | OAuth 2.0 + PKCE / REST API v59 | SF 本番（login.salesforce.com） |

---

## アーキテクチャ

```
[営業/営管T のブラウザ]
        │
        │ ① Firebase Auth で Google ログイン（@logiquest.co.jp 限定）
        │ ② 全 API 呼出に Authorization: Bearer <Firebase ID トークン>
        ▼
[GitHub Pages: フロント]
   index.html (営業用)、admin.html (営管T用)、callback.html (SF OAuth戻り先)
        │
        │ HTTPS + CORS
        ▼
[Cloudflare Workers BFF: sf-form-bff.takeaki-logiquest.workers.dev]
   - Firebase ID トークン検証 + ドメイン制限
   - SF OAuth 2.0 PKCE フロー（Client Secret は Worker Secret に格納）
   - SF REST API 中継（取引先・案件検索）
   - 受付データの Firestore CRUD
        │
        ├─→ [Firestore: receipts コレクション]
        ├─→ [Firebase Auth: 公開鍵で JWT 検証]
        └─→ [Salesforce 本番]
```

### 認証モデル（2階建て）

1. **Firebase Auth**：「あなたは社内ユーザーですか？」（アプリ利用権）
2. **SF OAuth**：「あなたの SF データへのアクセスを許可しますか？」（データ利用権）

---

## ディレクトリ構成

```
sf-quick-form/
├── README.md                ← このファイル
├── .gitignore               ← node_modules, .secrets/ 等の除外
├── docs/                    ← GitHub Pages 配信元（フロント）
│   ├── index.html             営業用：ログイン・案件操作
│   ├── admin.html             営管T用：受付一覧・状態遷移
│   └── callback.html          SF OAuth コールバック
└── worker/                  ← Cloudflare Workers BFF
    ├── src/
    │   └── index.ts            ルーティング・認証・Firestore・SF 中継
    ├── package.json
    ├── tsconfig.json
    └── wrangler.toml          公開可能な設定値（秘密情報は Cloudflare Secret）
```

---

## 主要URL

| 用途 | URL |
|------|-----|
| 営業用簡易フォーム | https://takeakilq.github.io/sf-quick-form/ |
| 営管T 受付管理 | https://takeakilq.github.io/sf-quick-form/admin.html |
| BFF（API） | https://sf-form-bff.takeaki-logiquest.workers.dev |
| Firebase Console | https://console.firebase.google.com/project/sf-quick-form |
| GitHub リポジトリ | https://github.com/takeakiLQ/sf-quick-form |

---

## 開発環境の構築

### 必要ツール

- Node.js 18+
- npm
- Git
- GitHub アカウント（リポジトリへの招待が必要）
- 各種コンソールへのアクセス権（Cloudflare、Firebase、Salesforce）

### 初回セットアップ手順

```bash
# 1. リポジトリのクローン
git clone https://github.com/takeakiLQ/sf-quick-form.git
cd sf-quick-form

# 2. Worker の依存パッケージをインストール
cd worker
npm install

# 3. Wrangler CLI のインストール（未インストール時）
npm install -g wrangler

# 4. Cloudflare アカウントにログイン
wrangler login
# → ブラウザが開いて認可。一度ログインすればトークンが保存される

# 5. wrangler.toml の確認
# 公開設定値（SF_CLIENT_ID, FIREBASE_PROJECT_ID 等）はコミット済み
# 秘密情報（SF_CLIENT_SECRET, FIREBASE_PRIVATE_KEY 等）は Cloudflare Workers Secret にすでに格納済み
# 新メンバーは Secret を投入する必要は通常ありません

# 6. ローカル動作確認（任意）
cd worker
npm run dev
# → http://localhost:8787 で Worker のローカル起動

# 7. フロントの動作確認（任意）
# docs/ 配下を任意の静的サーバで開くか、GitHub Pages の本番 URL で確認
```

> **注意**：Secret の追加・更新が必要な場合は、必ず `wrangler secret put <NAME>` で Cloudflare に投入してください。リポジトリには絶対にコミットしないでください。

### Firebase 関連

Firebase プロジェクト `sf-quick-form` への閲覧権限が必要な場合は、プロジェクトオーナーに [Firebase Console](https://console.firebase.google.com/project/sf-quick-form) からの招待を依頼してください。

---

## 開発フロー（GitHub Flow）

本プロジェクトでは **GitHub Flow** を採用しています。

```
main ←本番。直接 push 禁止。常にデプロイ可能。
  │
  └─ feature/<topic>  作業ブランチ。1機能・1修正単位で作る
        │
        ├─ コード変更
        ├─ git commit, git push
        │
        ▼
     Pull Request（PR）
        │
        ├─ レビュー（最低1名の承認）
        ├─ CI チェック合格
        │
        ▼
     main へマージ → 自動デプロイ
```

### ブランチ命名規則

- `feature/<short-description>` — 新機能、改善
- `fix/<issue-id>-<short-description>` — バグ修正
- `docs/<topic>` — ドキュメントのみの変更
- `refactor/<scope>` — リファクタリング

### コミットメッセージ

英語または日本語、命令形が好まれます。長文は本文で説明。

```
Add admin view for 営管T

- /admin/receipts エンドポイント追加
- ステータス遷移ロジック実装
- 詳細モーダルとアクション UI
```

詳細は [CONTRIBUTING.md](./CONTRIBUTING.md)（Phase 3 で作成予定）参照。

---

## デプロイ

### フロント（GitHub Pages）

`main` ブランチの `docs/` 配下が GitHub Actions により自動デプロイされます。`main` にマージされると 1〜2 分で公開 URL に反映。

### BFF（Cloudflare Workers）

**現状**：手動デプロイ
```bash
cd worker
wrangler deploy
```

**Phase 2 で対応予定**：`main` へのマージで GitHub Actions 経由で自動デプロイ。

---

## 設定値と秘密情報

### 公開可能な設定値（`worker/wrangler.toml` にコミット済み）

| 変数 | 値 | 説明 |
|------|-----|-----|
| `SF_LOGIN_URL` | `https://login.salesforce.com` | SF 本番ログインエンドポイント |
| `SF_CLIENT_ID` | （Connected App の Consumer Key） | OAuth Client ID（標準上公開可） |
| `SF_REDIRECT_URI` | `https://takeakilq.github.io/sf-quick-form/callback.html` | OAuth コールバック |
| `ALLOWED_ORIGIN` | `https://takeakilq.github.io` | CORS 許可オリジン |
| `FRONTEND_URL` | `https://takeakilq.github.io/sf-quick-form/` | ログイン後の戻り先 |
| `FIREBASE_PROJECT_ID` | `sf-quick-form` | Firebase プロジェクト ID |
| `ALLOWED_EMAIL_DOMAIN` | `logiquest.co.jp` | Firebase Auth で許可するドメイン |

### 秘密情報（Cloudflare Workers Secret に格納、リポジトリ非公開）

| Secret 名 | 説明 |
|-----------|------|
| `SF_CLIENT_SECRET` | SF Connected App の Consumer Secret |
| `COOKIE_SECRET` | （現在は未使用、後方互換用） |
| `FIREBASE_CLIENT_EMAIL` | Firebase サービスアカウントの client_email |
| `FIREBASE_PRIVATE_KEY` | Firebase サービスアカウントの private_key（PEM、`\n` エスケープ） |
| `ADMIN_EMAILS` | 営管T 権限を持つメアドのカンマ区切り |

Secret の確認：`wrangler secret list`
Secret の更新：`wrangler secret put <NAME>`

### フロントの Firebase 設定

`docs/index.html` および `docs/admin.html` 内の `firebaseConfig` に直接記述。これらの値（`apiKey` 等）は **OAuth Client ID と同じく公開可** な識別子で、悪用には別途 Firebase Auth ドメイン制限と Worker 側のドメイン検証が効いている設計。

---

## 関連ドキュメント

プロジェクト初期に作成された以下のドキュメントが手元にあります（リポジトリ外）：

- 要件定義書（02_要件定義書.docx）
- 業務フロー図（01_業務フロー図.md）
- 技術提案書（03_技術提案書.docx）
- 簡易フォーム項目設計書（04_簡易フォーム項目設計.xlsx）

リポジトリ内には Phase 3 で `ARCHITECTURE.md` と `CONTRIBUTING.md` を追加予定です。

---

## ライセンス

社内利用のみ。再配布・二次利用は不可。
