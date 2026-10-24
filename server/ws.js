'use strict';
// WebSocket。画面に「何かが変わった」ことだけを知らせます(中身は、画面側がAPIで取り直す)。
//   /ws/public … お客様用。最初に {type:'auth', sessionId} を送る。自分の卓のできごとだけ届く。
//   /ws/staff  … スタッフ用(cafe・pos)。最初に {type:'auth', token} を送る。
// 認証の情報を URL に入れないよう、接続したあとの最初のメッセージで送らせます。

const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');
const events = require('./events');
const { originAllowed } = require('./middleware/origin');

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const MAX_CONNECTIONS = 1000;
const MAX_PER_SESSION = 20;
const MSG_WINDOW_MS = 10000;
const MAX_MSG_PER_WINDOW = 30;
const SESSION_ID = /^[A-Za-z0-9_-]{16,32}$/;

function rejectUpgrade(socket, code) {
  socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const staffSockets = new Set();
  const sessionSockets = new Map(); // sessionId -> Set<ws>
  let total = 0;

  const send = (ws, obj) => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 1_000_000) return ws.terminate(); // 受け取れていない相手は切る
    ws.send(JSON.stringify(obj));
  };
  const toStaff = (obj) => staffSockets.forEach((ws) => send(ws, obj));
  const toSession = (id, obj, closeAfter) => {
    const set = sessionSockets.get(id);
    if (!set) return;
    for (const ws of [...set]) {
      send(ws, obj);
      if (closeAfter) ws.close(4410, 'session closed');
    }
  };
  const toAllPublic = (obj, closeAfter) => {
    for (const id of [...sessionSockets.keys()]) toSession(id, obj, closeAfter);
  };

  // --- サーバー内のできごと → 画面へ ---
  const onOrder = (e) => {
    toStaff({ type: 'order.created', table: e.table, orderId: e.orderId });
    toSession(e.sessionId, { type: 'order.created', orderId: e.orderId });
  };
  const onServed = (e) => {
    toStaff({ type: 'item.served', table: e.table, itemId: e.itemId });
    toSession(e.sessionId, { type: 'item.served', itemId: e.itemId });
  };
  const onSession = (e) => {
    toStaff({ type: 'session.changed', table: e.table, state: e.state });
    toSession(e.sessionId, { type: 'session.changed', state: e.state }, e.state === 'closed');
  };
  const onMenu = () => {
    toStaff({ type: 'menu.changed' });
    toAllPublic({ type: 'menu.changed' });
  };
  const onReset = () => {
    toStaff({ type: 'reset' });
    toAllPublic({ type: 'reset' }, true);
  };
  events.on('order.created', onOrder);
  events.on('item.served', onServed);
  events.on('session.changed', onSession);
  events.on('menu.changed', onMenu);
  events.on('reset', onReset);

  // --- 接続 ---
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400);
    }
    if (pathname !== '/ws/public' && pathname !== '/ws/staff') return rejectUpgrade(socket, 404);
    if (!originAllowed(req.headers, process.env.PUBLIC_BASE_URL)) {
      console.warn(`[ws] Originが許可されていません origin=${req.headers.origin} host=${req.headers.host}`);
      return rejectUpgrade(socket, 403);
    }
    if (total >= MAX_CONNECTIONS) return rejectUpgrade(socket, 503);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, pathname === '/ws/staff' ? 'staff' : 'public'));
  });

  function onConnection(ws, kind) {
    total += 1;
    ws.kind = kind;
    ws.isAlive = true;
    ws.authed = false;
    ws.authing = false;
    ws.exp = null;
    ws.sessionId = null;
    ws.windowStart = Date.now();
    ws.msgCount = 0;

    const timer = setTimeout(() => {
      if (!ws.authed) ws.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => console.warn('[ws] 接続エラー:', err.message));
    ws.on('close', () => {
      clearTimeout(timer);
      total -= 1;
      staffSockets.delete(ws);
      if (ws.sessionId) {
        const set = sessionSockets.get(ws.sessionId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) sessionSockets.delete(ws.sessionId);
        }
      }
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - ws.windowStart > MSG_WINDOW_MS) {
        ws.windowStart = now;
        ws.msgCount = 0;
      }
      if (++ws.msgCount > MAX_MSG_PER_WINDOW) return ws.close(4429, 'too many messages');
      if (isBinary) return ws.close(1003, 'text only');

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.close(1007, 'bad json');
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') return send(ws, { type: 'pong' });
      if (msg.type === 'auth' && !ws.authed && !ws.authing) {
        ws.authing = true;
        handleAuth(ws, msg)
          .catch((err) => {
            console.error('[ws] 認証処理でエラー:', err.message);
            ws.close(1011, 'server error');
          })
          .finally(() => {
            ws.authing = false;
          });
      }
    });
  }

  async function handleAuth(ws, msg) {
    if (ws.kind === 'staff') {
      const data = auth.verifyToken(msg.token);
      if (!data) return ws.close(4401, 'unauthorized');
      ws.authed = true;
      ws.exp = data.e;
      staffSockets.add(ws);
      return send(ws, { type: 'ready', role: data.r });
    }

    const id = msg.sessionId;
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return ws.close(4401, 'unauthorized');
    const r = await db.query('SELECT state FROM sessions WHERE id = $1', [id]);
    if (r.rowCount === 0) return ws.close(4401, 'unauthorized');
    if (r.rows[0].state === 'closed') return ws.close(4410, 'session closed');
    if (ws.readyState !== 1) return; // 認証の途中で切れた
    let set = sessionSockets.get(id);
    if (!set) {
      set = new Set();
      sessionSockets.set(id, set);
    }
    if (set.size >= MAX_PER_SESSION) return ws.close(4429, 'too many connections');
    set.add(ws);
    ws.sessionId = id;
    ws.authed = true;
    send(ws, { type: 'ready', state: r.rows[0].state });
  }

  // 定期的な生存確認。応答がない接続を切る。スタッフのトークンが切れたら知らせて切る。
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
      if (ws.exp && now > ws.exp) {
        send(ws, { type: 'auth_expired' });
        ws.close(4401, 'token expired');
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
      events.off('order.created', onOrder);
      events.off('item.served', onServed);
      events.off('session.changed', onSession);
      events.off('menu.changed', onMenu);
      events.off('reset', onReset);
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}

module.exports = { attachWebSocket };
