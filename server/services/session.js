'use strict';
const crypto = require('crypto');
const db = require('../db');
const events = require('../events');
const { AppError } = require('../middleware/error');
const { calcGames, freeGames, rulesFromConfig } = require('./game');
const { calcTotal } = require('./checkout');

const newSessionId = () => crypto.randomBytes(16).toString('base64url');

// 鍵の比較は、長さや中身の違いが時間に出ないよう、ハッシュにしてから行う
function keysMatch(expected, given) {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(expected), h(given));
}

const INVALID_QR = () => new AppError(403, 'invalid_qr', 'QRコードが正しくありません。スタッフにお声がけください');

// 卓名と鍵が合えば、使用中のセッションを返す。空き卓なら新しく作る(入場ドリンクもここで注文する)。
async function createOrGetSession(config, { table, key, people, drinks }) {
  const result = await db.tx(async (c) => {
    // 同じ卓の同時アクセスを順番に処理するため、卓の行をロックする
    const t = await c.query('SELECT qr_key FROM tables WHERE name = $1 FOR UPDATE', [table]);
    // 存在しない卓と鍵の違いを、外から区別できないようにする
    if (t.rowCount === 0 || !keysMatch(t.rows[0].qr_key, key)) throw INVALID_QR();

    const ex = await c.query("SELECT id, state FROM sessions WHERE table_name = $1 AND state <> 'closed'", [table]);
    if (ex.rowCount > 0) {
      return { sessionId: ex.rows[0].id, state: ex.rows[0].state, created: false };
    }

    // 入場ドリンク: 人数分、販売中のドリンクだけ
    const merged = new Map();
    for (const d of drinks) merged.set(d.id, (merged.get(d.id) || 0) + d.qty);
    const total = [...merged.values()].reduce((a, b) => a + b, 0);
    if (total !== people) {
      throw new AppError(400, 'drink_mismatch', `入場ドリンクは人数分(${people}杯)を選んでください`);
    }
    const ids = [...merged.keys()];
    const m = await c.query(
      "SELECT id, name FROM menu_items WHERE id = ANY($1) AND category = 'drink' AND on_sale",
      [ids]
    );
    if (m.rowCount !== ids.length) {
      throw new AppError(409, 'item_unavailable', '選べないドリンクが含まれています。メニューを開き直してください');
    }

    const sessionId = newSessionId();
    await c.query(
      `INSERT INTO sessions (id, table_name, people, state, entrance_fee_per_person)
       VALUES ($1, $2, $3, 'open', $4)`,
      [sessionId, table, people, config.pricing.entrance_fee_per_person]
    );
    const o = await c.query('INSERT INTO orders (session_id) VALUES ($1) RETURNING id', [sessionId]);
    for (const row of m.rows) {
      await c.query(
        `INSERT INTO order_items (order_id, session_id, menu_item_id, kind, category, name, unit_price, qty)
         VALUES ($1, $2, $3, 'entrance', 'drink', $4, 0, $5)`,
        [o.rows[0].id, sessionId, row.id, row.name, merged.get(row.id)]
      );
    }
    return { sessionId, state: 'open', created: true, orderId: o.rows[0].id };
  });

  if (result.created) {
    events.emit('session.changed', { table, sessionId: result.sessionId, state: 'open' });
    events.emit('order.created', { table, sessionId: result.sessionId, orderId: result.orderId });
  }
  return { sessionId: result.sessionId, state: result.state, created: result.created };
}

// 2人目以降の人が、人数・ドリンクの選択を飛ばして、同じ卓に入るための確認。
// 卓名と鍵が合えば、使用中のセッションがあるかどうかだけを返す(作らない)。
async function findActiveSession({ table, key }) {
  const t = await db.query('SELECT qr_key FROM tables WHERE name = $1', [table]);
  if (t.rowCount === 0 || !keysMatch(t.rows[0].qr_key, key)) throw INVALID_QR();
  const ex = await db.query("SELECT id, state FROM sessions WHERE table_name = $1 AND state <> 'closed'", [table]);
  if (ex.rowCount === 0) return { active: false };
  return { active: true, sessionId: ex.rows[0].id, state: ex.rows[0].state };
}

// 画面に出す、卓の状況(品目・ゲーム回数・金額)
async function getSessionDetail(config, sessionId, run = db.query) {
  const s = await run(
    `SELECT id, table_name, people, state, created_at, entrance_fee_per_person, free_tickets
     FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (s.rowCount === 0) throw new AppError(401, 'no_session', '識別番号が正しくありません');
  const session = s.rows[0];

  const it = await run(
    `SELECT oi.id, oi.name, oi.qty, oi.unit_price, oi.status, oi.kind, oi.category, oi.games_granted, oi.created_at, oi.served_at,
            oi.order_id::text || ':' || COALESCE(mi.parent_id, oi.menu_item_id) AS group_key
     FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.session_id = $1 ORDER BY oi.created_at, oi.id`,
    [sessionId]
  );

  let foodQty = 0;
  let extraGames = 0;
  let itemsTotal = 0;
  const items = it.rows.map((r) => {
    if (r.category === 'food') foodQty += r.qty;
    if (r.category === 'game') extraGames += r.games_granted * r.qty;
    itemsTotal += r.unit_price * r.qty;
    return {
      id: Number(r.id),
      name: r.name,
      qty: r.qty,
      unitPrice: r.unit_price,
      status: r.status,
      kind: r.kind,
      category: r.category,
      groupKey: r.group_key, // 同じ値の行は、同じフードと、そのトッピング(画面で、まとめて表示する)
      orderedAt: r.created_at,
      servedAt: r.served_at,
    };
  });

  const rules = rulesFromConfig(config);
  const current = calcGames(rules, foodQty, extraGames);
  const fee = session.entrance_fee_per_person ?? config.pricing.entrance_fee_per_person;
  // 無料チケット(レジで「適用」した枚数)を、入場料から引く
  const freeTickets = Math.min(session.free_tickets ?? 0, session.people);
  const t = calcTotal({ fee, people: session.people, itemsTotal, freeTickets });

  return {
    table: session.table_name,
    people: session.people,
    state: session.state,
    createdAt: session.created_at,
    // current: 今のゲーム回数 / free: フードで増えた分 / max: フードで増える分の上限 / extra: 購入した追加ゲーム
    games: { current, free: freeGames(rules, foodQty), max: rules.max, extra: extraGames },
    items,
    // entranceFee: 入場料(チケットを引く前) / discount: チケットで引いた金額 / total: お支払いの合計
    total: { entranceFee: t.entranceFee, items: itemsTotal, freeTickets, discount: t.discount, total: t.total },
  };
}

// お客様が会計ボタンを押したとき: 使用中 → 会計中。すでに会計中なら、そのまま成功にする。
async function requestCheckout(sessionId) {
  const out = await db.tx(async (c) => {
    const s = await c.query('SELECT table_name, state FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (s.rowCount === 0) throw new AppError(401, 'no_session', '識別番号が正しくありません');
    const { table_name: table, state } = s.rows[0];
    if (state === 'closed') throw new AppError(410, 'session_closed', 'この卓の会計は完了しています');
    if (state === 'paying') return { table, changed: false };
    await c.query("UPDATE sessions SET state = 'paying', paying_at = now() WHERE id = $1", [sessionId]);
    return { table, changed: true };
  });
  if (out.changed) events.emit('session.changed', { table: out.table, sessionId, state: 'paying' });
  return { state: 'paying' };
}

module.exports = { createOrGetSession, getSessionDetail, requestCheckout, findActiveSession };