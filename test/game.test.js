'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcGames, freeGames } = require('../server/services/game');
const { mergeItems } = require('../server/services/merge');
const { validateToppings } = require('../server/services/topping');

const rules = { initial: 2, max: 6, perFood: 2 };

test('ゲーム回数: 初期2、フード1品ごとに+2、フードで増えるのは6回まで', () => {
  assert.equal(calcGames(rules, 0, 0), 2);
  assert.equal(calcGames(rules, 1, 0), 4);
  assert.equal(calcGames(rules, 2, 0), 6);
  assert.equal(calcGames(rules, 3, 0), 6); // フードをさらに頼んでも、6回のまま
  assert.equal(freeGames(rules, 10), 6);
});

test('ゲーム回数: 追加ゲームは、6回の上に足される(上限なし)', () => {
  assert.equal(calcGames(rules, 0, 3), 5); // フードなし: 2 + 追加3
  assert.equal(calcGames(rules, 1, 1), 5); // フード1品: 4 + 追加1
  assert.equal(calcGames(rules, 2, 1), 7); // フードの上限(6)を超えた分は、追加ゲーム
  assert.equal(calcGames(rules, 2, 4), 10);
  assert.equal(calcGames(rules, 3, 2), 8);
});

test('ゲーム回数: 追加ゲームを先に買っても、あとでフードを頼んでも、無駄にならない', () => {
  // 追加2回を先に買い、そのあとフードを2品頼む → 6(フード分) + 2(追加分) = 8
  assert.equal(calcGames(rules, 0, 2), 4);
  assert.equal(calcGames(rules, 2, 2), 8);
});

test('同じ商品の行は1つにまとめる', () => {
  const m = mergeItems([{ id: 'f1', qty: 1 }, { id: 'd1', qty: 2 }, { id: 'f1', qty: 2 }]);
  assert.equal(m.get('f1'), 3);
  assert.equal(m.get('d1'), 2);
  assert.equal(m.size, 2);
});

// ---- トッピング: 対応するフードと一緒に、フードの数まで ----
const byId = new Map([
  ['f1', { id: 'f1', category: 'food', parent_id: null }],
  ['f2', { id: 'f2', category: 'food', parent_id: null }],
  ['t1', { id: 't1', category: 'topping', parent_id: 'f1' }],
  ['t2', { id: 't2', category: 'topping', parent_id: 'f1' }],
  ['d1', { id: 'd1', category: 'drink', parent_id: null }],
]);
const ok = (pairs) => validateToppings(byId, new Map(pairs));
const code = (pairs) => {
  try { ok(pairs); return null; } catch (e) { return e.code; }
};

test('トッピング: 対応するフードと一緒なら、注文できる', () => {
  assert.equal(code([['f1', 1], ['t1', 1]]), null);
  assert.equal(code([['f1', 2], ['t1', 2], ['t2', 1]]), null); // 別のトッピングも、それぞれフードの数まで
  assert.equal(code([['f1', 1], ['f2', 1], ['t1', 1]]), null); // 別のフードも一緒でよい
  assert.equal(code([['f1', 2], ['t1', 1], ['d1', 3]]), null); // トッピングを付けないフードもある
});

test('トッピング: フードなし・数が多すぎる・別のフードだけ、は断る', () => {
  assert.equal(code([['t1', 1]]), 'topping_needs_food'); // トッピングだけ
  assert.equal(code([['f1', 1], ['t1', 2]]), 'topping_needs_food'); // フードの数より多い
  assert.equal(code([['f2', 2], ['t1', 1]]), 'topping_needs_food'); // 対応しないフードだけ
});
