"use strict";
// ブラウザの動き(QR→入店→状況→WebSocket)を、コマンドで再現して確かめます。
//   実行:        BASE_URL=https://xxxx.replit.app npm run flow
//   卓を指定:    BASE_URL=... npm run flow -- --table=E5
// 必要: 環境変数 POS_PIN と ADMIN_PIN(旧来の STAFF_PIN だけでも動きます)。空き卓を1つ使い、最後に会計まで済ませて空きに戻します。
const WebSocket = require("ws");

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const WS_BASE = BASE.replace(/^http/, "ws");
const PIN = process.env.POS_PIN || process.env.STAFF_PIN; // レジ用
const ADMIN_PIN = process.env.ADMIN_PIN || process.env.STAFF_PIN; // 管理者用
const WANT = (process.argv.find((a) => a.startsWith("--table=")) || "").slice(
  8,
);
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
const say = (ok, msg) => console.log(`${ok ? "OK " : "NG "} ${msg}`);

// ブラウザと同じように、Origin(接続元)を付けて、WebSocketにつなぐ
function openWs(path, authMsg, waitMs) {
  return new Promise((resolve) => {
    const log = { msgs: [], closed: null, error: null };
    const ws = new WebSocket(WS_BASE + path, { headers: { Origin: BASE } });
    ws.on("open", () => ws.send(JSON.stringify(authMsg)));
    ws.on("message", (m) => log.msgs.push(JSON.parse(m.toString()).type));
    ws.on("close", (code, reason) => {
      log.closed = `${code} ${reason}`;
    });
    ws.on("unexpected-response", (req, res) => {
      log.error = `HTTP ${res.statusCode}`;
    });
    ws.on("error", (e) => {
      log.error = log.error || e.message;
    });
    setTimeout(() => {
      ws.close();
      resolve(log);
    }, waitMs);
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
  const tables = (await api("GET", "/api/pos/tables", { token })).json.tables;
  console.log(
    "卓の状態: " + tables.map((t) => `${t.table}=${t.state}`).join(" "),
  );
  const free = tables.find(
    (t) => t.state === "free" && (!WANT || t.table === WANT),
  );
  if (!free)
    throw new Error(
      "使える空き卓がありません(リセットするか、--table= を変えてください)",
    );
  const T = free.table;
  const key = new URL(
    (await api("GET", `/api/admin/tables/${T}/qr`, { token: admin })).json.url,
  ).searchParams.get("key");
  const menu = (await api("GET", "/api/public/menu")).json;
  const drink = menu.items.find((i) => i.category === "drink" && i.onSale);

  const s1 = await api("POST", "/api/public/sessions", {
    body: { table: T, key, people: 2, drinks: [{ id: drink.id, qty: 2 }] },
  });
  say(
    s1.status === 201,
    `1 入店(POST /sessions) → ${s1.status} ${s1.json?.error?.code || ""}`,
  );
  const sid = s1.json?.sessionId;
  if (!sid) throw new Error("識別番号が取れませんでした");

  const g1 = await api("GET", "/api/public/session", { session: sid });
  say(
    g1.status === 200,
    `2 状況の取得(GET /session) → ${g1.status} state=${g1.json?.state || g1.json?.error?.code}`,
  );

  const w = await openWs("/ws/public", { type: "auth", sessionId: sid }, 7000);
  say(
    w.msgs.includes("ready") && w.closed === null,
    `3 WebSocket(Origin付き・7秒待つ) → 受信=${w.msgs.join(",") || "なし"} 切断=${w.closed || "なし"} ${w.error ? "失敗=" + w.error : ""}`,
  );

  const s2 = await api("POST", "/api/public/sessions", {
    body: { table: T, key, people: 3, drinks: [{ id: drink.id, qty: 3 }] },
  });
  say(
    s2.status === 200 && s2.json?.sessionId === sid,
    `4 2台目の入店 → ${s2.status} 同じ識別番号=${s2.json?.sessionId === sid}`,
  );

  const g2 = await api("GET", "/api/public/session", { session: sid });
  say(g2.status === 200, `5 数秒後の状況の取得 → ${g2.status}`);

  await api("POST", "/api/public/checkout-request", { session: sid });
  const co = await api("POST", `/api/pos/tables/${T}/checkout`, {
    token,
    body: { confirmUnserved: true },
  });
  say(
    co.status === 200,
    `6 後片付け(会計) → ${co.status}。卓 ${T} は空きに戻りました`,
  );
})().catch((e) => {
  console.error("中断:", e.message);
  process.exit(1);
});
