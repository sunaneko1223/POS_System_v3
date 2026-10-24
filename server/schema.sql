-- 何度実行しても安全なように IF NOT EXISTS を使っています。

CREATE TABLE IF NOT EXISTS menu_items (
  id        TEXT PRIMARY KEY,
  category  TEXT    NOT NULL CHECK (category IN ('drink', 'food', 'topping', 'game')),
  name      TEXT    NOT NULL CHECK (char_length(name) BETWEEN 1 AND 30),
  price     INTEGER NOT NULL CHECK (price >= 0),
  games     INTEGER,
  on_sale   BOOLEAN NOT NULL DEFAULT TRUE,
  sort      INTEGER NOT NULL DEFAULT 0,
  CHECK (
    (category = 'game' AND games IS NOT NULL AND games >= 1)
    OR (category <> 'game' AND games IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS tables (
  name    TEXT PRIMARY KEY,
  qr_key  TEXT NOT NULL
);

-- state: open=使用中 / paying=会計中 / closed=終了
-- 卓の「空き」は、closed 以外のセッションが無いことで表します(別に持たない)。
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  table_name   TEXT NOT NULL REFERENCES tables(name),
  people       INTEGER NOT NULL CHECK (people >= 1),
  state        TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paying', 'closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paying_at    TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  total_amount INTEGER CHECK (total_amount IS NULL OR total_amount >= 0)
);

-- 同じ卓に、終了していないセッションは1件だけ。
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_table
  ON sessions (table_name) WHERE state <> 'closed';

CREATE TABLE IF NOT EXISTS orders (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 名前・単価・ゲーム数は注文時点の値を保存します(あとで値段を変えても変わらない)。
-- kind: entrance=入場ドリンク / normal=通常の注文
-- status: wait=未提供 / served=提供済み(追加ゲームは最初から served)
CREATE TABLE IF NOT EXISTS order_items (
  id             BIGSERIAL PRIMARY KEY,
  order_id       BIGINT NOT NULL REFERENCES orders(id),
  session_id     TEXT   NOT NULL REFERENCES sessions(id),
  menu_item_id   TEXT   NOT NULL REFERENCES menu_items(id),
  kind           TEXT   NOT NULL DEFAULT 'normal' CHECK (kind IN ('entrance', 'normal')),
  category       TEXT   NOT NULL CHECK (category IN ('drink', 'food', 'topping', 'game')),
  name           TEXT   NOT NULL,
  unit_price     INTEGER NOT NULL CHECK (unit_price >= 0),
  games_granted  INTEGER NOT NULL DEFAULT 0 CHECK (games_granted >= 0),
  qty            INTEGER NOT NULL CHECK (qty >= 1),
  status         TEXT   NOT NULL DEFAULT 'wait' CHECK (status IN ('wait', 'served')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  served_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS order_items_session_idx ON order_items (session_id);
CREATE INDEX IF NOT EXISTS order_items_wait_idx ON order_items (created_at) WHERE status = 'wait';

-- 後から足した項目(既存のDBにも安全に追加できるよう ALTER を使っています)
-- request_id: 注文の二重送信を防ぐための、画面側が作る一意の文字列
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_request_idx
  ON orders (session_id, request_id) WHERE request_id IS NOT NULL;

-- 入場料は、セッション作成時の値を保存(あとで設定を変えても、その卓の金額は変わらない)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS entrance_fee_per_person INTEGER
  CHECK (entrance_fee_per_person IS NULL OR entrance_fee_per_person >= 0);

-- トッピング(category = 'topping')を、既存のDBでも使えるようにする(カテゴリの制約を付け替える)。何度流しても安全です。
ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_category_check;
ALTER TABLE menu_items ADD CONSTRAINT menu_items_category_check
  CHECK (category IN ('drink', 'food', 'topping', 'game'));
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_category_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_category_check
  CHECK (category IN ('drink', 'food', 'topping', 'game'));

-- トッピングを、フードに紐づける(トッピングの行に、付けるフードの id を入れる)。ほかの種類では空のまま。
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES menu_items(id);

-- 会計のときの、お預かり金額(おつり = お預かり - 合計)。取引履歴に出す。古いデータは、空のまま。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS received_amount INTEGER
  CHECK (received_amount IS NULL OR received_amount >= 0);

-- 無料チケット(1枚で、1人ぶんの入場料が無料)。会計のときに入力した枚数。古いデータは0のまま。
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS free_tickets INTEGER NOT NULL DEFAULT 0
  CHECK (free_tickets >= 0);