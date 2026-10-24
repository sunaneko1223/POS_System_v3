'use strict';
// PINの照合、トークンの発行・検証、ログイン失敗のロック。
//   役割は3つ。それぞれ別のPINで入る:  pos(レジ) / cafe(カフェ) / admin(管理者)
//   pos・cafe のトークンは、通常の有効期限(staff_token_hours)。admin は短い(admin_token_min)。
//   PINは、環境変数 POS_PIN / CAFE_PIN / ADMIN_PIN。未設定のものは、旧来の STAFF_PIN で代用する(警告を出す)。

const crypto = require('crypto');
const { AppError } = require('./middleware/error');

const state = {
  ready: false,
  secret: null,
  pinMacs: {},
  staffTtlMs: 0,
  adminTtlMs: 0,
  maxFails: 5,
  lockMs: 180000,
};

const FAIL_WINDOW_MS = 10 * 60 * 1000; // 失敗を数える期間
const attempts = new Map(); // ip -> { fails, firstAt, lockedUntil }

const hmac = (label, value) =>
  crypto.createHmac('sha256', state.secret).update(label + ':' + value).digest();
const b64u = (buf) => Buffer.from(buf).toString('base64url');

const ROLES = ['pos', 'cafe', 'admin'];

function initAuth(config, env = process.env) {
  const secret = env.TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('環境変数 TOKEN_SECRET が未設定、または短すぎます(32文字以上を推奨)。');
  }
  if (secret.length < 32) console.warn('[auth] TOKEN_SECRET は32文字以上を推奨します');

  // 役割ごとのPIN。個別のものが未設定なら、旧来の共通PIN(STAFF_PIN)で代用する
  const pins = {};
  for (const role of ROLES) {
    const name = role.toUpperCase() + '_PIN';
    const pin = env[name] || env.STAFF_PIN;
    if (!pin || pin.length > 64) {
      throw new Error(`環境変数 ${name} が未設定、または長すぎます(64文字以内)。`);
    }
    if (!env[name]) console.warn(`[auth] ${name} が未設定のため、STAFF_PIN で代用します。PINを分けるには ${name} を設定してください`);
    if (pin.length < 4) console.warn(`[auth] ${name} が短いです。4文字以上を推奨します`);
    pins[role] = pin;
  }
  if (new Set(Object.values(pins)).size < ROLES.length) {
    console.warn('[auth] 同じPINを使っている役割があります(POS_PIN / CAFE_PIN / ADMIN_PIN は、別々の値にしてください)');
  }

  state.secret = secret;
  state.pinMacs = {};
  for (const role of ROLES) state.pinMacs[role] = hmac('pin:' + role, pins[role]);
  state.staffTtlMs = config.security.staff_token_hours * 3600 * 1000;
  state.adminTtlMs = config.security.admin_token_min * 60 * 1000;
  state.maxFails = config.security.login_max_fails;
  state.lockMs = config.security.login_lock_sec * 1000;
  state.ready = true;

  // 古い記録を掃除する(プロセスの終了を妨げない)
  setInterval(() => {
    const now = Date.now();
    for (const [ip, a] of attempts) {
      if (a.lockedUntil <= now && now - a.firstAt > FAIL_WINDOW_MS) attempts.delete(ip);
    }
  }, 60 * 1000).unref();
}

// role の PIN と一致するか(役割ごとに、別のPINで照合する)
function verifyPin(role, input) {
  if (typeof input !== 'string') return false;
  const expected = state.pinMacs[role];
  if (!expected) return false;
  const mac = hmac('pin:' + role, input);
  return crypto.timingSafeEqual(mac, expected); // 長さは常に32バイトで同じ
}

function issueToken(role) {
  if (!ROLES.includes(role)) throw new Error('不明な役割です: ' + role);
  const ttl = role === 'admin' ? state.adminTtlMs : state.staffTtlMs;
  const exp = Date.now() + ttl;
  const payload = b64u(JSON.stringify({ r: role, e: exp }));
  const sig = b64u(hmac('token', payload));
  return { token: `${payload}.${sig}`, expiresAt: exp };
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = hmac('token', payload);
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !ROLES.includes(data.r) || typeof data.e !== 'number') return null;
  if (data.e <= Date.now()) return null;
  return data;
}

// 通す役割を並べる。例: requireRole('pos', 'admin') … レジか管理者なら通す / requireRole('admin') … 管理者だけ
function requireRole(...allowed) {
  return (req, res, next) => {
    const m = /^Bearer ([A-Za-z0-9_.-]{10,600})$/.exec(req.headers.authorization || '');
    if (!m) return next(new AppError(401, 'unauthorized', 'ログインが必要です'));
    const data = verifyToken(m[1]);
    if (!data) {
      return next(new AppError(401, 'unauthorized', 'ログインの有効期限が切れました。もう一度ログインしてください'));
    }
    if (!allowed.includes(data.r)) {
      if (allowed.length === 1 && allowed[0] === 'admin') {
        return next(new AppError(403, 'admin_required', '管理用のPINが必要です'));
      }
      return next(new AppError(403, 'forbidden', 'この画面では使えないログインです。もう一度ログインしてください'));
    }
    req.auth = { role: data.r, exp: data.e };
    next();
  };
}

// --- ログイン失敗のロック(IPごと。サーバーのメモリ上で管理) ---

function lockRemainingSec(ip, now = Date.now()) {
  const a = attempts.get(ip);
  if (!a || a.lockedUntil <= now) return 0;
  return Math.ceil((a.lockedUntil - now) / 1000);
}

function recordFailure(ip, now = Date.now()) {
  let a = attempts.get(ip);
  if (!a || now - a.firstAt > FAIL_WINDOW_MS) {
    a = { fails: 0, firstAt: now, lockedUntil: 0 };
    attempts.set(ip, a);
  }
  a.fails += 1;
  if (a.fails >= state.maxFails) {
    a.lockedUntil = now + state.lockMs;
    a.fails = 0;
    a.firstAt = now;
  }
}

function clearFailures(ip) {
  attempts.delete(ip);
}

module.exports = {
  initAuth,
  ROLES,
  verifyPin,
  issueToken,
  verifyToken,
  requireRole,
  lockRemainingSec,
  recordFailure,
  clearFailures,
};
