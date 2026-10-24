'use strict';
// 管理用(管理トークンが必要)。メニュー編集、使用中に戻す、QR、リセット。
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { z } = require('zod');
const db = require('../db');
const events = require('../events');
const { AppError } = require('../middleware/error');
const { validateBody } = require('../middleware/validate');
const checkoutService = require('../services/checkout');
const { MAX_TOPPINGS, MAX_NAME, NEXT_SORT, newId, normalizeNames, toppingNames, syncToppings } = require('../services/toppingSync');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function tableParam(req) {
  const t = req.params.table;
  if (!/^[A-Za-z0-9]{1,8}$/.test(t)) throw new AppError(400, 'invalid_input', '卓の指定が正しくありません');
  return t;
}

// フードのトッピング(名前だけ。値段は付けない)。同じ名前の重複は、保存のときに1つにまとめる
const toppingsSchema = z.array(z.string().trim().min(1).max(MAX_NAME)).max(MAX_TOPPINGS);

const menuUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(30),
    price: z.number().int().min(0).max(100000),
    onSale: z.boolean(),
    toppings: toppingsSchema,
  })
  .strict()
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: '変更する項目がありません' });

// 商品の追加。ゲームだけ「1品で何回ぶんのゲームか」(games)が必要。トッピングを付けられるのは、フードだけ。
// (トッピングは、単独の商品としては作らない。フードの toppings で、名前を渡す)
const menuCreateSchema = z
  .object({
    category: z.enum(['drink', 'food', 'game']),
    name: z.string().trim().min(1).max(30),
    price: z.number().int().min(0).max(100000),
    games: z.number().int().min(1).max(20).optional(),
    toppings: toppingsSchema.optional(),
  })
  .strict()
  .refine((o) => (o.category === 'game' ? o.games !== undefined : o.games === undefined), {
    message: 'ゲームだけ、ゲーム回数が必要です',
  })
  .refine((o) => o.category === 'food' || o.toppings === undefined, {
    message: 'トッピングを付けられるのは、フードだけです',
  });

const resetSchema = z.object({ confirm: z.literal('リセット') }).strict();

// QRに入れるURLの土台。環境変数 PUBLIC_BASE_URL(例: https://xxxx.replit.app)を優先する。
function baseUrl(req) {
  const env = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (env) {
    if (!/^https?:\/\/[^\s]+$/.test(env)) throw new AppError(500, 'bad_base_url', 'PUBLIC_BASE_URL の形式が正しくありません');
    return { url: env, fromRequest: false };
  }
  return { url: `${req.protocol}://${req.get('host')}`, fromRequest: true };
}

// 画面に返す商品の形
const toItem = (m, toppings) => ({
  id: m.id,
  category: m.category,
  name: m.name,
  price: m.price,
  games: m.games,
  onSale: m.on_sale,
  ...(m.category === 'food' ? { toppings: toppings || [] } : {}),
});

// トッピングは、フードの編集で変える(単独の商品としては、編集・削除しない)
const TOPPING_MSG = 'トッピングは、フードの編集で変更してください';

function createAdminRouter() {
  const router = express.Router();

  // メニュー一覧(販売終了も含む)。トッピングは、フードの toppings(名前のリスト)として返す。
  router.get(
    '/menu',
    wrap(async (req, res) => {
      const r = await db.query('SELECT id, category, name, price, games, parent_id, on_sale FROM menu_items ORDER BY sort');
      const names = new Map();
      for (const m of r.rows) {
        if (m.category === 'topping' && m.on_sale && m.parent_id) {
          if (!names.has(m.parent_id)) names.set(m.parent_id, []);
          names.get(m.parent_id).push(m.name);
        }
      }
      res.json({ items: r.rows.filter((m) => m.category !== 'topping').map((m) => toItem(m, names.get(m.id))) });
    })
  );

  // 商品の追加。id は自動で作る。追加した商品は、すぐに販売中になる。フードは、toppings(名前のリスト)も付けられる。
  router.post(
    '/menu',
    validateBody(menuCreateSchema),
    wrap(async (req, res) => {
      const { category, name, price, games, toppings } = req.body;
      const names = category === 'food' ? normalizeNames(toppings) : [];
      const id = newId();
      const row = await db.tx(async (c) => {
        const r = await c.query(
          `INSERT INTO menu_items (id, category, name, price, games, on_sale, sort)
           VALUES ($1, $2, $3, $4, $5, TRUE, ${NEXT_SORT})
           RETURNING id, category, name, price, games, parent_id, on_sale`,
          [id, category, name, price, category === 'game' ? games : null]
        );
        if (names.length) await syncToppings(c, id, names);
        return r.rows[0];
      });
      events.emit('menu.changed', { id });
      res.status(201).json(toItem(row, names));
    })
  );

  // 名前・値段・販売状態の変更。フードは、toppings(名前のリスト)で、トッピングも変えられる。
  // 注文済みの品目の名前・金額は変わらない(注文時に保存してあるため)。
  router.put(
    '/menu/:id',
    validateBody(menuUpdateSchema),
    wrap(async (req, res) => {
      const id = req.params.id;
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) throw new AppError(400, 'invalid_input', '商品の指定が正しくありません');
      const { name = null, price = null, onSale = null, toppings } = req.body;
      const out = await db.tx(async (c) => {
        const cur = await c.query('SELECT category FROM menu_items WHERE id = $1 FOR UPDATE', [id]);
        if (cur.rowCount === 0) throw new AppError(404, 'not_found', '商品が見つかりません');
        const category = cur.rows[0].category;
        if (category === 'topping') throw new AppError(400, 'invalid_input', TOPPING_MSG);
        if (toppings !== undefined && category !== 'food') {
          throw new AppError(400, 'invalid_input', 'トッピングを付けられるのは、フードだけです');
        }
        const r = await c.query(
          `UPDATE menu_items
           SET name = COALESCE($2, name), price = COALESCE($3, price), on_sale = COALESCE($4, on_sale)
           WHERE id = $1
           RETURNING id, category, name, price, games, parent_id, on_sale`,
          [id, name, price, onSale]
        );
        if (toppings !== undefined) await syncToppings(c, id, normalizeNames(toppings));
        return { row: r.rows[0], names: category === 'food' ? await toppingNames(c, id) : [] };
      });
      events.emit('menu.changed', { id });
      res.json(toItem(out.row, out.names));
    })
  );

  // 商品の削除。一度でも注文された商品は、記録に残っているため削除できない(販売終了にする)。
  // フードを消すときは、そのトッピングも一緒に消える。
  router.delete(
    '/menu/:id',
    wrap(async (req, res) => {
      const id = req.params.id;
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) throw new AppError(400, 'invalid_input', '商品の指定が正しくありません');
      const inUse = '注文の記録がある商品は削除できません。「販売終了」にしてください';
      try {
        await db.tx(async (c) => {
          const cur = await c.query('SELECT category FROM menu_items WHERE id = $1 FOR UPDATE', [id]);
          if (cur.rowCount === 0) throw new AppError(404, 'not_found', '商品が見つかりません');
          if (cur.rows[0].category === 'topping') throw new AppError(400, 'invalid_input', TOPPING_MSG);
          if (cur.rows[0].category === 'food') {
            // フードが注文されたことがなければ、そのトッピングも、注文されていない
            const used = await c.query('SELECT 1 FROM order_items WHERE menu_item_id = $1 LIMIT 1', [id]);
            if (used.rowCount) throw new AppError(409, 'item_in_use', inUse);
            await c.query("DELETE FROM menu_items WHERE parent_id = $1 AND category = 'topping'", [id]);
          }
          await c.query('DELETE FROM menu_items WHERE id = $1', [id]);
        });
      } catch (e) {
        if (e && e.code === '23503') throw new AppError(409, 'item_in_use', inUse);
        throw e;
      }
      events.emit('menu.changed', { id });
      res.json({ deleted: true });
    })
  );

  // 会計中 → 使用中に戻す
  router.post(
    '/tables/:table/reopen',
    wrap(async (req, res) => {
      res.json(await checkoutService.reopen(tableParam(req)));
    })
  );

  // QR(SVG)とURL。?format=png で、保存用のPNG画像を返す
  router.get(
    '/tables/:table/qr',
    wrap(async (req, res) => {
      const table = tableParam(req);
      const t = await db.query('SELECT qr_key FROM tables WHERE name = $1', [table]);
      if (t.rowCount === 0) throw new AppError(404, 'not_found', '卓が見つかりません');
      const base = baseUrl(req);
      const url = `${base.url}/public/?table=${encodeURIComponent(table)}&key=${encodeURIComponent(t.rows[0].qr_key)}`;

      if (req.query.format === 'png') {
        const png = await QRCode.toBuffer(url, { width: 600, margin: 2, errorCorrectionLevel: 'M' });
        res.set('Content-Type', 'image/png');
        res.set('Content-Disposition', `attachment; filename="qr-${table}.png"`);
        res.set('Cache-Control', 'no-store');
        return res.send(png);
      }
      const svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      res.set('Cache-Control', 'no-store');
      res.json({ table, url, svg, baseUrlFromRequest: base.fromRequest });
    })
  );

  // 鍵の再発行。空き卓だけ(使用中・会計中の卓は断る)
  router.post(
    '/tables/:table/rotate-key',
    wrap(async (req, res) => {
      const table = tableParam(req);
      await db.tx(async (c) => {
        const t = await c.query('SELECT name FROM tables WHERE name = $1 FOR UPDATE', [table]);
        if (t.rowCount === 0) throw new AppError(404, 'not_found', '卓が見つかりません');
        const s = await c.query("SELECT 1 FROM sessions WHERE table_name = $1 AND state <> 'closed'", [table]);
        if (s.rowCount > 0) throw new AppError(409, 'table_in_use', '使用中の卓は再発行できません。会計のあとに行ってください');
        await c.query('UPDATE tables SET qr_key = $2 WHERE name = $1', [table, db.newKey()]);
      });
      res.json({ table, rotated: true });
    })
  );

  // 注文・セッションの全削除(メニュー・卓・QRの鍵は残す)。確認の文字列が必要
  router.post(
    '/reset',
    validateBody(resetSchema),
    wrap(async (req, res) => {
      await checkoutService.resetAll();
      res.json({ reset: true });
    })
  );

  return router;
}

module.exports = { createAdminRouter };
