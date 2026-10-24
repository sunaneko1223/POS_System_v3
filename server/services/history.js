'use strict';
// 取引履歴(会計が済んだ卓の一覧と、売上の集計)。レジの「取引履歴」の画面で使う。
const db = require('../db');

const LIMIT = 200; // 一覧に出す件数(新しい順)

// 取り出したデータを、画面に返す形にする(DBには触らない)
//   sessions: 会計済みの卓(新しい順) / itemRows: その品目 / summary: 全体の集計
function buildHistory(config, sessions, itemRows, summary) {
  const bySession = new Map();
  for (const r of itemRows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push({
      name: r.name,
      qty: r.qty,
      unitPrice: r.unit_price,
      category: r.category,
      kind: r.kind,
      groupKey: r.group_key,
    });
  }
  const sales = sessions.map((s) => {
    const fee = s.entrance_fee_per_person ?? config.pricing.entrance_fee_per_person;
    const received = s.received_amount ?? null;
    const freeTickets = s.free_tickets ?? 0;
    return {
      table: s.table_name,
      closedAt: s.closed_at,
      people: s.people,
      entranceFee: fee * s.people, // 無料チケットを引く前の入場料
      freeTickets,
      freeTicketDiscount: fee * freeTickets,
      items: bySession.get(s.id) || [],
      total: s.total_amount ?? 0,
      received,
      change: received === null ? null : received - (s.total_amount ?? 0),
    };
  });
  return {
    summary: {
      totalSales: summary.sales,
      count: summary.count,
      itemCount: summary.items,
      lastAt: summary.last,
      freeTicketCount: summary.tickets ?? 0, // 無料チケットを使った枚数の合計
      freeTicketDiscount: summary.discount ?? 0, // 無料チケットで引いた金額の合計
    },
    sales,
    shown: sales.length,
  };
}

async function getHistory(config) {
  const s = await db.query(
    `SELECT id, table_name, people, entrance_fee_per_person, closed_at, total_amount, received_amount, free_tickets
     FROM sessions WHERE state = 'closed'
     ORDER BY closed_at DESC, id DESC LIMIT $1`,
    [LIMIT]
  );
  const ids = s.rows.map((r) => r.id);
  const it = ids.length
    ? await db.query(
        `SELECT oi.session_id, oi.name, oi.qty, oi.unit_price, oi.category, oi.kind,
                oi.order_id::text || ':' || COALESCE(mi.parent_id, oi.menu_item_id) AS group_key
         FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.session_id = ANY($1) ORDER BY oi.created_at, oi.id`,
        [ids]
      )
    : { rows: [] };
  const agg = await db.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_amount), 0)::int AS sales, MAX(closed_at) AS last,
            COALESCE(SUM(free_tickets), 0)::int AS tickets,
            COALESCE(SUM(COALESCE(entrance_fee_per_person, $1::int) * free_tickets), 0)::int AS discount
     FROM sessions WHERE state = 'closed'`,
    [config.pricing.entrance_fee_per_person]
  );
  // 売れた商品数: 注文された商品(入場ドリンクと、トッピングは除く)の数量の合計
  const cnt = await db.query(
    `SELECT COALESCE(SUM(oi.qty), 0)::int AS n
     FROM order_items oi JOIN sessions s2 ON s2.id = oi.session_id
     WHERE s2.state = 'closed' AND oi.kind = 'normal' AND oi.category IN ('drink', 'food', 'game')`
  );
  return buildHistory(config, s.rows, it.rows, {
    sales: agg.rows[0].sales,
    count: agg.rows[0].n,
    last: agg.rows[0].last,
    items: cnt.rows[0].n,
    tickets: agg.rows[0].tickets,
    discount: agg.rows[0].discount,
  });
}

module.exports = { getHistory, buildHistory, LIMIT };