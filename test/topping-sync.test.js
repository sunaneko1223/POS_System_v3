'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeNames, diffToppings, MAX_TOPPINGS } = require('../server/services/toppingSync');

test('名前の分解: カンマ(半角・全角・読点)と改行で区切り、空白と重複を除く', () => {
  assert.deepEqual(normalizeNames('マヨ, ソース,青のり'), ['マヨ', 'ソース', '青のり']);
  assert.deepEqual(normalizeNames('マヨ、ソース，青のり\nかつお'), ['マヨ', 'ソース', '青のり', 'かつお']);
  assert.deepEqual(normalizeNames(' マヨ , , マヨ ,ソース,, '), ['マヨ', 'ソース']);
  assert.deepEqual(normalizeNames(''), []);
  assert.deepEqual(normalizeNames(undefined), []);
  assert.deepEqual(normalizeNames(['A', ' B ', 'A', '']), ['A', 'B']);
  assert.ok(MAX_TOPPINGS >= 1);
});

const ex = [
  { id: 't1', name: 'マヨ', on_sale: true },
  { id: 't2', name: 'ソース', on_sale: true },
  { id: 't3', name: '青のり', on_sale: false }, // 注文の記録があって、販売終了にされていた
];

test('差分: 変わらない名前は、そのまま(idを保つ)', () => {
  const d = diffToppings(ex, ['マヨ', 'ソース']);
  assert.deepEqual(d.keep.map((k) => k.id), ['t1', 't2']);
  assert.deepEqual(d.add, []);
  assert.deepEqual(d.remove.map((r) => r.id), ['t3']); // 青のりは、なくなった
});

test('差分: 新しい名前は、追加する', () => {
  const d = diffToppings(ex, ['マヨ', 'チーズ']);
  assert.deepEqual(d.add, ['チーズ']);
  assert.deepEqual(d.remove.map((r) => r.id).sort(), ['t2', 't3']);
});

test('差分: 販売終了にしていた名前を、また入れたら、販売中に戻す', () => {
  const d = diffToppings(ex, ['マヨ', 'ソース', '青のり']);
  assert.deepEqual(d.keep.find((k) => k.id === 't3'), { id: 't3', name: '青のり', revive: true });
  assert.equal(d.keep.find((k) => k.id === 't1').revive, false);
  assert.deepEqual(d.remove, []);
});

test('差分: 空のリストにすると、すべてなくなる。最初は、すべて追加', () => {
  assert.deepEqual(diffToppings(ex, []).remove.length, 3);
  assert.deepEqual(diffToppings([], ['A', 'B']).add, ['A', 'B']);
});

// ---- DBへの反映(疑似のDBで、処理の流れを確かめる。SQLの文法そのものは、実際のDBで確認が必要) ----
const { syncToppings, toppingNames } = require('../server/services/toppingSync');

// menu_items と order_items だけを持つ、小さな疑似DB。syncToppings が出すSQLを、見分けて動かす
function fakeDb(rows, ordered = []) {
  const log = [];
  const c = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      log.push(q.split(' ').slice(0, 3).join(' '));
      if (q.startsWith('SELECT id, name, on_sale FROM menu_items WHERE parent_id')) {
        return { rows: rows.filter((r) => r.parent_id === params[0] && r.category === 'topping').map((r) => ({ id: r.id, name: r.name, on_sale: r.on_sale })) };
      }
      if (q.startsWith('SELECT DISTINCT menu_item_id')) {
        return { rows: params[0].filter((id) => ordered.includes(id)).map((id) => ({ menu_item_id: id })) };
      }
      if (q.startsWith('UPDATE menu_items SET on_sale = FALSE')) { rows.find((r) => r.id === params[0]).on_sale = false; return { rows: [] }; }
      if (q.startsWith('UPDATE menu_items SET on_sale = TRUE')) { rows.find((r) => r.id === params[0]).on_sale = true; return { rows: [] }; }
      if (q.startsWith('DELETE FROM menu_items WHERE id')) { rows.splice(rows.findIndex((r) => r.id === params[0]), 1); return { rows: [] }; }
      if (q.startsWith('INSERT INTO menu_items')) { rows.push({ id: params[0], category: 'topping', name: params[1], parent_id: params[2], on_sale: true, sort: rows.length }); return { rows: [] }; }
      if (q.startsWith('SELECT COALESCE(MAX(sort)')) return { rows: [{ n: 100 }] };
      if (q.startsWith('UPDATE menu_items SET sort')) { rows.find((r) => r.id === params[0]).sort = params[1]; return { rows: [] }; }
      if (q.startsWith('SELECT name FROM menu_items WHERE parent_id')) {
        return { rows: rows.filter((r) => r.parent_id === params[0] && r.category === 'topping' && r.on_sale).sort((x, y) => x.sort - y.sort).map((r) => ({ name: r.name })) };
      }
      throw new Error('想定していないSQL: ' + q);
    },
  };
  return { c, rows, log };
}
const T = (id, name, extra = {}) => ({ id, category: 'topping', name, parent_id: 'f1', on_sale: true, sort: 0, ...extra });

test('反映: 新しいフードに、トッピングを入れる(入力した順に並ぶ)', async () => {
  const { c, rows } = fakeDb([]);
  await syncToppings(c, 'f1', ['マヨ', 'ソース', '青のり']);
  assert.deepEqual(await toppingNames(c, 'f1'), ['マヨ', 'ソース', '青のり']);
  assert.ok(rows.every((r) => r.category === 'topping' && r.parent_id === 'f1'));
  assert.equal(new Set(rows.map((r) => r.id)).size, 3); // idは、すべて別
});

test('反映: 注文の記録がないものは削除、あるものは販売終了、同じ名前は残す', async () => {
  const { c, rows } = fakeDb([T('a', 'マヨ'), T('b', 'ソース'), T('c', '青のり')], ['b']);
  await syncToppings(c, 'f1', ['マヨ', 'チーズ']);
  assert.ok(rows.find((r) => r.id === 'a'), 'マヨ(同じ名前)は、残る');
  assert.equal(rows.find((r) => r.id === 'b').on_sale, false); // ソースは、注文の記録があるので、販売終了
  assert.equal(rows.find((r) => r.id === 'c'), undefined); // 青のりは、記録がないので、削除
  assert.deepEqual(await toppingNames(c, 'f1'), ['マヨ', 'チーズ']); // 販売終了のソースは、出ない
});

test('反映: 販売終了にしていた名前を入れ直すと、販売中に戻る(新しい行は作らない)', async () => {
  const { c, rows } = fakeDb([T('a', 'マヨ'), T('b', 'ソース', { on_sale: false })], ['b']);
  await syncToppings(c, 'f1', ['マヨ', 'ソース']);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === 'b').on_sale, true);
});

test('反映: 空のリストで、すべてのトッピングが外れる。ほかのフードには、触らない', async () => {
  const other = { id: 'x', category: 'topping', name: 'マヨ', parent_id: 'f2', on_sale: true, sort: 0 };
  const { c, rows } = fakeDb([T('a', 'マヨ'), other]);
  await syncToppings(c, 'f1', []);
  assert.deepEqual(rows.map((r) => r.id), ['x']);
});
