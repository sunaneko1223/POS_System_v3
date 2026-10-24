"use strict";
// 1つの卓の注文回数の上限(50回)を、コマンドで確かめます。
//   実行:        POS_PIN=xxxx ADMIN_PIN=yyyy BASE_URL=https://xxxx.replit.app node scripts/order-limit.js
//   卓を指定:    ... node scripts/order-limit.js --table=E5
// 必要: 環境変数 POS_PIN と ADMIN_PIN(旧来の STAFF_PIN だけでも動きます)。空き卓を1つ使い、最後に会計まで済ませて空きに戻します。
// 注意: 試験の注文が50件、会計の記録に残ります(確認後に、管理画面の「データ」から全て削除してください)。

const MAX = 50; // server/services/order.js の MAX_ORDERS_PER_SESSION と同じ値
const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const PIN = process.env.POS_PIN || process.env.STAFF_PIN; // レジ用
const ADMIN_PIN = process.env.ADMIN_PIN || process.env.STAFF_PIN; // 管理者用
const WANT = (process.argv.find((a) => a.startsWith("--table=")) || "").slice(8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let failed = 0;
const say = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "OK " : "NG "} ${msg}`);
};

(async () => {
  if (!PIN) throw new Error("環境変数 POS_PIN(または STAFF_PIN)が設定されていません");
  console.log(`対象: ${BASE}(上限 ${MAX} 回)`);

  const { token } = (await api("POST", "/api/auth/login", { body: { pin: PIN } })).json || {};
  if (!token) throw new Error("ログインできませんでした(STAFF_PIN を確認してください)");
  const admin = (await api("POST", "/api/admin/login", { token, body: { pin: ADMIN_PIN } })).json?.token;
  if (!admin) throw new Error("管理ログインできませんでした");

  const tables = (await api("GET", "/api/pos/tables", { token })).json.tables;
  const free = tables.find((t) => t.state === "free" && (!WANT || t.table === WANT));
  if (!free) throw new Error("使える空き卓がありません(会計して空けるか、--table= を変えてください)");
  const T = free.table;
  const key = new URL((await api("GET", `/api/admin/tables/${T}/qr`, { token: admin })).json.url).searchParams.get("key");

  const menu = (await api("GET", "/api/public/menu")).json;
  const item = menu.items.find((i) => i.category === "drink" && i.onSale);
  if (!item) throw new Error("販売中のドリンクがありません");

  const s = await api("POST", "/api/public/sessions", {
    body: { table: T, key, people: 1, drinks: [{ id: item.id, qty: 1 }] },
  });
  say(s.status === 201, `入店(卓 ${T}) → ${s.status} ${s.json?.error?.code || ""}`);
  const sid = s.json?.sessionId;
  if (!sid) throw new Error("識別番号が取れませんでした");

  const stamp = Date.now();
  const order = (n) =>
    api("POST", "/api/public/orders", {
      session: sid,
      body: { requestId: `limit-${stamp}-${n}`, items: [{ id: item.id, qty: 1 }] },
    });

  try {
    let okCount = 0;
    for (let n = 1; n <= MAX; n++) {
      const r = await order(n);
      if (r.status !== 201) {
        say(false, `${n} 回目の注文 → ${r.status} ${r.json?.error?.code || ""}(通るはずでした)`);
        break;
      }
      okCount++;
      await sleep(20);
    }
    say(okCount === MAX, `${MAX} 回目まで、注文が通る(通った数: ${okCount})`);

    const over = await order(MAX + 1);
    say(
      over.status === 429 && over.json?.error?.code === "order_limit",
      `${MAX + 1} 回目は断られる → ${over.status} ${over.json?.error?.code || ""}`,
    );

    const dup = await order(MAX); // 50回目と同じ requestId の再送
    say(
      dup.status === 200 && dup.json?.duplicate === true,
      `${MAX} 回目の再送(二重送信)は、これまでどおり通る → ${dup.status} duplicate=${dup.json?.duplicate}`,
    );
  } finally {
    await api("POST", "/api/public/checkout-request", { session: sid });
    const co = await api("POST", `/api/pos/tables/${T}/checkout`, {
      token,
      body: { confirmUnserved: true },
    });
    say(co.status === 200, `後片付け(会計) → ${co.status}。卓 ${T} は空きに戻りました`);
  }
  console.log(failed === 0 ? "\nすべて OK" : `\nNG が ${failed} 件あります`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("中断:", e.message);
  process.exit(1);
});
