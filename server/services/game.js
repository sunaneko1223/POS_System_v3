'use strict';

// ゲーム回数 = フードで増える分(上限 max まで) + 購入した追加ゲーム数(上限なし)
//   フードで増える分 = min(max, 初期 + フード1品あたり × フード数量)
//   max を超えて遊びたい卓は、追加ゲーム(有料)を購入する。
// rules: { initial, max, perFood }
function freeGames(rules, foodQty) {
  return Math.min(rules.max, rules.initial + rules.perFood * foodQty);
}

function calcGames(rules, foodQty, extraGames) {
  return freeGames(rules, foodQty) + extraGames;
}

function rulesFromConfig(config) {
  return {
    initial: config.game.initial_games,
    max: config.game.max_games,
    perFood: config.game.games_per_food,
  };
}

module.exports = { calcGames, freeGames, rulesFromConfig };
