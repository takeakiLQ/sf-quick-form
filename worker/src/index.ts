/**
 * SF登録早期化プロジェクト — BFF（Backend for Frontend）
 *
 * 役割：
 *   1. Firebase Auth ID トークンの検証 + ドメイン制限（@logiquest.co.jp）
 *   2. SF OAuth 2.0 (Authorization Code + PKCE) のトークン交換代行
 *   3. SF REST API への中継（取引先・案件・稼働者の検索）
 *   4. 受付データの Firestore への保管
 *
 * 認証モデル：
 *   フロント → Firebase Auth で Google ログイン → ID トークン取得
 *           → 全 API 呼出に Authorization: Bearer <id_token> を付与
 *   Worker → Firebase 公開鍵で JWT 検証 → email ドメイン確認
 *         → Firebase UID をキーに SF トークンを KV から引く
 */

export interface Env {
  // 環境変数（vars）
  SF_LOGIN_URL: string;
  SF_CLIENT_ID: string;
  SF_REDIRECT_URI: string;
  ALLOWED_ORIGIN: string;
  FRONTEND_URL: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  ADMIN_EMAILS: string;

  // シークレット
  SF_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;

  // KV
  SESSIONS: KVNamespace;
  RECEIPTS: KVNamespace; // 旧（未使用、移行のため当面残す）
}

// ─────────────────────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────────────────────
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // CORS プリフライト
    if (req.method === "OPTIONS") {
      return cors(env, new Response(null, { status: 204 }));
    }

    try {
      const path = url.pathname;
      const method = req.method;

      // /admin/receipts/:id/transition の動的ルート
      const transitionMatch = path.match(/^\/admin\/receipts\/([^/]+)\/transition$/);
      if (method === "POST" && transitionMatch) {
        return cors(env, await handleAdminTransition(req, env, transitionMatch[1]));
      }

      switch (`${method} ${path}`) {
        case "POST /auth/login":
          return cors(env, await handleLogin(req, env));
        case "GET /auth/callback":
          return cors(env, await handleCallback(req, env));
        case "GET /auth/me":
          return cors(env, await handleMe(req, env));
        case "POST /auth/logout":
          return cors(env, await handleLogout(req, env));
        case "GET /sf/search/account":
          return cors(env, await handleSfSearch(req, env, "Account"));
        case "GET /sf/search/opportunity":
          return cors(env, await handleSfSearch(req, env, "Opportunity"));
        case "GET /sf/describe":
          return cors(env, await handleSfDescribe(req, env));
        case "POST /receipts":
          return cors(env, await handleCreateReceipt(req, env));
        case "GET /receipts":
          return cors(env, await handleListReceipts(req, env));
        case "GET /admin/receipts":
          return cors(env, await handleAdminListReceipts(req, env));
        case "GET /admin/me":
          return cors(env, await handleAdminMe(req, env));
      }
      return cors(env, json({ error: "not_found" }, 404));
    } catch (e: any) {
      console.error(e);
      return cors(env, json({ error: "internal_error", message: e?.message }, 500));
    }
  },
};

// ─────────────────────────────────────────────────────────────
// /auth/login — Firebase Auth 済みユーザーから SF 認可URLを返す
// フロントは fetch で受け取って location.href で SF へ遷移する
// ─────────────────────────────────────────────────────────────
async function handleLogin(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;

  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  const state = randomString(32);

  // PKCE と Firebase UID を紐づけて KV に保存（callback で取り出す）
  await env.SESSIONS.put(
    `pkce:${state}`,
    JSON.stringify({ verifier, firebaseUid: auth.uid, email: auth.email }),
    { expirationTtl: 600 }
  );

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.SF_CLIENT_ID,
    redirect_uri: env.SF_REDIRECT_URI,
    scope: "api refresh_token offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  const authorizeUrl = `${env.SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
  return json({ authorizeUrl });
}

// ─────────────────────────────────────────────────────────────
// /auth/callback — SF からの戻り。state に紐づく Firebase UID を取り出して
// SF トークンを KV に保管。
// このエンドポイントは Firebase Auth ヘッダ無しで叩かれるので、
// state パラメータの検証で Firebase UID への紐づけを保証する。
// ─────────────────────────────────────────────────────────────
async function handleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "missing_code_or_state" }, 400);

  const pkceStr = await env.SESSIONS.get(`pkce:${state}`);
  if (!pkceStr) return json({ error: "invalid_state" }, 400);
  await env.SESSIONS.delete(`pkce:${state}`);

  const pkce = JSON.parse(pkceStr) as { verifier: string; firebaseUid: string; email: string };

  const tokenRes = await fetch(`${env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.SF_CLIENT_ID,
      client_secret: env.SF_CLIENT_SECRET,
      redirect_uri: env.SF_REDIRECT_URI,
      code_verifier: pkce.verifier,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return json({ error: "token_exchange_failed", detail: text }, 400);
  }

  const token = (await tokenRes.json()) as SfTokenResponse;
  // SF トークンを Firebase UID をキーに保管
  await env.SESSIONS.put(
    `sf:${pkce.firebaseUid}`,
    JSON.stringify({
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      instanceUrl: token.instance_url,
      issuedAt: Date.now(),
      userInfoUrl: token.id,
      email: pkce.email,
    }),
    { expirationTtl: 60 * 60 * 8 }
  );

  // フロントへ戻す
  return new Response(null, {
    status: 302,
    headers: { Location: env.FRONTEND_URL },
  });
}

// ─────────────────────────────────────────────────────────────
// /sf/describe — SF オブジェクトの全フィールドメタデータを返す（管理者のみ）
// クエリ：?object=Account / Contact / Oppotunities__c など
// 用途：項目の棚卸し（業務分類とAPI名のマッピング作成）
// ─────────────────────────────────────────────────────────────
async function handleSfDescribe(req: Request, env: Env): Promise<Response> {
  // 棚卸しは管理作業なので管理者限定
  const auth = await requireAdmin(req, env);
  if (auth instanceof Response) return auth;

  const sfStr = await env.SESSIONS.get(`sf:${auth.uid}`);
  if (!sfStr) return json({ error: "sf_not_connected" }, 401);
  const sf = JSON.parse(sfStr) as SfSession;

  const url = new URL(req.url);
  const objectName = url.searchParams.get("object");
  if (!objectName) return json({ error: "missing_object_param" }, 400);

  // API 名は英数字とアンダースコアのみ許可（インジェクション対策）
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(objectName)) {
    return json({ error: "invalid_object_name" }, 400);
  }

  const apiUrl = `${sf.instanceUrl}/services/data/v59.0/sobjects/${objectName}/describe`;
  const r = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${sf.accessToken}` },
  });

  if (r.status === 401) return json({ error: "sf_session_expired" }, 401);
  if (r.status === 404) return json({ error: "object_not_found", objectName }, 404);
  if (!r.ok) return json({ error: "sf_api_error", detail: await r.text() }, 502);

  const data = (await r.json()) as any;

  // フィールド情報を整形（必要な項目だけ抽出して軽量化）
  const fields = (data.fields || []).map((f: any) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    length: f.length || null,
    // SF の "required"（実用的な定義）：null禁止 かつ 作成可能 かつ デフォルト値なし かつ 計算項目でない
    required: !f.nillable && f.createable && !f.defaultedOnCreate && !f.calculated,
    nillable: f.nillable,
    createable: f.createable,
    updateable: f.updateable,
    custom: f.custom,
    helpText: f.inlineHelpText || null,
    defaultValue: f.defaultValue,
    picklistValues: (f.picklistValues || [])
      .filter((p: any) => p.active)
      .map((p: any) => ({ value: p.value, label: p.label, default: p.defaultValue })),
    referenceTo: f.referenceTo || [],
    relationshipName: f.relationshipName || null,
  }));

  // レコードタイプ情報
  const recordTypes = (data.recordTypeInfos || []).map((rt: any) => ({
    recordTypeId: rt.recordTypeId,
    name: rt.name,
    developerName: rt.developerName,
    active: rt.active,
    available: rt.available,
    default: rt.defaultRecordTypeMapping,
    master: rt.master,
  }));

  return json({
    objectName: data.name,
    label: data.label,
    labelPlural: data.labelPlural,
    custom: data.custom,
    fieldCount: fields.length,
    recordTypeCount: recordTypes.length,
    recordTypes,
    fields,
  });
}

// ─────────────────────────────────────────────────────────────
// /auth/me — Firebase 認証 + SF セッション状態を返す
// ─────────────────────────────────────────────────────────────
async function handleMe(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;

  const sfStr = await env.SESSIONS.get(`sf:${auth.uid}`);
  if (!sfStr) {
    return json({ firebase: { authenticated: true, ...auth }, sf: { connected: false } });
  }
  const sf = JSON.parse(sfStr) as SfSession;
  // SF identity URL でユーザー情報取得
  const r = await fetch(sf.userInfoUrl, {
    headers: { Authorization: `Bearer ${sf.accessToken}` },
  });
  let sfUser: any = null;
  if (r.ok) sfUser = await r.json();
  return json({
    firebase: { authenticated: true, ...auth, isAdmin: isAdmin(auth.email, env) },
    sf: { connected: !!sfUser, user: sfUser, instanceUrl: sf.instanceUrl },
  });
}

// ─────────────────────────────────────────────────────────────
// /admin/me — 管理者権限のクイックチェック
// ─────────────────────────────────────────────────────────────
async function handleAdminMe(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;
  return json({ ...auth, isAdmin: isAdmin(auth.email, env) });
}

// ─────────────────────────────────────────────────────────────
// /admin/receipts — 全件取得（status フィルタあり）
// ─────────────────────────────────────────────────────────────
async function handleAdminListReceipts(req: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(req, env);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "";

  let receipts: any[];
  if (status) {
    // status フィルタの composite index は作っていないので JS でソート
    receipts = await firestoreQueryDocs(env, "receipts", {
      field: "status",
      op: "EQUAL",
      value: status,
    });
  } else {
    receipts = await firestoreListDocs(env, "receipts");
  }
  receipts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ items: receipts });
}

// ─────────────────────────────────────────────────────────────
// /admin/receipts/:id/transition — ステータス遷移
// body: { to: "reviewing"|"rejected"|"sf_registered"|"dispatched", reason?, sfRecordId?, comment? }
// ─────────────────────────────────────────────────────────────
async function handleAdminTransition(req: Request, env: Env, receiptId: string): Promise<Response> {
  const auth = await requireAdmin(req, env);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null) as any;
  if (!body || !body.to) return json({ error: "missing_to" }, 400);

  const validStates = ["reviewing", "rejected", "sf_registered", "dispatched"];
  if (!validStates.includes(body.to)) return json({ error: "invalid_state" }, 400);

  // 現在の受付を取得
  const current = await firestoreGetDoc(env, "receipts", receiptId);
  if (!current) return json({ error: "receipt_not_found" }, 404);

  const now = new Date().toISOString();
  const reviewer = { uid: auth.uid, email: auth.email, name: auth.name || "" };

  // 履歴エントリ
  const historyEntry: any = {
    at: now,
    by: reviewer,
    action: body.to,
  };
  if (body.comment) historyEntry.note = body.comment;

  // 更新する内容
  const updates: any = {
    status: body.to,
    reviewedBy: reviewer,
    reviewedAt: now,
    history: [...(current.history || []), historyEntry],
  };
  if (body.to === "rejected" && body.reason) {
    updates.rejectionReason = body.reason;
  }
  if (body.to === "sf_registered" && body.sfRecordId) {
    updates.sfRecordId = body.sfRecordId;
  }

  await firestoreUpdateDoc(env, "receipts", receiptId, updates);
  return json({ ok: true, status: body.to });
}

// ─────────────────────────────────────────────────────────────
// /auth/logout — SF セッションのみ破棄（Firebase Auth はフロント側でサインアウト）
// ─────────────────────────────────────────────────────────────
async function handleLogout(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;
  await env.SESSIONS.delete(`sf:${auth.uid}`);
  return new Response(null, { status: 204 });
}

// ─────────────────────────────────────────────────────────────
// /sf/search/account, /sf/search/opportunity
// ─────────────────────────────────────────────────────────────
async function handleSfSearch(req: Request, env: Env, kind: "Account" | "Opportunity"): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;

  const sfStr = await env.SESSIONS.get(`sf:${auth.uid}`);
  if (!sfStr) return json({ error: "sf_not_connected" }, 401);
  const sf = JSON.parse(sfStr) as SfSession;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 1) return json({ records: [] });

  const safe = q.replace(/'/g, "\\'");
  const soql = kind === "Account"
    ? `SELECT Id, Name, BillingCity FROM Account WHERE Name LIKE '%${safe}%' LIMIT 20`
    : `SELECT Id, Name, StageName, AccountId, Account.Name FROM Opportunity WHERE Name LIKE '%${safe}%' LIMIT 20`;

  const apiUrl = `${sf.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`;
  const r = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${sf.accessToken}` },
  });

  if (r.status === 401) return json({ error: "sf_session_expired" }, 401);
  if (!r.ok) return json({ error: "sf_api_error", detail: await r.text() }, 502);
  return json(await r.json());
}

// ─────────────────────────────────────────────────────────────
// /receipts (POST) — 受付データを Firestore に登録
// ─────────────────────────────────────────────────────────────
async function handleCreateReceipt(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid_body" }, 400);

  const id = `R-${new Date().toISOString().slice(0, 7).replace("-", "")}-${randomString(6).toUpperCase()}`;
  const record = {
    id,
    createdAt: new Date().toISOString(),
    status: "submitted",
    submittedBy: { uid: auth.uid, email: auth.email, name: auth.name || "" },
    payload: body,
  };

  await firestoreCreateDoc(env, "receipts", record, id);
  return json({ ok: true, id });
}

// ─────────────────────────────────────────────────────────────
// /receipts (GET) — 受付データ一覧（自分のみ／all=true で全件※将来は権限で絞る）
// ─────────────────────────────────────────────────────────────
async function handleListReceipts(req: Request, env: Env): Promise<Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "true";

  let receipts;
  if (all) {
    receipts = await firestoreListDocs(env, "receipts");
    receipts.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  } else {
    // (submittedBy.uid, createdAt) の composite index 利用でサーバーサイドソート
    receipts = await firestoreQueryDocs(
      env,
      "receipts",
      { field: "submittedBy.uid", op: "EQUAL", value: auth.uid },
      { orderBy: { field: "createdAt", direction: "DESCENDING" } }
    );
  }
  return json({ items: receipts });
}

// ═════════════════════════════════════════════════════════════
// Firebase Auth: ID トークン検証
// ═════════════════════════════════════════════════════════════

interface FirebaseClaims {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

let firebaseKeysCache: { keys: any[]; expiresAt: number } | null = null;

async function getFirebasePublicKeys(): Promise<any[]> {
  if (firebaseKeysCache && firebaseKeysCache.expiresAt > Date.now()) {
    return firebaseKeysCache.keys;
  }
  const r = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  );
  if (!r.ok) throw new Error("Failed to fetch Firebase public keys");
  const data = (await r.json()) as { keys: any[] };
  // Cache-Control から有効期限抽出（無ければ6時間）
  const cacheControl = r.headers.get("Cache-Control") || "";
  const m = cacheControl.match(/max-age=(\d+)/);
  const maxAge = m ? parseInt(m[1], 10) : 21600;
  firebaseKeysCache = { keys: data.keys, expiresAt: Date.now() + maxAge * 1000 };
  return data.keys;
}

async function verifyFirebaseIdToken(token: string, env: Env): Promise<FirebaseClaims | null> {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) {
      console.error("[verify] token format invalid - missing parts");
      return null;
    }

    const header = JSON.parse(b64UrlDecodeStr(headerB64));
    const payload = JSON.parse(b64UrlDecodeStr(payloadB64)) as FirebaseClaims;

    // クレーム検証
    const now = Math.floor(Date.now() / 1000);
    const expectedIss = `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`;
    if (payload.iss !== expectedIss) {
      console.error("[verify] iss mismatch:", payload.iss, "expected:", expectedIss);
      return null;
    }
    if (payload.aud !== env.FIREBASE_PROJECT_ID) {
      console.error("[verify] aud mismatch:", payload.aud, "expected:", env.FIREBASE_PROJECT_ID);
      return null;
    }
    if (payload.exp < now) {
      console.error("[verify] token expired. exp:", payload.exp, "now:", now);
      return null;
    }
    if (payload.iat > now + 60) {
      console.error("[verify] iat in future. iat:", payload.iat, "now:", now);
      return null;
    }
    if (!payload.sub) {
      console.error("[verify] no sub claim");
      return null;
    }

    // 署名検証
    const keys = await getFirebasePublicKeys();
    const key = keys.find((k: any) => k.kid === header.kid);
    if (!key) {
      console.error("[verify] kid not found in public keys. kid:", header.kid, "available:", keys.map((k: any) => k.kid));
      return null;
    }

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = b64UrlToBytes(signatureB64);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signedData
    );
    if (!valid) {
      console.error("[verify] signature verification failed for kid:", header.kid);
      return null;
    }
    console.log("[verify] OK uid:", payload.sub, "email:", payload.email);
    return payload;
  } catch (e: any) {
    console.error("[verify] exception:", e?.message, e?.stack);
    return null;
  }
}

function isAdmin(email: string, env: Env): boolean {
  const list = (env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

async function requireAdmin(
  req: Request,
  env: Env
): Promise<{ uid: string; email: string; name?: string } | Response> {
  const auth = await requireFirebaseAuth(req, env);
  if (auth instanceof Response) return auth;
  if (!isAdmin(auth.email, env)) {
    return json({ error: "admin_required", message: "営業管理チーム権限が必要です" }, 403);
  }
  return auth;
}

async function requireFirebaseAuth(
  req: Request,
  env: Env
): Promise<{ uid: string; email: string; name?: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "missing_token" }, 401);
  }
  const token = authHeader.slice("Bearer ".length);
  const claims = await verifyFirebaseIdToken(token, env);
  if (!claims) return json({ error: "invalid_token" }, 401);
  if (!claims.email) return json({ error: "no_email" }, 403);
  if (!claims.email.endsWith("@" + env.ALLOWED_EMAIL_DOMAIN)) {
    return json(
      {
        error: "domain_not_allowed",
        message: `${env.ALLOWED_EMAIL_DOMAIN} ドメインのアカウントのみ利用可能です`,
      },
      403
    );
  }
  return { uid: claims.sub, email: claims.email, name: claims.name };
}

// ═════════════════════════════════════════════════════════════
// Firestore REST API クライアント
// ═════════════════════════════════════════════════════════════

let firestoreTokenCache: { token: string; expiresAt: number } | null = null;

async function getFirestoreAccessToken(env: Env): Promise<string> {
  if (firestoreTokenCache && firestoreTokenCache.expiresAt > Date.now() + 60_000) {
    return firestoreTokenCache.token;
  }

  // サービスアカウント JWT を生成
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = b64UrlEncodeStr(JSON.stringify(header));
  const claimsB64 = b64UrlEncodeStr(JSON.stringify(claims));
  const data = `${headerB64}.${claimsB64}`;

  const cryptoKey = await importPkcs8Key(env.FIREBASE_PRIVATE_KEY);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(data)
  );
  const jwt = `${data}.${b64UrlEncodeBytes(new Uint8Array(signature))}`;

  // JWT をアクセストークンに交換
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Firestore token exchange failed: ${err}`);
  }
  const tk = (await r.json()) as { access_token: string; expires_in: number };
  firestoreTokenCache = {
    token: tk.access_token,
    expiresAt: Date.now() + tk.expires_in * 1000,
  };
  return tk.access_token;
}

async function importPkcs8Key(pem: string): Promise<CryptoKey> {
  // private_key は \n エスケープを実改行に戻す（wrangler secret に格納する都合）
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function firestoreCreateDoc(
  env: Env,
  collection: string,
  doc: any,
  docId: string
): Promise<any> {
  const token = await getFirestoreAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(docId)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields: jsToFsFields(doc) }),
  });
  if (!r.ok) throw new Error(`Firestore create failed: ${await r.text()}`);
  return await r.json();
}

async function firestoreGetDoc(env: Env, collection: string, docId: string): Promise<any | null> {
  const token = await getFirestoreAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(docId)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore get failed: ${await r.text()}`);
  const doc = await r.json();
  return fsDocToJs(doc);
}

async function firestoreUpdateDoc(
  env: Env,
  collection: string,
  docId: string,
  fields: any
): Promise<any> {
  const token = await getFirestoreAccessToken(env);
  // updateMask で更新するフィールドだけを指定（既存フィールドは保持）
  const fieldPaths = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${encodeURIComponent(docId)}?${fieldPaths}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: jsToFsFields(fields) }),
  });
  if (!r.ok) throw new Error(`Firestore update failed: ${await r.text()}`);
  return await r.json();
}

async function firestoreListDocs(env: Env, collection: string): Promise<any[]> {
  const token = await getFirestoreAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?pageSize=100`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Firestore list failed: ${await r.text()}`);
  const data = (await r.json()) as { documents?: any[] };
  return (data.documents || []).map(fsDocToJs);
}

async function firestoreQueryDocs(
  env: Env,
  collection: string,
  where: { field: string; op: string; value: any },
  options?: { orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" } }
): Promise<any[]> {
  const token = await getFirestoreAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const structuredQuery: any = {
    from: [{ collectionId: collection }],
    where: {
      fieldFilter: {
        field: { fieldPath: where.field },
        op: where.op,
        value: jsToFsValue(where.value),
      },
    },
    limit: 200,
  };
  if (options?.orderBy) {
    // 注：where + orderBy（異なるフィールド）は composite index が必要
    structuredQuery.orderBy = [
      { field: { fieldPath: options.orderBy.field }, direction: options.orderBy.direction },
    ];
  }
  const body = { structuredQuery };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Firestore query failed: ${await r.text()}`);
  const results = (await r.json()) as any[];
  return results.filter((r) => r.document).map((r) => fsDocToJs(r.document));
}

function jsToFsFields(obj: any): any {
  const fields: any = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = jsToFsValue(v);
  return fields;
}

function jsToFsValue(v: any): any {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: v.toString() } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFsValue) } };
  if (typeof v === "object") return { mapValue: { fields: jsToFsFields(v) } };
  return { stringValue: String(v) };
}

function fsDocToJs(doc: any): any {
  const result: any = {};
  if (doc.fields) {
    for (const [k, v] of Object.entries(doc.fields)) result[k] = fsValueToJs(v as any);
  }
  if (doc.name) result._id = doc.name.split("/").pop();
  return result;
}

function fsValueToJs(v: any): any {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fsValueToJs);
  if ("mapValue" in v) {
    const obj: any = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fsValueToJs(val as any);
    return obj;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════
// 共通ユーティリティ
// ═════════════════════════════════════════════════════════════

type SfTokenResponse = {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  id: string;
  token_type: string;
  issued_at: string;
  signature: string;
};

type SfSession = {
  accessToken: string;
  refreshToken: string | null;
  instanceUrl: string;
  issuedAt: number;
  userInfoUrl: string;
  email: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function cors(env: Env, res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers });
}

function randomString(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ("0" + b.toString(16)).slice(-2)).join("").slice(0, len);
}

async function sha256Base64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64UrlEncodeBytes(new Uint8Array(buf));
}

// Base64url encode/decode helpers
function b64UrlEncodeStr(str: string): string {
  return b64UrlEncodeBytes(new TextEncoder().encode(str));
}

function b64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlDecodeStr(input: string): string {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const binary = atob(s);
  // atob は Latin-1 として解釈した文字列を返すため、UTF-8 として再デコードする
  // （JWT の payload に日本語などのマルチバイト文字が含まれる場合に必要）
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function b64UrlToBytes(input: string): ArrayBuffer {
  // バイナリデータ（署名等）のための直接バイト復号
  // b64UrlDecodeStr は UTF-8 文字列向けで、バイナリには使えないため別実装
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
