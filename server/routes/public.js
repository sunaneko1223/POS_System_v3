'use strict';
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { AppError } = require('../middleware/error');
const { validateBody } = require('../middleware/validate');
const sessionService = require('../services/session');
const { placeOrder } = require('../services/order');
const { createImageIndex } = require('../services/images');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const SESSION_ID = /^[A-Za-z0-9_-]{16,32}$/;

function createPublicRouter(config) {
  const router = express.Router();
  const images = createImageIndex();
  const maxPeople = config.limits.max_people;
  const maxQty = config.limits.max_qty_per_item;

  const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,20}$/);
  const lineSchema = (max) => z.object({ id: idSchema, qty: z.number().int().min(1).max(max) }).strict();

  const createSessionSchema = z
    .object({
      table: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
      key: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/),
      people: z.number().int().min(1).max(maxPeople),
      drinks: z.array(lineSchema(maxPeople)).min(1).max(20),
    })
    .strict();

  const joinSessionSchema = z
    .object({
      table: z.string().regex(/^[A-Za-z0-9]{1,8}$/),
      key: z.string().regex(/^[A-Za-z0-9_-]{10,64}$/),
    })
    .strict();

  const orderSchema = z
    .object({
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
      items: z.array(lineSchema(maxQty)).min(1).max(30),
    })
    .strict();

  // 識別番号(X-Session-Id ヘッダー)を確認して、req.sessionId に入れる
  const requireSession = wrap(async (req, res, next) => {
    const id = req.get('x-session-id') || '';
    if (!SESSION_ID.test(id)) throw new AppError(401, 'no_session', '識別番号が必要です。QRコードを読み取り直してください');
    const r = await db.query('SELECT state FROM sessions WHERE id = $1', [id]);
    if (r.rowCount === 0) throw new AppError(401, 'no_session', '識別番号が正しくありません。QRコードを読み取り直してください');
    if (r.rows[0].state === 'closed') throw new AppError(410, 'session_closed', 'この卓の会計は完了しています');
    req.sessionId = id;
    next();
  });

  // メニュー(販売終了の商品も、売り切れ表示のために onSale:false で返す)
  router.get(
    '/menu',
    wrap(async (req, res) => {
      const r = await db.query('SELECT id, category, name, price, games, parent_id, on_sale FROM menu_items ORDER BY sort');
      res.json({
        event: { name: config.event.name },
        entranceFeePerPerson: config.pricing.entrance_fee_per_person,
        limits: { maxPeople, maxQtyPerItem: maxQty },
        game: { initial: config.game.initial_games, max: config.game.max_games, perFood: config.game.games_per_food },
        items: r.rows.map((m) => ({
          id: m.id,
          category: m.category,
          name: m.name,
          price: m.price,
          games: m.games,
          parentId: m.parent_id,
          onSale: m.on_sale,
          image: m.category === 'drink' || m.category === 'food' ? images.imageFor(m.name) : null,
        })),
      });
    })
  );

  // 人数と入場ドリンクを送って、識別番号を受け取る(使用中の卓なら、今の識別番号を返す)
  router.post(
    '/sessions',
    validateBody(createSessionSchema),
    wrap(async (req, res) => {
      const out = await sessionService.createOrGetSession(config, req.body);
      res.status(out.created ? 201 : 200).json(out);
    })
  );

  // 2人目以降: 使用中の卓があれば、その識別番号を返す(なければ active:false。作らない)
  router.post(
    '/sessions/join',
    validateBody(joinSessionSchema),
    wrap(async (req, res) => {
      res.json(await sessionService.findActiveSession(req.body));
    })
  );

  // 自分の卓の状況
  router.get(
    '/session',
    requireSession,
    wrap(async (req, res) => {
      res.json(await sessionService.getSessionDetail(config, req.sessionId));
    })
  );

  // 注文
  router.post(
    '/orders',
    requireSession,
    validateBody(orderSchema),
    wrap(async (req, res) => {
      const out = await placeOrder(config, req.sessionId, req.body);
      const detail = await sessionService.getSessionDetail(config, req.sessionId);
      res.status(out.duplicate ? 200 : 201).json({ orderId: out.orderId, duplicate: out.duplicate, games: detail.games, total: detail.total });
    })
  );

  // 会計ボタン
  router.post(
    '/checkout-request',
    requireSession,
    wrap(async (req, res) => {
      res.json(await sessionService.requestCheckout(req.sessionId));
    })
  );

  return router;
}

module.exports = { createPublicRouter };