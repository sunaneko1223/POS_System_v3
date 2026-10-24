'use strict';
// 画面の確認用。空いている卓に、お客様の入店と注文を作ります(画面から注文できるようになるまでの代わり)。
//   実行:        npm run demo
//   会計中にする: npm run demo -- --pay
//   公開URLで:    BASE_URL=https://xxxx.replit.app npm run demo
// 必要: 環境変数 POS_PIN と ADMIN_PIN(旧来の STAFF_PIN だけでも動きます)
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PIN = process.env.POS_PIN || process.env.STAFF_PIN; // レジ用
const ADMIN_PIN = process.env.ADMIN_PIN || process.env.STAFF_PIN; // 管理者用
const PAY = process.argv.includes('--pay');

async function api(method, path, { token, session, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (session) headers['X-Session-Id'] = session;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error?.message || ''}`);
  return json;
}

(async () => {
  if (!PIN) throw new Error('環境変数 POS_PIN(または STAFF_PIN)が設定されていません');
  const { token } = await api('POST', '/api/auth/login', { body: { pin: PIN } });
  const admin = await api('POST', '/api/admin/login', { token, body: { pin: ADMIN_PIN } });
  const tables = (await api('GET', '/api/pos/tables', { token })).tables;
  const free = tables.find((t) => t.state === 'free');
  if (!free) throw new Error('空き卓がありません');
  const T = free.table;

  const qr = await api('GET', `/api/admin/tables/${T}/qr`, { token: admin.token });
  const key = new URL(qr.url).searchParams.get('key');
  const menu = await api('GET', '/api/public/menu');
  const drink = menu.items.find((i) => i.category === 'drink' && i.onSale);
  const foods = menu.items.filter((i) => i.category === 'food' && i.onSale);
  if (!drink || !foods.length) throw new Error('販売中のドリンクとフードが必要です');

  const s = await api('POST', '/api/public/sessions', { body: { table: T, key, people: 2, drinks: [{ id: drink.id, qty: 2 }] } });
  const sid = s.sessionId;
  const stamp = Date.now();
  await api('POST', '/api/public/orders', { session: sid, body: { requestId: `demo-a-${stamp}`, items: [{ id: foods[0].id, qty: 2 }] } });
  if (foods[1]) await api('POST', '/api/public/orders', { session: sid, body: { requestId: `demo-b-${stamp}`, items: [{ id: foods[1].id, qty: 1 }] } });
  if (PAY) await api('POST', '/api/public/checkout-request', { session: sid });

  console.log(`卓 ${T} に、注文を入れました${PAY ? '(会計中)' : '(使用中)'}。`);
  console.log(`cafe: ${BASE}/cafe/  pos: ${BASE}/pos/`);
})().catch((e) => {
  console.error('失敗:', e.message);
  process.exit(1);
});
