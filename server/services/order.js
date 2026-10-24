'use strict';
const db = require('../db');
const events = require('../events');
const { AppError } = require('../middleware/error');
const { validateToppings } = require('./topping');
const { mergeItems } = require('./merge');

// 1つの卓で受け付ける注文の回数の上限(入場ドリンクの注文は数えない)
const MAX_ORDERS_PER_SESSION = 50;

// トッピングの注文は、控えの名前に「＋トッピング名(フード名)」と残す(カフェの画面で、どのフードか分かるように)
const snapName = (row) => (row.category === 'topping' ? `＋${row.name}(${row.parent_name})` : row.name);

// 注文を受ける。同じ卓の処理はロックで順番に行う。
async function placeOrder(config, sessionId, { requestId, items }) {
  const merged = mergeItems(items);
  for (const q of merged.values()) {
    if (q > config.limits.max_qty_per_item) {
      throw new AppError(400, 'invalid_input', `1つの商品は${config.limits.max_qty_per_item}個までです`);
    }
  }

  const result = await db.tx(async (c) => {
    const s = await c.query('SELECT table_name, state FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (s.rowCount === 0) throw new AppError(401, 'no_session', '識別番号が正しくありません');
    const { table_name: table, state } = s.rows[0];
    if (state === 'closed') throw new AppError(410, 'session_closed', 'この卓の会計は完了しています');
    if (state !== 'open') throw new AppError(409, 'paying', '会計中のため、注文できません');

    // 二重送信: 同じ requestId の注文があれば、新しく作らずに前の結果を返す
    const dup = await c.query('SELECT id FROM orders WHERE session_id = $1 AND request_id = $2', [sessionId, requestId]);
    if (dup.rowCount > 0) return { table, orderId: Number(dup.rows[0].id), duplicate: true };

    const cnt = await c.query(
      "SELECT COUNT(DISTINCT order_id)::int AS n FROM order_items WHERE session_id = $1 AND kind = 'normal'",
      [sessionId]
    );
    if (cnt.rows[0].n >= MAX_ORDERS_PER_SESSION) {
      throw new AppError(429, 'order_limit', `1つの卓の注文は${MAX_ORDERS_PER_SESSION}回までです。スタッフにお声がけください`);
    }

    const ids = [...merged.keys()];
    const m = await c.query(
      `SELECT m.id, m.category, m.name, m.price, m.games, m.on_sale, m.parent_id, p.name AS parent_name
       FROM menu_items m LEFT JOIN menu_items p ON p.id = m.parent_id WHERE m.id = ANY($1)`,
      [ids]
    );
    const byId = new Map(m.rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || !row.on_sale) {
        throw new AppError(409, 'item_unavailable', '販売が終了した商品が含まれています。メニューを開き直してください', {
          itemId: id,
        });
      }
    }

    // トッピングは、対応するフードと一緒に注文する
    validateToppings(byId, merged);

    const o = await c.query('INSERT INTO orders (session_id, request_id) VALUES ($1, $2) RETURNING id', [
      sessionId,
      requestId,
    ]);
    const orderId = Number(o.rows[0].id);
    for (const [id, qty] of merged) {
      const row = byId.get(id);
      const isGame = row.category === 'game';
      await c.query(
        `INSERT INTO order_items
           (order_id, session_id, menu_item_id, kind, category, name, unit_price, games_granted, qty, status, served_at)
         VALUES ($1, $2, $3, 'normal', $4, $5, $6, $7, $8, $9, $10)`,
        [
          orderId,
          sessionId,
          id,
          row.category,
          snapName(row),
          row.price,
          isGame ? row.games : 0,
          qty,
          isGame ? 'served' : 'wait', // 追加ゲームは作って運ぶ物ではないので、最初から提供済み
          isGame ? new Date() : null,
        ]
      );
    }
    return { table, orderId, duplicate: false };
  });

  if (!result.duplicate) {
    events.emit('order.created', { table: result.table, sessionId, orderId: result.orderId });
  }
  return { orderId: result.orderId, duplicate: result.duplicate };
}

module.exports = { placeOrder };
