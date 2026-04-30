# アーキテクチャドキュメント

SF登録早期化プロジェクト 簡易フォームの技術設計を記述します。新規参加メンバーが「全体感をつかむ」ための文書です。

---

## 全体像

```
┌─────────────────────────────────────────────────────────────────┐
│                       ブラウザ（営業 / 営管T）                  │
│  - Firebase JS SDK で Google ログイン                          │
│  - Firebase ID トークンを取得・保管                            │
│  - 全 API 呼出に Authorization: Bearer <id_token> 付与         │
└────────────────────┬────────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│      GitHub Pages 配信（フロントエンド・静的 HTML/JS）          │
│  https://takeakilq.github.io/sf-quick-form/                    │
│                                                                 │
│  - index.html      営業用：ログイン・案件操作・申請ステータス   │
│  - admin.html      営管T用：受付一覧・状態遷移                  │
│  - callback.html   SF OAuth コールバック中継                    │
└────────────────────┬────────────────────────────────────────────┘
                     │  fetch (CORS)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│   Cloudflare Workers BFF（Backend for Frontend）                │
│   sf-form-bff.takeaki-logiquest.workers.dev                    │
│                                                                 │
│  入口で Firebase ID トークンを検証＋ドメイン制限                │
│  ロール判定（ADMIN_EMAILS マッチ）                              │
│                                                                 │
│  ├─ /auth/login        SF OAuth 開始（PKCE生成）                │
│  ├─ /auth/callback     SF からの戻り、トークン交換              │
│  ├─ /auth/me           現在の認証状態を返す                     │
│  ├─ /auth/logout       SF セッション破棄                        │
│  ├─ /sf/search/account 取引先検索                               │
│  ├─ /sf/search/opportunity  案件検索                            │
│  ├─ /receipts (POST)   受付データ作成（Firestore）              │
│  ├─ /receipts (GET)    自分の受付一覧                           │
│  ├─ /admin/me          管理者権限チェック                       │
│  ├─ /admin/receipts    全受付一覧（管理者のみ）                 │
│  └─ /admin/receipts/:id/transition  状態遷移（管理者のみ）      │
└──────┬─────────────────────┬─────────────────────────┬──────────┘
       │                     │                         │
       ▼                     ▼                         ▼
┌──────────────┐  ┌────────────────────┐  ┌────────────────────┐
│  Firebase    │  │     Firestore      │  │    Salesforce      │
│  Auth        │  │   (asia-ne1)       │  │     (本番)         │
│              │  │                    │  │                    │
│ JWK 公開鍵で │  │ receipts コレク    │  │ Connected App で   │
│ ID トークン  │  │ ション             │  │ OAuth 2.0 PKCE     │
│ を検証       │  │                    │  │ REST API v59       │
└──────────────┘  └────────────────────┘  └────────────────────┘
                  │
              （SESSIONS KV）
              SF アクセストークン保管
              `sf:<firebaseUid>` キー
```

---

## 認証モデル（2階建て）

### 1階：Firebase Auth（アプリ利用権）

「あなたは社内ユーザーですか？」を判定。

- フロント：Firebase JS SDK の `signInWithPopup(GoogleAuthProvider)` で Google ログイン
- 制限：`@logiquest.co.jp` ドメインのアカウントのみ
  - クライアント側：`onAuthStateChanged` でメアドのドメインをチェック、違ったら即サインアウト
  - **サーバ側（必須防御）**：Worker の `requireFirebaseAuth` で必ず JWT のメアドドメインを検証
- セッション：Firebase JS SDK が `localStorage` で保持（永続）
- ID トークンの有効期限：1時間（自動更新）

### 2階：Salesforce OAuth（データ利用権）

「あなたの SF データへのアクセスを許可しますか？」を判定。

- 標準的な OAuth 2.0 Authorization Code + PKCE フロー
- BFF（Worker）が Connected App の Consumer Secret を保持
- アクセストークン・リフレッシュトークンは Cloudflare KV に保管（`sf:<firebaseUid>`）

### ロール（営管T 判定）

- `ADMIN_EMAILS`（Cloudflare Secret）に含まれるメアドが営管T
- カンマ区切りで複数登録可
- フロントは `/admin/me` で問い合わせ、管理者でなければ `admin.html` で「権限がありません」と表示
- Worker の `/admin/*` エンドポイントは `requireAdmin` でゲート

---

## 認証フロー詳細

### 初回ログイン（営業ユーザー）

```
1. ブラウザ: index.html 開く
2. ブラウザ: Firebase JS SDK 初期化、onAuthStateChanged で未認証検知
3. ブラウザ: 「Google でログイン」ボタンをユーザがクリック
4. ブラウザ: signInWithPopup → Google 認証画面（ポップアップ）
5. ユーザ: Google 認証
6. ブラウザ: ID トークン取得、@logiquest.co.jp チェック
7. ブラウザ: GET /auth/me（Authorization: Bearer <id_token>）
8. Worker:  Firebase 公開鍵で JWT 検証、ドメインチェック
9. Worker:  KV に sf:<uid> なし → { sf.connected: false } を返す
10. ブラウザ: SF未連携画面を表示

11. ユーザ: 「Salesforce と連携する」ボタンをクリック
12. ブラウザ: POST /auth/login（Authorization: Bearer <id_token>）
13. Worker:  PKCE verifier 生成、KV に pkce:<state> = { verifier, firebaseUid } 保管
14. Worker:  SF authorize URL を返す
15. ブラウザ: location.href = authorize URL → SF ログイン画面
16. ユーザ: SF ログイン
17. SF:    callback.html?code=...&state=... へリダイレクト
18. ブラウザ: callback.html の JS が GET /auth/callback?code=...&state=... へ転送
19. Worker:  KV から pkce:<state> 取得（firebaseUid 付き）
20. Worker:  SF にトークン交換要求（Consumer Secret 同梱）
21. Worker:  KV に sf:<firebaseUid> = アクセストークン+インスタンスURL 保管（TTL 8h）
22. Worker:  302 リダイレクト → FRONTEND_URL（GitHub Pages）
23. ブラウザ: index.html 再読込
24. ブラウザ: GET /auth/me → 今度は { sf.connected: true } 
25. ブラウザ: 認証完了画面、各種操作可能
```

### 2回目以降

`localStorage` の Firebase Auth セッションが生きていれば、ページ開いた瞬間に GET /auth/me まで進む。SF 側のセッション（KV の `sf:<uid>`）が残っていればそのまま操作可能、切れていたら 11. の「SF と連携する」から再開。

---

## データモデル（Firestore）

### `receipts` コレクション

ドキュメント ID：`R-YYYYMM-XXXXXX` 形式（例：`R-202604-A1B2C3`）

```typescript
{
  id: string;              // ドキュメントIDと同じ
  createdAt: string;       // ISO 8601
  status: "submitted" | "reviewing" | "rejected" | "sf_registered" | "dispatched";
  submittedBy: {
    uid: string;           // Firebase UID
    email: string;
    name: string;
  };
  payload: any;            // 申請内容（案件種別ごとに構造が異なる）
  
  // 営管T 操作後に追加されるフィールド
  reviewedBy?: { uid, email, name };
  reviewedAt?: string;
  sfRecordId?: string;     // SF カスタム案件オブジェクトのレコードID
  rejectionReason?: string;
  history?: Array<{
    at: string;
    by: { uid, email, name };
    action: "reviewing" | "rejected" | "sf_registered" | "dispatched";
    note?: string;
  }>;
}
```

### Firestore インデックス

複合インデックス：
- `(submittedBy.uid ASC, createdAt DESC)` ← 自分の受付一覧用
- 必要に応じて追加（status フィルタ等は JS ソートで対応中）

---

## ステータス遷移

```
submitted（送信済）
    │
    ├──▶ reviewing（確認中）
    │       │
    │       ├──▶ rejected（差戻し）
    │       │       │
    │       │       └──▶ submitted（営業が再送信）※未実装
    │       │
    │       └──▶ sf_registered（SF登録済・SFレコードID付与）
    │               │
    │               └──▶ dispatched（配車済・終了）
    │
    └──▶ rejected（直接差戻し）
```

遷移は `/admin/receipts/:id/transition` で行い、`history` 配列に追記される。

---

## Cloudflare Workers の構成

### KV ネームスペース

| バインディング | 用途 |
|----------------|------|
| `SESSIONS` | OAuth 一時データ（PKCE）・SF セッショントークン |
| `RECEIPTS` | （旧）KV 保管時代の名残、Firestore 移行後は未使用。後で削除予定 |

### Secrets

| 名前 | 内容 |
|------|------|
| `SF_CLIENT_SECRET` | Connected App の Consumer Secret |
| `FIREBASE_CLIENT_EMAIL` | Firebase サービスアカウント |
| `FIREBASE_PRIVATE_KEY` | サービスアカウント秘密鍵（PEM、`\n` エスケープ）|
| `ADMIN_EMAILS` | 営管T のメアド一覧（カンマ区切り）|
| `COOKIE_SECRET` | （未使用、後方互換）|

### 環境変数（公開可）

`worker/wrangler.toml` の `[vars]` 参照。OAuth Client ID、URL、ドメイン名など。

---

## 主要な技術判断と背景

### なぜ GitHub Pages + Cloudflare Workers?

- 営業/営管T 約100名超を想定。Cloudflare Access の有料プラン（$7/user/月）は予算に乗らない
- GitHub Pages は無料、CDN 配信、独自ドメイン化も可能
- Cloudflare Workers は無料枠で月10万リクエスト、本プロジェクトの想定規模（月300案件 × 各数十リクエスト）を大きく下回る

### なぜ Firebase（Auth + Firestore）?

- Firebase Auth：100名超でも完全無料（MAU 50,000 まで）。Cloudflare Access の代替として SSO ゲート機能を実現
- Firestore：標準的なドキュメント DB、検索性とリアルタイム性が必要になっても拡張可
- Firebase 一括で Auth + DB の管理画面を提供、運用負担少

### なぜ HttpOnly Cookie ではなく Authorization ヘッダ?

- フロント（github.io）と BFF（workers.dev）が別ドメイン
- HttpOnly Cookie + SameSite=None は iOS Safari でブロックされる（ITP）
- Bearer トークン方式ならクロスサイト問題ゼロ
- セキュリティ上は localStorage 保管のリスクが残るが、Firebase JS SDK が標準で取る方式に従う

### なぜ JS-side ソートと Firestore composite index の併用?

- 件数が小さい admin の受付一覧は JS ソートで十分（インデックス管理不要）
- 件数が増えるユーザー個人の受付一覧は composite index でサーバサイドソート（性能優先）
- 「インデックスのビルド待ちで作業が止まらない」「無理にインデックスを増やさない」ためのバランス

---

## デプロイメント

### フロントエンド（GitHub Pages）

`main` ブランチの `docs/` 配下を GitHub の自動デプロイ機能で配信。`docs/` を変更した PR がマージされると約1分で反映。

### BFF（Cloudflare Workers）

GitHub Actions の `Deploy Worker` ワークフローが自動実行：

1. `worker/**` または `.github/workflows/deploy-worker.yml` を含む `main` への push をトリガー
2. `npm ci` で依存解決
3. `tsc --noEmit` で型チェック（失敗時はデプロイ中止）
4. `cloudflare/wrangler-action@v3` で deploy

ロールバック：直前の version に戻すなら、Cloudflare ダッシュボードから version 選択 or `wrangler rollback`。

---

## 制約・既知の課題

- **Cloudflare Workers の CPU 時間**：1リクエスト10ms（無料）。Firestore REST 呼び出しが遅い場合は Workers Paid（$5/月）への移行を検討
- **iOS Safari の挙動**：popup login が稀に閉じない。`signInWithRedirect` への切替を検討中
- **SF 項目の棚卸し未実施**：本格的な機能拡張前に、SF カスタム案件オブジェクトの全項目を棚卸しして「営業入力／営管T入力／参照のみ／対象外」に振り分ける必要あり（Phase 1.5）
- **Firestore セキュリティルール未設定**：現状はデフォルトの「全拒否」、Worker からのみアクセス。フロントから直接 Firestore を叩くフェーズになったら正規のルール設計が必要

---

## 参考リンク

- [Cloudflare Workers ドキュメント](https://developers.cloudflare.com/workers/)
- [Firebase Authentication ドキュメント](https://firebase.google.com/docs/auth)
- [Cloud Firestore ドキュメント](https://firebase.google.com/docs/firestore)
- [Salesforce OAuth 2.0](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_flows.htm)
- [GitHub Flow](https://docs.github.com/ja/get-started/quickstart/github-flow)
