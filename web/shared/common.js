'use strict';
// 全画面で共通の部品(window.YS): API呼び出し、トークンの保存、通知の表示、WebSocket(自動で再接続)
(() => {
  // ログイン状態の保存場所は、画面(pos / cafe / admin)ごとに別にする(PINと役割が画面ごとに違うため)
  const KEY = 'yushisai_token_' + ((location.pathname.split('/')[1] || 'app').toLowerCase());

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

  // スタッフ用トークン(通常用)の保存。期限が過ぎたものは、取り出すときに捨てる
  const store = {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (!v || !v.t) return null;
        if (v.e && Date.parse(v.e) <= Date.now()) {
          localStorage.removeItem(KEY);
          return null;
        }
        return v.t;
      } catch {
        return null;
      }
    },
    set(token, expiresAt) {
      try {
        localStorage.setItem(KEY, JSON.stringify({ t: token, e: expiresAt || null }));
      } catch {
        /* 保存できない環境では、再読み込みでログインし直す */
      }
    },
    clear() {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* 何もしない */
      }
    },
  };

  // opts: { token(Bearerで送る), session(識別番号), body }
  // 失敗したときは、status / code / message / data(サーバーのエラー内容)を持つErrorを投げる
  async function api(method, path, opts = {}) {
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    if (opts.session) headers['X-Session-Id'] = opts.session;

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        cache: 'no-store', // ブラウザに保存された古い返事を使わない(識別番号がヘッダーで、URLが同じため)
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      const err = new Error('通信できませんでした。電波の状態を確認してください');
      err.status = 0;
      err.code = 'network';
      throw err;
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* 本文なし */
    }
    if (!res.ok) {
      const e = (json && json.error) || {};
      const err = new Error(e.message || 'エラーが起きました');
      err.status = res.status;
      err.code = e.code || 'error';
      err.data = e;
      throw err;
    }
    return json;
  }

  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'fixed left-1/2 z-50 hidden -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white';
      el.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 24px)';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), 2500);
  }

  // WebSocket。切れたら、少しずつ間隔をあけて自動で再接続する。
  //   path: '/ws/staff' など / authMsg(): 接続のたびに送る認証メッセージを返す関数
  //   onStatus('connecting'|'open'|'closed') / onOpen(認証が通ったとき。再接続のときも呼ばれる)
  //   onMessage(m) / onAuthError(認証が通らない・期限切れ) / onEnded(サーバーが会計済みなどで切ったとき)
  function connect(o) {
    let ws = null;
    let retry = 0;
    let stopped = false;
    let timer = null;
    const status = (s) => o.onStatus && o.onStatus(s);

    const open = () => {
      status('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}${o.path}`);
      ws.onopen = () => ws.send(JSON.stringify(o.authMsg()));
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === 'pong') return;
        if (m.type === 'ready') {
          retry = 0;
          status('open');
          if (o.onOpen) o.onOpen(m);
          return;
        }
        if (o.onMessage) o.onMessage(m);
      };
      ws.onclose = (ev) => {
        status('closed');
        if (stopped) return;
        if (ev.code === 4401) return o.onAuthError && o.onAuthError();
        if (ev.code === 4410) return o.onEnded && o.onEnded();
        timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++));
      };
      ws.onerror = () => {};
    };
    open();

    const keepAlive = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send('{"type":"ping"}');
    }, 25000);

    return {
      close() {
        stopped = true;
        clearTimeout(timer);
        clearInterval(keepAlive);
        if (ws) ws.close();
      },
    };
  }

  // トッピングを、付けたフードの下にまとめる。
  //   items: groupKey と category を持つ品目の配列(順番どおり)。同じ groupKey の行が、1つのまとまりになる。
  //   戻り値: [{ head, tops }]  head: フードなどの本体(ないときは null) / tops: そのトッピング(category が topping の行)
  function groupItems(items) {
    const out = [];
    const byKey = new Map();
    for (const it of items) {
      const isTop = it.category === 'topping';
      if (!it.groupKey) {
        out.push({ head: isTop ? null : it, tops: isTop ? [it] : [] });
        continue;
      }
      let g = byKey.get(it.groupKey);
      if (!g) {
        g = { head: null, tops: [] };
        byKey.set(it.groupKey, g);
        out.push(g);
      }
      if (isTop) g.tops.push(it);
      else g.head = it;
    }
    return out;
  }
  // 注文の控えの名前(「＋マヨネーズ(たこ焼き)」)から、トッピングの名前だけを取り出す
  function toppingName(name, headName) {
    let n = String(name).replace(/^＋/, '');
    const suffix = headName ? `(${headName})` : '';
    if (suffix && n.endsWith(suffix)) n = n.slice(0, -suffix.length);
    return n;
  }

  window.YS = { esc, yen, store, api, toast, connect, groupItems, toppingName };
})();