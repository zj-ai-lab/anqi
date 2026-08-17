// 鉴权 v2（0.3.0 起）：应用内账号密码登录 + 30 天滚动会话。
// - 网页/API：登录后发 anjian_sess cookie（HttpOnly，30 天，滚动续期）。
// - CLI/受信任客户端兼容：cookie anjian_token 与 env ANJIAN_STATIC_TOKEN 恒时比较后放行（actor=cli）。
// - /internal/*：X-Anjian-Key header，供受信任自动化使用。
// - 密码存版本化 scrypt 哈希（env ANJIAN_PASS_HASH）；兼容旧 salt:hex，明文不落任何地方。
// - 无鉴权只认显式 ANJIAN_UNSAFE_NO_AUTH=1，且启动守卫将其限制在非 production 回环实例。
import crypto from 'node:crypto';
import { db, audit } from '../db.js';
import passwordHash from '../lib/password-hash.cjs';
import { unsafeNoAuthAllowed } from '../lib/startup-config.js';

const SESS_DAYS = 30;
const LOGIN_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAIL_CAPACITY = 2048;
const fails = new Map(); // [req.ip, username] -> {count, windowStartedAt, lockUntil, expiresAt}

// 默认 actor：产品化后不再硬编码个人名。env 可覆盖（如自用部署设 ANJIAN_DEFAULT_ACTOR=fang）。
export const DEFAULT_ACTOR = process.env.ANJIAN_DEFAULT_ACTOR || 'web';

function parseCookies(req) {
  const out = {};
  for (const kv of (req.headers.cookie || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

export const {
  hashPassword,
  parsePasswordHash,
  verifyPassword,
  verifyPasswordDetailed,
} = passwordHash;

function fixedDigest(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

// 先摘要到固定长度，再恒时比较；配置缺失时仍完成比较但永不放行。
export function secretMatches(candidate, expected) {
  const candidateDigest = fixedDigest(candidate);
  const expectedDigest = fixedDigest(expected);
  const configured = typeof expected === 'string' && expected.length > 0;
  return configured && crypto.timingSafeEqual(candidateDigest, expectedDigest);
}

// 无论用户名是否命中，都执行配置 hash 对应的 scrypt 路径，避免账号存在性时序差。
export function verifyLoginCredentials(username, password, env = process.env) {
  const passwordResult = verifyPasswordDetailed(password || '', env.ANJIAN_PASS_HASH);
  const usernameOk = secretMatches(username, env.ANJIAN_USER);
  return {
    ok: usernameOk && passwordResult.ok,
    legacy: passwordResult.legacy,
  };
}

function nowPlusDays(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

function sessionCookie(token, req, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  return `anjian_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function createSession(res, req) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')').run();
  db.prepare(
    "INSERT INTO sessions (token, created_at, expires_at, last_seen) VALUES (?, datetime('now'), ?, datetime('now'))"
  ).run(token, nowPlusDays(SESS_DAYS));
  res.setHeader('Set-Cookie', sessionCookie(token, req, SESS_DAYS * 86400));
  return token;
}

export function destroySession(req, res) {
  const t = parseCookies(req).anjian_sess;
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', sessionCookie('', req, 0));
}

// 返回 'session' | 'token' | false
function authed(req, res) {
  const cookies = parseCookies(req);
  if (cookies.anjian_sess) {
    const row = db.prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(cookies.anjian_sess);
    if (row) {
      // 滚动续期：距上次续期超过 1 天才写库
      if (row.last_seen < nowPlusDays(-1).slice(0, 19)) {
        db.prepare("UPDATE sessions SET expires_at = ?, last_seen = datetime('now') WHERE token = ?")
          .run(nowPlusDays(SESS_DAYS), row.token);
        res.setHeader('Set-Cookie', sessionCookie(row.token, req, SESS_DAYS * 86400));
      }
      return 'session';
    }
  }
  const staticToken = process.env.ANJIAN_STATIC_TOKEN;
  if (staticToken && secretMatches(cookies.anjian_token, staticToken)) return 'token';
  return false;
}

function pruneLoginFails(now) {
  for (const [key, state] of fails) {
    if (state.expiresAt <= now) fails.delete(key);
  }
}

function loginFailKey(req) {
  const username = String(req.body?.username || '').slice(0, 128);
  return JSON.stringify([req.ip || '?', username]);
}

export function loginLimiter(req, res, next) {
  const now = Date.now();
  pruneLoginFails(now);
  const key = loginFailKey(req);
  const f = fails.get(key);
  if (f && f.lockUntil > now) {
    res.setHeader('Retry-After', String(Math.ceil((f.lockUntil - now) / 1000)));
    return res.status(429).json({ error: '尝试过多，15 分钟后再试' });
  }
  if (!f && fails.size >= LOGIN_FAIL_CAPACITY) {
    res.setHeader('Retry-After', String(LOGIN_WINDOW_MS / 1000));
    return res.status(429).json({ error: '登录请求过多，请稍后再试' });
  }
  req._loginIp = req.ip || '?';
  req._loginKey = key;
  next();
}

export function recordLoginFail(key) {
  if (!key) return;
  const now = Date.now();
  let f = fails.get(key);
  if (!f || f.expiresAt <= now || now - f.windowStartedAt >= LOGIN_WINDOW_MS) {
    f = { count: 0, windowStartedAt: now, lockUntil: 0, expiresAt: now + LOGIN_WINDOW_MS };
  }
  f.count += 1;
  if (f.count >= LOGIN_FAILS) {
    f.count = 0;
    f.lockUntil = now + LOGIN_LOCK_MS;
    f.expiresAt = f.lockUntil;
  }
  fails.delete(key);
  fails.set(key, f);
}

export function clearLoginFail(key) {
  fails.delete(key);
}

// /api 面（除 /api/login）
export function apiAuth(req, res, next) {
  if (unsafeNoAuthAllowed()) {
    req.actor = req.get('X-Anjian-Actor') || DEFAULT_ACTOR;
    return next();
  }
  const how = authed(req, res);
  if (!how) return res.status(401).json({ error: 'unauthorized' });
  req.actor = req.get('X-Anjian-Actor') || (how === 'token' ? 'cli' : DEFAULT_ACTOR);
  next();
}

// 页面面：未登录跳 /login.html
export function pageAuth(req, res, next) {
  if (unsafeNoAuthAllowed()) return next();
  const open = req.path === '/login.html' || req.path === '/healthz'
    || req.path.startsWith('/css/') || req.path.startsWith('/js/')
    || req.path.startsWith('/assets/') || req.path === '/favicon.ico';
  if (open || authed(req, res)) return next();
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
    return res.redirect('/login.html');
  }
  res.status(401).json({ error: 'unauthorized' });
}

export function internalAuth(req, res, next) {
  if (unsafeNoAuthAllowed()) {
    req.actor = req.get('X-Anjian-Actor') || 'internal';
    return next();
  }
  const key = process.env.ANJIAN_INTERNAL_KEY;
  if (!key) {
    return res.status(503).json({ error: 'ANJIAN_INTERNAL_KEY not configured' });
  }
  if (!secretMatches(req.get('X-Anjian-Key'), key)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.actor = req.get('X-Anjian-Actor') || 'internal';
  next();
}

export { audit };
