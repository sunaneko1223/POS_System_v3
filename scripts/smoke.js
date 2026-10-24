'use strict';
// 動作確認用。本物のサーバーに、お客様・スタッフの操作を通しで行い、結果を確かめます。
//   実行:   npm run smoke
//   公開URLに対して: BASE_URL=https://xxxx.replit.app npm run smoke
//   最後に、注文とセッションを全削除: npm run smoke -- --reset
// 必要: 環境変数 POS_PIN と ADMIN_PIN(旧来の STAFF_PIN だけでも動きます)(Replit の Secrets に入っていれば、そのまま使えます)
// 注意: 空いている卓を1つ使い、注文を入れて会計まで進めます。メニュー・QRの鍵は変えません。

const WebSocket = require('ws');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const PIN = process.env.POS_PIN || process.env.STAFF_PIN; // レジ用
const ADMIN_PIN = process.env.ADMIN_PIN || process.env.STAFF_PIN; // 管理者用
const RESET = process.argv.includes('--reset');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.log(`  NG   ${name}${detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
  }
}
const section = (t) => console.log(`\n■ ${t}`);

async function api(method, path, { token, session, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  if (session) headers['X-Session-Id'] = session;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 本文なし */
  }
  return { status: res.status, json };
}

function openWs(path, authMsg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_BASE + path);
    ws.msgs = [];
    ws.closeCode = null;
    ws.on('message', (m) => ws.msgs.push(JSON.parse(m.toString())));
    ws.on('close', (code) => {
      ws.closeCode = code;
    });
    ws.on('open', () => ws.send(JSON.stringify(authMsg)));
    ws.on('error', reject);
    const started = Date.now();
    const iv = setInterval(() => {
      const i = ws.msgs.findIndex((m) => m.type === 'ready');
      if (i >= 0) {
        ws.msgs.splice(i, 1);
        clearInterval(iv);
        resolve(ws);
      } else if (ws.closeCode !== null || Date.now() - started > 5000) {
        clearInterval(iv);
        reject(new Error(`WebSocketの認証に失敗 (${path}, close=${ws.closeCode})`));
      }
    }, 50);
  });
}

// 指定の種類の通知を待つ(見つけたら、受信済みの一覧から取り除いて返す)
async function waitMsg(ws, type, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = ws.msgs.findIndex((m) => m.type === type);
    if (i >= 0) return ws.msgs.splice(i, 1)[0];
    await sleep(50);
  }
  return null;
}
async function waitClose(ws, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ws.closeCode !== null) return ws.closeCode;
    await sleep(50);
  }
  return null;
}

async function main() {
  if (!PIN) throw new Error('環境変数 POS_PIN(または STAFF_PIN)が設定されていません');
  console.log(`対象: ${BASE}`);
  const sockets = [];

  try {
    section('生存確認・認証');
    const ping = await fetch(BASE + '/ping');
    ok('/ping が ok を返す', ping.status === 200 && (await ping.text()) === 'ok');

    ok('トークンなしで pos を呼ぶと 401', (await api('GET', '/api/pos/tables')).status === 401);
    ok('間違ったPINは 401', (await api('POST', '/api/auth/login', { body: { pin: PIN + '-wrong' } })).status === 401);

    const login = await api('POST', '/api/auth/login', { body: { pin: PIN } });
    ok('正しいPINでログインできる', login.status === 200 && !!login.json?.token, login.json);
    const token = login.json.token;
    ok('/api/auth/me が通る', (await api('GET', '/api/auth/me', { token })).status === 200);
    ok('通常用トークンで管理APIを呼ぶと 403', (await api('GET', '/api/admin/menu', { token })).status === 403);
    const al = await api('POST', '/api/admin/login', { token, body: { pin: ADMIN_PIN } });
    ok('管理用ログインができる', al.status === 200 && al.json?.role === 'admin', al.json);
    const adminToken = al.json.token;
    ok('管理用トークンで管理APIが通る', (await api('GET', '/api/admin/menu', { token: adminToken })).status === 200);

    section('メニューと卓の準備');
    const menu = (await api('GET', '/api/public/menu')).json;
    const fee = menu.entranceFeePerPerson;
    const drink = menu.items.find((i) => i.category === 'drink' && i.onSale);
    const food = menu.items.find((i) => i.category === 'food' && i.onSale);
    const game = menu.items.find((i) => i.category === 'game' && i.onSale);
    ok('メニューに販売中のドリンクとフードがある', !!drink && !!food);
    if (!drink || !food) throw new Error('メニューが足りません');

    const tables = (await api('GET', '/api/pos/tables', { token })).json.tables;
    const free = tables.find((t) => t.state === 'free');
    if (!free) throw new Error('空き卓がありません。会計を済ませてから、もう一度実行してください');
    const T = free.table;
    console.log(`  使う卓: ${T}`);

    const qr = await api('GET', `/api/admin/tables/${T}/qr`, { token: adminToken });
    const key = new URL(qr.json.url).searchParams.get('key');
    ok('QRのURLに鍵が入っている', !!key && !!qr.json.svg);

    section('お客様: 入場');
    const bad1 = await api('POST', '/api/public/sessions', { body: { table: T, key: 'x'.repeat(24), people: 2, drinks: [{ id: drink.id, qty: 2 }] } });
    ok('鍵が違うと 403', bad1.status === 403 && bad1.json?.error?.code === 'invalid_qr', bad1.json);
    const bad2 = await api('POST', '/api/public/sessions', { body: { table: T, key, people: 2, drinks: [{ id: drink.id, qty: 1 }] } });
    ok('入場ドリンクが人数分でないと 400', bad2.status === 400 && bad2.json?.error?.code === 'drink_mismatch', bad2.json);
    const bad3 = await api('POST', '/api/public/sessions', { body: { table: T, key, people: -1, drinks: [{ id: drink.id, qty: 1 }] } });
    ok('人数が不正だと 400', bad3.status === 400, bad3.json);

    const s1 = await api('POST', '/api/public/sessions', { body: { table: T, key, people: 2, drinks: [{ id: drink.id, qty: 2 }] } });
    ok('セッションが作られる(201)', s1.status === 201 && !!s1.json?.sessionId, s1.json);
    const sid = s1.json.sessionId;
    const s2 = await api('POST', '/api/public/sessions', { body: { table: T, key, people: 3, drinks: [{ id: drink.id, qty: 3 }] } });
    ok('同じ卓でもう一度送ると、同じ識別番号が返る(200)', s2.status === 200 && s2.json?.sessionId === sid && s2.json?.created === false, s2.json);
    ok('識別番号なしは 401', (await api('GET', '/api/public/session')).status === 401);

    const wsPub = await openWs('/ws/public', { type: 'auth', sessionId: sid });
    const wsStaff = await openWs('/ws/staff', { type: 'auth', token });
    sockets.push(wsPub, wsStaff);
    ok('WebSocket(客・スタッフ)が認証できる', true);

    section('お客様: 注文');
    const rid = 'smoke-' + Date.now();
    const o1 = await api('POST', '/api/public/orders', { session: sid, body: { requestId: rid, items: [{ id: food.id, qty: 1 }] } });
    ok('注文できる(201)', o1.status === 201 && o1.json?.duplicate === false, o1.json);
    ok('客に order.created が届く', !!(await waitMsg(wsPub, 'order.created')));
    const oc = await waitMsg(wsStaff, 'order.created');
    ok('スタッフに order.created が届く(卓名つき)', !!oc && oc.table === T, oc);

    const o2 = await api('POST', '/api/public/orders', { session: sid, body: { requestId: rid, items: [{ id: food.id, qty: 1 }] } });
    ok('同じ requestId の再送は、新しく作らない(duplicate)', o2.status === 200 && o2.json?.duplicate === true && o2.json?.orderId === o1.json?.orderId, o2.json);
    const o3 = await api('POST', '/api/public/orders', { session: sid, body: { requestId: 'smoke-bad-' + Date.now(), items: [{ id: food.id, qty: 0 }] } });
    ok('数量0は 400', o3.status === 400, o3.json);
    const o4 = await api('POST', '/api/public/orders', { session: sid, body: { requestId: 'smoke-none-' + Date.now(), items: [{ id: 'no_such_item', qty: 1 }] } });
    ok('存在しない商品は 409', o4.status === 409, o4.json);

    // ゲームの数え方: フードで増える分(上限 gr.max まで) + 追加ゲーム(上限なし)
    const gr = menu.game;
    const freeNow = Math.min(gr.max, gr.initial + gr.perFood * 1);
    let extraCost = 0;
    let extraGames = 0;
    if (game) {
      const gp = await api('POST', '/api/public/orders', { session: sid, body: { requestId: 'smoke-game-' + Date.now(), items: [{ id: game.id, qty: 2 }] } });
      ok(`追加ゲームは、フードの上限(${gr.max})を超えても買える`, gp.status === 201, gp.json);
      extraCost = 2 * game.price;
      extraGames = 2 * game.games;
    }

    const view = await api('GET', '/api/public/session', { session: sid });
    const expected = fee * 2 + food.price + extraCost;
    ok(`合計金額が一致する (期待 ${expected})`, view.json?.total?.total === expected, view.json?.total);
    ok('ゲーム回数 = フードで増えた分 + 追加ゲーム', view.json?.games?.current === freeNow + extraGames, view.json?.games);

    section('cafe: 提供');
    const queue = (await api('GET', '/api/cafe/queue', { token: adminToken })).json.items.filter((i) => i.table === T);
    const qFood = queue.find((i) => i.kind === 'normal');
    ok('一覧に、注文した品と入場ドリンクが出る', !!qFood && queue.some((i) => i.kind === 'entrance'), queue);
    ok('追加ゲームは一覧に出ない', !queue.some((i) => game && i.name === game.name));
    const sv = await api('POST', `/api/cafe/items/${qFood.id}/serve`, { token: adminToken });
    ok('提供済みにできる', sv.status === 200 && sv.json?.alreadyServed === false, sv.json);
    ok('客に item.served が届く', !!(await waitMsg(wsPub, 'item.served')));
    ok('スタッフに item.served が届く', !!(await waitMsg(wsStaff, 'item.served')));
    const sv2 = await api('POST', `/api/cafe/items/${qFood.id}/serve`, { token: adminToken });
    ok('もう一度押しても、エラーにならない(alreadyServed)', sv2.status === 200 && sv2.json?.alreadyServed === true, sv2.json);

    section('会計');
    const early = await api('POST', `/api/pos/tables/${T}/checkout`, { token, body: {} });
    ok('お客様が会計ボタンを押す前は 409 not_paying', early.status === 409 && early.json?.error?.code === 'not_paying', early.json);

    const cr = await api('POST', '/api/public/checkout-request', { session: sid });
    ok('会計ボタンが通る', cr.status === 200 && cr.json?.state === 'paying', cr.json);
    ok('客に session.changed(paying) が届く', (await waitMsg(wsPub, 'session.changed'))?.state === 'paying');
    ok('スタッフに session.changed(paying) が届く', (await waitMsg(wsStaff, 'session.changed'))?.state === 'paying');
    const late = await api('POST', '/api/public/orders', { session: sid, body: { requestId: 'smoke-late-' + Date.now(), items: [{ id: food.id, qty: 1 }] } });
    ok('会計中は注文できない(409 paying)', late.status === 409 && late.json?.error?.code === 'paying', late.json);

    const un = await api('POST', `/api/pos/tables/${T}/checkout`, { token, body: {} });
    ok('未提供があると、確認なしでは会計できない(409 unserved_items)', un.status === 409 && un.json?.error?.code === 'unserved_items' && un.json.error.items?.length >= 1, un.json);
    const co = await api('POST', `/api/pos/tables/${T}/checkout`, { token, body: { confirmUnserved: true } });
    ok('確認済みで会計できる', co.status === 200, co.json);
    ok(`会計の金額がサーバー計算と一致する (期待 ${expected})`, co.json?.total === expected, co.json);
    ok('未提供が自動で提供済みになる', co.json?.autoServed >= 1, co.json);
    ok('スタッフに session.changed(closed) が届く', (await waitMsg(wsStaff, 'session.changed'))?.state === 'closed');
    ok('客のWebSocketが切れる(4410)', (await waitClose(wsPub)) === 4410);
    ok('会計後の識別番号は 410', (await api('GET', '/api/public/session', { session: sid })).status === 410);
    const after = (await api('GET', '/api/pos/tables', { token })).json.tables.find((t) => t.table === T);
    ok('卓が空きに戻る', after.state === 'free', after);
    const again = await api('POST', '/api/cafe/items/' + qFood.id + '/serve', { token: adminToken });
    ok('終了した卓の品目は、提供操作の対象外でもエラーにならない', again.status === 200, again.json);

    section('使用中に戻す');
    const r1 = await api('POST', '/api/public/sessions', { body: { table: T, key, people: 1, drinks: [{ id: drink.id, qty: 1 }] } });
    const sid2 = r1.json.sessionId;
    ok('新しい識別番号が発行される', r1.status === 201 && sid2 !== sid, r1.json);
    await api('POST', '/api/public/checkout-request', { session: sid2 });
    ok('通常用トークンでは戻せない(403)', (await api('POST', `/api/admin/tables/${T}/reopen`, { token })).status === 403);
    const ro = await api('POST', `/api/admin/tables/${T}/reopen`, { token: adminToken });
    ok('管理用トークンで戻せる', ro.status === 200 && ro.json?.state === 'open', ro.json);
    const o5 = await api('POST', '/api/public/orders', { session: sid2, body: { requestId: 'smoke-re-' + Date.now(), items: [{ id: food.id, qty: 1 }] } });
    ok('戻したあとは、また注文できる', o5.status === 201, o5.json);
    const rk = await api('POST', `/api/admin/tables/${T}/rotate-key`, { token: adminToken });
    ok('使用中の卓は、QRの鍵を再発行できない(409)', rk.status === 409 && rk.json?.error?.code === 'table_in_use', rk.json);
    await api('POST', '/api/public/checkout-request', { session: sid2 });
    const co2 = await api('POST', `/api/pos/tables/${T}/checkout`, { token, body: { confirmUnserved: true } });
    ok('2回目の会計もできる', co2.status === 200 && co2.json?.total === fee + food.price, co2.json);

    if (RESET) {
      section('リセット(--reset)');
      ok('確認の文字列がないと 400', (await api('POST', '/api/admin/reset', { token: adminToken, body: {} })).status === 400);
      const rs = await api('POST', '/api/admin/reset', { token: adminToken, body: { confirm: 'リセット' } });
      ok('リセットできる', rs.status === 200, rs.json);
      const left = (await api('GET', '/api/pos/tables', { token })).json.tables.filter((t) => t.state !== 'free');
      ok('全卓が空きになる', left.length === 0, left);
    } else {
      console.log('\n(試験の注文データが残っています。本番前に、管理タブのリセットか、npm run smoke -- --reset で消してください)');
    }
  } finally {
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        /* 閉じ済み */
      }
    }
  }
}

main()
  .catch((err) => {
    failed++;
    console.error('\n中断:', err.message);
  })
  .finally(() => {
    console.log(`\n結果: ${passed} 件OK / ${failed} 件NG`);
    process.exit(failed ? 1 : 0);
  });
