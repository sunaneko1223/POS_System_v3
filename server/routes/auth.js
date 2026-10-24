'use strict';
const express = require('express');
const { z } = require('zod');
const auth = require('../auth');
const { AppError } = require('../middleware/error');
const { validateBody } = require('../middleware/validate');

// レジ(pos)・カフェ(cafe)用。role を省くと pos として扱う
const loginSchema = z
  .object({ pin: z.string().min(1).max(64), role: z.enum(['pos', 'cafe']).optional() })
  .strict();
// 管理者(admin)用
const adminLoginSchema = z.object({ pin: z.string().min(1).max(64) }).strict();

function login(getRole) {
  return (req, res) => {
    const role = getRole(req);
    const ip = req.ip;
    const wait = auth.lockRemainingSec(ip);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new AppError(429, 'locked', 'PINを続けて間違えたため、しばらく使えません', { retryAfterSec: wait });
    }
    if (!auth.verifyPin(role, req.body.pin)) {
      auth.recordFailure(ip);
      console.warn(`[auth] PIN失敗 role=${role} ip=${ip}`);
      throw new AppError(401, 'invalid_pin', 'PINが違います');
    }
    auth.clearFailures(ip);
    const { token, expiresAt } = auth.issueToken(role);
    res.json({ token, role, expiresAt: new Date(expiresAt).toISOString() });
  };
}

function createAuthRouter(loginLimiter) {
  const router = express.Router();

  // レジ・カフェのログイン(role は 'pos' か 'cafe'。役割ごとに別のPIN)
  router.post('/auth/login', loginLimiter, validateBody(loginSchema), login((req) => req.body.role || 'pos'));

  // 管理者のログイン(管理者のPIN。ほかのログインは不要)
  router.post('/admin/login', loginLimiter, validateBody(adminLoginSchema), login(() => 'admin'));

  // トークンがまだ有効か確認する(画面側の確認用)
  router.get('/auth/me', auth.requireRole('pos', 'cafe', 'admin'), (req, res) => {
    res.json({ role: req.auth.role, expiresAt: new Date(req.auth.exp).toISOString() });
  });

  return router;
}

module.exports = { createAuthRouter };
