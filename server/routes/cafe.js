'use strict';
const express = require('express');
const db = require('../db');
const events = require('../events');
const { AppError } = require('../middleware/error');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createCafeRouter(config) {
  const router = express.Router();

  // 未提供の品目の一覧(古い順)。追加ゲームは最初から提供済みなので、ここには出ない。
  router.get(
    '/queue',
    wrap(async (req, res) => {
      const r = await db.query(
        `SELECT oi.id, s.table_name, s.state, oi.name, oi.qty, oi.kind, oi.category, oi.created_at,
                oi.order_id::text || ':' || COALESCE(mi.parent_id, oi.menu_item_id) AS group_key
         FROM order_items oi
         JOIN sessions s ON s.id = oi.session_id
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.status = 'wait' AND oi.category <> 'game' AND s.state <> 'closed'
         ORDER BY oi.created_at, oi.id
         LIMIT 500`
      );
      res.json({
        // 待ち時間は、端末の時計ではなくサーバーの時刻を基準にする(端末の時計のずれ対策)
        serverTime: new Date().toISOString(),
        warnMin: config.ui.wait_warn_min,
        dangerMin: config.ui.wait_danger_min,
        items: r.rows.map((x) => ({
          id: Number(x.id),
          table: x.table_name,
          sessionState: x.state,
          name: x.name,
          qty: x.qty,
          kind: x.kind,
          category: x.category,
          groupKey: x.group_key,
          orderedAt: x.created_at,
        })),
      });
    })
  );

  // 提供済みの品目の一覧(新しい順に、直近100件)。追加ゲームは、最初から提供済みなので出さない。
  router.get(
    '/served',
    wrap(async (req, res) => {
      const r = await db.query(
        `SELECT oi.id, s.table_name, oi.name, oi.qty, oi.kind, oi.category, oi.served_at,
                oi.order_id::text || ':' || COALESCE(mi.parent_id, oi.menu_item_id) AS group_key
         FROM order_items oi
         JOIN sessions s ON s.id = oi.session_id
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.status = 'served' AND oi.category <> 'game' AND oi.served_at IS NOT NULL
         ORDER BY oi.served_at DESC, oi.id DESC
         LIMIT 100`
      );
      res.json({
        items: r.rows.map((x) => ({
          id: Number(x.id),
          table: x.table_name,
          name: x.name,
          qty: x.qty,
          kind: x.kind,
          category: x.category,
          groupKey: x.group_key,
          servedAt: x.served_at,
        })),
      });
    })
  );

  // 品目を提供済みにする。連打や、2台のiPadからの同時操作でも、結果は同じ(すでに提供済みなら何もしない)。
  router.post(
    '/items/:itemId/serve',
    wrap(async (req, res) => {
      if (!/^\d{1,15}$/.test(req.params.itemId)) {
        throw new AppError(400, 'invalid_input', '品目の指定が正しくありません');
      }
      const itemId = Number(req.params.itemId);

      const u = await db.query(
        `UPDATE order_items AS oi
         SET status = 'served', served_at = now()
         FROM sessions AS s
         WHERE oi.id = $1 AND oi.status = 'wait' AND s.id = oi.session_id AND s.state <> 'closed'
         RETURNING oi.id, oi.session_id, s.table_name`,
        [itemId]
      );
      if (u.rowCount === 1) {
        events.emit('item.served', { table: u.rows[0].table_name, sessionId: u.rows[0].session_id, itemId });
        return res.json({ id: itemId, status: 'served', alreadyServed: false });
      }

      const e = await db.query('SELECT status FROM order_items WHERE id = $1', [itemId]);
      if (e.rowCount === 0) throw new AppError(404, 'not_found', '品目が見つかりません');
      res.json({ id: itemId, status: 'served', alreadyServed: true });
    })
  );

  return router;
}

module.exports = { createCafeRouter };