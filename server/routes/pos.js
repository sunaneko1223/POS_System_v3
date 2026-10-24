'use strict';
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { AppError } = require('../middleware/error');
const { validateBody } = require('../middleware/validate');
const sessionService = require('../services/session');
const checkoutService = require('../services/checkout');
const historyService = require('../services/history');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function tableParam(req) {
  const t = req.params.table;
  if (!/^[A-Za-z0-9]{1,8}$/.test(t)) throw new AppError(400, 'invalid_input', '卓の指定が正しくありません');
  return t;
}

// received: お預かり金額(円)。省くと、金額を記録せずに会計する(古い呼び方との互換)
// freeTickets: 無料チケットの枚数。省くと、「適用」で保存した枚数(上限は、卓の人数。サービス側で確認する)
const checkoutSchema = z
  .object({
    confirmUnserved: z.boolean().optional(),
    received: z.number().int().min(0).max(10000000).optional(),
    freeTickets: z.number().int().min(0).max(1000).optional(),
    force: z.boolean().optional(), // true: お客様が会計ボタンを押していない卓も、会計する
  })
  .strict();

// 無料チケットの枚数を保存する(会計の前の「適用」)
const ticketsSchema = z.object({ freeTickets: z.number().int().min(0).max(1000) }).strict();

function createPosRouter(config) {
  const router = express.Router();

  // 全卓の状態の一覧(空き / 使用中 / 会計中)
  router.get(
    '/tables',
    wrap(async (req, res) => {
      const r = await db.query(
        `SELECT t.name AS table_name, s.state, s.people, s.entrance_fee_per_person, s.free_tickets, s.created_at, s.paying_at,
                COALESCE(SUM(oi.unit_price * oi.qty), 0)::int AS items_total,
                (COUNT(oi.id) FILTER (WHERE oi.status = 'wait' AND oi.category <> 'game'))::int AS unserved
         FROM tables t
         LEFT JOIN sessions s ON s.table_name = t.name AND s.state <> 'closed'
         LEFT JOIN order_items oi ON oi.session_id = s.id
         GROUP BY t.name, s.id`
      );
      const order = (n) => {
        const i = config.tables.indexOf(n);
        return i === -1 ? 9999 : i;
      };
      const tables = r.rows
        .map((x) => {
          if (!x.state) return { table: x.table_name, state: 'free' };
          const fee = x.entrance_fee_per_person ?? config.pricing.entrance_fee_per_person;
          return {
            table: x.table_name,
            state: x.state,
            people: x.people,
            total: fee * Math.max(0, x.people - (x.free_tickets || 0)) + x.items_total, // 無料チケットを引いたあと
            unserved: x.unserved,
            createdAt: x.created_at,
            payingAt: x.paying_at,
          };
        })
        .sort((a, b) => order(a.table) - order(b.table) || a.table.localeCompare(b.table));
      res.json({ tables });
    })
  );

  // 1つの卓の詳細(品目・提供状況・合計・未提供)
  router.get(
    '/tables/:table',
    wrap(async (req, res) => {
      const table = tableParam(req);
      const t = await db.query('SELECT name FROM tables WHERE name = $1', [table]);
      if (t.rowCount === 0) throw new AppError(404, 'not_found', '卓が見つかりません');
      const s = await db.query("SELECT id FROM sessions WHERE table_name = $1 AND state <> 'closed'", [table]);
      if (s.rowCount === 0) return res.json({ table, state: 'free' });
      const detail = await sessionService.getSessionDetail(config, s.rows[0].id);
      const unserved = detail.items
        .filter((i) => i.status === 'wait' && i.category !== 'game')
        .map((i) => ({ id: i.id, name: i.name, qty: i.qty }));
      res.json({ ...detail, unserved });
    })
  );

  // 会計。未提供があるときは、スタッフが客に確認したうえで confirmUnserved:true を付けて送る
  router.post(
    '/tables/:table/checkout',
    validateBody(checkoutSchema),
    wrap(async (req, res) => {
      const out = await checkoutService.checkout(config, tableParam(req), {
        confirmUnserved: req.body.confirmUnserved === true,
        received: req.body.received,
        freeTickets: req.body.freeTickets, // 省くと、保存した枚数
        force: req.body.force === true,
      });
      res.json(out);
    })
  );

  // 無料チケットを適用する(枚数を保存して、お客様の画面にも反映する)
  router.post(
    '/tables/:table/tickets',
    validateBody(ticketsSchema),
    wrap(async (req, res) => {
      res.json(await checkoutService.setTickets(tableParam(req), req.body.freeTickets));
    })
  );

  // 取引履歴(会計済みの卓の一覧と、売上の集計)
  router.get(
    '/history',
    wrap(async (req, res) => {
      res.json(await historyService.getHistory(config));
    })
  );

  return router;
}

module.exports = { createPosRouter };