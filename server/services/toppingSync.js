'use strict';
const crypto = require('crypto');
// フードのトッピング(名前のリスト)の整理と、差分の計算と、DBへの反映(routes/admin.js から使う)。

const MAX_TOPPINGS = 20; // 1つのフードに付けられるトッピングの数
const MAX_NAME = 30; // トッピング名の長さ

// 入力(配列、または、カンマ区切りの文字列)を、名前の配列にする。
// 前後の空白を取り、空の名前と、重複(同じ名前)を除く。区切りは、「,」「、」「,」と改行。
function normalizeNames(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,、，\n]/);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = String(raw).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// いまDBにあるトッピングの行と、新しい名前のリストを比べる。
//   existing: [{ id, name, on_sale }]  / names: normalizeNames() の結果
//   keep   : 名前が同じ行(販売終了になっていたら revive: true。販売中に戻す)
//   add    : 新しく作る名前
//   remove : なくなった行(注文の記録があれば、消さずに販売終了にする。それは呼び出し側で判断)
function diffToppings(existing, names) {
  const byName = new Map(existing.map((r) => [r.name, r]));
  const wanted = new Set(names);
  const keep = [];
  const add = [];
  for (const name of names) {
    const row = byName.get(name);
    if (row) keep.push({ id: row.id, name, revive: !row.on_sale });
    else add.push(name);
  }
  const remove = existing.filter((r) => !wanted.has(r.name)).map((r) => ({ id: r.id, name: r.name }));
  return { keep, add, remove };
}

// ----- ここから下は、DBを使う部分(c や q は、DBの接続。トランザクションの中で呼ぶ) -----

const newId = () => 'm' + crypto.randomBytes(6).toString('hex');
const NEXT_SORT = '(SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_items)';

// フードのトッピング(販売中のもの)の名前を、並び順どおりに返す
async function toppingNames(q, foodId) {
  const r = await q.query(
    "SELECT name FROM menu_items WHERE parent_id = $1 AND category = 'topping' AND on_sale ORDER BY sort, id",
    [foodId]
  );
  return r.rows.map((x) => x.name);
}

// フードのトッピングを、新しい名前のリストに揃える(c: トランザクションの接続)。
//   同じ名前は、そのまま残す / 新しい名前は、追加する / なくなった名前は、削除する
//   ただし、注文の記録がある(外せない)ものは、消さずに、販売終了にする。
async function syncToppings(c, foodId, names) {
  const ex = (await c.query("SELECT id, name, on_sale FROM menu_items WHERE parent_id = $1 AND category = 'topping'", [foodId])).rows;
  const { keep, add, remove } = diffToppings(ex, names);

  let used = new Set();
  if (remove.length) {
    const u = await c.query('SELECT DISTINCT menu_item_id FROM order_items WHERE menu_item_id = ANY($1)', [remove.map((r) => r.id)]);
    used = new Set(u.rows.map((r) => r.menu_item_id));
  }
  for (const r of remove) {
    if (used.has(r.id)) await c.query('UPDATE menu_items SET on_sale = FALSE WHERE id = $1', [r.id]);
    else await c.query('DELETE FROM menu_items WHERE id = $1', [r.id]);
  }
  for (const k of keep) if (k.revive) await c.query('UPDATE menu_items SET on_sale = TRUE WHERE id = $1', [k.id]);

  const idByName = new Map(keep.map((k) => [k.name, k.id]));
  for (const name of add) {
    const id = newId();
    await c.query(
      `INSERT INTO menu_items (id, category, name, price, games, parent_id, on_sale, sort)
       VALUES ($1, 'topping', $2, 0, NULL, $3, TRUE, ${NEXT_SORT})`,
      [id, name, foodId]
    );
    idByName.set(name, id);
  }
  // 並び順は、入力した順にする
  const base = (await c.query('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM menu_items')).rows[0].n;
  for (const [i, name] of names.entries()) {
    await c.query('UPDATE menu_items SET sort = $2 WHERE id = $1', [idByName.get(name), base + i]);
  }
}

module.exports = { MAX_TOPPINGS, MAX_NAME, NEXT_SORT, newId, normalizeNames, diffToppings, toppingNames, syncToppings };
