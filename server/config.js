'use strict';
// config.yml を読み込み、形と値を検証して返します。
// 値がおかしいときは、起動時にわかりやすいメッセージを出して止めます。

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { z } = require('zod');

const CONFIG_PATH = path.join(__dirname, '..', 'config.yml');

const int = (min, max) => z.number().int().min(min).max(max);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,20}$/, '英数字・_・- のみ、20文字以内');
const nameSchema = z.string().trim().min(1).max(30);
const priceSchema = int(0, 100000);

const itemSchema = z.object({ id: idSchema, name: nameSchema, price: priceSchema }).strict();
// フード: topping に、トッピングの名前を並べる(省略できる。値段は付けない)
const foodSchema = z
  .object({
    id: idSchema,
    name: nameSchema,
    price: priceSchema,
    topping: z.array(nameSchema).max(20).optional(),
  })
  .strict();
const gameItemSchema = z
  .object({ id: idSchema, name: nameSchema, price: priceSchema, games: int(1, 10) })
  .strict();

const securitySchema = z
  .object({
    staff_token_hours: int(1, 72),
    admin_token_min: int(1, 240),
    login_max_fails: int(1, 20),
    login_lock_sec: int(10, 3600),
    api_limit_per_min: int(60, 10000),
  })
  .strict()
  .partial();

const DEFAULT_SECURITY = Object.freeze({
  staff_token_hours: 12, // 通常用トークンの有効時間
  admin_token_min: 30, // 管理用トークンの有効時間
  login_max_fails: 5, // この回数だけ連続で失敗するとロック
  login_lock_sec: 180, // ロックする秒数
  api_limit_per_min: 1200, // 1つのIPが1分間に送れるAPI呼び出しの上限
});

const configSchema = z
  .object({
    event: z.object({ name: nameSchema }).strict(),
    pricing: z.object({ entrance_fee_per_person: priceSchema }).strict(),
    game: z
      .object({
        initial_games: int(0, 20),
        max_games: int(1, 20),
        games_per_food: int(0, 20),
      })
      .strict(),
    limits: z
      .object({ max_people: int(1, 50), max_qty_per_item: int(1, 50) })
      .strict(),
    ui: z
      .object({ wait_warn_min: int(1, 120), wait_danger_min: int(1, 120) })
      .strict(),
    tables: z
      .array(z.string().regex(/^[A-Za-z0-9]{1,8}$/, '英数字8文字以内'))
      .min(1)
      .max(50),
    security: securitySchema.optional(),
    menu: z
      .object({
        drinks: z.array(itemSchema).min(1),
        foods: z.array(foodSchema),
        gamecoins: z.array(gameItemSchema),
      })
      .strict(),
  })
  .strict();

function deepFreeze(obj) {
  Object.values(obj).forEach((v) => {
    if (v && typeof v === 'object') deepFreeze(v);
  });
  return Object.freeze(obj);
}

function findDuplicate(list) {
  const seen = new Set();
  for (const v of list) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

function loadConfig() {
  let raw;
  try {
    raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`config.yml を読み込めませんでした: ${err.message}`);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(全体)'}: ${i.message}`
    );
    throw new Error(`config.yml の内容に問題があります:\n${lines.join('\n')}`);
  }
  const cfg = result.data;
  cfg.security = { ...DEFAULT_SECURITY, ...(cfg.security || {}) };

  const problems = [];
  if (cfg.game.initial_games > cfg.game.max_games) {
    problems.push('game.initial_games が game.max_games より大きいです');
  }
  if (cfg.ui.wait_warn_min >= cfg.ui.wait_danger_min) {
    problems.push('ui.wait_warn_min は ui.wait_danger_min より小さくしてください');
  }
  const dupTable = findDuplicate(cfg.tables);
  if (dupTable) problems.push(`tables に重複があります: ${dupTable}`);
  // トッピングの id は、「フードのid_t番号」で自動で作る(例: f1_t1)。長すぎないか、重複しないかも確かめる
  const toppingIds = [];
  for (const f of cfg.menu.foods) {
    const names = f.topping || [];
    const dupName = findDuplicate(names);
    if (dupName) problems.push(`フード ${f.id} のトッピングに重複があります: ${dupName}`);
    names.forEach((_, i) => {
      const tid = `${f.id}_t${i + 1}`;
      if (tid.length > 20) problems.push(`フード ${f.id} の id が長すぎます(トッピングの id が20文字を超えます)`);
      toppingIds.push(tid);
    });
  }
  const ids = [...cfg.menu.drinks, ...cfg.menu.foods, ...cfg.menu.gamecoins].map((m) => m.id).concat(toppingIds);
  const dupId = findDuplicate(ids);
  if (dupId) problems.push(`menu の id が重複しています: ${dupId}`);
  if (problems.length) {
    throw new Error(`config.yml の内容に問題があります:\n  - ${problems.join('\n  - ')}`);
  }

  return deepFreeze(cfg);
}

module.exports = { loadConfig };
