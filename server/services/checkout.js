'use strict';
// 会計・会計の取り消し(使用中に戻す)・全データのリセット。どれもトランザクションの中で行う。
const db = require('../db');
const events = require('../events');
const { AppError } = require('../middleware/error');

const ACTIVE = "table_name = $1 AND state <> 'closed'";

// 無料チケット: 1枚で、1人ぶんの入場料が無料。枚数は 0 〜 その卓の人数。
function validateTickets(freeTickets, people) {
  if (!Number.isInteger(freeTickets) || freeTickets < 0 || freeTickets > people) {
    throw new AppError(400, 'invalid_tickets', `無料チケットは、0〜${people}枚で入力してください`, { people });
  }
}

// 合計 = 入場料 ×(人数 − チケット枚数)+ 品目の合計(DBには触らない)
function calcTotal({ fee, people, itemsTotal, freeTickets }) {
  validateTickets(freeTickets, people);
  const discount = fee * freeTickets;
  return { entranceFee: fee * people, discount, total: fee * people - discount + itemsTotal };
}

// 会計中の卓を会計して、終了にする。
// 未提供の品目があるときは、confirmUnserved: true(スタッフが客に確認した)でないと断る。
// received(お預かり金額)を渡したときは、合計より少なければ断り、保存する(おつり = お預かり - 合計)。
// freeTickets(無料チケットの枚数)は、入場料から引く。省くと、レジで「適用」して保存した枚数を使う。
// force: true のときは、お客様が会計ボタンを押していない卓(使用中)も、レジから会計できる。
async function checkout(config, table, { confirmUnserved, received, freeTickets, force = false }) {
  const out = await db.tx(async (c) => {
    const s = await c.query(
      `SELECT id, state, people, entrance_fee_per_person, free_tickets FROM sessions WHERE ${ACTIVE} FOR UPDATE`,
      [table]
    );
    if (s.rowCount === 0) throw new AppError(404, 'table_free', 'この卓は空きです');
    const ses = s.rows[0];
    const forced = force === true && ses.state === 'open'; // レジからの強制の会計
    if (ses.state !== 'paying' && !forced) {
      throw new AppError(409, 'not_paying', 'お客様が会計ボタンを押すと、会計できます');
    }
    const tickets = freeTickets === undefined ? ses.free_tickets ?? 0 : freeTickets; // 送られなければ、保存した枚数
    validateTickets(tickets, ses.people); // 枚数がおかしいときは、未提供の確認より先に断る

    const un = await c.query(
      `SELECT name, qty FROM order_items
       WHERE session_id = $1 AND status = 'wait' AND category <> 'game'
       ORDER BY created_at, id`,
      [ses.id]
    );
    if (un.rowCount > 0 && !confirmUnserved) {
      throw new AppError(409, 'unserved_items', '未提供の品目があります', {
        items: un.rows.map((r) => ({ name: r.name, qty: r.qty })),
      });
    }

    // 合計を先に出して、お預かりが足りないときは、何も変えずに断る
    const sum = await c.query(
      'SELECT COALESCE(SUM(unit_price * qty), 0)::int AS total FROM order_items WHERE session_id = $1',
      [ses.id]
    );
    const fee = ses.entrance_fee_per_person ?? config.pricing.entrance_fee_per_person;
    const { discount, total } = calcTotal({ fee, people: ses.people, itemsTotal: sum.rows[0].total, freeTickets: tickets });
    const hasReceived = received !== undefined && received !== null;
    if (hasReceived && received < total) {
      throw new AppError(400, 'insufficient', 'お預かり金額が、合計より少ないです', { total, received });
    }

    // 確認済みで会計したときは、未提供の品目を提供済みにして、cafeの一覧に残さない
    const served = await c.query(
      "UPDATE order_items SET status = 'served', served_at = now() WHERE session_id = $1 AND status = 'wait'",
      [ses.id]
    );

    await c.query(
      "UPDATE sessions SET state = 'closed', closed_at = now(), total_amount = $2, received_amount = $3, free_tickets = $4 WHERE id = $1",
      [ses.id, total, hasReceived ? received : null, tickets]
    );
    return { sessionId: ses.id, total, discount, tickets, received: hasReceived ? received : null, autoServed: served.rowCount };
  });

  events.emit('session.changed', { table, sessionId: out.sessionId, state: 'closed' });
  return {
    table,
    total: out.total,
    freeTickets: out.tickets,
    discount: out.discount,
    received: out.received,
    change: out.received === null ? null : out.received - out.total,
    autoServed: out.autoServed,
  };
}

// 無料チケットの枚数を、会計の前に保存する(レジの「適用」)。お客様の画面にも、すぐ反映する。
//   使用中・会計中の卓だけ。枚数は 0 〜 その卓の人数。
async function setTickets(table, freeTickets) {
  const out = await db.tx(async (c) => {
    const s = await c.query(`SELECT id, state, people FROM sessions WHERE ${ACTIVE} FOR UPDATE`, [table]);
    if (s.rowCount === 0) throw new AppError(404, 'table_free', 'この卓は空きです');
    validateTickets(freeTickets, s.rows[0].people);
    await c.query('UPDATE sessions SET free_tickets = $2 WHERE id = $1', [s.rows[0].id, freeTickets]);
    return { sessionId: s.rows[0].id, state: s.rows[0].state };
  });
  // 画面を更新させる(お客様の画面・レジ・cafe)
  events.emit('session.changed', { table, sessionId: out.sessionId, state: out.state });
  return { table, freeTickets };
}

// 会計中 → 使用中に戻す(お客様が追加の注文をできるようにする)
async function reopen(table) {
  const sessionId = await db.tx(async (c) => {
    const s = await c.query(`SELECT id, state FROM sessions WHERE ${ACTIVE} FOR UPDATE`, [table]);
    if (s.rowCount === 0) throw new AppError(404, 'table_free', 'この卓は空きです');
    if (s.rows[0].state !== 'paying') throw new AppError(409, 'not_paying', 'この卓は会計中ではありません');
    await c.query("UPDATE sessions SET state = 'open', paying_at = NULL WHERE id = $1", [s.rows[0].id]);
    return s.rows[0].id;
  });
  events.emit('session.changed', { table, sessionId, state: 'open' });
  return { table, state: 'open' };
}

// 注文・セッションを全部消す(メニュー・卓・QRの鍵は残す)
async function resetAll() {
  await db.tx(async (c) => {
    await c.query('TRUNCATE order_items, orders, sessions RESTART IDENTITY');
  });
  console.warn('[admin] 注文とセッションを全て削除しました');
  events.emit('reset', {});
}

module.exports = { checkout, setTickets, reopen, resetAll, calcTotal, validateTickets };