'use strict';

// 同じ商品が複数行で送られても、1つにまとめる({ id, qty } の配列 → Map<id, 合計数量>)
function mergeItems(list) {
  const m = new Map();
  for (const { id, qty } of list) m.set(id, (m.get(id) || 0) + qty);
  return m;
}

module.exports = { mergeItems };
