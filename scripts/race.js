"use strict";
// 同時に操作されたときの動きの確認(1人でも、複数の端末が同時に使った状況を再現します)。
//   実行:           npm run race
//   公開URLに対して: BASE_URL=https://xxxx.replit.app npm run race
// 空いている卓を全部使い、卓ごとに次を確かめます。終わったら、会計まで済ませます。
//   1 同じ卓への同時の入店  2 同じ注文の同時の再送  3 ゲーム上限の同時の取り合い
//   4 同じ品目の同時の提供  5 会計ボタンと注文の同時  6 同時の会計
// 必要: 環境変数 POS_PIN と ADMIN_PIN(旧来の STAFF_PIN だけでも動きます)。試験の注文データが残るので、終わったらリセットしてください。

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const PIN = process.env.POS_PIN || process.env.STAFF_PIN; // レジ用
const ADMIN_PIN = process.env.ADMIN_PIN || process.env.STAFF_PIN; // 管理者用
let passed = 0;
let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) passed++;
  else failed++;
  console.log(
    `  ${cond ? "OK " : "NG "} ${name}${cond || detail === undefined ? "" : "  → " + JSON.stringify(detail)}`,
  );
};

async function api(method, path, { token, session, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  if (session) headers["X-Session-Id"] = session;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const many = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const rid = (p) =>
  `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function scenario(T, ctx) {
  const { token, admin, menu, drink, food, game, fee } = ctx;
  const tag = `[${T}]`;
  const qr = await api("GET", `/api/admin/tables/${T}/qr`, { token: admin });
  const key = new URL(qr.json.url).searchParams.get("key");
  const view = async (sid) =>
    (await api("GET", "/api/public/session", { session: sid })).json;

  // 1 同じ卓への同時の入店 → 1件だけ作られ、全員が同じ識別番号を受け取る
  const joins = await many(6, () =>
    api("POST", "/api/public/sessions", {
      body: { table: T, key, people: 2, drinks: [{ id: drink.id, qty: 2 }] },
    }),
  );
  const sids = new Set(joins.map((r) => r.json?.sessionId));
  ok(
    `${tag} 同時の入店で、セッションは1つだけ(201は1件)`,
    joins.filter((r) => r.status === 201).length === 1 && sids.size === 1,
    joins.map((r) => r.status),
  );
  const sid = [...sids][0];

  // 2 同じ requestId の注文を同時に5回 → 注文は1件だけ
  const same = rid("same");
  const dups = await many(5, () =>
    api("POST", "/api/public/orders", {
      session: sid,
      body: { requestId: same, items: [{ id: food.id, qty: 1 }] },
    }),
  );
  ok(
    `${tag} 同じ注文の同時再送は、全部成功扱い`,
    dups.every((r) => r.status === 200 || r.status === 201),
    dups.map((r) => r.status),
  );
  let s = await view(sid);
  const foodQty = s.items
    .filter((i) => i.category === "food")
    .reduce((a, i) => a + i.qty, 0);
  ok(`${tag} フードは1個だけ入っている`, foodQty === 1, foodQty);

  // 3 追加ゲームを同時に8回 → 全部買えて、回数が正しく足される(追加ゲームに上限はない)
  if (game) {
    const before = s.games.current;
    const buys = await many(8, () =>
      api("POST", "/api/public/orders", {
        session: sid,
        body: { requestId: rid("g"), items: [{ id: game.id, qty: 1 }] },
      }),
    );
    const won = buys.filter((r) => r.status === 201).length;
    s = await view(sid);
    ok(`${tag} 追加ゲームの同時購入が、全部通る`, won === 8, buys.map((r) => r.status));
    ok(
      `${tag} ゲーム回数が、買った分だけ増えている`,
      s.games.current === before + 8 * game.games,
      { before, now: s.games.current },
    );
  }

  // 4 同じ品目を同時に提供 → 1回だけ「提供した」になる
  const q = (await api("GET", "/api/cafe/queue", { token: admin })).json.items.find(
    (i) => i.table === T && i.kind === "normal",
  );
  const serves = await many(5, () =>
    api("POST", `/api/cafe/items/${q.id}/serve`, { token: admin }),
  );
  ok(
    `${tag} 同時の提供で、実際に切り替わったのは1回だけ`,
    serves.filter((r) => r.json?.alreadyServed === false).length === 1,
    serves.map((r) => r.json),
  );

  // 5 会計ボタンと注文を同時に → 会計中になり、そのあとの注文は入らない。合計は品目と一致
  const mix = await Promise.all([
    api("POST", "/api/public/checkout-request", { session: sid }),
    ...Array.from({ length: 5 }, () =>
      api("POST", "/api/public/orders", {
        session: sid,
        body: { requestId: rid("m"), items: [{ id: food.id, qty: 1 }] },
      }),
    ),
  ]);
  ok(`${tag} 会計ボタンは成功`, mix[0].status === 200, mix[0].json);
  s = await view(sid);
  const sumItems = s.items.reduce((a, i) => a + i.unitPrice * i.qty, 0);
  ok(`${tag} 状態は会計中`, s.state === "paying", s.state);
  ok(
    `${tag} 合計 = 入場料 + 品目の合計`,
    s.total.total === fee * 2 + sumItems,
    { total: s.total, sumItems },
  );
  const late = await api("POST", "/api/public/orders", {
    session: sid,
    body: { requestId: rid("late"), items: [{ id: food.id, qty: 1 }] },
  });
  ok(`${tag} 会計中の注文は断られる`, late.status === 409, late.status);
  const expected = s.total.total;

  // 6 同時の会計 → 1回だけ成功。金額は一致
  const outs = await many(3, () =>
    api("POST", `/api/pos/tables/${T}/checkout`, {
      token,
      body: { confirmUnserved: true },
    }),
  );
  ok(
    `${tag} 同時の会計は、1回だけ成功`,
    outs.filter((r) => r.status === 200).length === 1,
    outs.map((r) => r.status),
  );
  const done = outs.find((r) => r.status === 200);
  ok(`${tag} 会計の金額が一致する`, done?.json?.total === expected, {
    got: done?.json?.total,
    expected,
  });
}

(async () => {
  if (!PIN) throw new Error("環境変数 POS_PIN(または STAFF_PIN)が設定されていません");
  console.log(`対象: ${BASE}`);
  const { token } = (
    await api("POST", "/api/auth/login", { body: { pin: PIN } })
  ).json;
  const admin = (
    await api("POST", "/api/admin/login", { token, body: { pin: ADMIN_PIN } })
  ).json.token;
  const menu = (await api("GET", "/api/public/menu")).json;
  const drink = menu.items.find((i) => i.category === "drink" && i.onSale);
  const food = menu.items.find((i) => i.category === "food" && i.onSale);
  const game = menu.items.find((i) => i.category === "game" && i.onSale);
  const free = (
    await api("GET", "/api/pos/tables", { token })
  ).json.tables.filter((t) => t.state === "free");
  if (!drink || !food) throw new Error("販売中のドリンクとフードが必要です");
  if (!free.length) throw new Error("空き卓がありません");
  console.log(
    `使う卓: ${free.map((t) => t.table).join(", ")}(卓ごとに同時に実行します)`,
  );
  const ctx = {
    token,
    admin,
    menu,
    drink,
    food,
    game,
    fee: menu.entranceFeePerPerson,
  };
  await Promise.all(free.map((t) => scenario(t.table, ctx)));
})()
  .catch((e) => {
    failed++;
    console.error("中断:", e.message);
  })
  .finally(() => {
    console.log(`\n結果: ${passed} 件OK / ${failed} 件NG`);
    process.exit(failed ? 1 : 0);
  });
