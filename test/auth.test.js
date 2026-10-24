'use strict';
// 実行: npm test   (Node標準のテスト機能を使うので、追加のインストールは不要)
const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../server/auth');

const cfg = { security: { staff_token_hours: 12, admin_token_min: 30, login_max_fails: 3, login_lock_sec: 60 } };
const env = {
  POS_PIN: 'pos-pin-1111',
  CAFE_PIN: 'cafe-pin-2222',
  ADMIN_PIN: 'admin-pin-3333',
  TOKEN_SECRET: 'x'.repeat(40),
};
auth.initAuth(cfg, env);

test('役割ごとに、別のPINだけが通る', () => {
  assert.equal(auth.verifyPin('pos', 'pos-pin-1111'), true);
  assert.equal(auth.verifyPin('cafe', 'cafe-pin-2222'), true);
  assert.equal(auth.verifyPin('admin', 'admin-pin-3333'), true);
  // ほかの役割のPINでは入れない
  assert.equal(auth.verifyPin('pos', 'cafe-pin-2222'), false);
  assert.equal(auth.verifyPin('pos', 'admin-pin-3333'), false);
  assert.equal(auth.verifyPin('cafe', 'pos-pin-1111'), false);
  assert.equal(auth.verifyPin('admin', 'pos-pin-1111'), false);
  assert.equal(auth.verifyPin('admin', 'cafe-pin-2222'), false);
  // 間違い・空・数字・知らない役割
  assert.equal(auth.verifyPin('pos', 'pos-pin-1112'), false);
  assert.equal(auth.verifyPin('pos', ''), false);
  assert.equal(auth.verifyPin('pos', 1234), false);
  assert.equal(auth.verifyPin('staff', 'pos-pin-1111'), false);
});

test('発行したトークンは検証できる', () => {
  for (const role of ['pos', 'cafe', 'admin']) {
    const { token } = auth.issueToken(role);
    assert.equal(auth.verifyToken(token).r, role);
  }
  assert.throws(() => auth.issueToken('staff'));
});

test('改ざんしたトークンは拒否される', () => {
  const { token } = auth.issueToken('pos');
  const [payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ r: 'admin', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(auth.verifyToken(`${forged}.${sig}`), null);
  assert.equal(auth.verifyToken(`${payload}.${sig.slice(0, -2)}AA`), null);
  assert.equal(auth.verifyToken('abc'), null);
  assert.equal(auth.verifyToken(''), null);
  assert.equal(auth.verifyToken(undefined), null);
});

test('旧来の staff 役割のトークンは拒否される', () => {
  // 旧版が発行した staff トークン(署名は正しい)でも、今の役割に当てはまらないので通さない
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({ r: 'staff', e: Date.now() + 1e6 })).toString('base64url');
  const sig = crypto.createHmac('sha256', env.TOKEN_SECRET).update('token:' + payload).digest().toString('base64url');
  assert.equal(auth.verifyToken(`${payload}.${sig}`), null);
});

test('期限切れのトークンは拒否される', () => {
  const realNow = Date.now;
  const { token } = auth.issueToken('pos');
  const admin = auth.issueToken('admin');
  Date.now = () => realNow() + 31 * 60 * 1000; // 31分後: 管理は切れ、レジはまだ有効
  try {
    assert.equal(auth.verifyToken(admin.token), null);
    assert.equal(auth.verifyToken(token).r, 'pos');
    Date.now = () => realNow() + 13 * 3600 * 1000; // 13時間後: レジも切れる
    assert.equal(auth.verifyToken(token), null);
  } finally {
    Date.now = realNow;
  }
});

test('別の秘密鍵で作ったトークンは拒否される', () => {
  const { token } = auth.issueToken('pos');
  auth.initAuth(cfg, { ...env, TOKEN_SECRET: 'y'.repeat(40) });
  assert.equal(auth.verifyToken(token), null);
  auth.initAuth(cfg, env);
});

// requireRole: 通す役割だけ通し、ほかは理由つきで断る
function run(mw, role) {
  const headers = {};
  if (role) headers.authorization = 'Bearer ' + auth.issueToken(role).token;
  let result = 'called-next-without-error';
  mw({ headers }, {}, (err) => { if (err) result = `${err.status} ${err.code}`; });
  return result;
}
test('requireRole は、通す役割だけを通す', () => {
  const posApi = auth.requireRole('pos', 'admin');
  assert.equal(run(posApi, 'pos'), 'called-next-without-error');
  assert.equal(run(posApi, 'admin'), 'called-next-without-error');
  assert.equal(run(posApi, 'cafe'), '403 forbidden');
  assert.equal(run(posApi, null), '401 unauthorized');

  const cafeApi = auth.requireRole('cafe', 'admin');
  assert.equal(run(cafeApi, 'cafe'), 'called-next-without-error');
  assert.equal(run(cafeApi, 'pos'), '403 forbidden');

  const adminApi = auth.requireRole('admin');
  assert.equal(run(adminApi, 'admin'), 'called-next-without-error');
  assert.equal(run(adminApi, 'pos'), '403 admin_required');
  assert.equal(run(adminApi, 'cafe'), '403 admin_required');
});

test('連続失敗でロックされ、時間が過ぎると解除される', () => {
  const ip = '203.0.113.9';
  const t0 = 1_000_000;
  assert.equal(auth.lockRemainingSec(ip, t0), 0);
  auth.recordFailure(ip, t0);
  auth.recordFailure(ip, t0 + 1000);
  assert.equal(auth.lockRemainingSec(ip, t0 + 1000), 0);
  auth.recordFailure(ip, t0 + 2000); // 3回目
  assert.ok(auth.lockRemainingSec(ip, t0 + 2000) > 0);
  assert.equal(auth.lockRemainingSec(ip, t0 + 2000 + 61 * 1000), 0);
});

test('成功すると失敗の記録が消え、別のIPには影響しない', () => {
  const t0 = 2_000_000;
  auth.recordFailure('198.51.100.1', t0);
  auth.recordFailure('198.51.100.1', t0);
  auth.clearFailures('198.51.100.1');
  auth.recordFailure('198.51.100.1', t0);
  assert.equal(auth.lockRemainingSec('198.51.100.1', t0), 0);
  auth.recordFailure('198.51.100.2', t0);
  auth.recordFailure('198.51.100.2', t0);
  auth.recordFailure('198.51.100.2', t0);
  assert.ok(auth.lockRemainingSec('198.51.100.2', t0) > 0);
  assert.equal(auth.lockRemainingSec('198.51.100.3', t0), 0);
});

test('環境変数が足りないと起動時にエラー', () => {
  assert.throws(() => auth.initAuth(cfg, { TOKEN_SECRET: 'x'.repeat(40) }));
  assert.throws(() => auth.initAuth(cfg, { STAFF_PIN: 'abcd' }));
  assert.throws(() => auth.initAuth(cfg, { STAFF_PIN: 'abcd', TOKEN_SECRET: 'short' }));
  // 一部のPINだけ設定して、ほかが未設定(STAFF_PIN もなし)なら、エラー
  assert.throws(() => auth.initAuth(cfg, { POS_PIN: 'abcd', TOKEN_SECRET: 'x'.repeat(40) }));
  auth.initAuth(cfg, env);
});

test('個別のPINが未設定でも、STAFF_PIN があれば、それで代用できる', () => {
  auth.initAuth(cfg, { STAFF_PIN: 'shared-pin', ADMIN_PIN: 'admin-only-pin', TOKEN_SECRET: 'x'.repeat(40) });
  assert.equal(auth.verifyPin('pos', 'shared-pin'), true);
  assert.equal(auth.verifyPin('cafe', 'shared-pin'), true);
  assert.equal(auth.verifyPin('admin', 'shared-pin'), false); // 管理者は、個別のPINだけ
  assert.equal(auth.verifyPin('admin', 'admin-only-pin'), true);
  auth.initAuth(cfg, env);
});
