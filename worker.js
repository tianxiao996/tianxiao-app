var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var EMAIL_FROM = "noreply@tianxiao.us.kg";
var EMAIL_CODE_TTL = 900;
var EMAIL_SEND_COOLDOWN = 60;

// Security state is authoritative in D1. Never fall back to KV for transactions or sessions.
const SECURITY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS security_sessions (user_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS security_email_challenges (purpose TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0, operation_id TEXT NOT NULL, PRIMARY KEY (purpose, user_id, email))`,
  `CREATE TABLE IF NOT EXISTS security_email_rates (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS security_reward_claims (user_id TEXT NOT NULL, reward_key TEXT NOT NULL, operation_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, reward_key))`,
  `CREATE TABLE IF NOT EXISTS security_checkins (user_id TEXT PRIMARY KEY, last_at INTEGER NOT NULL, operation_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS security_download_limits (user_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL, operation_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS security_download_passes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_version INTEGER NOT NULL, url TEXT NOT NULL, expires_at INTEGER NOT NULL, redeemed_token TEXT)`
,`CREATE TABLE IF NOT EXISTS user_avatars (user_id TEXT PRIMARY KEY, object_key TEXT UNIQUE, operation_id TEXT NOT NULL, updated_at INTEGER NOT NULL)`,`CREATE TABLE IF NOT EXISTS avatar_cleanup_queue (object_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`];
const securitySchemaPromises = new WeakMap();
async function ensureSecuritySchema(env) {
  if (!env.DB || typeof env.DB.batch !== "function") throw new Error("D1 security storage unavailable");
  let pending = securitySchemaPromises.get(env.DB);
  if (!pending) {
    pending = env.DB.batch(SECURITY_SCHEMA.map(sql => env.DB.prepare(sql)));
    securitySchemaPromises.set(env.DB, pending);
  }
  try { await pending; } catch (error) { securitySchemaPromises.delete(env.DB); throw error; }
}
function securityId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}
function validCoinAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid coin amount");
  return amount;
}
function changed(result) { return Number(result && result.meta && result.meta.changes || 0) > 0; }
async function getSessionVersion(env, userId) {
  await ensureSecuritySchema(env);
  const row = await env.DB.prepare("SELECT version FROM security_sessions WHERE user_id = ?").bind(userId).first();
  return row ? row.version : 0;
}
async function readBanRecord(env, key) {
  // Storage failures must not silently turn a banned account into an active account.
  const row = await env.DB.prepare("SELECT value, expires_at FROM kv_store WHERE key = ?").bind(key).first();
  if (row) return row.expires_at && row.expires_at <= Date.now() ? null : row.value;
  return env.STORAGE.get(key);
}
async function isActiveDownloadSession(env, userId, version) {
  if (await getSessionVersion(env, userId) !== version) return false;
  if (!await getUserById(userId, env)) return false;
  return !await checkBanStatus(userId, env);
}
async function getVerifiedUserSession(token, env) {
  if (typeof token !== "string" || !token) return null;
  try {
    let info;
    if (token.startsWith("utk.")) {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const signature = await hmacSha256("utoken:" + parts[1], requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
      if (!timingSafeEqualStr(signature, parts[2]) || await kvGet(env, "bl_" + parts[2])) return null;
      info = JSON.parse(decodeURIComponent(escape(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))));
    } else {
      const raw = await kvGet(env, "user_token_" + token);
      if (!raw) return null;
      const legacy = JSON.parse(raw);
      info = { u: legacy.userId, e: legacy.expiresAt, v: legacy.sessionVersion || 0 };
    }
    const version = info.v === undefined ? 0 : info.v;
    if (typeof info.u !== "string" || !info.u || !Number.isFinite(info.e) || Date.now() >= info.e || !Number.isSafeInteger(version) || version < 0) return null;
    if (await getSessionVersion(env, info.u) !== version || !await getUserById(info.u, env)) return null;
    return { userId: info.u, version };
  } catch (_) { return null; }
}
async function issueEmailChallenge(env, request, purpose, userId, email) {
  await ensureSecuritySchema(env);
  const now = Date.now(), op = securityId(), code = generateEmailCode();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rates = [["email:" + email, 60000], ["ip:" + ip, 15000]];
  if (userId) rates.push(["user:" + userId, 60000]);
  const hash = await hmacSha256(JSON.stringify([purpose, userId, email, code]), requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
  const rateKeys = rates.map(r => r[0]);
  const statements = [env.DB.prepare(`INSERT INTO security_email_challenges (purpose, user_id, email, code_hash, expires_at, attempts, consumed, operation_id)
    SELECT ?, ?, ?, ?, ?, 0, 0, ? WHERE NOT EXISTS (SELECT 1 FROM security_email_rates WHERE key IN (${rateKeys.map(() => "?").join(",")}) AND next_at > ?)
    ON CONFLICT(purpose, user_id, email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, consumed = 0, operation_id = excluded.operation_id`)
    .bind(purpose, userId, email, hash, now + EMAIL_CODE_TTL * 1000, op, ...rateKeys, now)];
  for (const [key, interval] of rates) statements.push(env.DB.prepare(`INSERT INTO security_email_rates (key, next_at)
    SELECT ?, ? WHERE EXISTS (SELECT 1 FROM security_email_challenges WHERE purpose = ? AND user_id = ? AND email = ? AND operation_id = ?)
    ON CONFLICT(key) DO UPDATE SET next_at = excluded.next_at`).bind(key, now + interval, purpose, userId, email, op));
  const result = await env.DB.batch(statements);
  if (!changed(result[0])) return { success: false, status: 429, error: "发送太频繁，请稍后重试（同一邮箱或账号间隔60秒）" };
  const sent = await sendEmailCode(email, code, env);
  if (!sent.success) {
    await env.DB.prepare("DELETE FROM security_email_challenges WHERE purpose = ? AND user_id = ? AND email = ? AND operation_id = ?").bind(purpose, userId, email, op).run();
    return { success: false, status: 500, error: sent.error || "发送失败" };
  }
  return { success: true, message: "验证码已发送", retryAfter: 60 };
}
async function consumeEmailChallenge(env, purpose, userId, email, code) {
  await ensureSecuritySchema(env);
  const hash = await hmacSha256(JSON.stringify([purpose, userId, email, String(code)]), requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
  // Increment and successful consumption are one SQL statement. Concurrent guesses cannot reset the counter.
  const row = await env.DB.prepare(`UPDATE security_email_challenges SET attempts = attempts + 1,
    consumed = CASE WHEN code_hash = ? THEN 1 ELSE 0 END
    WHERE purpose = ? AND user_id = ? AND email = ? AND consumed = 0 AND attempts < 5 AND expires_at > ?
    RETURNING consumed, attempts`).bind(hash, purpose, userId, email, Date.now()).first();
  if (row && row.consumed === 1) return { success: true };
  const status = !row || row.attempts >= 5 ? 429 : 400;
  return { success: false, status, error: status === 429 ? "验证码已失效、过期或错误次数过多，请重新发送" : "验证码错误" };
}
async function resetPasswordAndSessions(env, userId, hash) {
  await ensureSecuritySchema(env);
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").bind(hash, userId),
    env.DB.prepare(`INSERT INTO security_sessions (user_id, version) SELECT ?, 1 WHERE changes() > 0
      ON CONFLICT(user_id) DO UPDATE SET version = version + 1`).bind(userId)
  ]);
  if (!changed(result[0])) throw new Error("User unavailable for password reset");
  // Clear the compatibility copies so a later D1 outage cannot authenticate the old password.
  await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind("user_data_" + userId).run();
  await env.STORAGE.delete("user_data_" + userId);
  const user = await getUserById(userId, env);
  if (user) await kvPut(env, "user_data_" + userId, JSON.stringify(user));
}
async function getDownloadLimit(env, userId) {
  await ensureSecuritySchema(env);
  const now = Date.now();
  let row = await env.DB.prepare("SELECT count, reset_at FROM security_download_limits WHERE user_id = ?").bind(userId).first();
  if (!row) {
    const old = await kvGet(env, "dl_count_" + userId);
    let initial = { count: 0, resetAt: now + 86400000 };
    if (old) { try { const data = JSON.parse(old); if (Number.isSafeInteger(data.count) && data.count >= 0 && data.resetAt > now) initial = data; } catch (_) {} }
    await env.DB.prepare("INSERT OR IGNORE INTO security_download_limits (user_id, count, reset_at, operation_id) VALUES (?, ?, ?, '')").bind(userId, initial.count, initial.resetAt).run();
    row = await env.DB.prepare("SELECT count, reset_at FROM security_download_limits WHERE user_id = ?").bind(userId).first();
  }
  return { count: row.reset_at <= now ? 0 : row.count, resetAt: row.reset_at <= now ? now + 86400000 : row.reset_at };
}
async function authorizeDownloadAtomic(env, userId, version, targetUrl, passId, expiresAt) {
  await getDownloadLimit(env, userId);
  const now = Date.now(), op = "txcoin_" + securityId();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE security_download_limits SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END, operation_id = ?
      WHERE user_id = ? AND (reset_at <= ? OR count < 10)
      AND COALESCE((SELECT balance FROM user_coins WHERE user_id = ?), 0) >= 1
      AND COALESCE((SELECT version FROM security_sessions WHERE user_id = ?), 0) = ?`)
      .bind(now, now, now + 86400000, op, userId, now, userId, userId, version),
    env.DB.prepare(`UPDATE user_coins SET balance = balance - 1, updated_at = ? WHERE user_id = ? AND balance >= 1
      AND EXISTS (SELECT 1 FROM security_download_limits WHERE user_id = ? AND operation_id = ?)`)
      .bind(now, userId, userId, op),
    env.DB.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, description, created_at)
      SELECT ?, ?, -1, 'download', '下载文件', ? WHERE changes() > 0`).bind(op, userId, now),
    env.DB.prepare(`INSERT INTO security_download_passes (id, user_id, session_version, url, expires_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM coin_transactions WHERE id = ?)`)
      .bind(passId, userId, version, targetUrl, expiresAt, op),
    env.DB.prepare("SELECT balance FROM user_coins WHERE user_id = ?").bind(userId)
  ]);
  if (!changed(result[0])) {
    const limit = await getDownloadLimit(env, userId);
    return { ok: false, limited: limit.count >= 10, balance: await getFishCoins(env, userId) };
  }
  return { ok: true, balance: result[4].results[0].balance };
}
async function signDownloadPass(env, info) {
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(info)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "v2." + payload + "." + await hmacSha256("dlpass:v2:" + payload, getGhdlSecret(env));
}
async function verifyDownloadPass(env, pass, targetUrl) {
  if (typeof pass !== "string") return null;
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== "v2") return null;
  try {
    const expected = await hmacSha256("dlpass:v2:" + parts[1], getGhdlSecret(env));
    if (!timingSafeEqualStr(expected, parts[2])) return null;
    const info = JSON.parse(decodeURIComponent(escape(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")))));
    if (info.url !== targetUrl || !info.id || !info.u || !Number.isFinite(info.e) || info.e <= Date.now()) return null;
    return await isActiveDownloadSession(env, info.u, info.v) ? info : null;
  } catch (_) { return null; }
}
async function redeemDownloadPass(env, pass, token, info) {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE security_download_passes SET redeemed_token = ?
      WHERE id = ? AND user_id = ? AND session_version = ? AND url = ? AND expires_at > ? AND redeemed_token IS NULL
      AND COALESCE((SELECT version FROM security_sessions WHERE user_id = ?), 0) = ?`)
      .bind(token, pass.id, pass.u, pass.v, pass.url, now, pass.u, pass.v),
    env.DB.prepare(`INSERT INTO kv_store (key, value, expires_at) SELECT ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM security_download_passes WHERE id = ? AND redeemed_token = ?)`)
      .bind("px_tmp_" + token, JSON.stringify(info), now + 90000, pass.id, token)
  ]);
  return changed(result[0]);
}
async function consumeProxyDownload(env, token, pageToken) {
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("DELETE FROM kv_store WHERE key = ? AND value = ? AND expires_at > ?").bind("px_pt_" + pageToken, token, now),
    env.DB.prepare(`UPDATE kv_store SET value = json_set(value, '$.maxDownloads', 0, '$.started', json('true')), expires_at = ?
      WHERE key = ? AND expires_at > ? AND json_extract(value, '$.maxDownloads') > 0 AND changes() > 0`)
      .bind(now + 600000, "px_tmp_" + token, now)
  ]);
  return changed(result[1]);
}
function gatedRewardStatements(env, gate, gateArgs, userId, amount, type, description, op, now, avatar) {
  validCoinAmount(amount);
  const statements = [];
  if (amount > 0) {
    statements.push(env.DB.prepare(`INSERT INTO user_coins (user_id, balance, updated_at) SELECT ?, ?, ? WHERE ${gate}
      ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at`).bind(userId, amount, now, ...gateArgs));
    statements.push(env.DB.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, description, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${gate}`).bind(op, userId, amount, type, description, now, ...gateArgs));
  }
  
  return statements;
}
async function claimMailRewardAtomic(env, userId, mailId, mail, oldMeta) {
  await ensureSecuritySchema(env);
  const op = securityId(), now = Date.now(), key = "mail:" + mailId;
  const fish = oldMeta.rewardClaimed ? 0 : validCoinAmount(mail.fishReward || 0);
  const avatar = null;
  const gate = "EXISTS (SELECT 1 FROM security_reward_claims WHERE user_id = ? AND reward_key = ? AND operation_id = ?)";
  const result = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO security_reward_claims (user_id, reward_key, operation_id, created_at) VALUES (?, ?, ?, ?)").bind(userId, key, op, now),
    ...gatedRewardStatements(env, gate, [userId, key, op], userId, fish, "mail_reward", "邮件奖励", "txcoin_" + op, now, avatar)
  ]);
  return { claimed: changed(result[0]), fish: changed(result[0]) ? fish : 0, avatar: changed(result[0]) && !!(avatar && avatar.url), balance: await getFishCoins(env, userId) };
}
async function claimCheckinAtomic(env, userId) {
  await ensureSecuritySchema(env);
  const now = Date.now(), op = securityId();
  // Preserve the existing rolling 24-hour cooldown on the first request after upgrading.
  const old = Number(await kvGet(env, "user_checkin_" + userId)) || 0;
  await env.DB.prepare("INSERT OR IGNORE INTO security_checkins (user_id, last_at, operation_id) VALUES (?, ?, '')").bind(userId, old).run();
  const gate = "EXISTS (SELECT 1 FROM security_checkins WHERE user_id = ? AND operation_id = ?)";
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE security_checkins SET last_at = ?, operation_id = ? WHERE user_id = ? AND last_at <= ?").bind(now, op, userId, now - 86400000),
    ...gatedRewardStatements(env, gate, [userId, op], userId, 1, "checkin", "每日签到奖励", "txcoin_" + op, now, null)
  ]);
  const row = await env.DB.prepare("SELECT last_at FROM security_checkins WHERE user_id = ?").bind(userId).first();
  return { ok: changed(result[0]), balance: await getFishCoins(env, userId), remainingSeconds: Math.max(0, Math.ceil((row.last_at + 86400000 - now) / 1000)) };
}


function generateEmailCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (1e5 + a[0] % 9e5).toString();
}
__name(generateEmailCode, "generateEmailCode");
__name2(generateEmailCode, "generateEmailCode");
async function sendEmailCode(email, code, env) {
  const apiKey = env.RESEND_API_KEY || "";
  if (!apiKey) return { success: false, error: "RESEND_API_KEY\u672A\u914D\u7F6E" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: email,
      subject: "\u5929\u7B11\u306E\u7A9D - \u767B\u5F55\u9A8C\u8BC1\u7801",
      html: `<div style="font-family:system-ui,sans-serif;max-width:400px;margin:0 auto;padding:20px;">
        <h2 style="color:#333;">\u5929\u7B11\u306E\u7A9D</h2>
        <p style="color:#666;font-size:14px;">\u60A8\u7684\u767B\u5F55\u9A8C\u8BC1\u7801\u662F\uFF1A</p>
        <div style="font-size:32px;font-weight:bold;color:#d94f7b;letter-spacing:8px;padding:16px 0;">${code}</div>
        <p style="color:#999;font-size:12px;">\u9A8C\u8BC1\u78015\u5206\u949F\u5185\u6709\u6548\uFF0C\u8BF7\u52FF\u6CC4\u9732\u7ED9\u4ED6\u4EBA\u3002</p>
      </div>`
    })
  });
  if (res.ok) {
    return { success: true };
  }
  const err = await res.json().catch(() => ({}));
  return { success: false, error: err.message || "\u90AE\u4EF6\u53D1\u9001\u5931\u8D25" };
}
__name(sendEmailCode, "sendEmailCode");
__name2(sendEmailCode, "sendEmailCode");
async function initD1(env) {
  if (!env.DB) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT NOT NULL, avatar TEXT, level INTEGER DEFAULT 1, level_color TEXT, score REAL DEFAULT 0, comment TEXT NOT NULL, created_at INTEGER NOT NULL, reply_to TEXT, reply_to_user TEXT, reply_to_user_id TEXT)`,
    `CREATE TABLE IF NOT EXISTS reply_notifications (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'reply', card_id TEXT NOT NULL, reply_comment_id TEXT NOT NULL, reply_content TEXT NOT NULL, reply_username TEXT NOT NULL, reply_avatar TEXT, reply_level INTEGER DEFAULT 1, parent_content TEXT, parent_username TEXT, target_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, read INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS comment_likes (comment_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (comment_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS proxy_links (id TEXT PRIMARY KEY, slug TEXT NOT NULL, url TEXT NOT NULL, filename TEXT, sig TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_card_id ON comments(card_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reply_notif_target ON reply_notifications(target_user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reply_notif_unread ON reply_notifications(target_user_id, read)`,
    `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT, email TEXT, github_id TEXT, avatar TEXT, exp INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_users_github ON users(github_id)`,
    `CREATE TABLE IF NOT EXISTS user_coins (user_id TEXT PRIMARY KEY, balance INTEGER DEFAULT 0, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS user_items (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, avatar_id TEXT, url TEXT NOT NULL, name TEXT, source TEXT, price INTEGER DEFAULT 0, equipped INTEGER DEFAULT 0, acquired_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_user_items_user ON user_items(user_id)`,
    `CREATE TABLE IF NOT EXISTS coin_transactions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, type TEXT NOT NULL, description TEXT, created_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_user ON coin_transactions(user_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS card_views (card_id TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS card_view_log (card_id TEXT NOT NULL, ip TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (card_id, ip))`
  ];
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      console.error("D1 init error:", e);
    }
  }
}
__name(initD1, "initD1");
__name2(initD1, "initD1");
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://tian-xiao.com",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}
__name(jsonRes, "jsonRes");
__name2(jsonRes, "jsonRes");
var _d1DownUntil = 0;
function _d1Race(promise, ms) {
  return Promise.race([promise, new Promise((_, rj) => setTimeout(() => rj(new Error("D1\u8D85\u65F6\u964D\u7EA7")), ms))]);
}
__name(_d1Race, "_d1Race");
__name2(_d1Race, "_d1Race");
async function _d1Try(promise, ms) {
  if (Date.now() < _d1DownUntil) throw new Error("D1\u7194\u65AD\u4E2D");
  try {
    return await _d1Race(promise, ms);
  } catch (e) {
    _d1DownUntil = Date.now() + 3e4;
    throw e;
  }
}
__name(_d1Try, "_d1Try");
__name2(_d1Try, "_d1Try");
async function kvGet(env, key) {
  try {
    const row = await _d1Try(env.DB.prepare("SELECT value, expires_at FROM kv_store WHERE key = ?").bind(key).first(), 1500);
    if (row) {
      if (row.expires_at && row.expires_at < Date.now()) {
        try {
          await env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run();
        } catch (e) {
        }
        return null;
      }
      return row.value;
    }
  } catch (e) {
  }
  try {
    return await env.STORAGE.get(key);
  } catch (e) {
    return null;
  }
}
__name(kvGet, "kvGet");
__name2(kvGet, "kvGet");
async function kvPut(env, key, value, opts) {
  let expiresAt = null;
  if (opts && opts.expirationTtl) expiresAt = Date.now() + opts.expirationTtl * 1e3;
  else if (opts && opts.expiration) expiresAt = opts.expiration * 1e3;
  try {
    await _d1Try(env.DB.prepare("INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)").bind(key, value, expiresAt).run(), 2500);
    return;
  } catch (e) {
  }
  await env.STORAGE.put(key, value, opts);
}
__name(kvPut, "kvPut");
__name2(kvPut, "kvPut");
async function kvDelete(env, key) {
  try {
    await _d1Try(env.DB.prepare("DELETE FROM kv_store WHERE key = ?").bind(key).run(), 2500);
  } catch (e) {
  }
  try {
    await env.STORAGE.delete(key);
  } catch (e) {
  }
}
__name(kvDelete, "kvDelete");
__name2(kvDelete, "kvDelete");
async function kvList(env, prefixOrOpts, limitArg) {
  let prefix = "", limit = 1e3, offset = 0;
  if (typeof prefixOrOpts === "object" && prefixOrOpts !== null) {
    prefix = prefixOrOpts.prefix || "";
    limit = prefixOrOpts.limit || 1e3;
    if (prefixOrOpts.cursor) offset = parseInt(prefixOrOpts.cursor, 10) || 0;
  } else {
    prefix = prefixOrOpts || "";
    if (limitArg) limit = limitArg;
  }
  const like = prefix.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
  let rows;
  try {
    rows = await _d1Try(env.DB.prepare("SELECT key FROM kv_store WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ? OFFSET ?").bind(like, Date.now(), limit + 1, offset).all(), 2500);
  } catch (e) {
    const kvPage = await env.STORAGE.list({ prefix, limit });
    return { keys: kvPage.keys, list_complete: true };
  }
  const results = rows.results || [];
  const complete = results.length <= limit;
  const keys = results.slice(0, limit).map((r) => ({ name: r.key }));
  return complete ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(offset + limit) };
}
__name(kvList, "kvList");
__name2(kvList, "kvList");
var ADMIN_PANELS = { header: `<div id="adminBar" style="display: none;">
<div id="adminBarToggleRow" style="max-width:900px;margin:0 auto 8px auto;display:flex;justify-content:center;">
<button id="adminBarToggleBtn" onclick="toggleAdminBarCollapse()" style="background:#555!important;padding:4px 20px;font-size:12px;border-radius:20px;min-width:unset!important;max-width:unset!important;flex:unset!important;">\u25B2 \u6536\u8D77\u9762\u677F</button>
</div>
<!-- \u786E\u4FDD\u9762\u677F\u9ED8\u8BA4\u5C55\u5F00\uFF1A\u4E0D\u8BBE\u7F6E style="display:none" -->
<div id="adminBarBtns" data-force-visible="true">
<button onclick="addCard()">\u2795 \u65B0\u589E</button>
<button class="btn-save" onclick="saveToCloud()">\u2601\uFE0F \u4FDD\u5B58\u4E91\u7AEF</button>
<button onclick="toggleCatPanel()" style="background:#333!important;">\u{1F3F7}\uFE0F \u5206\u7C7B</button>
<button onclick="toggleBannerEdit()" style="background:#878787!important;">\u{1F5BC}\uFE0F \u8F6E\u64AD\u56FE</button>
<button onclick="openGalleryPanel()" style="background:#673ab7!important;">\u{1F4D6} \u50BB\u5B50\u5FC5\u770B</button>
<button onclick="toggleShortlinkPanel()" style="background:#7b7b7b!important;">\u{1F517} \u77ED\u94FE</button>
<button onclick="exportHTML()" style="background:#17a2b8!important;">\u{1F4BE} \u5BFC\u51FA\u5907\u4EFD</button>
<button onclick="migrateAllLinksToKV()" style="background:#c62828!important;">\u{1F512} \u8FC1\u79FB\u94FE\u63A5</button>
<button onclick="recoverLinks()" style="background:#ff5722!important;">\u{1F504} \u6062\u590D\u94FE\u63A5</button>
<button onclick="debugCardStructure()" style="background:#333!important;">\u{1F41B} \u8C03\u8BD5</button>
<button onclick="setInviteCode()" style="background:#673ab7!important;">\u{1F3AB} \u9080\u8BF7\u7801</button>
<button onclick="openUserQueryPanel()" style="background:#2196f3!important;">\u{1F50D} \u67E5\u7528\u6237</button>
<button onclick="openWordlistPanel()" style="background:#00796b!important;">\u{1F6AB} \u5C4F\u853D\u8BCD</button>
<select id="imgbedFolderSelect" onchange="localStorage.setItem('imgbed_folder',this.value)" style="flex:1 1 calc(33.333% - 7px);min-width:calc(33.333% - 7px);max-width:calc(33.333% - 7px);cursor:pointer;border:1px solid rgba(0,0,0,.15);border-radius:6px;padding:10px;background:#607d8b;color:#fff;font-weight:bold;font-size:12px;box-sizing:border-box;text-align:center;text-align-last:center"><option value="">\u{1F4C2} \u56FE\u5E8A\u6587\u4EF6\u5939</option></select>

<button onclick="openMailManagePanel()" style="background:#7d7d7d!important;">\u{1F4E7} \u53D1\u90AE\u4EF6</button>
<button onclick="openLinkProxyPanel()" style="background:#555!important;">\u{1F517} \u94FE\u63A5\u4EE3\u7406</button>
<button onclick="openProxyManagePanel()" style="background:#795548!important;">\u{1F4CB} \u7BA1\u7406\u4EE3\u7406\u94FE\u63A5</button>
<button id="adminAuditBtn" onclick="toggleAdminAuditMode()" style="background:#7d7d7d!important;">\u{1F4AC} \u5BA1\u6838\u8BC4\u8BBA</button>
<button onclick="openVerifyQuestionsPanel()" style="background:#009688!important;">\u{1F4DD} \u5BFC\u5165\u9A8C\u8BC1\u95EE\u9898</button>
<button onclick="fixLinkFormatV2()" style="background:#ff9800!important">\u{1F527} \u4FEE\u590D\u683C\u5F0F</button>
<button class="btn-exit" onclick="exitAdmin()">\u{1F6AA} \u9000\u51FA</button></div>
</div>
<!-- \u{1F3F7}\uFE0F \u5206\u7C7B\u7BA1\u7406\u9762\u677F -->
<!-- \u{1F3AB} \u9080\u8BF7\u7801\u7BA1\u7406\u9762\u677F -->
<div id="inviteCodePanel" style="display:none; background:#efefef; border:1px dashed #7b7b7b; border-radius:12px; padding:14px; margin:0 auto 12px auto; max-width:600px;">
<div style="font-size:13px; font-weight:bold; color:#6a1b9a; margin-bottom:10px;">\u{1F3AB} \u9080\u8BF7\u7801\u7BA1\u7406</div>
<!-- \u6C38\u4E45\u9080\u8BF7\u7801 -->
<div style="background:#fff; border-radius:10px; padding:12px; margin-bottom:10px; border:1px solid #aaa;">
<div style="font-size:12px; font-weight:bold; color:#6a1b9a; margin-bottom:6px;">\u{1F511} \u6C38\u4E45\u9080\u8BF7\u7801\uFF08\u53EF\u91CD\u590D\u4F7F\u7528\uFF0C\u624B\u52A8\u66F4\u6362\u624D\u5931\u6548\uFF09</div>
<div style="font-size:13px; margin-bottom:8px;">\u5F53\u524D\uFF1A<b id="permanentInviteDisplay" style="font-family:monospace;color:#6a1b9a;">\u52A0\u8F7D\u4E2D...</b></div>
<div style="display:flex; gap:8px;">
<input type="text" id="permanentInviteInput" placeholder="\u8F93\u5165\u65B0\u7684\u6C38\u4E45\u9080\u8BF7\u7801" style="flex:1;border:1px solid #aaa;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;min-width:0;">
<button onclick="setPermanentInvite()" style="background:#7b7b7b;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:bold;cursor:pointer;flex-shrink:0;">\u66F4\u65B0</button>

</div>
</div>
<!-- \u4E00\u6B21\u6027\u9080\u8BF7\u7801 -->
<div style="background:#fff; border-radius:10px; padding:12px; margin-bottom:10px; border:1px solid #aaa;">
<div style="font-size:12px; font-weight:bold; color:#6a1b9a; margin-bottom:6px;">\u{1F39F}\uFE0F \u4E00\u6B21\u6027\u9080\u8BF7\u7801\uFF08\u7528\u5B8C\u5373\u5931\u6548\uFF09<span id="onetimeInviteCount" style="font-weight:normal;color:#aaa;margin-left:6px;">\u5171 0 \u4E2A</span></div>
<div style="display:flex; gap:8px; margin-bottom:10px; align-items:center;">
<span style="font-size:12px;color:#666;flex-shrink:0;">\u751F\u6210\u6570\u91CF\uFF1A</span>
<input type="number" id="onetimeCount" value="1" min="1" max="20" style="width:60px;border:1px solid #aaa;border-radius:8px;padding:6px 8px;font-size:13px;outline:none;">
<button onclick="genOnetimeInvites()" style="background:#7b7b7b;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:bold;cursor:pointer;">\u751F\u6210</button>
<button onclick="loadOnetimeInvites()" style="background:#7b1fa2;color:#fff;border:none;border-radius:8px;padding:8px 10px;font-size:13px;cursor:pointer;">\u{1F504}</button>
</div>
<div id="onetimeInviteList" style="display:flex;flex-wrap:wrap;gap:6px;max-height:120px;overflow-y:auto;">
<span style="font-size:12px;color:#aaa;">\u70B9\u51FB\u5237\u65B0\u67E5\u770B\u5217\u8868</span>
</div>
</div>
</div>
<!-- \u{1F50D} \u7528\u6237\u67E5\u8BE2\u9762\u677F\uFF08\u7BA1\u7406\u5458\uFF09 -->
<div id="userQueryPanel" style="display:none; background:#e3f2fd; border:1px dashed #2196f3; border-radius:12px; padding:12px; margin:0 auto 12px auto; max-width:550px;">
<div style="font-size:13px; font-weight:bold; color:#1565c0; margin-bottom:10px;">\u{1F50D} \u7528\u6237\u67E5\u8BE2</div>
<div style="display:flex; gap:8px; margin-bottom:10px;">
<input type="text" id="userQueryInput" placeholder="\u8F93\u5165\u7528\u6237\u540D\u6216\u8D26\u53F7ID..." style="flex:1; border:1px solid #90caf9; border-radius:8px; padding:8px 10px; font-size:13px; outline:none; min-width:0;">
<button onclick="queryUser()" style="background:#2196f3; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; font-weight:bold; cursor:pointer; flex-shrink:0;">\u67E5\u8BE2</button>
</div>
<div id="userQueryResult" style="display:none; flex-direction:column; gap:8px;"></div>
</div>
<!-- \u{1F6AB} \u5C4F\u853D\u8BCD\u7BA1\u7406\u9762\u677F\uFF08\u7BA1\u7406\u5458\uFF09 -->
<div id="wordlistPanel" style="display:none; background:#eee; border:1px dashed #388e3c; border-radius:12px; padding:14px; margin:0 auto 12px auto; max-width:560px;">
<div style="font-size:13px; font-weight:bold; color:#1b5e20; margin-bottom:10px;">\u{1F6AB} \u8BC4\u8BBA\u5C4F\u853D\u8BCD\u7BA1\u7406</div>
<div style="background:#fff; border-radius:10px; padding:12px; margin-bottom:10px; border:1px solid #bbb;">
<div style="font-size:12px; font-weight:bold; color:#2e7d32; margin-bottom:8px;">\u{1F4E5} \u5BFC\u5165 TXT \u6587\u4EF6\uFF08\u6BCF\u884C\u4E00\u4E2A\u8BCD\uFF0C\u6587\u4EF6\u540D\u5373\u5408\u96C6\u540D\uFF09\u5C4F\u853D\u8BCD\u540C\u65F6\u4F5C\u7528\u4E8E\u8BC4\u8BBA\u548C\u7528\u6237\u540D\u6CE8\u518C</div>
<label style="display:flex; align-items:center; gap:8px; padding:10px 12px; border:1.5px dashed #999; border-radius:8px; cursor:pointer; font-size:13px; color:#555; background:#f3f3f3;">
<span style="font-size:18px;">\u{1F4C2}</span>
<span id="wordlistFileName">\u70B9\u51FB\u9009\u62E9 .txt \u6587\u4EF6</span>
<input type="file" id="wordlistFileInput" accept=".txt" style="display:none;" onchange="onWordlistFileSelect(this)">
</label>
<div id="wordlistPreview" style="display:none; margin-top:8px; font-size:12px; color:#555; background:#f0f0f0; border-radius:8px; padding:8px 10px;">
\u5408\u96C6\u540D\uFF1A<b id="wordlistPreviewName" style="color:#2e7d32;"></b> &nbsp;\xB7&nbsp; \u8BCD\u6570\uFF1A<b id="wordlistPreviewCount" style="color:#2e7d32;"></b>
</div>
<button onclick="uploadWordlist()" style="margin-top:10px; width:100%; background:#388e3c; color:#fff; border:none; border-radius:8px; padding:9px; font-size:13px; font-weight:bold; cursor:pointer;">\u2B06\uFE0F \u5BFC\u5165\u5408\u96C6</button>
</div>
<div style="background:#fff; border-radius:10px; padding:12px; border:1px solid #bbb;">
<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
<div style="font-size:12px; font-weight:bold; color:#2e7d32;">\u{1F4CB} \u5DF2\u6709\u5408\u96C6</div>
<button onclick="loadWordlistCollections()" style="background:#555; color:#fff; border:none; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer;">\u{1F504} \u5237\u65B0</button>
</div>
<div id="wordlistCollectionList" style="display:flex; flex-direction:column; gap:6px; max-height:200px; overflow-y:auto;">
<div style="font-size:12px; color:#aaa; text-align:center; padding:10px;">\u70B9\u51FB\u5237\u65B0\u67E5\u770B</div>
</div>
</div>
</div>
<div id="catPanel">
<div class="cat-panel-title">\u{1F3F7}\uFE0F \u5206\u7C7B\u7BA1\u7406\uFF08\u65B0\u589E / \u6392\u5E8F / \u5220\u9664\uFF09</div>
<div class="cat-add-row">
<input type="text" id="catEmojiInput" placeholder="emoji\uFF08\u53EF\u9009\uFF09" style="max-width:80px;">
<input type="text" id="catNameInput" placeholder="\u5206\u7C7B\u540D\u79F0\uFF08\u5FC5\u586B\uFF09">
<button class="cat-add-btn" onclick="addCategory()">\uFF0B \u6DFB\u52A0</button>
</div>
<div class="cat-list" id="catList"></div>
<button class="cat-save-btn" onclick="saveCategoryOrder()">\u2705 \u4FDD\u5B58\u5E76\u66F4\u65B0\u5BFC\u822A</button>
</div>
<!-- \u{1F4E7} \u90AE\u4EF6\u7BA1\u7406\u9762\u677F\uFF08\u7BA1\u7406\u5458\uFF09 -->
<div id="mailManagePanel" style="display:none; background:#f0f0f0; border:1px dashed #878787; border-radius:12px; padding:14px; margin:0 auto 12px auto; max-width:600px;">
<div style="font-size:13px; font-weight:bold; color:#333; margin-bottom:10px;">\u{1F4E7} \u53D1\u9001\u90AE\u4EF6</div>
<div style="background:#fff; border-radius:10px; padding:12px; border:1px solid #ababab;">
<div style="display:flex; flex-direction:column; gap:6px;">
<input type="text" id="mailTitleInput" placeholder="\u90AE\u4EF6\u6807\u9898" style="border:1px solid #ababab;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;">
<textarea id="mailContentInput" placeholder="\u90AE\u4EF6\u5185\u5BB9" rows="4" style="border:1px solid #ababab;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;resize:vertical;"></textarea>
<div style="display:flex; gap:8px;">
<input type="number" id="mailExpireInput" placeholder="\u6709\u6548\u671F(\u5929)\uFF0C0=\u6C38\u4E45" min="0" value="7" style="flex:1;border:1px solid #ababab;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;">
<input type="number" id="mailFishInput" placeholder="\u5C0F\u9C7C\u5E72\u5956\u52B1" min="0" value="0" style="flex:1;border:1px solid #ababab;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;">
</div>


<button onclick="sendAdminMail()" style="background:#878787;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:bold;cursor:pointer;">\u{1F4E7} \u53D1\u9001\u7ED9\u6240\u6709\u7528\u6237</button>
</div>
</div>
<div style="font-size:12px; font-weight:bold; color:#333; margin:10px 0 8px;display:flex;align-items:center;justify-content:space-between;">
\u{1F4CB} \u5DF2\u53D1\u9001\u90AE\u4EF6
<button onclick="cleanupExpiredMails()" style="background:#f2f2f2;color:#333;border:none;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;">\u{1F5D1}\uFE0F \u6E05\u7406\u8FC7\u671F\u90AE\u4EF6</button>
</div>
<div id="adminMailList" style="max-height:200px;overflow-y:auto;"></div>
</div>
<!-- \u{1F4CB} \u4EE3\u7406\u94FE\u63A5\u6279\u91CF\u7BA1\u7406\u9762\u677F\uFF08\u7BA1\u7406\u5458\uFF09\u2014 \u72EC\u7ACB\u9762\u677F\uFF0C\u7BA1\u7406\u6240\u6709\u5DF2\u4FDD\u5B58\u7684\u4EE3\u7406\u94FE\u63A5 -->
<div id="proxyManagePanel" style="display:none; background:#ddd; border:1px dashed #795548; border-radius:12px; padding:14px; margin:0 auto 12px auto; max-width:600px;">
<div style="font-size:13px; font-weight:bold; color:#333; margin-bottom:10px;">\u{1F4CB} \u4EE3\u7406\u94FE\u63A5\u6279\u91CF\u7BA1\u7406</div>
<div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; padding:8px 10px; background:#f0f0f0; border-radius:8px; border:1px solid #ddd;">
<input type="checkbox" id="proxyManageSelectAll" onchange="toggleProxyManageSelectAll(this)" style="cursor:pointer; width:16px; height:16px;">
<label for="proxyManageSelectAll" style="font-size:12px; color:#333; cursor:pointer; font-weight:bold;">\u5168\u9009</label>
<span id="proxyManageCount" style="font-size:11px; color:#888; margin-left:4px;">(0/0)</span>
<button onclick="batchDeleteProxyManage()" style="margin-left:auto; background:#333; color:#fff; border:none; border-radius:6px; padding:6px 14px; font-size:12px; cursor:pointer; font-weight:bold;">\u{1F5D1}\uFE0F \u6279\u91CF\u5220\u9664</button>
</div>
<div id="proxyManageList" style="display:flex; flex-direction:column; gap:6px; max-height:400px; overflow-y:auto;">
<div style="font-size:12px; color:#aaa; text-align:center; padding:20px;">\u70B9\u51FB\u5237\u65B0\u6309\u94AE\u52A0\u8F7D\u5217\u8868</div>
</div>
<div style="display:flex; gap:8px; margin-top:10px;">
<button onclick="loadProxyManageList()" style="flex:1; background:#795548; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:13px; cursor:pointer; font-weight:bold;">\u{1F504} \u5237\u65B0\u5217\u8868</button>
</div>
</div>
<!-- \u{1F517} \u94FE\u63A5\u4EE3\u7406\u9762\u677F\uFF08\u7BA1\u7406\u5458\uFF09\u2014 \u5C06GitHub\u7B49\u94FE\u63A5\u8F6C\u6362\u4E3A\u4F60\u7684\u57DF\u540D\u4EE3\u7406\u94FE\u63A5\uFF0C\u62B9\u9664\u6E90\u7AD9\u75D5\u8FF9 -->
<div id="linkProxyPanel" style="display:none; background:#eee; border:1px dashed #555; border-radius:12px; padding:14px; margin:0 auto 12px auto; max-width:600px;">
<div style="font-size:13px; font-weight:bold; color:#2e7d32; margin-bottom:10px;">\u{1F517} \u94FE\u63A5\u4EE3\u7406\u8F6C\u6362\uFF08\u9690\u85CF\u771F\u5B9E\u6765\u6E90\uFF09</div>
<div style="background:#fff; border-radius:10px; padding:12px; border:1px solid #bbb;">
<div style="font-size:12px; color:#666; margin-bottom:8px;">\u8F93\u5165GitHub\u7B49\u76F4\u94FE\uFF0C\u8F6C\u6362\u4E3A\u4F60\u7684\u57DF\u540D\u4EE3\u7406\u94FE\u63A5\uFF0CF12\u4E5F\u8FFD\u8E2A\u4E0D\u5230\u6E90\u7AD9</div>
<div style="display:flex; flex-direction:column; gap:6px;">
<input type="text" id="linkProxyInput" placeholder="\u7C98\u8D34\u539F\u59CB\u94FE\u63A5\uFF08\u5982 https://github.com/...\uFF09" style="border:1px solid #bbb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;">
<input type="text" id="linkProxyName" placeholder="\u6587\u4EF6\u540D\uFF08\u53EF\u9009\uFF0C\u5982 A146.dat\uFF09" style="border:1px solid #bbb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;">
<button onclick="convertLinkProxy()" style="background:#555;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:bold;cursor:pointer;font-family:inherit;">\u{1F504} \u8F6C\u6362\u94FE\u63A5</button>
</div>
<div id="linkProxyResult" style="display:none; margin-top:10px; padding:10px; background:#f0f0f0; border-radius:8px; border:1px solid #ccc;">
<div style="font-size:11px; color:#558b2f; font-weight:bold; margin-bottom:4px;">\u2705 \u8F6C\u6362\u6210\u529F\uFF01\u590D\u5236\u4E0B\u65B9\u94FE\u63A5\u4F7F\u7528\uFF1A</div>
<div id="linkProxyOutput" style="font-size:12px; color:#2e7d32; word-break:break-all; background:#fff; padding:6px 8px; border-radius:4px; border:1px solid #bbb; font-family:monospace;"></div>
<div style="display:flex; gap:6px; margin-top:8px;">
<button onclick="copyLinkProxy()" style="flex:1; background:#555;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;cursor:pointer;">\u{1F4CB} \u590D\u5236\u94FE\u63A5</button>
<button onclick="useLinkProxyInCard()" style="flex:1; background:#42a5f5;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;cursor:pointer;">\u{1F4E5} \u586B\u5165\u5F53\u524D\u5361\u7247\u4E0B\u8F7D\u6846</button>
</div>
</div>
</div>
<!-- \u23F1\uFE0F \u4E34\u65F6\u76F4\u94FE\u751F\u6210\u5DE5\u5177 -->
<div style="background:#fff; border-radius:10px; padding:12px; border:1px solid #bbb; margin-top:10px;">
<div style="font-size:12px; font-weight:bold; color:#333; margin-bottom:8px;">\u23F1\uFE0F \u4E34\u65F6\u76F4\u94FE\u751F\u6210\uFF0830\u5206\u949F\u6709\u6548\u671F\uFF09</div>
<div style="font-size:11px; color:#666; margin-bottom:8px;">\u8F93\u5165\u539F\u59CB\u94FE\u63A5\uFF0C\u751F\u621030\u5206\u949F\u6709\u6548\u7684\u4E34\u65F6\u4E0B\u8F7D\u76F4\u94FE\uFF08\u65E0\u9700\u4FDD\u5B58\u5230\u6570\u636E\u5E93\uFF09</div>
<div style="display:flex; flex-direction:column; gap:6px;">
<input type="text" id="tempLinkInput" placeholder="\u7C98\u8D34\u539F\u59CB\u94FE\u63A5\uFF08\u5982 https://huggingface.co/...\uFF09" style="border:1px solid #c3c3c3;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;">
<input type="text" id="tempLinkName" placeholder="\u6587\u4EF6\u540D\uFF08\u53EF\u9009\uFF09" style="border:1px solid #c3c3c3;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit;">
<button onclick="generateTempProxyLink()" style="background:#878787;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:bold;cursor:pointer;font-family:inherit;">\u23F1\uFE0F \u751F\u621030\u5206\u949F\u4E34\u65F6\u76F4\u94FE</button>
</div>
<div id="tempLinkResult" style="display:none; margin-top:10px; padding:10px; background:#f2f2f2; border-radius:8px; border:1px solid #ddd;">
<div style="font-size:11px; color:#333; font-weight:bold; margin-bottom:4px;">\u2705 \u4E34\u65F6\u76F4\u94FE\u5DF2\u751F\u6210\uFF0830\u5206\u949F\u5185\u6709\u6548\uFF09\uFF1A</div>
<div id="tempLinkOutput" style="font-size:12px; color:#333; word-break:break-all; background:#fff; padding:6px 8px; border-radius:4px; border:1px solid #c3c3c3; font-family:monospace;"></div>
<div style="display:flex; gap:6px; margin-top:8px;">
<button onclick="copyTempLink()" style="flex:1; background:#999999;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;cursor:pointer;">\u{1F4CB} \u590D\u5236\u94FE\u63A5</button>
<button onclick="useTempLinkInCard()" style="flex:1; background:#42a5f5;color:#fff;border:none;border-radius:6px;padding:6px;font-size:12px;cursor:pointer;">\u{1F4E5} \u586B\u5165\u5F53\u524D\u5361\u7247\u4E0B\u8F7D\u6846</button>
</div>
</div>
</div>
</div>`, main: `<!-- \u7BA1\u7406\u5458Banner\u7F16\u8F91\u9762\u677F\uFF08\u4EC5\u7BA1\u7406\u6A21\u5F0F\u663E\u793A\uFF09 -->
<div id="bannerEditPanel">
<div class="banner-edit-title">\u{1F5BC}\uFE0F \u8F6E\u64AD\u56FE\u7BA1\u7406\uFF08\u70B9\u51FB\u56FE\u7247\u53EF\u8DF3\u8F6C\u94FE\u63A5\uFF09</div>
<div id="bannerSlideList"></div>
<button class="banner-add-btn" onclick="addBannerSlide()">\uFF0B \u6DFB\u52A0\u4E00\u5F20\u56FE\u7247</button>
<button class="banner-save-btn" onclick="saveBannerConfig()">\u{1F4BE} \u4FDD\u5B58\u8F6E\u64AD\u56FE</button>
</div>
<!-- \u77ED\u94FE\u7BA1\u7406\u9762\u677F\uFF08\u4EC5\u7BA1\u7406\u6A21\u5F0F\u663E\u793A\uFF09 -->
<div id="shortlinkPanel">
<div class="sl-title">\u{1F517} \u84DD\u594F\u4E91\u77ED\u94FE\u7BA1\u7406\uFF08\u9690\u85CF\u771F\u5B9E\u94FE\u63A5\uFF09</div>
<div class="sl-input-row">
<input type="text" id="slInputUrl" placeholder="\u7C98\u8D34\u84DD\u594F\u4E91\u94FE\u63A5...">
</div>
<div class="sl-input-row">
<input type="text" id="slInputLabel" placeholder="\u5907\u6CE8\uFF08\u53EF\u9009\uFF0C\u5982\uFF1AA46\u6E38\u620F\u672C\u4F53\uFF09">
</div>
<button class="sl-btn sl-btn-add" onclick="addShortlink()">\u26A1 \u751F\u6210\u77ED\u94FE</button>
<div class="sl-result" id="slResult">
<div class="sl-result-url" id="slResultUrl"></div>
<button class="sl-result-copy" onclick="copyShortlink()">\u{1F4CB} \u590D\u5236\u77ED\u94FE\uFF08\u7C98\u8D34\u5230\u5361\u7247\u94FE\u63A5\u91CC\uFF09</button>
</div>
<!-- HF\u6587\u4EF6\u76F4\u94FE\u533A\u57DF -->
<div style="border-top:1px dashed #aaa;margin:12px 0 10px 0;"></div>
<div class="sl-title">\u2601\uFE0F HF\u6587\u4EF6\u76F4\u94FE\uFF08\u79C1\u6709\u4ED3\u5E93\uFF0C\u9690\u85CF\u771F\u5B9E\u5730\u5740\uFF09</div>
<div class="sl-input-row">
<input type="text" id="hfInputFilename" placeholder="\u6587\u4EF6\u540D\uFF0C\u5982\uFF1Agame_v1.0.zip">
</div>
<div class="sl-input-row">
<input type="text" id="hfInputLabel" placeholder="\u5907\u6CE8\uFF08\u53EF\u9009\uFF09">
</div>
<button class="sl-btn sl-btn-add" style="background:#2196f3;" onclick="addHFLink()">\u2601\uFE0F \u751F\u6210HF\u76F4\u94FE</button>
<div class="sl-result" id="hfResult">
<div class="sl-result-url" id="hfResultUrl"></div>
<button class="sl-result-copy" onclick="copyHFLink()">\u{1F4CB} \u590D\u5236\u76F4\u94FE\uFF08\u7C98\u8D34\u5230\u5361\u7247\u76F4\u94FE\u91CC\uFF09</button>
</div>
</div>` };
function safeJsonRes(data, status = 500) {
  if (status >= 500 && data.error) {
    data.error = "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
  }
  return jsonRes(data, status);
}
__name(safeJsonRes, "safeJsonRes");
__name2(safeJsonRes, "safeJsonRes");
async function getGithubAccessToken(code, env) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code
    })
  });
  const data = await res.json();
  return data.access_token || null;
}
__name(getGithubAccessToken, "getGithubAccessToken");
__name2(getGithubAccessToken, "getGithubAccessToken");
async function getGithubUser(accessToken) {
  const res = await fetch("https://api.github.com/user", {
    headers: { "Authorization": `Bearer ${accessToken}`, "User-Agent": "tianxiao-app" }
  });
  return await res.json();
}
__name(getGithubUser, "getGithubUser");
__name2(getGithubUser, "getGithubUser");
function generateOAuthState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(generateOAuthState, "generateOAuthState");
__name2(generateOAuthState, "generateOAuthState");
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hashPassword, "hashPassword");
__name2(hashPassword, "hashPassword");
function timingSafeEqualStr(a, b) {
  const ba = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  const len = Math.max(ba.length, bb.length, 1);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i % ba.length] || 0) ^ (bb[i % bb.length] || 0);
  }
  return diff === 0;
}
__name(timingSafeEqualStr, "timingSafeEqualStr");
__name2(timingSafeEqualStr, "timingSafeEqualStr");
function _u8ToHex(u8) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(_u8ToHex, "_u8ToHex");
async function hashPasswordPBKDF2(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 1e5 }, key, 256);
  return "pbkdf2$100000$" + _u8ToHex(salt) + "$" + _u8ToHex(new Uint8Array(bits));
}
__name(hashPasswordPBKDF2, "hashPasswordPBKDF2");
__name2(hashPasswordPBKDF2, "hashPasswordPBKDF2");
async function verifyPassword(password, stored) {
  if (!stored) return { ok: false, migrated: null };
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return { ok: false, migrated: null };
    const iterations = parseInt(parts[1], 10) || 1e5;
    const saltHex = parts[2];
    if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0) return { ok: false, migrated: null };
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    return { ok: timingSafeEqualStr(_u8ToHex(new Uint8Array(bits)), parts[3].toLowerCase()), migrated: null };
  }
  const legacyHash = await hashPassword(password);
  if (timingSafeEqualStr(legacyHash, stored)) {
    return { ok: true, migrated: await hashPasswordPBKDF2(password) };
  }
  return { ok: false, migrated: null };
}
__name(verifyPassword, "verifyPassword");
__name2(verifyPassword, "verifyPassword");
function generateUserId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "tx_" + Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}
__name(generateUserId, "generateUserId");
__name2(generateUserId, "generateUserId");
async function generateSequentialUserId(env) {
  try {
    const row = await env.DB.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(user_id, 3) AS INTEGER)), 0) + 1 AS next_id FROM users WHERE user_id GLOB 'tx[0-9]*' AND user_id NOT LIKE 'tx\\_%' ESCAPE '\\'").first();
    return "tx" + (row ? row.next_id : 1);
  } catch (e) {
    return generateUserId();
  }
}
__name(generateSequentialUserId, "generateSequentialUserId");
__name2(generateSequentialUserId, "generateSequentialUserId");
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
__name2(escapeHtml, "escapeHtml");
function renderCardsFromData(cardsData) {
  return cardsData.map((card, index) => {
    const title = escapeHtml(card.title || "\u6807\u9898...");
    const tags = escapeHtml(card.tags || "\u6807\u7B7E:");
    const desc = escapeHtml(card.desc || "").replace(/\n/g, "<br>").replace(/^(<br>)+|(<br>)+$/g, "");
    const linkText = escapeHtml((card.linkText || "").replace(/\t/g, "|"));
    const isPinned = card.isPinned ? "is-pinned" : "";
    const isFav = card.isFav ? "is-fav" : "";
    const directDl = escapeHtml(card.directDl || "");
    const images = (card.images || []).filter((u) => typeof u === "string" && u.startsWith("http"));
    const imgCount = Math.max(images.length, 1);
    let imgsHtml = '<img class="active" loading="lazy" src="https://via.placeholder.com/400x300?text=No+Image" draggable="false">';
    if (images.length > 0) {
      imgsHtml = images.map((url, i) => '<img class="' + (i === 0 ? "active" : "") + '" loading="lazy" src="' + escapeHtml(url) + '" draggable="false">').join("");
    }
    const favBtns = Array(imgCount).fill('<div class="fav-btn" onclick="toggleFavorite(this)">\u{1F90D}</div>').join("");
    const cardId = card.id ? escapeHtml(String(card.id)) : "card_" + Date.now() + "_" + index;
    return '<div class="card ' + isPinned + " " + isFav + '" data-card-id="' + cardId + '" data-direct-download="' + directDl + '"><div class="pin-btn" onclick="togglePin(this)">\u{1F4CC}</div><div class="del-btn" onclick="deleteCard(this)">\xD7</div><div class="slider-box"><button class="edit-img-btn" onclick="editCurrentImg(this);return false;">\u{1F517} \u66F4\u6362\u56FE\u7247</button><button class="slide-btn prev" onclick="changeSlide(this, -1)">\u2039</button>' + imgsHtml + '<button class="slide-btn next" onclick="changeSlide(this, 1)">\u203A</button><div class="img-index">1 / ' + imgCount + "</div>" + favBtns + '<button class="img-add-btn" onclick="addImgSlot(this)">\u2795 \u52A0\u56FE</button><button class="img-del-btn" onclick="delImgSlot(this)">\u{1F5D1}\uFE0F \u5220\u56FE</button></div><div class="info-box"><div class="g-name" onclick="handleNameClick(this)">' + title + '</div><div class="g-tags" onclick="handleTagsClick(this)">' + tags + '</div><div class="desc-wrap"><div class="desc-text" onclick="handleDescClick(this)">' + desc + '</div><div class="desc-expand-btn" onclick="toggleDescExpand(this)">\u5C55\u5F00\u7B80\u4ECB \u25BE</div></div><div class="link-wrap"><div class="link-text" data-kv-placeholder="1">' + linkText + '</div><div class="expand-btn" onclick="toggleExpand(this)">\u5C55\u5F00 \u25BE</div></div><div class="direct-dl-edit"><input class="direct-dl-input" type="text" placeholder="\u76F4\u63A5\u4E0B\u8F7D\u77ED\u94FE\uFF08\u9009\u586B\uFF0C\u975E\u7BA1\u7406\u5458\u4E0D\u53EF\u89C1\uFF09" value="' + directDl + '" oninput="updateDirectDl(this)"><button class="direct-dl-save" onclick="updateDirectDl(this.previousElementSibling)">\u2713</button></div></div></div>';
  }).join("");
}
__name(renderCardsFromData, "renderCardsFromData");
__name2(renderCardsFromData, "renderCardsFromData");
async function recordLoginFail(env, failKey, freezeKey) {
  try {
    const cache = caches.default;
    const failUrl = "https://internal/fail/" + failKey;
    const freezeUrl = "https://internal/freeze/" + freezeKey;
    const cached = await cache.match(failUrl);
    let count = 1;
    if (cached) {
      const d = await cached.json().catch(() => ({}));
      count = (d.count || 0) + 1;
    }
    if (count >= 5) {
      await cache.put(freezeUrl, new Response(JSON.stringify({ until: Date.now() + 10 * 60 * 1e3, count }), { headers: { "Cache-Control": "max-age=600" } }));
      await cache.delete(failUrl);
    } else {
      await cache.put(failUrl, new Response(JSON.stringify({ count }), { headers: { "Cache-Control": "max-age=1800" } }));
    }
  } catch (e) {
  }
}
__name(recordLoginFail, "recordLoginFail");
__name2(recordLoginFail, "recordLoginFail");
async function clearLoginFail(env, failKey, freezeKey) {
  const cache = caches.default;
  try {
    await cache.delete("https://internal/fail/" + failKey);
  } catch (e) {
  }
  try {
    await cache.delete("https://internal/freeze/" + freezeKey);
  } catch (e) {
  }
}
__name(clearLoginFail, "clearLoginFail");
__name2(clearLoginFail, "clearLoginFail");
async function recordAuthFail(env, failKey, freezeKey) {
  try {
    const cache = caches.default;
    const failUrl = "https://internal/fail/" + failKey;
    const freezeUrl = "https://internal/freeze/" + freezeKey;
    const cached = await cache.match(failUrl);
    let count = 1;
    if (cached) {
      const d = await cached.json().catch(() => ({}));
      count = (d.count || 0) + 1;
    }
    if (count >= 5) {
      await cache.put(freezeUrl, new Response(JSON.stringify({ until: Date.now() + 30 * 60 * 1e3 }), { headers: { "Cache-Control": "max-age=1800" } }));
      await cache.delete(failUrl);
    } else {
      await cache.put(failUrl, new Response(JSON.stringify({ count }), { headers: { "Cache-Control": "max-age=3600" } }));
    }
  } catch (e) {
  }
}
__name(recordAuthFail, "recordAuthFail");
__name2(recordAuthFail, "recordAuthFail");
async function checkAuthFreeze(env, freezeKey) {
  const cache = caches.default;
  const cached = await cache.match("https://internal/freeze/" + freezeKey);
  const freezeRaw = cached ? await cached.text().catch(() => "") : null;
  if (freezeRaw) {
    const freezeData = JSON.parse(freezeRaw);
    const remainMin = Math.ceil((freezeData.until - Date.now()) / 6e4);
    if (Date.now() < freezeData.until) {
      return { frozen: true, remainMin };
    }
    try {
      await cache.delete("https://internal/freeze/" + freezeKey);
    } catch (e) {
    }
  }
  return { frozen: false };
}
__name(checkAuthFreeze, "checkAuthFreeze");
__name2(checkAuthFreeze, "checkAuthFreeze");
async function clearAuthFail(env, failKey, freezeKey) {
  const cache = caches.default;
  try {
    await cache.delete("https://internal/fail/" + failKey);
  } catch (e) {
  }
  try {
    await cache.delete("https://internal/freeze/" + freezeKey);
  } catch (e) {
  }
}
__name(clearAuthFail, "clearAuthFail");
__name2(clearAuthFail, "clearAuthFail");
async function getFishCoins(env, userId) {
  const row = await env.DB.prepare("SELECT balance FROM user_coins WHERE user_id = ?").bind(userId).first();
  return row ? row.balance : 0;
}
__name(getFishCoins, "getFishCoins");
__name2(getFishCoins, "getFishCoins");
async function addFishCoins(env, userId, amount, type, description) {
  validCoinAmount(amount);
  const now = Date.now(), txId = "txcoin_" + securityId();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO user_coins (user_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at`).bind(userId, amount, now),
    env.DB.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(txId, userId, amount, type, description, now),
    env.DB.prepare("SELECT balance FROM user_coins WHERE user_id = ?").bind(userId)
  ]);
  return result[2].results[0].balance;
}
__name(addFishCoins, "addFishCoins");
__name2(addFishCoins, "addFishCoins");
async function spendFishCoins(env, userId, amount, type, description) {
  validCoinAmount(amount);
  const now = Date.now(), txId = "txcoin_" + securityId();
  const result = await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO user_coins (user_id, balance, updated_at) VALUES (?, 0, ?)").bind(userId, now),
    env.DB.prepare("UPDATE user_coins SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?").bind(amount, now, userId, amount),
    env.DB.prepare(`INSERT INTO coin_transactions (id, user_id, amount, type, description, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`).bind(txId, userId, -amount, type, description, now),
    env.DB.prepare("SELECT balance FROM user_coins WHERE user_id = ?").bind(userId)
  ]);
  return { ok: changed(result[1]), balance: result[3].results[0].balance };
}
__name(spendFishCoins, "spendFishCoins");
__name2(spendFishCoins, "spendFishCoins");
function requireEnvSecret(v, name) {
  if (!v) throw new Error("server secret not configured: " + (name || "unknown"));
  return v;
}
__name(requireEnvSecret, "requireEnvSecret");
__name2(requireEnvSecret, "requireEnvSecret");
async function hmacSha256(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacSha256, "hmacSha256");
__name2(hmacSha256, "hmacSha256");
async function generateGhdlToken(userId, clientIp, secret) {
  const ts = Date.now();
  const sigHex = await hmacSha256(ts + ":" + clientIp + ":" + userId, secret);
  const sigB64 = btoa(sigHex).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return sigB64 + "." + ts;
}
__name(generateGhdlToken, "generateGhdlToken");
__name2(generateGhdlToken, "generateGhdlToken");
async function verifyGhdlToken(token, clientIp, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "Token\u683C\u5F0F\u9519\u8BEF" };
  const ts = parseInt(parts[1]);
  if (isNaN(ts)) return { valid: false, reason: "\u65F6\u95F4\u6233\u65E0\u6548" };
  const age = Date.now() - ts;
  if (age > 5e3) return { valid: false, reason: "Token\u5DF2\u8FC7\u671F" };
  if (age < 0) return { valid: false, reason: "\u65F6\u95F4\u6233\u5F02\u5E38" };
  const sigHex = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
  const expectedSig = await hmacSha256(ts + ":" + clientIp + ":ghdl", secret);
  let eq = true;
  for (let i = 0; i < Math.max(sigHex.length, expectedSig.length); i++) {
    if (sigHex[i] !== expectedSig[i]) eq = false;
  }
  if (!eq) return { valid: false, reason: "\u7B7E\u540D\u9A8C\u8BC1\u5931\u8D25" };
  return { valid: true };
}
__name(verifyGhdlToken, "verifyGhdlToken");
__name2(verifyGhdlToken, "verifyGhdlToken");
function getGhdlSecret(env) {
  return requireEnvSecret(env.GHDL_SECRET || env.GITHUB_CLIENT_SECRET, "GHDL_SECRET");
}
__name(getGhdlSecret, "getGhdlSecret");
__name2(getGhdlSecret, "getGhdlSecret");
function generateProxySlug() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "px_" + Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}
__name(generateProxySlug, "generateProxySlug");
__name2(generateProxySlug, "generateProxySlug");
function generateTempToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}
__name(generateTempToken, "generateTempToken");
__name2(generateTempToken, "generateTempToken");
async function signProxyId(id, secret) {
  const sig = await hmacSha256("proxy:" + id, secret);
  return sig.substring(0, 16);
}
__name(signProxyId, "signProxyId");
__name2(signProxyId, "signProxyId");
async function verifyProxyId(id, sigHex, secret) {
  const expected = await signProxyId(id, secret);
  return timingSafeEqualStr(sigHex, expected);
}
__name(verifyProxyId, "verifyProxyId");
__name2(verifyProxyId, "verifyProxyId");
function getProxySecret(env) {
  return requireEnvSecret(env.PROXY_SECRET || env.GHDL_SECRET || env.GITHUB_CLIENT_SECRET, "PROXY_SECRET");
}
__name(getProxySecret, "getProxySecret");
__name2(getProxySecret, "getProxySecret");
async function doProxyDownload(targetUrl, filename, request, env, cacheId) {
  const HF_TOKEN = env.HF_TOKEN || "";
  const dbg = [];
  try {
    const cacheKey = new Request(new URL(request.url).origin + "/_proxy_cache/" + cacheId, request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const cacheHeaders = new Headers(cached.headers);
      cacheHeaders.set("X-Cache", "HIT");
      cacheHeaders.set("Server", "nginx");
      if (filename) cacheHeaders.set("Content-Disposition", 'attachment; filename="' + filename + '"');
      return new Response(cached.body, { status: 200, headers: cacheHeaders });
    }
    const rangeHeader = request.headers.get("Range") || "";
    let downloadUrl = targetUrl;
    const isHfResolve = targetUrl.includes("huggingface.co") && (targetUrl.includes("/resolve/") || targetUrl.includes("/blob/"));
    dbg.push("isHfResolve=" + isHfResolve);
    dbg.push("origUrl=" + targetUrl.substring(0, 60));
    if (isHfResolve) {
      try {
        const redirRes = await fetch(targetUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "Authorization": "Bearer " + HF_TOKEN,
            "User-Agent": "HuggingFace/Hub-Client 0.20.1"
          }
        });
        dbg.push("redirStatus=" + redirRes.status);
        const loc = redirRes.headers.get("Location");
        dbg.push("location=" + (loc ? loc.substring(0, 60) : "null"));
        if ((redirRes.status === 302 || redirRes.status === 301) && loc) {
          downloadUrl = loc;
        }
      } catch (e) {
        dbg.push("redirErr=" + e.message);
      }
    }
    dbg.push("downloadUrl=" + downloadUrl.substring(0, 60));
    const isHf = downloadUrl.includes("huggingface.co") || downloadUrl.includes("cdn-lfs");
    const upstream = await fetch(downloadUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "HuggingFace/Hub-Client 0.20.1",
        "Accept": "*/*",
        ...isHf ? { "Authorization": "Bearer " + HF_TOKEN } : {},
        ...rangeHeader ? { "Range": rangeHeader } : {}
      }
    });
    dbg.push("upstreamStatus=" + upstream.status);
    if (!upstream.ok && upstream.status !== 206) {
      return new Response("\u4E0B\u8F7D\u5931\u8D25 (\u4E0A\u6E38\u8FD4\u56DE " + upstream.status + ", URL: " + downloadUrl.substring(0, 60) + "... Debug: " + dbg.join("; ") + ")", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const responseHeaders = new Headers();
    const ct = upstream.headers.get("content-type");
    const cl = upstream.headers.get("content-length");
    const acceptRanges = upstream.headers.get("accept-ranges");
    const cr = upstream.headers.get("content-range");
    if (ct) responseHeaders.set("Content-Type", ct);
    if (cl) responseHeaders.set("Content-Length", cl);
    if (acceptRanges) responseHeaders.set("Accept-Ranges", acceptRanges);
    if (cr) responseHeaders.set("Content-Range", cr);
    if (filename) responseHeaders.set("Content-Disposition", 'attachment; filename="' + filename + '"');
    responseHeaders.set("Server", "nginx");
    responseHeaders.set("X-Cache", "MISS");
    responseHeaders.set("Cache-Control", "private, max-age=30");
    const response = new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    try {
      await cache.put(cacheKey, response.clone());
    } catch (e) {
    }
    return response;
  } catch (e) {
    return new Response("\u4E0B\u8F7D\u5931\u8D25: " + e.message + " (Debug: " + dbg.join("; ") + ")", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
__name(doProxyDownload, "doProxyDownload");
__name2(doProxyDownload, "doProxyDownload");
function createMathCaptcha() {
  const ops = [
    { sym: "+", fn: /* @__PURE__ */ __name2((a2, b2) => a2 + b2, "fn") },
    { sym: "-", fn: /* @__PURE__ */ __name2((a2, b2) => a2 - b2, "fn") },
    { sym: "\xD7", fn: /* @__PURE__ */ __name2((a2, b2) => a2 * b2, "fn") }
  ];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let a = Math.floor(Math.random() * 50) + 1;
  let b = Math.floor(Math.random() * 50) + 1;
  if (op.sym === "-" && a < b) [a, b] = [b, a];
  if (op.sym === "\xD7") {
    a = Math.floor(Math.random() * 12) + 2;
    b = Math.floor(Math.random() * 12) + 2;
  }
  return { question: a + " " + op.sym + " " + b + " = ?", answer: String(op.fn(a, b)) };
}
__name(createMathCaptcha, "createMathCaptcha");
__name2(createMathCaptcha, "createMathCaptcha");
async function generateUserToken(userId, env) {
  const version = await getSessionVersion(env, userId);
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify({ u: userId, e: Date.now() + 30 * 86400000, n: securityId(), v: version })))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = await hmacSha256("utoken:" + payload, requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
  return "utk." + payload + "." + sig;
}
__name(generateUserToken, "generateUserToken");
__name2(generateUserToken, "generateUserToken");
async function checkBanStatus(userId, env) {
  try {
    const banRaw = await readBanRecord(env, `banned_${userId}`);
    if (banRaw) {
      const banInfo = JSON.parse(banRaw);
      if (Date.now() < banInfo.bannedUntil) {
        return { banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason || "" };
      }
    }
    const userDataForBan = await getUserById(userId, env);
    if (userDataForBan) {
      if (userDataForBan.inviteType === "super" && userDataForBan.inviterId && !userDataForBan.inviterIsAdmin) {
        const inviterBanRaw = await readBanRecord(env, `banned_${userDataForBan.inviterId}`);
        if (inviterBanRaw) {
          const inviterBan = JSON.parse(inviterBanRaw);
          if (Date.now() < inviterBan.bannedUntil) {
            await kvPut(env, `banned_${userId}`, JSON.stringify({
              bannedUntil: inviterBan.bannedUntil,
              reason: `\u8FDE\u5E26\u5C01\u53F7\uFF1A\u9080\u8BF7\u4EBA ${userDataForBan.inviterId} \u88AB\u5C01\u53F7`,
              bannedAt: Date.now()
            }));
            return { banned: true, bannedUntil: inviterBan.bannedUntil, reason: `\u8FDE\u5E26\u5C01\u53F7\uFF1A\u9080\u8BF7\u4EBA ${userDataForBan.inviterId} \u88AB\u5C01\u53F7` };
          }
        }
      }
    }
    return null;
  } catch (e) {
    throw e;
  }
}
__name(checkBanStatus, "checkBanStatus");
__name2(checkBanStatus, "checkBanStatus");
async function verifyUserToken(token, env) {
  const session = await getVerifiedUserSession(token, env);
  return session ? session.userId : null;
}
__name(verifyUserToken, "verifyUserToken");
__name2(verifyUserToken, "verifyUserToken");
async function verifyTurnstile(token, env) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    console.error("[\u5B89\u5168] TURNSTILE_SECRET \u672A\u914D\u7F6E\uFF0C\u62D2\u7EDD\u9A8C\u8BC1\u8BF7\u6C42\u3002\u8BF7\u5728 Worker \u73AF\u5883\u53D8\u91CF\u4E2D\u914D\u7F6E\u8BE5\u5BC6\u94A5\u3002");
    return false;
  }
  if (!token || typeof token !== "string") return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error("[\u5B89\u5168] Turnstile \u6821\u9A8C\u8BF7\u6C42\u5F02\u5E38\uFF0C\u6309\u672A\u901A\u8FC7\u5904\u7406:", e);
    return false;
  }
}
__name(verifyTurnstile, "verifyTurnstile");
__name2(verifyTurnstile, "verifyTurnstile");
var LEVEL_CONFIG = [
  { level: 1, color: "#ffffff", bg: "rgba(255,255,255,0.15)", name: "LV1" },
  { level: 2, color: "#4caf50", bg: "rgba(76,175,80,0.15)", name: "LV2" },
  { level: 3, color: "#2196f3", bg: "rgba(33,150,243,0.15)", name: "LV3" },
  { level: 4, color: "#ff9800", bg: "rgba(255,152,0,0.15)", name: "LV4" },
  { level: 5, color: "#ff69b4", bg: "rgba(255,105,180,0.15)", name: "LV5" },
  { level: 6, color: "#f44336", bg: "rgba(244,67,54,0.15)", name: "LV6" }
];
var LEVEL_THRESHOLDS = [0, 200, 600, 1600, 3600, 6100];
function getLevelInfo(exp) {
  const e = exp || 0;
  let lv = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (e >= LEVEL_THRESHOLDS[i]) lv = i + 1;
    else break;
  }
  lv = Math.min(lv, 6);
  const cfg = LEVEL_CONFIG[lv - 1];
  const nextThreshold = lv < 6 ? LEVEL_THRESHOLDS[lv] : LEVEL_THRESHOLDS[5];
  const currentThreshold = LEVEL_THRESHOLDS[lv - 1];
  const progress = Math.min(100, Math.round((e - currentThreshold) / (nextThreshold - currentThreshold) * 100));
  return {
    level: lv,
    color: cfg.color,
    bg: cfg.bg,
    name: cfg.name,
    exp: e,
    nextThreshold,
    currentThreshold,
    progress: lv >= 6 ? 100 : progress
  };
}
__name(getLevelInfo, "getLevelInfo");
__name2(getLevelInfo, "getLevelInfo");
var DEFAULT_AVATAR = "https://tian-xiao.com/assets/default-avatar.jpg";
async function getUserById(userId, env) {
  try {
    const row = await env.DB.prepare("SELECT user_id, username, password_hash, email, github_id, avatar, exp, created_at, last_login_at FROM users WHERE user_id = ?").bind(userId).first();
    if (row) return {
      userId: row.user_id,
      username: row.username,
      passwordHash: row.password_hash || "",
      email: row.email || "",
      githubId: row.github_id || "",
      avatar: row.avatar || "",
      exp: row.exp || 0,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at || row.created_at
    };
  } catch (e) {
  }
  try {
    const raw = await kvGet(env, `user_data_${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
__name(getUserById, "getUserById");
__name2(getUserById, "getUserById");
async function getUserByUsername(username, env) {
  try {
    const row = await env.DB.prepare("SELECT user_id FROM users WHERE username = ?").bind(username).first();
    if (row) return row.user_id;
  } catch (e) {
  }
  return kvGet(env, `user_name_${username}`);
}
__name(getUserByUsername, "getUserByUsername");
__name2(getUserByUsername, "getUserByUsername");
async function getUserByEmail(email, env) {
  try {
    const row = await env.DB.prepare("SELECT user_id FROM users WHERE email = ?").bind(email).first();
    if (row) return row.user_id;
  } catch (e) {
  }
  return kvGet(env, `email_user_${email}`);
}
__name(getUserByEmail, "getUserByEmail");
__name2(getUserByEmail, "getUserByEmail");
async function getUserByGithubId(ghId, env) {
  try {
    const row = await env.DB.prepare("SELECT user_id FROM users WHERE github_id = ?").bind(ghId).first();
    if (row) return row.user_id;
  } catch (e) {
  }
  return kvGet(env, `github_user_${ghId}`);
}
__name(getUserByGithubId, "getUserByGithubId");
__name2(getUserByGithubId, "getUserByGithubId");
async function createUserD1(userData2, env) {
  await env.DB.prepare("INSERT INTO users (user_id, username, password_hash, email, github_id, avatar, exp, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
    userData2.userId,
    userData2.username,
    userData2.passwordHash || null,
    userData2.email || null,
    userData2.githubId || null,
    userData2.avatar || "",
    userData2.exp || 0,
    userData2.createdAt || Date.now(),
    userData2.lastLoginAt || Date.now()
  ).run();
}
__name(createUserD1, "createUserD1");
__name2(createUserD1, "createUserD1");
async function updateUserD1(userId, fields, env) {
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = { lastLoginAt: "last_login_at", avatar: "avatar", exp: "exp", passwordHash: "password_hash", email: "email", githubId: "github_id" }[k];
    if (col) {
      sets.push(col + " = ?");
      vals.push(v);
    }
  }
  if (!sets.length) return;
  vals.push(userId);
  try {
    await env.DB.prepare("UPDATE users SET " + sets.join(", ") + " WHERE user_id = ?").bind(...vals).run();
  } catch (e) {
  }
  try {
    const userData2 = await getUserById(userId, env);
    if (userData2) {
      for (const [k, v] of Object.entries(fields)) userData2[k] = v;
      await kvPut(env, `user_data_${userId}`, JSON.stringify(userData2));
    }
  } catch (e) {
  }
}
__name(updateUserD1, "updateUserD1");
__name2(updateUserD1, "updateUserD1");






async function getUserPublicInfo(userId, env) {
  try {
    const userData2 = await getUserById(userId, env);
    if (!userData2) return { username: "\u672A\u77E5\u7528\u6237", avatar: DEFAULT_AVATAR, level: 1, levelColor: "#fff" };
    const lvInfo = getLevelInfo(userData2.exp || 0);
    return {
      username: userData2.username || "\u672A\u77E5\u7528\u6237",
      avatar: await getCurrentAvatar(env, userId),
      level: lvInfo.level,
      levelColor: lvInfo.color,
      levelBg: lvInfo.bg,
      levelName: lvInfo.name,
      exp: userData2.exp || 0
    };
  } catch (e) {
    return { username: "\u672A\u77E5\u7528\u6237", avatar: DEFAULT_AVATAR, level: 1, levelColor: "#fff" };
  }
}
__name(getUserPublicInfo, "getUserPublicInfo");
__name2(getUserPublicInfo, "getUserPublicInfo");
async function addUserExp(userId, env, amount) {
  try {
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const dailyKey = `exp_daily_${userId}_${today}`;
    const dailyRaw = await kvGet(env, dailyKey);
    const dailyExp = dailyRaw ? parseInt(dailyRaw) : 0;
    const DAILY_LIMIT = 60;
    if (dailyExp >= DAILY_LIMIT) return { added: 0, total: dailyExp, limited: true };
    const actualAdd = Math.min(amount, DAILY_LIMIT - dailyExp);
    if (actualAdd <= 0) return { added: 0, total: dailyExp, limited: true };
    const userData2 = await getUserById(userId, env);
    if (!userData2) return { added: 0, total: 0 };
    const newExp = (userData2.exp || 0) + actualAdd;
    try {
      await updateUserD1(userId, { exp: newExp }, env);
    } catch (e) {
    }
    userData2.exp = newExp;
    try {
      await kvPut(env, dailyKey, String(dailyExp + actualAdd), { expirationTtl: 48 * 60 * 60 });
    } catch (e) {
    }
    const lvInfo = getLevelInfo(userData2.exp);
    return { added: actualAdd, total: dailyExp + actualAdd, limited: false, exp: userData2.exp, level: lvInfo };
  } catch (e) {
    return { added: 0, total: 0 };
  }
}
__name(addUserExp, "addUserExp");
__name2(addUserExp, "addUserExp");
const USER_AVATAR_PREFIX = "用户头像/";
const USER_AVATAR_ORIGIN = "https://api.tian-xiao.com";
function avatarPublicUrl(key) {
  return key ? USER_AVATAR_ORIGIN + "/api/user/avatar/file/" + key.slice(USER_AVATAR_PREFIX.length) : DEFAULT_AVATAR;
}
async function getCurrentAvatar(env, userId) {
  await ensureSecuritySchema(env);
  const row = await env.DB.prepare("SELECT object_key FROM user_avatars WHERE user_id = ?").bind(userId).first();
  return avatarPublicUrl(row && row.object_key);
}
async function readAvatarBody(request) {
  const limit = 512 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) return null;
  if (!request.body) return null;
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function isCroppedJpeg(bytes) {
  if (!bytes || bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length-2] !== 255 || bytes[bytes.length-1] !== 217) return false;
  let pos = 2;
  while (pos + 4 < bytes.length) {
    if (bytes[pos++] !== 255) return false;
    while (bytes[pos] === 255) pos++;
    const marker = bytes[pos++];
    if (marker === 218 || marker === 217) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (pos + 2 > bytes.length) return false;
    const length = (bytes[pos] << 8) | bytes[pos+1];
    if (length < 2 || pos + length > bytes.length) return false;
    if ([192,193,194].includes(marker)) {
      if (length < 8) return false;
      const height = (bytes[pos+3] << 8) | bytes[pos+4], width = (bytes[pos+5] << 8) | bytes[pos+6];
      return width === 512 && height === 512;
    }
    pos += length;
  }
  return false;
}
async function drainAvatarCleanup(env) {
  const pending = await env.DB.prepare("SELECT object_key FROM avatar_cleanup_queue LIMIT 10").all();
  for (const row of pending.results || []) {
    if (!/^用户头像\/[a-f0-9]{32}\.jpg$/.test(row.object_key)) continue;
    const current = await env.DB.prepare("SELECT 1 AS x FROM user_avatars WHERE object_key = ?").bind(row.object_key).first();
    if (current) continue;
    try {
      await env.USER_AVATARS.delete(row.object_key);
      await env.DB.prepare("DELETE FROM avatar_cleanup_queue WHERE object_key = ?").bind(row.object_key).run();
    } catch (_) { /* Keep the durable retry entry; a later request retries it. */ }
  }
}
async function updateUploadedAvatar(request, env, reset) {
  const session = await getVerifiedUserSession((request.headers.get("Authorization") || "").replace(/^Bearer /, ""), env);
  if (!session) return jsonRes({ success:false, error:"登录已过期" },401);
  if (await checkBanStatus(session.userId, env)) return jsonRes({ success:false, error:"账号被封禁，无法修改头像" },403);
  if (!env.USER_AVATARS) return jsonRes({ success:false, error:"头像存储暂不可用" },503);
  const user = await env.DB.prepare("SELECT user_id FROM users WHERE user_id = ?").bind(session.userId).first();
  if (!user) return jsonRes({ success:false, error:"用户不存在" },404);
  const old = await env.DB.prepare("SELECT object_key, operation_id, updated_at FROM user_avatars WHERE user_id = ?").bind(session.userId).first();
  const now = Date.now();
  if (old && now - old.updated_at < 10000) return jsonRes({ success:false, error:"请稍等 10 秒再修改头像" },429);
  let bytes = null;
  if (!reset) {
    if ((request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase() !== "image/jpeg") return jsonRes({ success:false,error:"请上传裁剪后的 JPEG 头像" },415);
    bytes = await readAvatarBody(request);
    if (!bytes) return jsonRes({ success:false,error:"头像文件过大" },413);
    if (!isCroppedJpeg(bytes)) return jsonRes({ success:false,error:"头像必须是 512×512 的 JPEG 图片" },400);
  }
  const op = securityId(), key = reset ? null : USER_AVATAR_PREFIX + op + ".jpg", avatar = avatarPublicUrl(key);
  if (key) await env.USER_AVATARS.put(key, bytes, { httpMetadata:{ contentType:"image/jpeg" },customMetadata:{userId:session.userId} });
  const gate = "EXISTS (SELECT 1 FROM user_avatars WHERE user_id = ? AND operation_id = ?)";
  let result;
  try {
    const statements = [
      env.DB.prepare(`INSERT INTO user_avatars (user_id, object_key, operation_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET object_key=excluded.object_key, operation_id=excluded.operation_id, updated_at=excluded.updated_at
        WHERE user_avatars.operation_id IS ?`).bind(session.userId,key,op,now,old ? old.operation_id : null),
      env.DB.prepare(`UPDATE users SET avatar = ? WHERE user_id = ? AND ${gate}`).bind(avatar,session.userId,session.userId,op),
      env.DB.prepare(`UPDATE kv_store SET value = json_set(value, '$.avatar', ?) WHERE key = ? AND json_valid(value) AND ${gate}`).bind(avatar,"user_data_"+session.userId,session.userId,op),
      env.DB.prepare(`UPDATE comments SET avatar = ? WHERE user_id = ? AND ${gate}`).bind(avatar,session.userId,session.userId,op),
      env.DB.prepare(`UPDATE reply_notifications SET reply_avatar = ? WHERE reply_comment_id IN (SELECT id FROM comments WHERE user_id = ?) AND ${gate}`).bind(avatar,session.userId,session.userId,op)
    ];
    if (old && old.object_key) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO avatar_cleanup_queue (object_key, created_at) SELECT ?, ? WHERE ${gate}`).bind(old.object_key,now,session.userId,op));
    result = await env.DB.batch(statements);
  } catch (error) {
    if (key) {
      try { await env.USER_AVATARS.delete(key); }
      catch (_) { await env.DB.prepare("INSERT OR IGNORE INTO avatar_cleanup_queue (object_key,created_at) VALUES (?,?)").bind(key,now).run(); }
    }
    throw error;
  }
  if (!changed(result[0])) {
    if (key) {
      try { await env.USER_AVATARS.delete(key); }
      catch (_) { await env.DB.prepare("INSERT OR IGNORE INTO avatar_cleanup_queue (object_key,created_at) VALUES (?,?)").bind(key,now).run(); }
    }
    return jsonRes({ success:false,error:"头像已在其他页面更新，请刷新后重试" },409);
  }
  try { await drainAvatarCleanup(env); } catch (_) { /* The committed cleanup queue remains retryable. */ }
  return jsonRes({ success:true,avatar,message:reset ? "已恢复默认头像" : "头像已更新" });
}

var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.DB && !env._d1Inited) {
      try {
        await initD1(env);
        env._d1Inited = true;
      } catch (e) {
        console.error("D1 init error:", e);
      }
    }
    if (url.pathname.startsWith("/api/user/") || url.pathname.startsWith("/api/ghdl/") || url.pathname === "/api/download/check" || url.pathname === "/api/proxy/temp-link" || url.pathname.startsWith("/px/")) {
      try { await ensureSecuritySchema(env); }
      catch (_) { return jsonRes({ success: false, error: "安全存储暂不可用，请稍后重试" }, 503); }
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(JSON.stringify({ status: "ok", name: "tianxiao-api" }), { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://tian-xiao.com",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }
    if (url.pathname.startsWith("/api/user/backpack") || ["/api/admin/avatar","/api/admin/avatars","/api/user/avatars","/api/user/my-avatars","/api/user/buy-avatar","/api/user/set-avatar"].includes(url.pathname)) {
      return jsonRes({ success:false,error:"头像商店与背包已移除" },410);
    }
    if (request.method === "POST" && ["/api/user/avatar/upload","/api/user/avatar/reset"].includes(url.pathname)) {
      try { return await updateUploadedAvatar(request, env, url.pathname.endsWith("/reset")); }
      catch (_) { return safeJsonRes({ success:false,error:"头像上传暂不可用，请稍后重试" },503); }
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/user/avatar/file/")) {
      const file = url.pathname.slice("/api/user/avatar/file/".length);
      if (!/^[a-f0-9]{32}\.jpg$/.test(file)) return new Response("Not found",{status:404});
      if (!env.USER_AVATARS) return new Response("Unavailable",{status:503});
      try {
        await drainAvatarCleanup(env);
        const object = await env.USER_AVATARS.get(USER_AVATAR_PREFIX + file);
        if (!object) return new Response("Not found",{status:404});
        return new Response(object.body,{headers:{"Content-Type":"image/jpeg","X-Content-Type-Options":"nosniff","Cache-Control":"public,max-age=300","Access-Control-Allow-Origin":"https://tian-xiao.com"}});
      } catch (_) { return new Response("Unavailable",{status:503}); }
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return jsonRes({
        turnstileSiteKey: "0x4AAAAAACxkhwPrw1gO9XFQ",
        version: "3.3.0"
      });
    }
    if (request.method === "POST" && url.pathname === "/api/captcha/new") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rlKey = `rl_captcha_${ip}_${Math.floor(Date.now() / 6e4)}`;
      const rlCount = parseInt(await kvGet(env, rlKey) || "0");
      if (rlCount >= 20) return jsonRes({ error: "\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 429);
      await kvPut(env, rlKey, String(rlCount + 1), { expirationTtl: 70 });
      const ops = ["+", "-", "\xD7"];
      const op = ops[Math.floor(Math.random() * ops.length)];
      let a, b, answer;
      if (op === "+") {
        a = Math.floor(Math.random() * 50) + 1;
        b = Math.floor(Math.random() * 50) + 1;
        answer = a + b;
      } else if (op === "-") {
        a = Math.floor(Math.random() * 50) + 1;
        b = Math.floor(Math.random() * 50) + 1;
        if (a < b) {
          const t = a;
          a = b;
          b = t;
        }
        answer = a - b;
      } else {
        a = Math.floor(Math.random() * 12) + 2;
        b = Math.floor(Math.random() * 12) + 2;
        answer = a * b;
      }
      const question = `${a} ${op} ${b} = ?`;
      const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b2) => b2.toString(16).padStart(2, "0")).join("");
      await kvPut(env, "captcha_" + sessionId, String(answer), { expirationTtl: 300 });
      return jsonRes({ sessionId, question });
    }
    if (url.pathname === "/cleanup-tokens") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "\u672A\u6388\u6743" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      if (!await verifyToken(authHeader.substring(7), env)) {
        return new Response(JSON.stringify({ error: "Token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      try {
        const list = await kvList(env, "token_");
        let deletedCount = 0;
        let expiredCount = 0;
        for (const key of list.keys) {
          try {
            const data = await kvGet(env, key.name);
            if (!data) {
              await kvDelete(env, key.name);
              deletedCount++;
              continue;
            }
            const tokenInfo = JSON.parse(data);
            if (Date.now() > tokenInfo.expiresAt) {
              await kvDelete(env, key.name);
              deletedCount++;
              expiredCount++;
            }
          } catch (e) {
            await kvDelete(env, key.name);
            deletedCount++;
          }
        }
        return new Response(`
\u2705 Token \u6E05\u7406\u5B8C\u6210\uFF01

\u7EDF\u8BA1\u4FE1\u606F\uFF1A
- \u603B Token \u6570\uFF1A${list.keys.length}
- \u5DF2\u5220\u9664\uFF1A${deletedCount} \u4E2A
- \u5176\u4E2D\u8FC7\u671F\uFF1A${expiredCount} \u4E2A
- \u5269\u4F59\u6709\u6548\uFF1A${list.keys.length - deletedCount} \u4E2A

\u5EFA\u8BAE\uFF1A
- \u5982\u679C\u5269\u4F59 Token \u6570\u91CF\u8FD8\u5F88\u591A\uFF0C\u53EF\u4EE5\u518D\u6B21\u8BBF\u95EE\u6B64\u8DEF\u7531
- \u5B9A\u671F\u6E05\u7406\u53EF\u4EE5\u907F\u514D Token \u79EF\u7D2F

\u6E05\u7406\u65F6\u95F4\uFF1A${(/* @__PURE__ */ new Date()).toLocaleString("zh-CN")}
        `, {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (error) {
        return new Response(`\u274C \u6E05\u7406\u5931\u8D25\uFF1A${error.message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/verify") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (typeof env.ADMIN_USERID !== "string" || !env.ADMIN_USERID.trim() || typeof env.ADMIN_PASSWORD !== "string" || !env.ADMIN_PASSWORD.trim()) {
        return jsonRes({ success: false, message: "管理员登录暂不可用：凭据未配置" }, 503);
      }
      const body = await request.json();
      if (typeof body.userId !== "string" || !body.userId.trim() || typeof body.password !== "string" || !body.password) {
        return jsonRes({ success: false, message: "请输入管理员账号和密码" }, 400);
      }
      const fpHash = body.fingerprint ? body.fingerprint.slice(0, 32) : "no_fp";
      const lockKey = `brute_${ip}`;
      const LOCK_MAX = 5;
      const LOCK_DURATION = 30 * 60 * 1e3;
      try {
        const lockRaw = await kvGet(env, lockKey);
        const lockInfo = lockRaw ? JSON.parse(lockRaw) : { attempts: 0, lockedUntil: 0 };
        const now = Date.now();
        if (lockInfo.lockedUntil && now < lockInfo.lockedUntil) {
          const remain = Math.ceil((lockInfo.lockedUntil - now) / 6e4);
          return new Response(JSON.stringify({
            success: false,
            locked: true,
            message: `IP \u5DF2\u5C01\u7981\uFF0C\u8BF7 ${remain} \u5206\u949F\u540E\u518D\u8BD5`
          }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        }
        if (lockInfo.lockedUntil && now >= lockInfo.lockedUntil) {
          lockInfo.attempts = 0;
          lockInfo.lockedUntil = 0;
        }
        const tsOk = await verifyTurnstile(body.turnstileToken || "", env);
        if (!tsOk) {
          return jsonRes({ success: false, message: "\u4EBA\u673A\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5" }, 403);
        }
        const inputPassword = body.password;
        const correctUserId = env.ADMIN_USERID;
        const correctPassword = env.ADMIN_PASSWORD;
        const inputUserId = body.userId || "";
        if (timingSafeEqualStr(inputPassword, correctPassword) && timingSafeEqualStr(inputUserId, correctUserId)) {
          await kvDelete(env, lockKey);
          await cleanupExpiredTokens(env);
          const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
          const token = await generateToken(env, clientIp);
          return new Response(JSON.stringify({
            success: true,
            message: "\u9A8C\u8BC1\u6210\u529F",
            token
          }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        } else {
          lockInfo.attempts += 1;
          const remaining = LOCK_MAX - lockInfo.attempts;
          if (lockInfo.attempts >= LOCK_MAX) {
            lockInfo.lockedUntil = now + LOCK_DURATION;
            await kvPut(env, lockKey, JSON.stringify(lockInfo), { expirationTtl: 35 * 60 });
            return new Response(JSON.stringify({
              success: false,
              locked: true,
              message: "IP \u5DF2\u5C01\u798130\u5206\u949F\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5"
            }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
            });
          } else {
            await kvPut(env, lockKey, JSON.stringify(lockInfo), { expirationTtl: 35 * 60 });
            return new Response(JSON.stringify({
              success: false,
              message: `\u5BC6\u7801\u9519\u8BEF\uFF0C\u8FD8\u5269 ${remaining} \u6B21\u673A\u4F1A`
            }), {
              status: 401,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
            });
          }
        }
      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          message: "\u9A8C\u8BC1\u5931\u8D25: " + error.message
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/views") {
      try {
        const rows = await env.DB.prepare("SELECT card_id, views FROM card_views").all();
        const map = {};
        for (const r of rows.results || []) map[r.card_id] = r.views;
        return jsonRes({ success: true, views: map });
      } catch (e) {
        return jsonRes({ success: false, views: {} });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/view") {
      try {
        const body = await request.json();
        const cardId = (body.cardId || "").toString().slice(0, 80);
        if (!cardId || !/^[A-Za-z0-9_-]+$/.test(cardId)) return jsonRes({ success: false, error: "bad cardId" }, 400);
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const now = Date.now();
        const cooldown = 6 * 3600 * 1e3;
        const seen = await env.DB.prepare("SELECT ts FROM card_view_log WHERE card_id = ? AND ip = ?").bind(cardId, ip).first();
        if (seen && now - seen.ts < cooldown) {
          const cur = await env.DB.prepare("SELECT views FROM card_views WHERE card_id = ?").bind(cardId).first();
          return jsonRes({ success: true, views: cur ? cur.views : 0, counted: false });
        }
        await env.DB.prepare("INSERT OR REPLACE INTO card_view_log (card_id, ip, ts) VALUES (?, ?, ?)").bind(cardId, ip, now).run();
        await env.DB.prepare("INSERT INTO card_views (card_id, views) VALUES (?, 1) ON CONFLICT(card_id) DO UPDATE SET views = views + 1").bind(cardId).run();
        if (Math.random() < 0.02) {
          try {
            await env.DB.prepare("DELETE FROM card_view_log WHERE ts < ?").bind(now - 7 * 24 * 3600 * 1e3).run();
          } catch (e) {
          }
        }
        const cur2 = await env.DB.prepare("SELECT views FROM card_views WHERE card_id = ?").bind(cardId).first();
        return jsonRes({ success: true, views: cur2 ? cur2.views : 1, counted: true });
      } catch (e) {
        return jsonRes({ success: false, error: e.message }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/data") {
      try {
        const authHeader0 = request.headers.get("Authorization") || "";
        const token0 = authHeader0.replace("Bearer ", "");
        const isAdmin0 = token0 ? await verifyToken(token0, env) : false;
        const cache = caches.default;
        const cacheUrl = new URL(request.url);
        cacheUrl.search = "";
        const cacheKey = new Request(cacheUrl.toString(), request);
        const cached = await cache.match(cacheKey);
        if (cached && !isAdmin0) return cached;
        const r2Obj = await env.R2.get("tianxiao_data");
        const data = r2Obj ? await r2Obj.text() : null;
        if (!data) {
          return new Response(JSON.stringify({
            content: btoa(JSON.stringify({ cards: "" }))
          }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "https://tian-xiao.com",
              "Cache-Control": "public, max-age=3600"
            }
          });
        }
        const isAdmin = isAdmin0;
        let responseData = data;
        if (!isAdmin) {
          const decoded = JSON.parse(atob(data));
          if (decoded.cards) {
            decoded.cards = decoded.cards.replace(/\s*data-direct-download="[^"]*"/g, "");
          }
          responseData = btoa(JSON.stringify(decoded));
        }
        const res = new Response(JSON.stringify({
          content: responseData
        }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://tian-xiao.com",
            "Cache-Control": isAdmin ? "private, no-store" : "public, max-age=3600"
          }
        });
        if (!isAdmin) cache.put(cacheKey, res.clone());
        return res;
      } catch (error) {
        return new Response(JSON.stringify({
          error: "\u8BFB\u53D6\u5931\u8D25: " + error.message
        }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "https://tian-xiao.com"
          }
        });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      let d1 = "ok";
      try {
        await _d1Race(env.DB.prepare("SELECT 1 AS x").first(), 1200);
      } catch (e) {
        d1 = "down";
      }
      let kv = "ok";
      try {
        await env.STORAGE.get("__health_probe__");
      } catch (e) {
        kv = "down";
      }
      return jsonRes({ d1, kv, ts: Date.now() });
    }
    if (request.method === "POST" && url.pathname === "/api/admin/kv-migrate") {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";
      if (!token || !await verifyToken(token, env)) {
        return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
      }
      try {
        await initD1(env);
        let cursor, done = false, total = 0, migrated = 0, failed = 0;
        const oversized = [];
        const startMs = Date.now();
        while (!done) {
          const opts = { limit: 1e3 };
          if (cursor) opts.cursor = cursor;
          const page = await env.STORAGE.list(opts);
          done = page.list_complete;
          cursor = page.cursor;
          for (const k of page.keys) {
            total++;
            try {
              const v = await env.STORAGE.get(k.name);
              if (v === null || v === void 0) continue;
              if (v.length > 9e5) {
                oversized.push({ key: k.name, size: v.length });
                continue;
              }
              const exp = k.expiration ? k.expiration * 1e3 : null;
              await env.DB.prepare("INSERT OR REPLACE INTO kv_store (key, value, expires_at) VALUES (?, ?, ?)").bind(k.name, v, exp).run();
              migrated++;
            } catch (e) {
              failed++;
            }
          }
        }
        return jsonRes({ success: true, total, migrated, failed, oversized, ms: Date.now() - startMs });
      } catch (e) {
        return jsonRes({ error: "\u8FC1\u79FB\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/panel") {
      const authHeader = request.headers.get("Authorization") || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : "";
      if (!token || !await verifyToken(token, env)) {
        return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
      }
      return new Response(JSON.stringify(ADMIN_PANELS), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com", "Cache-Control": "no-store" }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/save") {
      try {
        const authHeader = request.headers.get("Authorization");
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
        }
        const token = authHeader.substring(7);
        const isValid = await verifyToken(token, env);
        if (!isValid) {
          return jsonRes({ error: "Token\u65E0\u6548" }, 401);
        }
        const t0 = Date.now();
        const body = await request.json();
        const { cards: cardsData, banner, notice, categories, galleryContent, dryRun } = body;
        if (!Array.isArray(cardsData)) {
          return jsonRes({ error: "\u5361\u7247\u6570\u636E\u683C\u5F0F\u9519\u8BEF" }, 400);
        }
        const safeCards = cardsData.map((card) => {
          return {
            id: card.id || "",
            title: String(card.title || "").replace(/[<>]/g, ""),
            tags: String(card.tags || "").replace(/[<>]/g, ""),
            desc: String(card.desc || "").replace(/[<>]/g, "").trim(),
            images: (card.images || []).filter((u) => typeof u === "string" && u.startsWith("http")),
            linkText: String(card.linkText || "").replace(/[<>]/g, ""),
            isPinned: !!card.isPinned,
            isFav: !!card.isFav,
            directDl: String(card.directDl || "").replace(/[<>]/g, "")
          };
        });
        const cardsHtml = renderCardsFromData(safeCards);
        const payload = JSON.stringify({
          cards: cardsHtml,
          banner: banner || [],
          notice: notice || "",
          categories: categories || [],
          commentUrl: "",
          galleryContent: galleryContent || "",
          updated: (/* @__PURE__ */ new Date()).toISOString()
        });
        const bytes = new TextEncoder().encode(payload);
        let binary = "";
        const B64_CHUNK = 32768;
        for (let i = 0; i < bytes.length; i += B64_CHUNK) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
        }
        const encoded = btoa(binary);
        if (dryRun === true) {
          return jsonRes({ success: true, dryRun: true, payloadBytes: bytes.length, encodedBytes: encoded.length, cardCount: safeCards.length, elapsedMs: Date.now() - t0 });
        }
        await env.R2.put("tianxiao_data", encoded, { httpMetadata: { contentType: "text/plain" } });
        const cacheUrl2 = new URL(request.url);
        cacheUrl2.pathname = "/api/data";
        cacheUrl2.search = "";
        await caches.default.delete(new Request(cacheUrl2.toString()));
        return jsonRes({ success: true, content: { sha: Date.now().toString() }, elapsedMs: Date.now() - t0 });
      } catch (error) {
        return jsonRes({ error: "\u4FDD\u5B58\u5931\u8D25: " + error.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/links/save") {
      const authHeader = request.headers.get("Authorization");
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "\u672A\u6388\u6743" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      const token = authHeader.substring(7);
      if (!await verifyToken(token, env)) {
        return new Response(JSON.stringify({ error: "Token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      try {
        const body = await request.json();
        const { cardId, links } = body;
        if (!cardId || !Array.isArray(links) || links.length === 0) {
          return new Response(JSON.stringify({ error: "\u53C2\u6570\u9519\u8BEF" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        }
        await kvPut(env, `card_links_${cardId}`, JSON.stringify(links));
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "\u5B58\u50A8\u5931\u8D25: " + e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/links/get") {
      const cardId = url.searchParams.get("cardId");
      const tsToken = url.searchParams.get("token");
      const vrfyToken = url.searchParams.get("vrfyToken");
      if (!cardId) {
        return new Response(JSON.stringify({ error: "\u7F3A\u5C11 cardId" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
      const authHeader = request.headers.get("Authorization") || "";
      const isAdmin = authHeader.startsWith("Bearer ") && await verifyToken(authHeader.substring(7), env);
      if (!isAdmin) {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (vrfyToken) {
          let valid = false;
          if (vrfyToken.includes(".")) {
            const parts = vrfyToken.split(".");
            if (parts.length === 2) {
              const expectedSig = await hmacSha256(parts[0], requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
              if (expectedSig === parts[1]) {
                try {
                  const vData = JSON.parse(decodeURIComponent(escape(atob(parts[0]))));
                  if (vData.type === "download-verification" && vData.ip === ip && Date.now() >= vData.createdAt && Date.now() - vData.createdAt < 12e4 && vData.cardId && vData.cardId === cardId) valid = true;
                } catch (e) {
                }
              }
            }
          } else {
            const vrfyRaw = await kvGet(env, `vrfy_${vrfyToken}`);
            if (vrfyRaw) {
              valid = true;
              await kvDelete(env, `vrfy_${vrfyToken}`);
            }
          }
          if (!valid) {
            return new Response(JSON.stringify({ error: "\u9A8C\u8BC1\u4EE4\u724C\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9A8C\u8BC1" }), {
              status: 403,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
            });
          }
        } else if (tsToken) {
          const tsRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: tsToken, remoteip: ip })
          });
          const tsData = await tsRes.json();
          if (!tsData.success) {
            return new Response(JSON.stringify({ error: "\u4EBA\u673A\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5" }), {
              status: 403,
              headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
            });
          }
        } else {
          return new Response(JSON.stringify({ error: "\u8BF7\u5B8C\u6210\u9A8C\u8BC1\u540E\u518D\u8BD5" }), {
            status: 403,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        }
      }
      try {
        const data = await kvGet(env, `card_links_${cardId}`);
        if (!data) {
          return new Response(JSON.stringify({ error: "\u94FE\u63A5\u4E0D\u5B58\u5728" }), {
            status: 404,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        }
        return new Response(JSON.stringify({ links: JSON.parse(data) }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "\u8BFB\u53D6\u5931\u8D25: " + e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/bg") {
      try {
        const raw = await kvGet(env, "site_bg");
        return new Response(JSON.stringify({ data: raw || null }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "PUT" && url.pathname === "/api/bg") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "\u672A\u6388\u6743" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      if (!await verifyToken(authHeader.substring(7), env)) {
        return new Response(JSON.stringify({ error: "Token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      try {
        const body = await request.json();
        await kvPut(env, "site_bg", JSON.stringify({ day: body.day || "", night: body.night || "" }));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "GET" && url.pathname === "/api/nav") {
      try {
        const navObj = await env.R2.get("txnav_data");
        const raw = navObj ? await navObj.text() : null;
        return new Response(JSON.stringify({ data: raw || null }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "PUT" && url.pathname === "/api/nav") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "\u672A\u6388\u6743" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      if (!await verifyToken(authHeader.substring(7), env)) {
        return new Response(JSON.stringify({ error: "Token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
      try {
        const body = await request.json();
        if (!body || typeof body.data !== "string") {
          return new Response(JSON.stringify({ error: "\u53C2\u6570\u9519\u8BEF" }), {
            status: 400,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
          });
        }
        await env.R2.put("txnav_data", body.data, { httpMetadata: { contentType: "text/plain" } });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/dl/")) {
      const namedRoutes = ["/dl/add"];
      if (namedRoutes.includes(url.pathname)) {
        return new Response("\u274C \u65B9\u6CD5\u4E0D\u5141\u8BB8", { status: 405, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const code = url.pathname.slice(4);
      if (!code) {
        return new Response("\u274C \u65E0\u6548\u7684\u77ED\u94FE", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const referer = request.headers.get("Referer") || "";
      const currentHost = new URL(request.url).hostname;
      const allowedOrigins = [currentHost, "localhost", "127.0.0.1"];
      let _refHost = "";
      try {
        _refHost = referer ? new URL(referer).hostname : "";
      } catch (e) {
      }
      const refererOk = !referer || allowedOrigins.includes(_refHost);
      if (!refererOk) {
        return new Response("\u274C \u7981\u6B62\u8BBF\u95EE\uFF1A\u6765\u6E90\u4E0D\u5408\u6CD5", {
          status: 403,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const rateLimitKey = `ratelimit_dl_${ip}_${Math.floor(Date.now() / 6e4)}`;
      const countRaw = await kvGet(env, rateLimitKey);
      const count = countRaw ? parseInt(countRaw) : 0;
      if (count >= 10) {
        return new Response("\u274C \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5", {
          status: 429,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Retry-After": "60"
          }
        });
      }
      await kvPut(env, rateLimitKey, String(count + 1), { expirationTtl: 70 });
      const lanzouUrl = await kvGet(env, `shortlink_${code}`);
      if (!lanzouUrl) {
        return new Response("\u274C \u77ED\u94FE\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      try {
        const directUrl = await parseLanzou(lanzouUrl);
        const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\u6B63\u5728\u4E0B\u8F7D...</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #fce4ec, #f8bbd0, #fce4ec);
    font-family: "Microsoft YaHei", sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  img { pointer-events: none; -webkit-user-drag: none; }
  .card {
    background: white;
    border-radius: 24px;
    padding: 36px 40px;
    box-shadow: 0 8px 32px rgba(233,30,99,0.15);
    text-align: center;
    max-width: 360px;
    width: 90%;
  }
  .title {
    font-size: 22px;
    font-weight: bold;
    color: #e91e63;
    margin-bottom: 6px;
  }
  .subtitle {
    font-size: 14px;
    color: #aaa;
    margin-bottom: 24px;
  }
  img {
    width: 200px;
    height: 200px;
    object-fit: cover;
    border-radius: 16px;
    margin-bottom: 20px;
  }
  .bar-wrap {
    background: #fce4ec;
    border-radius: 99px;
    height: 8px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .bar {
    height: 100%;
    background: linear-gradient(90deg, #f48fb1, #e91e63);
    border-radius: 99px;
    animation: loading 1.5s ease-in-out infinite;
  }
  @keyframes loading {
    0% { width: 0%; }
    50% { width: 80%; }
    100% { width: 100%; }
  }
  .tip { font-size: 12px; color: #bbb; }
</style>
</head>
<body>
<div class="card">
  <div class="title">\u6B63\u5728\u4E0B\u8F7D\u4E2D\uFF0C\u4E0D\u8981\u7740\u6025\u8D77\u98DE</div>
  <div class="subtitle">\u5373\u5C06\u81EA\u52A8\u5F00\u59CB\u4E0B\u8F7D...</div>
  <img src="${DEFAULT_AVATAR}" alt="\u5C11\u5973">
  <div class="bar-wrap"><div class="bar"></div></div>
  <div class="tip">\u5982\u672A\u81EA\u52A8\u4E0B\u8F7D\uFF0C\u8BF7\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5</div>
  <br>
  <a href="${directUrl}" style="color:#e91e63;font-size:13px;">\u70B9\u51FB\u624B\u52A8\u4E0B\u8F7D</a>
</div>
<script>
  setTimeout(function() {
    window.location.href = "${directUrl}";
  }, 1500);
<\/script>
</body>
</html>`;
        const finalHtml = html.replace("IMG_B64_PLACEHOLDER", "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");
        return new Response(finalHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (error) {
        return new Response(`\u274C \u89E3\u6790\u5931\u8D25\uFF1A${error.message}

\u53EF\u80FD\u539F\u56E0\uFF1A
- \u84DD\u594F\u4E91\u94FE\u63A5\u5DF2\u5931\u6548
- \u84DD\u594F\u4E91\u9875\u9762\u7ED3\u6784\u53D8\u5316`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/proxy-link") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { url: targetUrl, filename } = body;
        if (!targetUrl) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11\u94FE\u63A5\u5730\u5740" }, 400);
        }
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          return jsonRes({ success: false, error: "\u94FE\u63A5\u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" }, 400);
        }
        const id = generateUserId().replace("tx_", "px_");
        const slug = generateProxySlug();
        const proxySecret = getProxySecret(env);
        const sig = await signProxyId(id, proxySecret);
        await env.DB.prepare(
          "INSERT INTO proxy_links (id, slug, url, filename, sig, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, slug, targetUrl, filename || "", sig, Date.now()).run();
        const path = "/proxy/" + slug + "/" + id + "/" + sig;
        return jsonRes({ success: true, id, slug, sig, path, message: "\u94FE\u63A5\u5DF2\u4FDD\u5B58" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/proxy-links") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const { results } = await env.DB.prepare(
          "SELECT id, slug, url, filename, sig, created_at FROM proxy_links ORDER BY created_at DESC"
        ).all();
        return jsonRes({ success: true, links: results });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/api/admin/proxy-link/")) {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const id = url.pathname.replace("/api/admin/proxy-link/", "").trim();
        if (!id) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11ID" }, 400);
        }
        const { meta } = await env.DB.prepare(
          "DELETE FROM proxy_links WHERE id = ?"
        ).bind(id).run();
        if (meta?.changes === 0) {
          return jsonRes({ success: false, error: "\u94FE\u63A5\u4E0D\u5B58\u5728" }, 404);
        }
        return jsonRes({ success: true, message: "\u5DF2\u5220\u9664" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/proxy-links/batch-delete") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { ids } = body;
        if (!Array.isArray(ids) || ids.length === 0) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11ID\u5217\u8868" }, 400);
        }
        const placeholders = ids.map(() => "?").join(",");
        const { meta } = await env.DB.prepare(
          `DELETE FROM proxy_links WHERE id IN (${placeholders})`
        ).bind(...ids).run();
        return jsonRes({ success: true, deleted: meta?.changes || 0 });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/trim-descs") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const adminToken = authHeader.replace("Bearer ", "");
        const _checkAdminToken = /* @__PURE__ */ __name2(async function(tk, ev) {
          try {
            const data = await ev.STORAGE.get("token_" + tk);
            if (!data) return false;
            const info = JSON.parse(data);
            if (Date.now() > info.expiresAt) {
              await ev.STORAGE.delete("token_" + tk);
              return false;
            }
            if (info.isAdmin !== true) return false;
            return true;
          } catch (e) {
            return false;
          }
        }, "_checkAdminToken");
        if (!adminToken || !await _checkAdminToken(adminToken, env)) {
          return jsonRes({ success: false, error: "\u672A\u6388\u6743" }, 401);
        }
        if (!env.DB) {
          return jsonRes({ success: false, error: "\u6570\u636E\u5E93\u672A\u7ED1\u5B9A" }, 500);
        }
        const all = await env.DB.prepare("SELECT id, desc FROM cards").all();
        const rows = all && all.results ? all.results : [];
        let count = 0;
        for (const row of rows) {
          const rawDesc = row.desc || "";
          const lines = rawDesc.split("\n");
          if (lines.length > 2) {
            const trimmed = lines.slice(0, 2).join("\n");
            await env.DB.prepare("UPDATE cards SET desc = ? WHERE id = ?").bind(trimmed, row.id).run();
            count++;
          }
        }
        return jsonRes({ success: true, count });
      } catch (e) {
        return jsonRes({ success: false, error: e.message || "\u672A\u77E5\u9519\u8BEF" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/recover-links") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { cardIds } = body;
        if (!Array.isArray(cardIds) || cardIds.length === 0) {
          return jsonRes({ success: false, error: "\u8BF7\u63D0\u4F9B\u5361\u7247 ID \u5217\u8868" }, 400);
        }
        const list = await kvList(env, "card_links_");
        const allKeys = (list.keys || []).map((k) => k.name).filter((n) => n.startsWith("card_links_card_"));
        const indexed = [];
        const unordered = [];
        for (const keyName of allKeys) {
          const m = keyName.match(/^card_links_card_\d+_(\d+)$/);
          if (m) {
            indexed.push({ keyName, index: parseInt(m[1], 10) });
          } else {
            unordered.push(keyName);
          }
        }
        unordered.sort();
        unordered.forEach((keyName, i) => {
          indexed.push({ keyName, index: i });
        });
        let migrated = 0, skipped = 0, failed = 0;
        const details = [];
        for (const { keyName, index } of indexed) {
          if (index >= cardIds.length) {
            skipped++;
            details.push({ key: keyName, status: "skipped", reason: "\u7D22\u5F15\u8D85\u51FA\u5F53\u524D\u5361\u7247\u8303\u56F4" });
            continue;
          }
          const newCardId = cardIds[index];
          const newKey = "card_links_" + newCardId;
          if (newKey === keyName) {
            skipped++;
            continue;
          }
          try {
            const data = await kvGet(env, keyName);
            if (!data) {
              skipped++;
              details.push({ key: keyName, status: "skipped", reason: "\u6570\u636E\u4E3A\u7A7A" });
              continue;
            }
            await kvPut(env, newKey, data);
            migrated++;
            details.push({ key: keyName, newKey, status: "migrated", linkCount: JSON.parse(data).length });
          } catch (e) {
            failed++;
            details.push({ key: keyName, status: "failed", error: e.message });
          }
        }
        return jsonRes({ success: true, migrated, skipped, failed, total: allKeys.length, details: details.slice(0, 100) });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u6062\u590D\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/verification-questions") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const text = await request.text();
        if (!text || !text.trim()) {
          return jsonRes({ success: false, error: "\u5185\u5BB9\u4E3A\u7A7A" }, 400);
        }
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        const questions = [];
        for (let line of lines) {
          line = line.replace(/^A[：:]?\s*/, "");
          let q = "", a = "";
          const bMatch = line.match(/^(.*?)\s*B[：:]\s*(.+)$/);
          const qmMatch = line.match(/^(.*？)\s*[：:]\s*(.+)$/);
          if (bMatch) {
            q = bMatch[1].trim();
            a = bMatch[2].trim();
          } else if (qmMatch) {
            q = qmMatch[1].trim();
            a = qmMatch[2].trim();
          }
          if (q && a) questions.push(q + "?" + a);
        }
        if (questions.length === 0) {
          return jsonRes({ success: false, error: "\u672A\u89E3\u6790\u5230\u6709\u6548\u9898\u76EE\uFF08\u683C\u5F0F\uFF1AA\u95EE\u9898\uFF1FB\uFF1A\u7B54\u6848\uFF09" }, 400);
        }
        await kvPut(env, "verify_questions", JSON.stringify(questions));
        return jsonRes({ success: true, count: questions.length });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/verification-questions/count") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const raw = await kvGet(env, "verify_questions");
        const count = raw ? JSON.parse(raw).length : 0;
        return jsonRes({ success: true, count });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/verification/session") {
      try {
        const body = await request.json();
        const { fpHash } = body;
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!fpHash) return jsonRes({ error: "\u7F3A\u5C11\u6D4F\u89C8\u5668\u6307\u7EB9" }, 400);
        const freezeKey = `verify_freeze_${ip}_${fpHash}`;
        const freezeCheck = await checkAuthFreeze(env, freezeKey);
        if (freezeCheck.frozen) {
          return jsonRes({ error: `\u9A8C\u8BC1\u5DF2\u51BB\u7ED3\uFF0C\u8BF7 ${freezeCheck.remainMin} \u5206\u949F\u540E\u91CD\u8BD5`, frozen: true, retryAfter: freezeCheck.remainMin * 60 }, 403);
        }
        const raw = await kvGet(env, "verify_questions");
        if (!raw) return jsonRes({ error: "\u95EE\u9898\u5E93\u6682\u672A\u5F00\u653E" }, 503);
        const allQuestions = JSON.parse(raw);
        const available = Array.isArray(allQuestions) ? allQuestions.map((item,index)=>({item,index})).filter(({item})=>typeof item === "string" && item.lastIndexOf("?") > 0 && item.substring(item.lastIndexOf("?")+1).trim()) : [];
        if (!available.length) return jsonRes({ error: "问题库暂未开放，请联系管理员" }, 503);
        const chosen = available[crypto.getRandomValues(new Uint32Array(1))[0] % available.length];
        const qIdx = [chosen.index];
        const question = chosen.item.substring(0,chosen.item.lastIndexOf("?")).trim();
        const sessionData = { version: 2, ip, fpHash, cardId: body.cardId || "", qIdx, currentStep: 1, createdAt: Date.now() };
        const payload = btoa(unescape(encodeURIComponent(JSON.stringify(sessionData))));
        const sig = await hmacSha256(payload, requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
        const token = payload + "." + sig;
        return jsonRes({ success: true, sessionId: token, question, mathQuestion: question, totalSteps: 1 });
      } catch (e) {
        return jsonRes({ success: false, error: "\u9A8C\u8BC1\u670D\u52A1\u5F02\u5E38: " + (e.message || "\u672A\u77E5\u9519\u8BEF") }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/verification/answer") {
      try {
        const body = await request.json();
        const { sessionId, answer } = body;
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!sessionId) return jsonRes({ error: "\u7F3A\u5C11\u4F1A\u8BDDID" }, 400);
        if (answer === void 0 || answer === null || answer === "") return jsonRes({ error: "\u8BF7\u8F93\u5165\u7B54\u6848" }, 400);
        const parts = sessionId.split(".");
        if (parts.length !== 2) return jsonRes({ error: "\u4F1A\u8BDD\u683C\u5F0F\u9519\u8BEF" }, 400);
        const expectedSig = await hmacSha256(parts[0], requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
        if (expectedSig !== parts[1]) return jsonRes({ error: "\u4F1A\u8BDD\u7B7E\u540D\u65E0\u6548" }, 400);
        let session;
        try {
          session = JSON.parse(decodeURIComponent(escape(atob(parts[0]))));
        } catch (e) {
          return jsonRes({ error: "\u4F1A\u8BDD\u89E3\u6790\u5931\u8D25: " + e.message }, 400);
        }
        if (Date.now() - session.createdAt > 3e5) return jsonRes({ error: "\u4F1A\u8BDD\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB" }, 400);
        if (session.ip !== ip) return jsonRes({ error: "\u7F51\u7EDC\u73AF\u5883\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB" }, 400);
        const failKey = `verify_fail_${ip}_${session.fpHash}`;
        const freezeKey = `verify_freeze_${ip}_${session.fpHash}`;
        const frozen = await checkAuthFreeze(env, freezeKey);
        if (frozen.frozen) return jsonRes({ error: "验证已冻结，请稍后重试", frozen: true, retryAfter: frozen.remainMin * 60 }, 403);
        if (session.version === 2 && (session.currentStep !== 1 || !Array.isArray(session.qIdx) || session.qIdx.length !== 1)) return jsonRes({ error: "会话无效，请重新开始" }, 400);
        let correct = false;
        if (session.currentStep === 0) {
          const ansHash = await hmacSha256("ans:" + String(answer).trim().toLowerCase(), requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
          correct = ansHash === session.mh;
        } else {
          const bank = JSON.parse(await kvGet(env, "verify_questions"));
          const bi = session.qIdx[session.currentStep - 1];
          const item = bank[bi];
          if (item) {
            const sep = item.lastIndexOf("?");
            const expected = item.substring(sep + 1).trim();
            correct = String(answer).trim().toLowerCase() === expected.toLowerCase();
          }
        }
        if (!correct) {
          await recordAuthFail(env, failKey, freezeKey);
          const freezeCheck = await checkAuthFreeze(env, freezeKey);
          if (freezeCheck.frozen) {
            return jsonRes({ error: `\u9A8C\u8BC1\u5DF2\u51BB\u7ED3\uFF0C\u8BF7 ${freezeCheck.remainMin} \u5206\u949F\u540E\u91CD\u8BD5`, frozen: true, retryAfter: freezeCheck.remainMin * 60 }, 403);
          }
          const failRaw = await kvGet(env, failKey);
          const failCount = failRaw ? JSON.parse(failRaw).count : 0;
          const remaining = 5 - failCount;
          return jsonRes({ error: "\u7B54\u6848\u9519\u8BEF\uFF0C\u8BF7\u91CD\u65B0\u5F00\u59CB", reset: true, remainingAttempts: Math.max(0, remaining) }, 400);
        }
        session.currentStep++;
        if (session.version === 2 || session.currentStep >= 5) {
          const vData = { type: "download-verification", ip, cardId: session.cardId || "", createdAt: Date.now() };
          const vPayload = btoa(unescape(encodeURIComponent(JSON.stringify(vData))));
          const vSig = await hmacSha256(vPayload, requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
          const vToken = vPayload + "." + vSig;
          await clearAuthFail(env, failKey, freezeKey);
          return jsonRes({ success: true, done: true, verifyToken: vToken });
        }
        const bank2 = JSON.parse(await kvGet(env, "verify_questions"));
        const nextItem = bank2[session.qIdx[session.currentStep - 1]];
        const sep2 = nextItem ? nextItem.lastIndexOf("?") : -1;
        const nextQ = sep2 >= 0 ? nextItem.substring(0, sep2).trim() : "";
        const newPayload = btoa(unescape(encodeURIComponent(JSON.stringify(session))));
        const newSig = await hmacSha256(newPayload, requireEnvSecret(env.TURNSTILE_SECRET, "TURNSTILE_SECRET"));
        const newToken = newPayload + "." + newSig;
        return jsonRes({ success: true, step: session.currentStep + 1, question: nextQ, totalSteps: 5, sessionId: newToken });
      } catch (e) {
        return jsonRes({ success: false, error: "\u9A8C\u8BC1\u5F02\u5E38: " + (e.message || "\u672A\u77E5\u9519\u8BEF") }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/proxy/temp-link") {
      try {
        const body = await request.json();
        let { url: targetUrl, filename, dlPass } = body;
        let _tlOk = false;
        const _tlAuth = request.headers.get("Authorization") || "";
        const _tlTok = _tlAuth.startsWith("Bearer ") ? _tlAuth.substring(7) : "";
        if (_tlTok && await verifyToken(_tlTok, env)) _tlOk = true;
        let _downloadPass = null;
        if (!_tlOk && targetUrl && dlPass) {
          _downloadPass = await verifyDownloadPass(env, dlPass, targetUrl);
          _tlOk = !!_downloadPass;
        }
        if (!_tlOk) {
          return jsonRes({ success: false, error: "\u672A\u6388\u6743\uFF0C\u8BF7\u5148\u5B8C\u6210\u4E0B\u8F7D\u9A8C\u8BC1" }, 401);
        }
        if (!targetUrl) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11\u94FE\u63A5\u5730\u5740" }, 400);
        }
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          return jsonRes({ success: false, error: "\u94FE\u63A5\u5FC5\u987B\u4EE5 http:// \u6216 https:// \u5F00\u5934" }, 400);
        }
        const token = generateTempToken();
        const key = "px_tmp_" + token;
        const requesterIp = request.headers.get("CF-Connecting-IP") || "unknown";
        const downloadSecret = generateTempToken() + generateTempToken();
        const info = { url: targetUrl, filename: filename || "", created: Date.now(), maxDownloads: 1, requesterIp, started: false, downloadSecret,
          userId: _downloadPass ? _downloadPass.u : null, sessionVersion: _downloadPass ? _downloadPass.v : null, adminAuthorized: !_downloadPass };
        if (_downloadPass) {
          if (!await redeemDownloadPass(env, _downloadPass, token, info)) return jsonRes({ success: false, error: "下载凭据已使用或失效，请重新验证" }, 403);
        } else { await kvPut(env, key, JSON.stringify(info), { expirationTtl: 90 }); }
        return jsonRes({ success: true, token, path: "/px/" + token, expiresIn: 60, maxDownloads: 1 });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    const _proxyPathCheck = url.pathname.replace("/proxy/", "").trim();
    if (request.method === "GET" && url.pathname.startsWith("/proxy/") && _proxyPathCheck && !_proxyPathCheck.includes("/")) {
      try {
        const id = _proxyPathCheck;
        if (!id) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11\u94FE\u63A5ID" }, 400);
        }
        const { results } = await env.DB.prepare(
          "SELECT url, filename, slug, sig FROM proxy_links WHERE id = ?"
        ).bind(id).all();
        if (results.length === 0) {
          return jsonRes({ success: false, error: "\u94FE\u63A5\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" }, 404);
        }
        const r = results[0];
        const directUrl = `/proxy/${r.slug}/${id}/${r.sig}`;
        const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\u6B63\u5728\u4E0B\u8F7D...</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #fce4ec, #f8bbd0, #fce4ec);
    font-family: "Microsoft YaHei", sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  img { pointer-events: none; -webkit-user-drag: none; }
  .card {
    background: white;
    border-radius: 24px;
    padding: 36px 40px;
    box-shadow: 0 8px 32px rgba(233,30,99,0.15);
    text-align: center;
    max-width: 360px;
    width: 90%;
  }
  .title { font-size: 22px; font-weight: bold; color: #e91e63; margin-bottom: 6px; }
  .subtitle { font-size: 14px; color: #aaa; margin-bottom: 24px; }
  img { width: 200px; height: 200px; object-fit: cover; border-radius: 16px; margin-bottom: 20px; }
  .bar-wrap { background: #fce4ec; border-radius: 99px; height: 8px; overflow: hidden; margin-bottom: 12px; }
  .bar { height: 100%; background: linear-gradient(90deg, #f48fb1, #e91e63); border-radius: 99px; animation: loading 1.5s ease-in-out infinite; }
  @keyframes loading { 0% { width: 0%; } 50% { width: 80%; } 100% { width: 100%; } }
  .tip { font-size: 12px; color: #bbb; }
</style>
</head>
<body>
<div class="card">
  <div class="title">\u6B63\u5728\u4E0B\u8F7D\u4E2D\uFF0C\u4E0D\u8981\u7740\u6025\u8D77\u98DE</div>
  <div class="subtitle">\u5373\u5C06\u81EA\u52A8\u5F00\u59CB\u4E0B\u8F7D...</div>
  <img src="${DEFAULT_AVATAR}" alt="\u5C11\u5973" draggable="false">
  <div class="bar-wrap"><div class="bar"></div></div>
  <div class="tip">\u5982\u672A\u81EA\u52A8\u4E0B\u8F7D\uFF0C\u8BF7\u70B9\u51FB\u4E0B\u65B9\u94FE\u63A5</div>
  <br>
  <a href="${directUrl}" style="color:#e91e63;font-size:13px;">\u70B9\u51FB\u624B\u52A8\u4E0B\u8F7D</a>
</div>
<script>
  setTimeout(function() {
    window.location.href = "${directUrl}";
  }, 1500);
<\/script>
</body>
</html>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/dl/add") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "\u672A\u6388\u6743" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" } });
      }
      if (!await verifyToken(authHeader.substring(7), env)) {
        return new Response(JSON.stringify({ error: "Token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }), { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" } });
      }
      try {
        const body = await request.json();
        const lanzouUrl = body.url;
        const label = body.label || "";
        if (!lanzouUrl) {
          return new Response(JSON.stringify({ error: "\u7F3A\u5C11 url \u53C2\u6570" }), { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" } });
        }
        const allowed = [
          "lanzou.com",
          "lanzoui.com",
          "lanzoux.com",
          "lanzoub.com",
          "lanzouc.com",
          "lanzoud.com",
          "lanzous.com",
          "lanzout.com",
          "lanzouw.com",
          "lanzouv.com",
          "lanzoum.com",
          "lanzoun.com",
          "ilanzou.com"
        ];
        let isAllowed = false;
        try {
          isAllowed = allowed.some((d) => new URL(lanzouUrl).hostname.endsWith(d));
        } catch (e) {
        }
        if (!isAllowed) {
          return new Response(JSON.stringify({ error: "\u53EA\u652F\u6301\u84DD\u594F\u4E91\u94FE\u63A5" }), { status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" } });
        }
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        let code = "";
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        bytes.forEach((b) => code += chars[b % chars.length]);
        await kvPut(env, `shortlink_${code}`, lanzouUrl);
        const shortUrl = `${new URL(request.url).origin}/dl/${code}`;
        return new Response(JSON.stringify({ success: true, code, shortUrl }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: "\u6DFB\u52A0\u5931\u8D25: " + error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/send-code") {
      try {
        const body = await request.json();
        const { email, inviteCode, turnstileToken } = body;
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return jsonRes({ success: false, error: "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u90AE\u7BB1\u5730\u5740" }, 400);
        }
        const normalizedEmail = email.toLowerCase().trim();
        const existingUidForCode = await getUserByEmail(normalizedEmail, env);
        if (!existingUidForCode && (!inviteCode || !inviteCode.trim())) {
          return jsonRes({ success: false, error: "\u8BE5\u90AE\u7BB1\u672A\u6CE8\u518C\uFF0C\u8BF7\u8F93\u5165\u9080\u8BF7\u7801" }, 400);
        }
        if (!turnstileToken) {
          return jsonRes({ success: false, error: "\u8BF7\u5148\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1" }, 400);
        }
        const tsOk = await verifyTurnstile(turnstileToken, env);
        if (!tsOk) {
          return jsonRes({ success: false, error: "\u4EBA\u673A\u9A8C\u8BC1\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5" }, 403);
        }
        if (!existingUidForCode) {
          const permanentInvite = await kvGet(env, "admin_invite_code");
          const onetimeKey2 = `onetime_invite_${inviteCode.trim()}`;
          const onetimeInviteRaw = await kvGet(env, onetimeKey2);
          const isPermInvite = permanentInvite && permanentInvite === inviteCode.trim();
          const isOnetimeInvite = !!onetimeInviteRaw;
          if (!isPermInvite && !isOnetimeInvite) {
            return jsonRes({ success: false, error: "\u9080\u8BF7\u7801\u9519\u8BEF\u6216\u5DF2\u5931\u6548" }, 403);
          }
        }
        const sent = await issueEmailChallenge(env, request, "login", "", normalizedEmail);
        return jsonRes(sent, sent.status || 200);
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/email-login") {
      try {
        const body = await request.json();
        const { email, code, username, password, password2, inviteCode, fingerprint } = body;
        if (!email || !code) {
          return jsonRes({ success: false, error: "\u90AE\u7BB1\u548C\u9A8C\u8BC1\u7801\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
        }
        const normalizedEmail = email.toLowerCase().trim();
        const verification = await consumeEmailChallenge(env, "login", "", normalizedEmail, code);
        if (!verification.success) return jsonRes(verification, verification.status);
        const existingUserId = await getUserByEmail(normalizedEmail, env);
        let userId, finalUsername;
        if (existingUserId) {
          const userData2 = await getUserById(existingUserId, env);
          if (!userData2) {
            return jsonRes({ success: false, error: "\u7528\u6237\u6570\u636E\u5F02\u5E38" }, 500);
          }
          userId = userData2.userId;
          finalUsername = userData2.username;
          userData2.lastLoginAt = Date.now();
          if (password && !userData2.passwordHash) {
            if (!/[a-zA-Z]/.test(password)) {
              return jsonRes({ success: false, error: "\u5BC6\u7801\u987B\u542B\u5B57\u6BCD" }, 400);
            }
            const newHash = await hashPasswordPBKDF2(password);
            try {
              await updateUserD1(userId, { passwordHash: newHash }, env);
            } catch (e) {
            }
            try {
              userData2.passwordHash = newHash;
              await kvPut(env, `user_data_${userId}`, JSON.stringify(userData2));
            } catch (e) {
            }
          }
          try {
            await updateUserD1(userId, { lastLoginAt: Date.now() }, env);
          } catch (e) {
          }
        } else {
          if (!username) {
            return jsonRes({ success: false, error: "\u9996\u6B21\u767B\u5F55\u9700\u8981\u8BBE\u7F6E\u7528\u6237\u540D" }, 400);
          }
          if (username.length < 1 || username.length > 8) {
            return jsonRes({ success: false, error: "\u7528\u6237\u540D\u957F\u5EA61-8\u5B57\u7B26" }, 400);
          }
          if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username)) {
            return jsonRes({ success: false, error: "\u7528\u6237\u540D\u53EA\u80FD\u5305\u542B\u4E2D\u82F1\u6587\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF" }, 400);
          }
          if (!inviteCode) {
            return jsonRes({ success: false, error: "\u9996\u6B21\u767B\u5F55\u9700\u8981\u9080\u8BF7\u7801" }, 400);
          }
          const permanentInvite = await kvGet(env, "admin_invite_code");
          const onetimeKey2 = `onetime_invite_${inviteCode}`;
          const onetimeInviteRaw = await kvGet(env, onetimeKey2);
          const isPermInvite = permanentInvite && permanentInvite === inviteCode;
          const isOnetimeInvite = !!onetimeInviteRaw;
          if (!isPermInvite && !isOnetimeInvite) {
            return jsonRes({ success: false, error: "\u9080\u8BF7\u7801\u9519\u8BEF\u6216\u5DF2\u5931\u6548" }, 403);
          }
          if (isOnetimeInvite) {
            await kvDelete(env, onetimeKey2);
          }
          const nameExists = await getUserByUsername(username, env);
          if (nameExists) {
            return jsonRes({ success: false, error: "\u7528\u6237\u540D\u5DF2\u88AB\u6CE8\u518C" }, 400);
          }
          const now = Date.now();
          let passwordHash = null;
          if (password) {
            if (password.length < 8 || !/[a-zA-Z]/.test(password)) {
              return jsonRes({ success: false, error: "\u5BC6\u7801\u987B8\u4F4D\u4EE5\u4E0A\u4E14\u5305\u542B\u5B57\u6BCD" }, 400);
            }
            if (password2 && password !== password2) {
              return jsonRes({ success: false, error: "\u4E24\u6B21\u5BC6\u7801\u4E0D\u4E00\u81F4" }, 400);
            }
            passwordHash = await hashPasswordPBKDF2(password);
          }
          userId = await generateSequentialUserId(env);
          const userData2 = {
            userId,
            username,
            email: normalizedEmail,
            passwordHash: passwordHash || null,
            createdAt: now,
            lastLoginAt: now
          };
          await createUserD1(userData2, env);
          try {
            await kvPut(env, `user_data_${userId}`, JSON.stringify(userData2));
          } catch (e) {
          }
          try {
            await kvPut(env, `user_name_${username}`, userId);
          } catch (e) {
          }
          try {
            await kvPut(env, `email_user_${normalizedEmail}`, userId);
          } catch (e) {
          }
          finalUsername = username;
        }
        const ban = await checkBanStatus(userId, env);
        if (ban) return jsonRes({ success: false, banned: true, error: "账号已封禁", bannedUntil: ban.bannedUntil }, 403);
        const token = await generateUserToken(userId, env);
        return jsonRes({ success: true, token, userId, username: finalUsername });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u9519\u8BEF" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/forgot-password") {
      try {
        const { email, code, newPassword, turnstileToken } = await request.json();
        if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes({ success: false, error: "请输入有效邮箱" }, 400);
        const normalizedEmail = email.toLowerCase().trim();
        if (!code) {
          if (!await verifyTurnstile(turnstileToken, env)) return jsonRes({ success: false, error: "请完成人机验证" }, 403);
          if (!await getUserByEmail(normalizedEmail, env)) return jsonRes({ success: true, message: "如该邮箱已注册，验证码已发送至您的邮箱" });
          const sent = await issueEmailChallenge(env, request, "reset", "", normalizedEmail);
          return jsonRes(sent, sent.status || 200);
        }
        if (typeof newPassword !== "string" || newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword)) return jsonRes({ success: false, error: "新密码须8位以上且包含字母" }, 400);
        const verification = await consumeEmailChallenge(env, "reset", "", normalizedEmail, code);
        if (!verification.success) return jsonRes(verification, verification.status);
        const userId = await getUserByEmail(normalizedEmail, env);
        if (!userId) return jsonRes({ success: false, error: "用户不存在" }, 404);
        await resetPasswordAndSessions(env, userId, await hashPasswordPBKDF2(newPassword));
        return jsonRes({ success: true, message: "密码已重置，其他登录会话已失效，请重新登录" });
      } catch (_) { return safeJsonRes({ success: false, error: "重置失败，请稍后重试" }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/api/user/bind-email") {
      try {
        const userId = await verifyUserToken((request.headers.get("Authorization") || "").replace("Bearer ", ""), env);
        if (!userId) return jsonRes({ success: false, error: "登录已过期" }, 401);
        if (await checkBanStatus(userId, env)) return jsonRes({ success: false, banned: true, error: "账号已封禁" }, 403);
        const { email, code, turnstileToken } = await request.json();
        const user = await getUserById(userId, env);
        if (!user || user.email) return jsonRes({ success: false, error: "用户不存在或已绑定邮箱" }, 400);
        if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonRes({ success: false, error: "请输入有效邮箱地址" }, 400);
        const normalizedEmail = email.toLowerCase().trim();
        const existing = await getUserByEmail(normalizedEmail, env);
        if (existing && existing !== userId) return jsonRes({ success: false, error: "该邮箱已被其他账号绑定" }, 409);
        if (!code) {
          if (!await verifyTurnstile(turnstileToken, env)) return jsonRes({ success: false, error: "请完成人机验证" }, 403);
          const sent = await issueEmailChallenge(env, request, "bind", userId, normalizedEmail);
          return jsonRes(sent, sent.status || 200);
        }
        const verification = await consumeEmailChallenge(env, "bind", userId, normalizedEmail, code);
        if (!verification.success) return jsonRes(verification, verification.status);
        const result = await env.DB.prepare(`UPDATE users SET email = ? WHERE user_id = ? AND (email IS NULL OR email = '')
          AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(email) = ? AND user_id <> ?)`).bind(normalizedEmail, userId, normalizedEmail, userId).run();
        if (!changed(result)) return jsonRes({ success: false, error: "邮箱或账号绑定状态已变化，请重新操作" }, 409);
        await kvPut(env, "email_user_" + normalizedEmail, userId);
        const updated = await getUserById(userId, env);
        if (updated) await kvPut(env, "user_data_" + userId, JSON.stringify(updated));
        return jsonRes({ success: true, message: "邮箱绑定成功", email: normalizedEmail });
      } catch (_) { return safeJsonRes({ success: false, error: "绑定失败，请稍后重试" }, 500); }
    }
    if (request.method === "GET" && url.pathname === "/api/user/check_auth") {
      try {
        const state = url.searchParams.get("state");
        if (!state) return jsonRes({ success: false, error: "\u7F3A\u5C11state\u53C2\u6570" }, 400);
        const cache = caches.default;
        let resultRaw = null;
        const cached = await cache.match("https://internal/auth_result/" + state);
        if (cached) {
          resultRaw = await cached.text();
          await cache.delete("https://internal/auth_result/" + state);
        }
        if (!resultRaw) {
          const kvRaw = await kvGet(env, `auth_result_${state}`);
          if (kvRaw) {
            resultRaw = kvRaw;
            try {
              await kvDelete(env, `auth_result_${state}`);
            } catch (e) {
            }
          }
        }
        if (!resultRaw) return jsonRes({ success: false, error: "\u6388\u6743\u5C1A\u672A\u5B8C\u6210\u6216\u5DF2\u8FC7\u671F" }, 404);
        const result = JSON.parse(resultRaw);
        if (result.success) {
          return jsonRes({ success: true, token: result.token, userId: result.userId, username: result.username });
        }
        const errorMap = {
          "github_already_bound": "\u8BE5GitHub\u8D26\u53F7\u5DF2\u7ED1\u5B9A\u5176\u4ED6\u7528\u6237\uFF0C\u65E0\u6CD5\u91CD\u590D\u6CE8\u518C",
          "username_taken": "\u7528\u6237\u540D\u5DF2\u88AB\u62A2\u6CE8\uFF0C\u8BF7\u91CD\u65B0\u6CE8\u518C\u5E76\u6362\u4E00\u4E2A\u7528\u6237\u540D"
        };
        return jsonRes({ success: false, error: errorMap[result.error] || result.error, code: result.error }, 400);
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/login") {
      const loginIp = request.headers.get("CF-Connecting-IP") || "unknown";
      try {
        const body = await request.json();
        const { userId, password, fingerprint } = body;
        let loginId = userId;
        if (!userId || !password) {
          return jsonRes({ success: false, error: "\u8BF7\u8F93\u5165\u7528\u6237\u540D\u6216\u8D26\u53F7ID\u548C\u5BC6\u7801" }, 400);
        }
        const uid = await getUserByUsername(userId, env);
        if (!uid) {
          return jsonRes({ success: false, error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" }, 401);
        }
        loginId = uid;
        const fpHash = fingerprint ? await hashPassword(fingerprint.slice(0, 64)) : "no_fp";
        const freezeKey = `login_freeze_${loginIp}`;
        const failKey = `login_fail_${loginIp}`;
        const loginFreeze = await checkAuthFreeze(env, freezeKey);
        if (loginFreeze.frozen) {
          return jsonRes({ success: false, error: `\u8FDE\u7EED\u8F93\u95195\u6B21\uFF0C\u8BF7${loginFreeze.remainMin}\u5206\u949F\u540E\u518D\u8BD5` }, 403);
        }
        const userData2 = await getUserById(loginId, env);
        if (!userData2) {
          await recordLoginFail(env, failKey, freezeKey);
          return jsonRes({ success: false, error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" }, 401);
        }
        const _pv = await verifyPassword(password, userData2.passwordHash);
        if (!_pv.ok) {
          await recordLoginFail(env, failKey, freezeKey);
          return jsonRes({ success: false, error: "\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF" }, 401);
        }
        if (_pv.migrated) {
          try {
            await updateUserD1(loginId, { passwordHash: _pv.migrated }, env);
          } catch (e) {
          }
          try {
            userData2.passwordHash = _pv.migrated;
            await kvPut(env, `user_data_${loginId}`, JSON.stringify(userData2));
          } catch (e) {
          }
        }
        if (userData2.inviteType === "super" && userData2.inviterId && !userData2.inviterIsAdmin) {
          const inviterBanRaw = await kvGet(env, `banned_${userData2.inviterId}`);
          if (inviterBanRaw) {
            const inviterBan = JSON.parse(inviterBanRaw);
            if (Date.now() < inviterBan.bannedUntil) {
              await kvPut(env, `banned_${loginId}`, JSON.stringify({
                bannedUntil: inviterBan.bannedUntil,
                reason: `\u8FDE\u5E26\u5C01\u53F7\uFF1A\u9080\u8BF7\u4EBA ${userData2.inviterId} \u88AB\u5C01\u53F7`,
                bannedAt: Date.now()
              }));
              return jsonRes({ success: false, error: "\u4F60\u7684\u9080\u8BF7\u4EBA\u5DF2\u88AB\u5C01\u53F7\uFF0C\u4F60\u4E5F\u88AB\u8FDE\u5E26\u5C01\u53F7\uFF0C\u5C01\u53F7\u65F6\u95F4\u76F8\u540C" }, 403);
            }
          }
        }
        const THREE_MONTHS = 90 * 24 * 60 * 60 * 1e3;
        if (Date.now() - userData2.lastLoginAt > THREE_MONTHS) {
          try {
            await kvDelete(env, `user_data_${loginId}`);
            await kvDelete(env, `user_name_${userData2.username}`);
          } catch (e) {
          }
          return jsonRes({ success: false, error: "\u8D26\u53F7\u5DF2\u56E0\u8D85\u8FC73\u4E2A\u6708\u672A\u767B\u5F55\u88AB\u81EA\u52A8\u6CE8\u9500" }, 403);
        }
        userData2.lastLoginAt = Date.now();
        try {
          await updateUserD1(loginId, { lastLoginAt: Date.now() }, env);
        } catch (e) {
        }
        const banInfo = await checkBanStatus(loginId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({
            success: false,
            error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`,
            banned: true,
            bannedUntil: banInfo.bannedUntil,
            reason: banInfo.reason,
            daysLeft
          }, 403);
        }
        const token = await generateUserToken(loginId, env);
        await clearLoginFail(env, failKey, freezeKey);
        return jsonRes({
          success: true,
          token,
          userId: userData2.userId,
          username: userData2.username,
          message: "\u767B\u5F55\u6210\u529F"
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/me") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) {
          return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55" }, 401);
        }
        const userData2 = await getUserById(userId, env);
        if (!userData2) {
          return jsonRes({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" }, 404);
        }
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({
            success: false,
            error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`,
            banned: true,
            bannedUntil: banInfo.bannedUntil,
            reason: banInfo.reason,
            daysLeft,
            userId: userData2.userId,
            username: userData2.username
          }, 403);
        }
        return jsonRes({
          success: true,
          userId: userData2.userId,
          username: userData2.username,
          fishCoins: await getFishCoins(env, userId),
          createdAt: userData2.createdAt,
          lastLoginAt: userData2.lastLoginAt
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u83B7\u53D6\u4FE1\u606F\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/logout") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (token && token.startsWith("utk.")) {
          try {
            const _lp = token.split(".");
            if (_lp.length === 3) await kvPut(env, "bl_" + _lp[2], "1", { expirationTtl: 30 * 24 * 3600 });
          } catch (e) {
          }
        } else if (token) {
          try {
            await kvDelete(env, `user_token_${token}`);
          } catch (e) {
          }
        }
        return jsonRes({ success: true, message: "\u5DF2\u9000\u51FA\u767B\u5F55" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/comment") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) {
          return jsonRes({ success: false, error: "\u8BF7\u5148\u767B\u5F55\u540E\u518D\u8BC4\u8BBA" }, 401);
        }
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({ success: false, error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`, banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason, daysLeft }, 403);
        }
        const body = await request.json();
        const { cardId, score, comment, replyTo, replyToUser, replyToUserId } = body;
        if (!cardId || !comment) {
          return jsonRes({ success: false, error: "\u8BC4\u8BBA\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
        }
        let scoreNum = score ? parseFloat(score) : 0;
        if (scoreNum > 0) {
          if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 5) {
            return jsonRes({ success: false, error: "\u8BC4\u5206\u8303\u56F4 1-5 \u661F" }, 400);
          }
          scoreNum = Math.round(scoreNum * 2);
        }
        if (comment.length > 300) {
          return jsonRes({ success: false, error: "\u8BC4\u8BBA\u6700\u591A300\u5B57" }, 400);
        }
        const lastCommentKey = `comment_limit_${userId}`;
        const lastCommentRaw = await kvGet(env, lastCommentKey);
        if (lastCommentRaw) {
          const lastTime = parseInt(lastCommentRaw);
          const elapsed = Date.now() - lastTime;
          if (elapsed < 60 * 1e3) {
            const waitSeconds = Math.ceil((60 * 1e3 - elapsed) / 1e3);
            return jsonRes({ success: false, error: `\u8BC4\u8BBA\u592A\u9891\u7E41\uFF0C\u8BF7 ${waitSeconds} \u79D2\u540E\u518D\u8BD5`, code: "rate_limited", waitSeconds }, 429);
          }
        }
        const userData2 = await getUserById(userId, env);
        if (!userData2) {
          return jsonRes({ success: false, error: "\u7528\u6237\u4FE1\u606F\u4E0D\u5B58\u5728" }, 500);
        }
        if (scoreNum > 0) {
          const { results } = await env.DB.prepare(
            "SELECT 1 FROM comments WHERE card_id = ? AND user_id = ? AND score > 0 LIMIT 1"
          ).bind(cardId, userId).all();
          if (results.length > 0) {
            return jsonRes({ success: false, error: "\u4F60\u5DF2\u7ECF\u8BC4\u8FC7\u5206\u4E86\uFF0C\u6BCF\u4E2A\u8D26\u53F7\u53EA\u80FD\u8BC4\u4E00\u6B21" }, 400);
          }
        }
        const muteKey = `muted_comment_${userId}`;
        const muteRaw = await kvGet(env, muteKey);
        if (muteRaw) {
          const muteData = JSON.parse(muteRaw);
          const remaining = Math.ceil((muteData.muteUntil - Date.now()) / 1e3);
          if (remaining > 0) {
            return jsonRes({ success: false, error: `\u4F60\u56E0\u89E6\u53D1\u5C4F\u853D\u8BCD\u5DF2\u88AB\u7981\u8A00\uFF0C\u8FD8\u5269 ${remaining} \u79D2`, code: "muted", remaining }, 403);
          } else {
            await kvDelete(env, muteKey);
          }
        }
        const wlAllRaw = await kvGet(env, "wordlist_all");
        if (wlAllRaw) {
          const wlAll = JSON.parse(wlAllRaw);
          const commentLower = comment.toLowerCase();
          let hitWord = null;
          for (const [name, words] of Object.entries(wlAll)) {
            hitWord = words.find((w) => commentLower.includes(w.toLowerCase()));
            if (hitWord) break;
          }
          if (hitWord) {
            const muteUntil = Date.now() + 12 * 1e3;
            await kvPut(env, muteKey, JSON.stringify({ muteUntil, reason: hitWord }), { expirationTtl: 30 });
            return jsonRes({ success: false, error: "\u8BC4\u8BBA\u542B\u6709\u8FDD\u7981\u8BCD\uFF0C\u5DF2\u88AB\u7981\u8A00 12 \u79D2\uFF0C\u9700\u91CD\u65B0\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1", code: "muted", remaining: 12 }, 403);
          }
        }
        const _lvInfo2 = getLevelInfo(userData2.exp || 0);
        const userPub = {
          username: userData2.username || "\u672A\u77E5\u7528\u6237",
          avatar: await getCurrentAvatar(env, userId),
          level: _lvInfo2.level,
          levelColor: _lvInfo2.color,
          levelBg: _lvInfo2.bg,
          levelName: _lvInfo2.name,
          exp: userData2.exp || 0
        };
        const commentId = generateUserId().replace("tx_", "cm_");
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO comments (id, card_id, user_id, username, avatar, level, level_color, score, comment, created_at, reply_to, reply_to_user, reply_to_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          commentId,
          cardId,
          userId,
          userData2.username,
          userPub.avatar,
          userPub.level,
          userPub.levelColor,
          scoreNum,
          comment.trim(),
          now,
          replyTo || null,
          replyToUser || null,
          replyToUserId || null
        ).run();
        await kvPut(env, lastCommentKey, String(now), { expirationTtl: 120 });
        let parentContent = "";
        let parentUsername = replyToUser || "";
        let actualTargetUserId = replyToUserId || null;
        if (replyTo && replyToUser) {
          if (!actualTargetUserId) {
            const { results } = await env.DB.prepare(
              "SELECT user_id, comment, username FROM comments WHERE id = ?"
            ).bind(replyTo).all();
            if (results.length > 0) {
              actualTargetUserId = results[0].user_id;
              parentContent = results[0].comment;
              parentUsername = results[0].username;
            }
          } else {
            const { results } = await env.DB.prepare(
              "SELECT comment FROM comments WHERE id = ?"
            ).bind(replyTo).all();
            if (results.length > 0) parentContent = results[0].comment;
          }
          if (actualTargetUserId && actualTargetUserId !== userId) {
            const notifId = "notif_" + generateUserId().replace("tx_", "");
            await env.DB.prepare(
              `INSERT INTO reply_notifications (id, type, card_id, reply_comment_id, reply_content, reply_username, reply_avatar, reply_level, parent_content, parent_username, target_user_id, created_at, read)
               VALUES (?, 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
            ).bind(
              notifId,
              cardId,
              commentId,
              comment.trim(),
              userData2.username,
              userPub.avatar,
              userPub.level,
              parentContent,
              parentUsername,
              actualTargetUserId,
              now
            ).run();
          }
        }
        let expResult = { added: 0 };
        if (scoreNum > 0) {
          expResult = await addUserExp(userId, env, 10);
        }
        const { results: allComments } = await env.DB.prepare(
          "SELECT score FROM comments WHERE card_id = ?"
        ).bind(cardId).all();
        const totalCount = allComments.length;
        const scored = allComments.filter((c) => c.score > 0);
        const avgScore = scored.length > 0 ? (scored.reduce((s, c) => s + c.score, 0) / scored.length).toFixed(1) : 0;
        return jsonRes({
          success: true,
          avgScore,
          totalCount,
          message: "\u8BC4\u8BBA\u53D1\u8868\u6210\u529F" + (expResult.added > 0 ? ` +${expResult.added}\u7ECF\u9A8C` : ""),
          comment: {
            id: commentId,
            userId,
            username: userData2.username,
            avatar: userPub.avatar,
            level: userPub.level,
            levelColor: userPub.levelColor,
            score: scoreNum,
            comment: comment.trim(),
            createdAt: now,
            replyTo: replyTo || null,
            replyToUser: replyToUser || null,
            replyToUserId: replyToUserId || null
          },
          expAdded: expResult.added,
          exp: expResult.exp,
          level: expResult.level
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u8BC4\u8BBA\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/comment") {
      try {
        let to5Star = /* @__PURE__ */ __name(function(s10) {
          if (s10 >= 9) return 5;
          if (s10 >= 7) return 4;
          if (s10 >= 5) return 3;
          if (s10 >= 3) return 2;
          return 1;
        }, "to5Star");
        __name2(to5Star, "to5Star");
        const cardId = url.searchParams.get("cardId");
        if (!cardId) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11 cardId \u53C2\u6570" }, 400);
        }
        const { results } = await env.DB.prepare(
          `SELECT id, card_id, user_id, username, avatar, level, level_color, score, comment, created_at, reply_to, reply_to_user, reply_to_user_id
           FROM comments WHERE card_id = ? ORDER BY created_at ASC`
        ).bind(cardId).all();
        const userIdSet = /* @__PURE__ */ new Set();
        for (const row of results) {
          if (row.user_id) userIdSet.add(row.user_id);
        }
        const userCache = /* @__PURE__ */ new Map();
        const userIds = [...userIdSet];
        const userReads = userIds.map((uid) => getUserById(uid, env));
        const userResults = await Promise.all(userReads);
        for (let i = 0; i < userIds.length; i++) {
          const ud = userResults[i];
          if (ud) {
            const lvInfo = getLevelInfo(ud.exp || 0);
            userCache.set(userIds[i], {
              username: ud.username || "\u672A\u77E5\u7528\u6237",
              avatar: await getCurrentAvatar(env, userIds[i]),
              level: lvInfo.level,
              levelColor: lvInfo.color,
              levelBg: lvInfo.bg,
              levelName: lvInfo.name,
              exp: ud.exp || 0
            });
          }
        }
        const comments = [];
        for (const row of results) {
          const pub = row.user_id ? userCache.get(row.user_id) || null : null;
          comments.push({
            id: row.id,
            userId: row.user_id,
            username: pub?.username || row.username,
            avatar: pub?.avatar || row.avatar,
            level: pub?.level || row.level,
            levelColor: pub?.levelColor || row.level_color,
            levelBg: pub?.levelBg,
            score: row.score,
            comment: row.comment,
            createdAt: row.created_at,
            replyTo: row.reply_to,
            replyToUser: row.reply_to_user,
            replyToUserId: row.reply_to_user_id
          });
        }
        for (const c of comments) {
          if (c.score > 0) c.score = to5Star(c.score);
        }
        const scoredComments = comments.filter((c) => c.score > 0);
        const avgScore = scoredComments.length > 0 ? (scoredComments.reduce((sum, c) => sum + c.score, 0) / scoredComments.length).toFixed(1) : 0;
        const scoreDist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
        for (const c of scoredComments) {
          const s = Math.round(c.score);
          if (s >= 1 && s <= 5) scoreDist[s]++;
        }
        const maxDist = Math.max(...Object.values(scoreDist), 1);
        let userVoted = false;
        let currentUserInfo = null;
        let currentUserId = null;
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (token) {
          const userId = await verifyUserToken(token, env);
          if (userId) {
            currentUserId = userId;
            userVoted = comments.some((c) => c.userId === userId && c.score > 0);
            currentUserInfo = await getUserPublicInfo(userId, env);
          }
        }
        const _likeMap = {};
        const _likedSet = /* @__PURE__ */ new Set();
        const _cids = comments.map((c) => c.id);
        for (let i = 0; i < _cids.length; i += 50) {
          const chunk = _cids.slice(i, i + 50);
          const ph = chunk.map(() => "?").join(",");
          const { results: cnts } = await env.DB.prepare(
            `SELECT comment_id, COUNT(*) as cnt FROM comment_likes WHERE comment_id IN (${ph}) GROUP BY comment_id`
          ).bind(...chunk).all();
          for (const r of cnts) _likeMap[r.comment_id] = r.cnt;
          if (currentUserId) {
            const { results: mine } = await env.DB.prepare(
              `SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${ph})`
            ).bind(currentUserId, ...chunk).all();
            for (const r of mine) _likedSet.add(r.comment_id);
          }
        }
        for (const c of comments) {
          c.likes = _likeMap[c.id] || 0;
          c.userLiked = _likedSet.has(c.id);
        }
        return jsonRes({
          success: true,
          comments,
          avgScore,
          totalCount: comments.length,
          userVoted,
          scoredCount: scoredComments.length,
          scoreDist,
          maxDist,
          currentUser: currentUserInfo
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u83B7\u53D6\u8BC4\u8BBA\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/comment/like") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u8BF7\u5148\u767B\u5F55" }, 401);
        const body = await request.json();
        const { commentId, action } = body;
        if (!commentId || !action) return jsonRes({ success: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
        if (action === "like") {
          const { results } = await env.DB.prepare(
            "SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?"
          ).bind(commentId, userId).all();
          if (results.length > 0) return jsonRes({ success: false, error: "\u5DF2\u7ECF\u8D5E\u8FC7\u4E86" }, 400);
          await env.DB.prepare(
            "INSERT INTO comment_likes (comment_id, user_id, created_at) VALUES (?, ?, ?)"
          ).bind(commentId, userId, Date.now()).run();
          return jsonRes({ success: true, message: "\u70B9\u8D5E\u6210\u529F" });
        } else if (action === "unlike") {
          const { meta } = await env.DB.prepare(
            "DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?"
          ).bind(commentId, userId).run();
          if (meta?.changes === 0) return jsonRes({ success: false, error: "\u8FD8\u6CA1\u6709\u8D5E\u8FC7" }, 400);
          return jsonRes({ success: true, message: "\u53D6\u6D88\u8D5E\u6210\u529F" });
        }
        return jsonRes({ success: false, error: "\u65E0\u6548\u64CD\u4F5C" }, 400);
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/invite") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { action, inviteCode, count } = body;
        if (action === "set_permanent") {
          if (!inviteCode || inviteCode.length < 1) return jsonRes({ success: false, error: "\u9080\u8BF7\u7801\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
          await kvPut(env, "admin_invite_code", inviteCode);
          return jsonRes({ success: true, message: `\u6C38\u4E45\u9080\u8BF7\u7801\u5DF2\u8BBE\u7F6E\u4E3A\uFF1A${inviteCode}` });
        }
        if (action === "gen_onetime") {
          const num = Math.min(count || 1, 20);
          const codes = [];
          for (let i = 0; i < num; i++) {
            const code = generateOAuthState().slice(0, 8).toUpperCase();
            await kvPut(env, `onetime_invite_${code}`, JSON.stringify({ createdAt: Date.now() }));
            codes.push(code);
          }
          return jsonRes({ success: true, codes, message: `\u5DF2\u751F\u6210 ${codes.length} \u4E2A\u4E00\u6B21\u6027\u9080\u8BF7\u7801` });
        }
        if (action === "delete_onetime") {
          if (!inviteCode) return jsonRes({ success: false, error: "\u8BF7\u63D0\u4F9B\u8981\u5220\u9664\u7684\u9080\u8BF7\u7801" }, 400);
          await kvDelete(env, `onetime_invite_${inviteCode}`);
          return jsonRes({ success: true, message: `\u5DF2\u5220\u9664\uFF1A${inviteCode}` });
        }
        if (action === "list_onetime") {
          const list = await kvList(env, "onetime_invite_");
          const codes = list.keys.map((k) => k.name.replace("onetime_invite_", ""));
          return jsonRes({ success: true, codes, total: codes.length });
        }
        if (inviteCode) {
          await kvPut(env, "admin_invite_code", inviteCode);
          return jsonRes({ success: true, message: "\u9080\u8BF7\u7801\u5DF2\u66F4\u65B0" });
        }
        return jsonRes({ success: false, error: "\u672A\u77E5\u64CD\u4F5C" }, 400);
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/invite") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const code = await kvGet(env, "admin_invite_code");
        return jsonRes({ success: true, inviteCode: code || "" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname === "/api/admin/comment") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { cardId, commentId } = body;
        if (!cardId || !commentId) {
          return jsonRes({ success: false, error: "\u7F3A\u5C11\u53C2\u6570 cardId \u6216 commentId" }, 400);
        }
        const { meta } = await env.DB.prepare(
          "DELETE FROM comments WHERE id = ? AND card_id = ?"
        ).bind(commentId, cardId).run();
        if (meta?.changes === 0) {
          return jsonRes({ success: false, error: "\u8BC4\u8BBA\u4E0D\u5B58\u5728" }, 404);
        }
        await env.DB.prepare(
          "DELETE FROM reply_notifications WHERE reply_comment_id = ?"
        ).bind(commentId).run();
        return jsonRes({ success: true, message: "\u8BC4\u8BBA\u5DF2\u5220\u9664" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/ban") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { userId, days, reason } = body;
        if (!userId || typeof days !== "number" || days < 0) {
          return jsonRes({ success: false, error: "\u53C2\u6570\u9519\u8BEF" }, 400);
        }
        let isSuperInvited = false;
        let inviterId = null;
        let inviterIsAdmin = false;
        try {
          const userDataRaw = await kvGet(env, `user_data_${userId}`);
          if (userDataRaw) {
            const u = JSON.parse(userDataRaw);
            isSuperInvited = u.inviteType === "super";
            inviterId = u.inviterId || null;
            inviterIsAdmin = u.inviterIsAdmin || false;
          }
        } catch (e) {
        }
        if (days === 0) {
          await kvDelete(env, `banned_${userId}`);
          if (isSuperInvited && inviterId && !inviterIsAdmin) {
            await kvDelete(env, `banned_${inviterId}`);
          }
          return jsonRes({ success: true, message: "\u5DF2\u89E3\u5C01" + (isSuperInvited ? "\uFF08\u8FDE\u5E26\u89E3\u5C01\u4E86\u9080\u8BF7\u4EBA\uFF09" : "") });
        }
        const bannedUntil = Date.now() + days * 24 * 60 * 60 * 1e3;
        await kvPut(env, `banned_${userId}`, JSON.stringify({
          bannedUntil,
          reason: reason || "",
          bannedAt: Date.now()
        }));
        let extraMsg = "";
        if (isSuperInvited && inviterId && !inviterIsAdmin) {
          await kvPut(env, `banned_${inviterId}`, JSON.stringify({
            bannedUntil,
            reason: `\u8FDE\u5E26\u5C01\u53F7\uFF1A\u9080\u8BF7\u7684\u7528\u6237 ${userId} \u88AB\u5C01\u53F7` + (reason ? ` (${reason})` : ""),
            bannedAt: Date.now()
          }));
          extraMsg = "\uFF08\u5DF2\u8FDE\u5E26\u5C01\u53F7\u9080\u8BF7\u4EBA\uFF09";
        }
        return jsonRes({ success: true, message: `\u5DF2\u5C01\u53F7 ${days} \u5929` + extraMsg });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/user") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const keyword = url.searchParams.get("keyword") || "";
        if (!keyword) {
          return jsonRes({ success: false, error: "\u8BF7\u8F93\u5165\u5173\u952E\u8BCD" }, 400);
        }
        const users = [];
        if (keyword.startsWith("tx")) {
          const raw = await kvGet(env, `user_data_${keyword}`);
          if (raw) {
            const u = JSON.parse(raw);
            const banRaw = await kvGet(env, `banned_${u.userId}`);
            let bannedUntil = null;
            if (banRaw) {
              try {
                bannedUntil = JSON.parse(banRaw).bannedUntil;
              } catch (e) {
              }
            }
            users.push({ userId: u.userId, username: u.username, createdAt: u.createdAt, bannedUntil });
          }
        } else {
          const list = await kvList(env, "user_name_");
          for (const key of list.keys || []) {
            const uid = await kvGet(env, key.name);
            if (!uid) continue;
            const raw = await kvGet(env, `user_data_${uid}`);
            if (!raw) continue;
            const u = JSON.parse(raw);
            if (u.username && u.username.includes(keyword)) {
              const banRaw = await kvGet(env, `banned_${u.userId}`);
              let bannedUntil = null;
              if (banRaw) {
                try {
                  bannedUntil = JSON.parse(banRaw).bannedUntil;
                } catch (e) {
                }
              }
              users.push({ userId: u.userId, username: u.username, createdAt: u.createdAt, bannedUntil });
            }
          }
        }
        return jsonRes({ success: true, users });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/wordlist") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { name, words } = body;
        if (!name || !Array.isArray(words) || words.length === 0) {
          return jsonRes({ success: false, error: "\u53C2\u6570\u9519\u8BEF\uFF1A\u9700\u8981 name \u548C words \u6570\u7EC4" }, 400);
        }
        const cleaned = [...new Set(words.map((w) => String(w).trim()).filter((w) => w.length > 0))];
        if (cleaned.length === 0) {
          return jsonRes({ success: false, error: "\u5C4F\u853D\u8BCD\u5217\u8868\u4E3A\u7A7A" }, 400);
        }
        const wlAllRaw = await kvGet(env, "wordlist_all");
        let wlAll = wlAllRaw ? JSON.parse(wlAllRaw) : {};
        wlAll[name] = cleaned;
        await kvPut(env, "wordlist_all", JSON.stringify(wlAll));
        return jsonRes({ success: true, message: `\u5DF2\u5BFC\u5165\u300C${name}\u300D\uFF0C\u5171 ${cleaned.length} \u4E2A\u5C4F\u853D\u8BCD`, count: cleaned.length });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/wordlist") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const wlAllRaw = await kvGet(env, "wordlist_all");
        const wlAll = wlAllRaw ? JSON.parse(wlAllRaw) : {};
        const metaList = Object.entries(wlAll).map(([name, words]) => ({ name, count: words.length }));
        return jsonRes({ success: true, collections: metaList });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname === "/api/admin/wordlist") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { name } = body;
        if (!name) return jsonRes({ success: false, error: "\u7F3A\u5C11 name \u53C2\u6570" }, 400);
        const wlAllRaw = await kvGet(env, "wordlist_all");
        const wlAll = wlAllRaw ? JSON.parse(wlAllRaw) : {};
        if (!wlAll[name]) return jsonRes({ success: false, error: "\u5408\u96C6\u4E0D\u5B58\u5728" }, 404);
        delete wlAll[name];
        await kvPut(env, "wordlist_all", JSON.stringify(wlAll));
        return jsonRes({ success: true, message: `\u5DF2\u5220\u9664\u5408\u96C6\u300C${name}\u300D` });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (url.pathname === "/api/admin/lock") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.lid) {
            const existing = await kvGet(env, "admlock_" + body.lid);
            if (!existing) return jsonRes({ locked: true, user: "\u672A\u77E5" }, 409);
            await kvPut(env, "admlock_" + body.lid, JSON.stringify({ user: body.user || "\u7BA1\u7406\u5458", time: Date.now() }));
            return jsonRes({ success: true, lid: body.lid });
          }
          const list = await kvList(env, "admlock_");
          const now = Date.now();
          for (const k of list.keys || []) {
            const raw = await kvGet(env, k.name);
            if (!raw) continue;
            const d = JSON.parse(raw);
            if (now - (d.time || 0) > 3e5) {
              await kvDelete(env, k.name);
              continue;
            }
            if (d.token !== token) return jsonRes({ locked: true, user: d.user || "\u7BA1\u7406\u5458" }, 409);
            await kvDelete(env, k.name);
          }
          const lid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          await kvPut(env, "admlock_" + lid, JSON.stringify({ token, user: body.user || "\u7BA1\u7406\u5458", time: Date.now() }));
          return jsonRes({ success: true, lid });
        }
        if (request.method === "DELETE") {
          const body = await request.json().catch(() => ({}));
          if (body.lid) await kvDelete(env, "admlock_" + body.lid);
          return jsonRes({ success: true });
        }
      } catch (e) {
        return safeJsonRes({ error: e.message }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/upload-image") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
        const formData = await request.formData();
        const file = formData.get("file");
        const folder = formData.get("folder") || "";
        if (!file || !file.name) return jsonRes({ error: "\u8BF7\u9009\u62E9\u56FE\u7247" }, 400);
        const pvzBody = new FormData();
        pvzBody.append("file", file, file.name);
        const pvzRes = await fetch("https://pvz.2865036763.workers.dev/upload?password=" + encodeURIComponent(env.IMGBED_PASSWORD || "4399") + "&folder=" + encodeURIComponent(folder), { method: "POST", body: pvzBody });
        const data = await pvzRes.json();
        if (!data.success) return jsonRes({ error: data.error || "\u4E0A\u4F20\u5931\u8D25" }, 500);
        return jsonRes({ success: true, url: data.url });
      } catch (e) {
        return safeJsonRes({ error: "\u4E0A\u4F20\u5931\u8D25: " + e.message }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/imgbed-folders") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) return jsonRes({ error: "\u672A\u6388\u6743" }, 401);
        const pvzRes = await fetch("https://pvz.2865036763.workers.dev/folders?password=" + encodeURIComponent(env.IMGBED_PASSWORD || "4399"));
        const data = await pvzRes.json();
        return jsonRes(data);
      } catch (e) {
        return safeJsonRes({ error: "\u83B7\u53D6\u5931\u8D25" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/cleanup-users") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const THREE_MONTHS = 90 * 24 * 60 * 60 * 1e3;
        const now = Date.now();
        let cleaned = 0;
        let cursor, listComplete = false;
        while (!listComplete) {
          const opts = { prefix: "user_data_", limit: 1e3 };
          if (cursor) opts.cursor = cursor;
          const page = await kvList(env, opts);
          listComplete = page.list_complete;
          cursor = page.cursor;
          for (const key of page.keys || []) {
            const raw = await kvGet(env, key.name);
            if (!raw) continue;
            const user = JSON.parse(raw);
            const lastActive = user.lastLoginAt || user.createdAt || 0;
            if (now - lastActive > THREE_MONTHS) {
              await kvDelete(env, key.name);
              if (user.username) await kvDelete(env, `user_name_${user.username}`);
              cleaned++;
            }
          }
        }
        return jsonRes({ success: true, message: `\u5DF2\u6E05\u7406 ${cleaned} \u4E2A\u957F\u671F\u672A\u767B\u5F55\u7528\u6237` });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/rename") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({ success: false, error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`, banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason, daysLeft }, 403);
        }
        const body = await request.json();
        const newUsername = (body.newUsername || "").trim();
        if (!newUsername || !/[\u4e00-\u9fa5a-zA-Z0-9_]{1,8}$/.test(newUsername)) {
          return jsonRes({ success: false, error: "\u7528\u6237\u540D\u987B1-8\u4F4D\uFF0C\u4EC5\u9650\u4E2D\u82F1\u6587\u6570\u5B57\u4E0B\u5212\u7EBF" }, 400);
        }
        const userData2 = await getUserById(userId, env);
        if (!userData2) return jsonRes({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" }, 404);
        const existingUserId = await getUserByUsername(newUsername, env);
        if (existingUserId && existingUserId !== userId) {
          return jsonRes({ success: false, error: "\u8BE5\u7528\u6237\u540D\u5DF2\u88AB\u4F7F\u7528" }, 400);
        }
        const spendResult = await spendFishCoins(env, userId, 2, "rename", "\u6539\u540D\u6D88\u8D39");
        if (!spendResult.ok) {
          return jsonRes({ success: false, error: "\u5C0F\u9C7C\u5E72\u4E0D\u8DB3\uFF0C\u6539\u540D\u9700\u89812\u6761" }, 400);
        }
        const oldUsername = userData2.username;
        await updateUserD1(userId, {}, env);
        try {
          await env.DB.prepare("UPDATE users SET username = ? WHERE user_id = ?").bind(newUsername, userId).run();
        } catch (e) {
        }
        try {
          await kvPut(env, `user_data_${userId}`, JSON.stringify({ ...userData2, username: newUsername }));
        } catch (e) {
        }
        try {
          await kvDelete(env, `user_name_${oldUsername}`);
        } catch (e) {
        }
        try {
          await kvPut(env, `user_name_${newUsername}`, userId);
        } catch (e) {
        }
        return jsonRes({ success: true, username: newUsername, fishCoins: spendResult.balance, message: "\u6539\u540D\u6210\u529F\uFF01" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/checkin") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({ success: false, error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`, banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason, daysLeft }, 403);
        }
        const body = await request.json();
        const tsToken = body.tsToken;
        if (!tsToken) return jsonRes({ success: false, error: "\u8BF7\u5B8C\u6210\u4EBA\u673A\u9A8C\u8BC1" }, 403);
        const tsOk = await verifyTurnstile(tsToken, env);
        if (!tsOk) return jsonRes({ success: false, error: "\u4EBA\u673A\u9A8C\u8BC1\u672A\u901A\u8FC7" }, 403);
        const reward = await claimCheckinAtomic(env, userId);
        if (!reward.ok) return jsonRes({ success: false, error: "已签到，请明天再来", remainingSeconds: reward.remainingSeconds }, 400);
        const newBalance = reward.balance;
        await kvPut(env, "user_checkin_" + userId, String(Date.now()));
        const expResult = await addUserExp(userId, env, 20);
        return jsonRes({ success: true, fishCoins: newBalance, message: "\u7B7E\u5230\u6210\u529F\uFF01\u83B7\u5F971\u6761\u5C0F\u9C7C\u5E72" + (expResult.added > 0 ? ` +${expResult.added}\u7ECF\u9A8C` : ""), expAdded: expResult.added, exp: expResult.exp, level: expResult.level });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/redeem") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({ success: false, error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`, banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason, daysLeft }, 403);
        }
        const body = await request.json();
        const { type } = body;
        let cost = 0, code = "";
        if (type === "normal") {
          cost = 15;
          code = generateOAuthState().slice(0, 10);
          await kvPut(env, `onetime_invite_${code}`, JSON.stringify({ createdBy: userId, createdAt: Date.now() }));
        } else {
          return jsonRes({ success: false, error: "\u672A\u77E5\u7684\u5151\u6362\u7C7B\u578B" }, 400);
        }
        const spendResult = await spendFishCoins(env, userId, cost, "invite_exchange", `\u5151\u6362\u666E\u901A\u9080\u8BF7\u7801`);
        if (!spendResult.ok) return jsonRes({ success: false, error: `\u5C0F\u9C7C\u5E72\u4E0D\u8DB3\uFF0C\u9700\u8981${cost}\u6761` }, 400);
        return jsonRes({ success: true, code, cost, remainingFish: spendResult.balance, message: `\u5151\u6362\u6210\u529F\uFF01\u6D88\u8017${cost}\u6761\u5C0F\u9C7C\u5E72` });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/home") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const userRaw = await kvGet(env, `user_data_${userId}`);
        if (!userRaw) return jsonRes({ success: false, error: "\u7528\u6237\u4E0D\u5B58\u5728" }, 404);
        const userData2 = JSON.parse(userRaw);
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({
            success: false,
            error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`,
            banned: true,
            bannedUntil: banInfo.bannedUntil,
            reason: banInfo.reason,
            daysLeft,
            userId: userData2.userId,
            username: userData2.username
          }, 403);
        }
        const COOLDOWN = 24 * 60 * 60 * 1e3;
        const lastCheckinRaw = await kvGet(env, `user_checkin_${userId}`);
        let canCheckin = true, checkinRemaining = 0;
        if (lastCheckinRaw) {
          const last = parseInt(lastCheckinRaw);
          const elapsed = Date.now() - last;
          if (elapsed < COOLDOWN) {
            canCheckin = false;
            checkinRemaining = Math.ceil((COOLDOWN - elapsed) / 1e3);
          }
        }
        const favRaw = await kvGet(env, `user_fav_${userId}`);
        const favorites = favRaw ? JSON.parse(favRaw) : [];
        const lvInfo = getLevelInfo(userData2.exp || 0);
        let userEmail = userData2.email || "";
        if (!userEmail) {
          const d1User = await getUserById(userId, env);
          if (d1User && d1User.email) userEmail = d1User.email;
        }
        return jsonRes({
          success: true,
          userId: userData2.userId,
          email: userEmail,
          username: userData2.username,
          avatar: await getCurrentAvatar(env, userData2.userId),
          fishCoins: await getFishCoins(env, userId),
          exp: userData2.exp || 0,
          level: lvInfo.level,
          levelColor: lvInfo.color,
          levelBg: lvInfo.bg,
          levelName: lvInfo.name,
          levelProgress: lvInfo.progress,
          nextThreshold: lvInfo.nextThreshold,
          currentThreshold: lvInfo.currentThreshold,
          canCheckin,
          checkinRemaining,
          favorites,
          createdAt: userData2.createdAt
        });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/favorite") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const banInfo = await checkBanStatus(userId, env);
        if (banInfo) {
          const daysLeft = Math.ceil((banInfo.bannedUntil - Date.now()) / (24 * 60 * 60 * 1e3));
          return jsonRes({ success: false, error: `\u4F60\u5DF2\u88AB\u5C01\u53F7\uFF0C\u8BF7\u9075\u5B88\u6CD5\u5F8B\u6CD5\u89C4\uFF08\u5269\u4F59 ${daysLeft} \u5929\uFF09`, banned: true, bannedUntil: banInfo.bannedUntil, reason: banInfo.reason, daysLeft }, 403);
        }
        const body = await request.json();
        const { cardId, action } = body;
        const key = `user_fav_${userId}`;
        const favRaw = await kvGet(env, key);
        let favs = favRaw ? JSON.parse(favRaw) : [];
        if (action === "add") {
          if (!favs.includes(cardId)) favs.push(cardId);
        } else if (action === "remove") {
          favs = favs.filter((id) => id !== cardId);
        }
        await kvPut(env, key, JSON.stringify(favs));
        return jsonRes({ success: true, favorites: favs });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/replies") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT id, type, card_id, reply_comment_id, reply_content, reply_username,
                  reply_avatar, reply_level, parent_content, parent_username,
                  target_user_id, created_at, read
           FROM reply_notifications
           WHERE target_user_id = ?
           ORDER BY created_at DESC`
        ).bind(userId).all();
        const notifications = [];
        for (const row of results) {
          notifications.push({
            id: row.id,
            type: row.type,
            cardId: row.card_id,
            replyCommentId: row.reply_comment_id,
            replyContent: row.reply_content,
            replyUsername: row.reply_username,
            replyAvatar: row.reply_avatar,
            replyLevel: row.reply_level,
            parentContent: row.parent_content,
            parentUsername: row.parent_username,
            targetUserId: row.target_user_id,
            createdAt: row.created_at,
            read: row.read === 1
          });
        }
        return jsonRes({ success: true, notifications, total: notifications.length });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/replies/read") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const body = await request.json();
        const { notifId } = body;
        if (!notifId) return jsonRes({ success: false, error: "\u7F3A\u5C11notifId" }, 400);
        const { meta } = await env.DB.prepare(
          "UPDATE reply_notifications SET read = 1 WHERE id = ? AND target_user_id = ?"
        ).bind(notifId, userId).run();
        if (meta?.changes === 0) {
          return jsonRes({ success: false, error: "\u901A\u77E5\u4E0D\u5B58\u5728" }, 404);
        }
        return jsonRes({ success: true });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/replies/unread-count") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT COUNT(*) as count FROM reply_notifications WHERE target_user_id = ? AND read = 0"
        ).bind(userId).all();
        const count = results[0]?.count || 0;
        return jsonRes({ success: true, count });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    
    
    
    
    
    
    
    
    
    if (request.method === "POST" && url.pathname === "/api/admin/mail") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { title, content, expireDays, fishReward, avatarRewardUrl, avatarRewardName } = body;
        if (!title || !content) {
          return jsonRes({ success: false, error: "\u6807\u9898\u548C\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
        }
        const mailId = "mail_" + generateOAuthState().slice(0, 8);
        const expireAt = expireDays ? Date.now() + expireDays * 24 * 60 * 60 * 1e3 : 0;
        const mailData = {
          id: mailId,
          title,
          content,
          createdAt: Date.now(),
          expireAt,
          fishReward: fishReward || 0,
          avatarRewardUrl: null,
          avatarRewardName: null
        };
        await kvPut(env, `mail_${mailId}`, JSON.stringify(mailData));
        return jsonRes({ success: true, message: `\u90AE\u4EF6\u5DF2\u53D1\u9001\u7ED9\u6240\u6709\u7528\u6237`, mailId });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/admin/mails") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const list = await kvList(env, "mail_");
        const mails = [];
        for (const key of list.keys) {
          const raw = await kvGet(env, key.name);
          if (raw) {
            const m = JSON.parse(raw);
            mails.push(m);
          }
        }
        return jsonRes({ success: true, mails, total: mails.length });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "DELETE" && url.pathname === "/api/admin/mail") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const body = await request.json();
        const { mailId } = body;
        if (!mailId) return jsonRes({ success: false, error: "\u7F3A\u5C11mailId" }, 400);
        await kvDelete(env, `mail_${mailId}`);
        return jsonRes({ success: true, message: "\u90AE\u4EF6\u5DF2\u56DE\u6536" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/admin/mail/cleanup") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        if (!token || !await verifyToken(token, env)) {
          return jsonRes({ success: false, error: "\u65E0\u6743\u8BBF\u95EE" }, 403);
        }
        const list = await kvList(env, "mail_");
        let deleted = 0;
        for (const key of list.keys) {
          const raw = await kvGet(env, key.name);
          if (!raw) {
            await kvDelete(env, key.name);
            deleted++;
            continue;
          }
          const mailData = JSON.parse(raw);
          if (mailData.expireAt && Date.now() > mailData.expireAt) {
            await kvDelete(env, key.name);
            deleted++;
          }
        }
        return jsonRes({ success: true, message: `\u5DF2\u6E05\u7406 ${deleted} \u5C01\u8FC7\u671F\u90AE\u4EF6` });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/mails") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const userMailMetaRaw = await kvGet(env, `user_mail_meta_${userId}`);
        const userMailMeta = userMailMetaRaw ? JSON.parse(userMailMetaRaw) : {};
        const list = await kvList(env, "mail_");
        const mails = [];
        for (const key of list.keys) {
          const raw = await kvGet(env, key.name);
          if (!raw) continue;
          const mailData = JSON.parse(raw);
          if (mailData.expireAt && Date.now() > mailData.expireAt) {
            try {
              await kvDelete(env, key.name);
            } catch (e) {
            }
            continue;
          }
          const mailId = mailData.id;
          const meta = userMailMeta[mailId] || {};
          if (meta.deleted) continue;
          mails.push({ ...mailData, read: meta.read || false });
        }
        mails.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return jsonRes({ success: true, mails, total: mails.length });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/user/mail/read") {
      try {
        const userId = await verifyUserToken((request.headers.get("Authorization") || "").replace("Bearer ", ""), env);
        if (!userId) return jsonRes({ success: false, error: "登录已过期" }, 401);
        if (await checkBanStatus(userId, env)) return jsonRes({ success: false, banned: true, error: "账号已封禁" }, 403);
        const { mailId } = await request.json();
        if (typeof mailId !== "string" || !mailId || mailId.length > 200) return jsonRes({ success: false, error: "邮件不存在" }, 400);
        const raw = await kvGet(env, "mail_" + mailId);
        if (!raw) return jsonRes({ success: false, error: "邮件不存在" }, 404);
        const mail = JSON.parse(raw);
        if (mail.expireAt && Date.now() >= mail.expireAt) return jsonRes({ success: false, error: "邮件已过期" }, 410);
        const metaKey = "user_mail_meta_" + userId;
        const meta = JSON.parse(await kvGet(env, metaKey) || "{}");
        const oldMeta = meta[mailId] || {};
        if (oldMeta.deleted) return jsonRes({ success: false, error: "邮件已删除" }, 410);
        // Old read mail was already processed by the previous implementation. Do not grant it again.
        if (oldMeta.read) return jsonRes({ success: true, message: "已标记为已读", fishCoins: await getFishCoins(env, userId) });
        const reward = await claimMailRewardAtomic(env, userId, mailId, mail, oldMeta);
        meta[mailId] = { ...oldMeta, read: true, rewardClaimed: true, avatarClaimed: true };
        await kvPut(env, metaKey, JSON.stringify(meta));
        const message = reward.claimed ? [reward.fish ? "获得 " + reward.fish + " 条小鱼干" : "", ""].filter(Boolean).join(" + ") : "奖励已领取";
        return jsonRes({ success: true, message: message || "已标记为已读", fishCoins: reward.balance });
      } catch (_) { return safeJsonRes({ success: false, error: "领取失败，请稍后重试" }, 500); }
    }
    if (request.method === "POST" && url.pathname === "/api/user/mail/delete") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const body = await request.json();
        const { mailId } = body;
        const metaKey = `user_mail_meta_${userId}`;
        const metaRaw = await kvGet(env, metaKey);
        let meta = metaRaw ? JSON.parse(metaRaw) : {};
        if (!meta[mailId]) meta[mailId] = {};
        meta[mailId].deleted = true;
        await kvPut(env, metaKey, JSON.stringify(meta));
        return jsonRes({ success: true, message: "\u90AE\u4EF6\u5DF2\u5220\u9664" });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/user/unread-count") {
      try {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const userId = await verifyUserToken(token, env);
        if (!userId) return jsonRes({ success: false, error: "\u767B\u5F55\u5DF2\u8FC7\u671F" }, 401);
        const metaRaw = await kvGet(env, `user_mail_meta_${userId}`);
        const meta = metaRaw ? JSON.parse(metaRaw) : {};
        const list = await kvList(env, "mail_");
        let count = 0;
        for (const key of list.keys) {
          const raw = await kvGet(env, key.name);
          if (!raw) continue;
          const mailData = JSON.parse(raw);
          if (mailData.expireAt && Date.now() > mailData.expireAt) continue;
          const mailId = mailData.id;
          const mailMeta = meta[mailId] || {};
          if (mailMeta.deleted) continue;
          if (!mailMeta.read) count++;
        }
        return jsonRes({ success: true, count });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/px/")) {
      try {
        const token = url.pathname.replace("/px/", "").trim().split("/")[0].split("?")[0];
        if (!token) return new Response("Not Found", { status: 404 });
        const raw = await kvGet(env, "px_tmp_" + token);
        if (!raw) return new Response("\u94FE\u63A5\u5DF2\u8FC7\u671F\u6216\u4E0D\u5B58\u5728", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const info = JSON.parse(raw);
        if (!info.adminAuthorized && (!info.userId || !await isActiveDownloadSession(env, info.userId, info.sessionVersion))) {
          return new Response("下载授权已失效，请重新登录并验证", { status: 403 });
        }
        const leftDownloads = info.maxDownloads !== void 0 ? info.maxDownloads : 1;
        if (leftDownloads <= 0) {
          await kvDelete(env, "px_tmp_" + token);
          return new Response("\u4E0B\u8F7D\u6B21\u6570\u5DF2\u7528\u5B8C\uFF08\u96501\u6B21\uFF09", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const currentIp = request.headers.get("CF-Connecting-IP") || "unknown";
        if (info.requesterIp && info.requesterIp !== currentIp) {
          await kvDelete(env, "px_tmp_" + token);
          return new Response("\u26D4 \u94FE\u63A5\u5DF2\u88AB\u4ED6\u4EBA\u89E6\u53D1\uFF0C\u5DF2\u4F5C\u5E9F", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const isRaw = url.searchParams.get("raw") === "1";
        if (isRaw) {
          const pageToken2 = url.searchParams.get("pt") || "";
          if (!pageToken2) {
            return new Response("\u26D4 \u975E\u6CD5\u8BBF\u95EE\uFF1A\u8BF7\u4ECE\u4E0B\u8F7D\u9875\u9762\u70B9\u51FB\u6309\u94AE", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          const ptKey = "px_pt_" + pageToken2;
          const ptRaw = await kvGet(env, ptKey);
          if (!ptRaw || ptRaw !== token) {
            return new Response("\u26D4 \u4E0B\u8F7D\u9A8C\u8BC1\u5931\u8D25\uFF1A\u94FE\u63A5\u5DF2\u8FC7\u671F\u6216\u88AB\u7BE1\u6539", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          const downloadIp = request.headers.get("CF-Connecting-IP") || "unknown";
          if (info.requesterIp && info.requesterIp !== downloadIp) {
            await kvDelete(env, "px_tmp_" + token);
            return new Response("\u26D4 \u94FE\u63A5\u5DF2\u88AB\u4ED6\u4EBA\u89E6\u53D1\uFF0C\u5DF2\u4F5C\u5E9F", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          }
          if (info.downloadSecret) {
            const providedSecret = url.searchParams.get("ds") || "";
            if (providedSecret !== info.downloadSecret) {
              await kvDelete(env, "px_tmp_" + token);
              return new Response("\u26D4 \u5B89\u5168\u9A8C\u8BC1\u5931\u8D25", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
            }
          }
          if (!await consumeProxyDownload(env, token, pageToken2)) return new Response("下载凭据已使用或失效", { status: 403 });
          const targetUrl = info.url;
          const isHfResolve = targetUrl.includes("huggingface.co") && (targetUrl.includes("/resolve/") || targetUrl.includes("/blob/"));
          if (isHfResolve) {
            try {
              const HF_TOKEN = env.HF_TOKEN || "";
              const redirRes = await fetch(targetUrl, {
                method: "GET",
                redirect: "manual",
                headers: {
                  "Authorization": "Bearer " + HF_TOKEN,
                  "User-Agent": "HuggingFace/Hub-Client 0.20.1"
                }
              });
              const cdnUrl = redirRes.headers.get("Location");
              if ((redirRes.status === 302 || redirRes.status === 301) && cdnUrl) {
                const headers = new Headers();
                headers.set("Location", cdnUrl);
                if (info.filename) headers.set("Content-Disposition", 'attachment; filename="' + info.filename + '"');
                return new Response(null, { status: 302, headers });
              }
            } catch (e) {
            }
          }
          const isGithubRaw = targetUrl.includes("github.com") || targetUrl.includes("raw.githubusercontent.com");
          if (isGithubRaw) {
            try {
              const redirRes = await fetch(targetUrl, {
                method: "GET",
                redirect: "manual",
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
              });
              const rawUrl = redirRes.headers.get("Location");
              if ((redirRes.status === 302 || redirRes.status === 301) && rawUrl) {
                const headers = new Headers();
                headers.set("Location", rawUrl);
                if (info.filename) headers.set("Content-Disposition", 'attachment; filename="' + info.filename + '"');
                return new Response(null, { status: 302, headers });
              }
              if (redirRes.status === 200) {
                return doProxyDownload(targetUrl, info.filename, request, env, "tmp_" + token);
              }
            } catch (e) {
            }
          }
          const lanzouHosts = ["lanzou.com", "lanzoui.com", "lanzoux.com", "lanzoub.com", "lanzouc.com", "lanzoud.com", "lanzous.com", "lanzout.com", "lanzouw.com", "lanzouv.com", "lanzoum.com", "lanzoun.com", "ilanzou.com"];
          let isLanzou = false;
          try {
            isLanzou = lanzouHosts.some((h) => new URL(targetUrl).hostname.endsWith(h));
          } catch (e) {
          }
          if (isLanzou) {
            try {
              const lanzouDirect = await parseLanzou(targetUrl);
              if (lanzouDirect) {
                const headers = new Headers();
                headers.set("Location", lanzouDirect);
                if (info.filename) headers.set("Content-Disposition", 'attachment; filename="' + info.filename + '"');
                return new Response(null, { status: 302, headers });
              }
            } catch (e) {
            }
          }
          return doProxyDownload(targetUrl, info.filename, request, env, "tmp_" + token);
        }
        const elapsed = Date.now() - info.created;
        if (elapsed > 6e4) {
          await kvDelete(env, "px_tmp_" + token);
          return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>\u94FE\u63A5\u5DF2\u8FC7\u671F</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#fff;flex-direction:column;gap:16px;color:#999;text-align:center;padding:0 20px;}h1{font-size:48px;margin:0;color:#ddd;}p{font-size:14px;line-height:1.6;}</style></head><body><h1>\u23F1\uFE0F</h1><p>\u94FE\u63A5\u5DF2\u8FC7\u671F<br><span style="font-size:12px;color:#bbb;">\u8BE5\u4E0B\u8F7D\u94FE\u63A5\u5DF2\u8D85\u8FC760\u79D2\u6709\u6548\u671F\uFF0C\u5DF2\u88AB\u81EA\u52A8\u9500\u6BC1</span></p></body></html>`, { status: 410, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const pageToken = generateTempToken() + generateTempToken();
        await kvPut(env, "px_pt_" + pageToken, token, { expirationTtl: 60 });
        const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>\u4E0B\u8F7D\u51C6\u5907\u5C31\u7EEA</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(135deg,#fce4ec,#f8bbd0,#fce4ec);font-family:"Microsoft YaHei",sans-serif}
/* \u{1F4F5} \u7981\u6B62\u622A\u56FE */
body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:manipulation;}
img{pointer-events:none;-webkit-user-drag:none}
.card{background:white;border-radius:24px;padding:36px 24px;box-shadow:0 8px 32px rgba(233,30,99,0.15);text-align:center;max-width:380px;width:90%}
.title{font-size:20px;font-weight:bold;color:#e91e63;margin-bottom:8px}
.subtitle{font-size:13px;color:#888;margin-bottom:20px}
img{width:160px;height:160px;object-fit:cover;border-radius:16px;margin-bottom:16px}
.info{background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#e65100;text-align:left;word-break:break-all}
.btn{display:inline-block;width:100%;padding:14px 0;background:linear-gradient(135deg,#ff6699,#e91e63);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:bold;cursor:pointer;text-decoration:none;margin-bottom:8px}
.tip{font-size:11px;color:#bbb;margin-top:8px}
</style>
</head>
<body>
<div class="card">
<div class="title">\u2705 \u4E0B\u8F7D\u51C6\u5907\u5C31\u7EEA</div>
<img src="${DEFAULT_AVATAR}" alt="\u5C11\u5973" draggable="false">
<div class="info">\u{1F4CE} ${(info.filename || "\u4E0B\u8F7D\u6587\u4EF6").replace(/[<>&"']/g, "")}</div>
<div id="countdown" style="font-size:13px;color:#e91e63;margin-bottom:12px;font-weight:bold;">\u23F1\uFE0F \u8BF7\u5728 60 \u79D2\u5185\u70B9\u51FB\u4E0B\u8F7D</div>
<button id="dlBtn" class="btn">\u2B07\uFE0F \u70B9\u51FB\u4E0B\u8F7D</button>
<div id="statusMsg" style="font-size:11px;color:#999;margin-top:8px;min-height:16px;"></div>
</div>
<script>
window.__ds='${info.downloadSecret || ""}';
// 60\u79D2\u5012\u8BA1\u65F6 + \u79BB\u5F00\u9875\u9762\u5931\u6548
document.addEventListener('DOMContentLoaded',function(){
  var btn=document.getElementById('dlBtn');
  var cd=document.getElementById('countdown');
  var sm=document.getElementById('statusMsg');
  if(!btn||!cd)return;

  // 60\u79D2\u5012\u8BA1\u65F6\uFF08\u4EC5UI\u63D0\u793A\uFF0C\u5B9E\u9645\u9A8C\u8BC1\u5728\u540E\u7AEF\uFF09
  var left=60;
  var timer=setInterval(function(){
    left--;
    if(left>0){cd.textContent='\u23F1\uFE0F \u8BF7\u5728 '+left+' \u79D2\u5185\u70B9\u51FB\u4E0B\u8F7D';}
    else{cd.textContent='\u23F1\uFE0F \u5373\u5C06\u8FC7\u671F\uFF0C\u8BF7\u5C3D\u5FEB\u70B9\u51FB';clearInterval(timer);}
  },1000);

  // \u70B9\u51FB\u4E0B\u8F7D
  btn.addEventListener('click',function(){
    clearInterval(timer);
    btn.disabled=true;
    btn.textContent='\u{1F680} \u6B63\u5728\u5F00\u59CB\u4E0B\u8F7D...';
    if(sm)sm.textContent='\u4E0B\u8F7D\u5B8C\u6210\u540E\u94FE\u63A5\u81EA\u52A8\u9500\u6BC1';
    setTimeout(function(){window.location.href='${url.pathname}?raw=1&pt=${pageToken}&ds='+window.__ds;},300);
  });
});
<\/script>
</body>
</html>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "https://tian-xiao.com" }
        });
      } catch (e) {
        return new Response("Not Found", { status: 404 });
      }
    }
    if (request.method === "GET" && url.pathname.startsWith("/proxy/")) {
      try {
        const proxyPath = url.pathname.replace("/proxy/", "").trim();
        const pathParts = proxyPath.split("/");
        if (pathParts.length < 3) {
          return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
        const slug = pathParts[0];
        const id = pathParts[1];
        const sigHex = pathParts[2] || "";
        const proxySecret = getProxySecret(env);
        const sigOk = await verifyProxyId(id, sigHex, proxySecret);
        if (!sigOk) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const { results } = await env.DB.prepare(
          "SELECT url, filename, sig FROM proxy_links WHERE id = ? AND slug = ?"
        ).bind(id, slug).all();
        if (results.length === 0) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const dbSig = results[0].sig;
        const targetUrl = results[0].url;
        const filename = results[0].filename;
        if (sigHex !== dbSig) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        const requestReferer = request.headers.get("Referer") || "";
        const requestOrigin = request.headers.get("Origin") || "";
        const currentHost = new URL(request.url).hostname;
        const allowedHosts = [currentHost, "localhost", "127.0.0.1"];
        let _refHost2 = "", _oriHost = "";
        try {
          _refHost2 = requestReferer ? new URL(requestReferer).hostname : "";
        } catch (e) {
        }
        try {
          _oriHost = requestOrigin ? new URL(requestOrigin).hostname : "";
        } catch (e) {
        }
        const refererOk = !requestReferer || allowedHosts.includes(_refHost2);
        const originOk = !requestOrigin || allowedHosts.includes(_oriHost);
        if (!refererOk && !originOk) return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        return doProxyDownload(targetUrl, filename, request, env, id);
      } catch (e) {
        return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/ghdl/auth") {
      try {
        const body = await request.json();
        const { turnstileToken, verifyToken: verifyToken2, userToken, captchaAnswer, captchaSessionId, captchaQuestion, githubUrl } = body;
        let realUrl = githubUrl || "";
        if (realUrl.startsWith("/dl/")) {
          const code = realUrl.replace("/dl/", "").trim();
          const targetUrl = await kvGet(env, "shortlink_" + code);
          if (!targetUrl) return jsonRes({ success: false, error: "\u77ED\u94FE\u4E0D\u5B58\u5728" }, 404);
          realUrl = targetUrl;
        }
        const session = await getVerifiedUserSession(userToken, env);
        if (!session) return jsonRes({ success: false, error: "登录已过期" }, 401);
        const userId = session.userId;
        if (!await isActiveDownloadSession(env, userId, session.version)) return jsonRes({ success: false, banned: true, error: "账号或下载授权已失效" }, 403);
        if (typeof realUrl !== "string" || !/^https?:\/\//.test(realUrl)) return jsonRes({ success: false, error: "下载地址无效" }, 400);
        if (verifyToken2) {
          const vrfyRaw = await kvGet(env, `vrfy_${verifyToken2}`);
          if (!vrfyRaw) return jsonRes({ success: false, error: "\u9A8C\u8BC1\u4EE4\u724C\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u9A8C\u8BC1" }, 403);
          await kvDelete(env, `vrfy_${verifyToken2}`);
        } else {
          const turnstileOk = await verifyTurnstile(turnstileToken, env);
          if (!turnstileOk) return jsonRes({ success: false, error: "\u4EBA\u673A\u9A8C\u8BC1\u5931\u8D25" }, 403);
          if (captchaSessionId) {
            const kvKey = "captcha_" + captchaSessionId;
            const correctAnswer = await kvGet(env, kvKey);
            if (!correctAnswer) return jsonRes({ success: false, error: "\u9A8C\u8BC1\u7801\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u83B7\u53D6" }, 400);
            await kvDelete(env, kvKey);
            if (String(captchaAnswer).trim() !== correctAnswer) {
              return jsonRes({ success: false, error: "\u7B54\u6848\u9519\u8BEF" }, 400);
            }
          } else if (captchaQuestion) {
            const m = captchaQuestion.match(/^(\d+)\s+([+\-\u00d7xX*])\s+(\d+)\s*=\s*\?$/);
            if (!m) return jsonRes({ success: false, error: "\u9A8C\u8BC1\u7801\u683C\u5F0F\u9519\u8BEF" }, 400);
            const na = parseInt(m[1]), op = m[2], nb = parseInt(m[3]);
            let ca;
            if (op === "+") ca = String(na + nb);
            else if (op === "-") ca = String(na - nb);
            else ca = String(na * nb);
            if (String(captchaAnswer).trim() !== ca) return jsonRes({ success: false, error: "\u7B54\u6848\u9519\u8BEF" }, 400);
          } else {
            return jsonRes({ success: false, error: "\u7F3A\u5C11\u9A8C\u8BC1\u7801\u4FE1\u606F" }, 400);
          }
        }
        const expiresAt = Date.now() + 60000, passId = securityId();
        const passInfo = { id: passId, u: userId, v: session.version, url: realUrl, e: expiresAt };
        const dlPass = await signDownloadPass(env, passInfo);
        const spendResult = await authorizeDownloadAtomic(env, userId, session.version, realUrl, passId, expiresAt);
        if (!spendResult.ok) return jsonRes({ success: false, error: spendResult.limited ? "24小时内下载次数已达上限（10次）" : "余额不足或登录状态已变化", needCoins: !spendResult.limited, code: spendResult.limited ? "DL_LIMIT_REACHED" : "DOWNLOAD_DENIED" }, spendResult.limited ? 429 : 400);
        return jsonRes({ success: true, githubUrl: realUrl, fishCoins: spendResult.balance, dlPass, quotaConsumed: true });
      } catch (e) {
        return safeJsonRes({ success: false, error: "\u670D\u52A1\u5668\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/api/download/check") {
      try {
        const { userToken, action } = await request.json();
        const session = await getVerifiedUserSession(userToken, env);
        if (!session) return jsonRes({ success: false, error: "登录已过期", code: "AUTH_REQUIRED" }, 401);
        if (!await isActiveDownloadSession(env, session.userId, session.version)) return jsonRes({ success: false, banned: true, error: "账号已封禁" }, 403);
        const state = await getDownloadLimit(env, session.userId);
        if (state.count >= 10 && action !== "consume") return jsonRes({ success: false, error: "24小时内下载次数已达上限（10次）", code: "DL_LIMIT_REACHED", limit: 10, used: state.count, remaining: 0 }, 429);
        // Compatibility calls with action=consume are read-only. Authorization owns the debit and quota transaction.
        return jsonRes({ success: true, limit: 10, used: state.count, remaining: Math.max(0, 10 - state.count), resetAt: state.resetAt });
      } catch (_) { return safeJsonRes({ success: false, error: "下载状态暂不可用" }, 503); }
    }
    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "https://tian-xiao.com"
      }
    });
  }
};
async function parseLanzou(shareUrl) {
  const baseUrl = new URL(shareUrl);
  const hostname = baseUrl.hostname;
  const isNewVersion = hostname.includes("ilanzou.com");
  if (isNewVersion) {
    return await parseLanzouNew(shareUrl, baseUrl);
  } else {
    return await parseLanzouOld(shareUrl, baseUrl);
  }
}
__name(parseLanzou, "parseLanzou");
__name2(parseLanzou, "parseLanzou");
async function parseLanzouNew(shareUrl, baseUrl) {
  const apiUrl = `https://api.52vmy.cn/api/query/pan/ilanzou?url=${encodeURIComponent(shareUrl)}`;
  const res = await fetch(apiUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://api.52vmy.cn/"
    }
  });
  if (!res.ok) throw new Error(`\u89E3\u6790\u63A5\u53E3\u8BF7\u6C42\u5931\u8D25: ${res.status}`);
  const data = await res.json();
  if (data.code !== 200) throw new Error(`\u89E3\u6790\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF: ${data.msg || JSON.stringify(data)}`);
  const downUrl = data.data?.url;
  if (!downUrl) throw new Error("\u89E3\u6790\u63A5\u53E3\u672A\u8FD4\u56DE\u4E0B\u8F7D\u5730\u5740");
  return downUrl;
}
__name(parseLanzouNew, "parseLanzouNew");
__name2(parseLanzouNew, "parseLanzouNew");
async function parseLanzouOld(shareUrl, baseUrl) {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const pageRes = await fetch(shareUrl, {
    headers: { "User-Agent": ua, "Referer": `${baseUrl.origin}/` },
    redirect: "follow"
  });
  if (!pageRes.ok) throw new Error(`\u9875\u9762\u8BF7\u6C42\u5931\u8D25: ${pageRes.status}`);
  const pageHtml = await pageRes.text();
  const iframeMatch = pageHtml.match(/iframe[^>]+src=['"](\/fn\?[^'"]+)['"]/);
  if (!iframeMatch) throw new Error("\u672A\u627E\u5230\u4E0B\u8F7D iframe\uFF0C\u94FE\u63A5\u53EF\u80FD\u5DF2\u5931\u6548");
  const iframeUrl = `${baseUrl.origin}${iframeMatch[1]}`;
  const iframeRes = await fetch(iframeUrl, {
    headers: { "User-Agent": ua, "Referer": shareUrl }
  });
  if (!iframeRes.ok) throw new Error(`iframe \u8BF7\u6C42\u5931\u8D25: ${iframeRes.status}`);
  const iframeHtml = await iframeRes.text();
  const directMatch = iframeHtml.match(/href=['"](https?:\/\/[^'"]*\.(?:zip|rar|apk|exe|pdf|mp4|mkv|txt|7z)[^'"]*)['"]/i);
  if (directMatch) return directMatch[1];
  const signMatch = iframeHtml.match(/var\s+signs?\s*=\s*'([^']+)'/) || iframeHtml.match(/['"]sign['"]\s*:\s*['"]([^'"]+)['"]/);
  const websignMatch = iframeHtml.match(/var\s+websign\s*=\s*'([^']+)'/);
  const websignkeyMatch = iframeHtml.match(/var\s+websignkey\s*=\s*'([^']+)'/);
  if (!signMatch) throw new Error("\u672A\u80FD\u63D0\u53D6 sign \u53C2\u6570");
  const postData = new URLSearchParams({ action: "downprocess", sign: signMatch[1], ves: "1" });
  if (websignMatch) postData.set("websign", websignMatch[1]);
  if (websignkeyMatch) postData.set("websignkey", websignkeyMatch[1]);
  const ajaxRes = await fetch(`${baseUrl.origin}/ajaxm.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": iframeUrl,
      "User-Agent": ua,
      "X-Requested-With": "XMLHttpRequest"
    },
    body: postData.toString()
  });
  if (!ajaxRes.ok) throw new Error(`ajax \u8BF7\u6C42\u5931\u8D25: ${ajaxRes.status}`);
  const ajaxData = await ajaxRes.json();
  if (ajaxData.zt !== 1) throw new Error(`\u84DD\u594F\u4E91\u8FD4\u56DE\u9519\u8BEF: ${JSON.stringify(ajaxData)}`);
  return `${ajaxData.dom}/file/${ajaxData.url}`;
}
__name(parseLanzouOld, "parseLanzouOld");
__name2(parseLanzouOld, "parseLanzouOld");
async function generateToken(env, clientIp) {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const token = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiresAt = Date.now() + 12 * 60 * 60 * 1e3;
  await kvPut(env, `token_${token}`, JSON.stringify({
    createdAt: Date.now(),
    expiresAt,
    clientIp: clientIp || null,
    isAdmin: true
  }), {
    expirationTtl: 12 * 60 * 60
  });
  return token;
}
__name(generateToken, "generateToken");
__name2(generateToken, "generateToken");
async function verifyToken(token, env) {
  try {
    const data = await kvGet(env, `token_${token}`);
    if (!data) return false;
    const tokenInfo = JSON.parse(data);
    if (Date.now() > tokenInfo.expiresAt) {
      await kvDelete(env, `token_${token}`);
      return false;
    }
    if (tokenInfo.isAdmin !== true) return false;
    return true;
  } catch (e) {
    return false;
  }
}
__name(verifyToken, "verifyToken");
__name2(verifyToken, "verifyToken");
async function findValidToken(env) {
  try {
    const list = await kvList(env, "token_", 50);
    for (const key of list.keys) {
      const data = await kvGet(env, key.name);
      if (!data) continue;
      try {
        const tokenInfo = JSON.parse(data);
        if (tokenInfo.isAdmin !== true) continue;
        if (Date.now() + 60 * 60 * 1e3 < tokenInfo.expiresAt) {
          return key.name.substring(6);
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
__name(findValidToken, "findValidToken");
__name2(findValidToken, "findValidToken");
async function cleanupExpiredTokens(env) {
  try {
    const list = await kvList(env, "token_", 100);
    let deletedCount = 0;
    const maxToKeep = 10;
    const tokens = [];
    for (const key of list.keys) {
      const data = await kvGet(env, key.name);
      if (!data) {
        await kvDelete(env, key.name);
        deletedCount++;
        continue;
      }
      try {
        const tokenInfo = JSON.parse(data);
        tokens.push({
          key: key.name,
          expiresAt: tokenInfo.expiresAt
        });
      } catch (e) {
        await kvDelete(env, key.name);
        deletedCount++;
      }
    }
    for (const token of tokens) {
      if (Date.now() > token.expiresAt) {
        await kvDelete(env, token.key);
        deletedCount++;
      }
    }
    const validTokens = tokens.filter((t) => Date.now() <= t.expiresAt);
    if (validTokens.length > maxToKeep) {
      validTokens.sort((a, b) => b.expiresAt - a.expiresAt);
      for (let i = maxToKeep; i < validTokens.length; i++) {
        await kvDelete(env, validTokens[i].key);
        deletedCount++;
      }
    }
    console.log(`\u2705 \u81EA\u52A8\u6E05\u7406\u4E86 ${deletedCount} \u4E2A Token`);
  } catch (e) {
    console.error("Token \u6E05\u7406\u5931\u8D25:", e);
  }
}
__name(cleanupExpiredTokens, "cleanupExpiredTokens");
__name2(cleanupExpiredTokens, "cleanupExpiredTokens");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
