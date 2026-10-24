'use strict';
const { AppError } = require('../middleware/error');

// トッピングは、対応するフード(parent_id)と同じ注文に入れる。トッピングの数は、そのフードの数まで。
// byId: 商品の id → { category, parent_id, ... } / merged: 注文の id → 数量
function validateToppings(byId, merged) {
  for (const [id, qty] of merged) {
    const row = byId.get(id);
    if (!row || row.category !== 'topping') continue;
    const parentQty = row.parent_id ? merged.get(row.parent_id) || 0 : 0;
    if (qty > parentQty) {
      throw new AppError(400, 'topping_needs_food', 'トッピングは、対応するフードと一緒に、フードの数まで注文できます');
    }
  }
}

module.exports = { validateToppings };
