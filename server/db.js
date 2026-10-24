'use strict';
// PostgreSQL への接続、トランザクション、初期化(表の作成と初期データの投入)。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL が設定されていません。ReplitのDatabaseツールでデータベースを作成してください。');
  }
  const opts = {
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
  // SSL は接続文字列の指定に従います。接続できないときだけ、環境変数 DB_SSL で切り替えます。
  //   DB_SSL=true       → 証明書を検証してSSL接続
  //   DB_SSL=no-verify  → SSL接続するが証明書は検証しない(安全性が下がるので最後の手段)
  if (process.env.DB_SSL === 'true') opts.ssl = true;
  else if (process.env.DB_SSL === 'no-verify') opts.ssl = { rejectUnauthorized: false };

  pool = new Pool(opts);
  // 待機中の接続が切れたときにプロセスが落ちないようにする
  pool.on('error', (err) => console.error('[db] 接続プールのエラー:', err.message));
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

// fn(client) を1つのトランザクションとして実行します。失敗したら全部取り消します。
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK に失敗:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

const newKey = () => crypto.randomBytes(18).toString('base64url');

const SEED_LOCK_ID = 724001; // 起動が同時に走っても、初期投入が二重にならないようにする鍵

async function initDb(config) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(schema);

  await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_ID]);

    // メニュー: DBが空のときだけ config.yml から投入(以後はDBが正)
    const { rows } = await c.query('SELECT count(*)::int AS count FROM menu_items');
    if (rows[0].count === 0) {
      let sort = 0;
      const groups = [
        ['drink', config.menu.drinks],
        ['food', config.menu.foods],
        ['game', config.menu.gamecoins],
      ];
      for (const [category, items] of groups) {
        for (const m of items) {
          await c.query(
            `INSERT INTO menu_items (id, category, name, price, games, on_sale, sort)
             VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
            [m.id, category, m.name, m.price, category === 'game' ? m.games : null, sort++]
          );
          // フードのトッピング(config の topping の名前)。値段は付けない(0円)
          for (const [i, name] of (m.topping || []).entries()) {
            await c.query(
              `INSERT INTO menu_items (id, category, name, price, games, parent_id, on_sale, sort)
               VALUES ($1, 'topping', $2, 0, NULL, $3, TRUE, $4)`,
              [`${m.id}_t${i + 1}`, name, m.id, sort++]
            );
          }
        }
      }
      console.log('[db] メニューを config.yml から初期投入しました');
    }

    // 卓: 足りない卓だけ、ランダムな鍵つきで追加(既存の鍵は変えない)
    for (const t of config.tables) {
      await c.query('INSERT INTO tables (name, qr_key) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [
        t,
        newKey(),
      ]);
    }
  });

  const { rows: dbTables } = await query('SELECT name FROM tables');
  const extra = dbTables.map((r) => r.name).filter((n) => !config.tables.includes(n));
  if (extra.length) {
    console.warn(`[db] config.yml にない卓がDBに残っています: ${extra.join(', ')}`);
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, tx, initDb, close, newKey };
