'use strict';
(() => {
  const { esc, store, connect, groupItems, toppingName } = YS;
  const rawApi = YS.api;
  const api = (method, path, opts = {}) => rawApi(method, path, { ...opts, token: store.get() });
  const root = document.getElementById('app');
  const S = { items: [], served: [], view: 'queue', confirm: null, offset: 0, warn: 5, danger: 10, known: null, fresh: new Set(), online: false, err: '', ws: null };

  // --- 通知(posと同じ作り) ---
  let toastEl = null;
  let toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast hide';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.remove('hide');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hide'), 2800);
  }

  // --- ログイン ---
  function showLogin(msg) {
    if (S.ws) {
      S.ws.close();
      S.ws = null;
    }
    root.innerHTML = `<div class="app"><header class="hdr"><h1>勇志祭 | Cafe</h1></header><div class="center"><div class="card">
      <div class="field"><label for="pin">cafeのPIN</label>
        <input id="pin" class="input" type="password" inputmode="numeric" autocomplete="off" maxlength="64" placeholder="PINを入力"></div>
      <p id="msg" class="err" style="min-height:20px">${esc(msg || '')}</p>
      <div style="height:16px"></div>
      <button class="btn btn-lg btn-blue" data-act="login">ログイン</button></div></div></div>`;
    const pin = document.getElementById('pin');
    pin.addEventListener('keydown', (e) => e.key === 'Enter' && login());
    pin.focus();
  }

  async function login() {
    const pin = document.getElementById('pin').value;
    const msg = document.getElementById('msg');
    if (!pin) {
      msg.textContent = 'PINを入力してください';
      return;
    }
    try {
      const r = await rawApi('POST', '/api/auth/login', { body: { pin, role: 'cafe' } });
      store.set(r.token, r.expiresAt);
      start();
    } catch (e) {
      msg.textContent = e.code === 'locked' ? `${e.message}(あと${e.data.retryAfterSec}秒)` : e.message;
    }
  }

  // --- 一覧 ---
  const waitMin = (at) => Math.max(0, Math.floor((Date.now() + S.offset - new Date(at).getTime()) / 60000));
  // フードと、そのトッピングを、1つのまとまりにする(フードがない(先に提供した)トッピングは、単独で出す)
  const blocksOf = (items) => groupItems(items).flatMap((g) => (g.head ? [g] : g.tops.map((t) => ({ head: t, tops: [] }))));
  const topLines = (b, cls) =>
    b.tops.map((t) => `<div class="${cls}">・${esc(toppingName(t.name, b.head.name))}${b.head.qty > 1 ? ` × ${t.qty}` : ''}</div>`).join('');
  // 確認の画面に出す、短い説明(「たこ焼き × 2(マヨネーズ、鰹節)」)
  const describe = (items) =>
    blocksOf(items)
      .map((b) => `${b.head.name} × ${b.head.qty}${b.tops.length ? `(${b.tops.map((t) => toppingName(t.name, b.head.name)).join('、')})` : ''}`)
      .join('、');
  const hhmm = (at) => {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const tone = (m) => (m >= S.danger ? 'danger' : m >= S.warn ? 'warn' : '');

  function render() {
    if (!store.get()) return; // ログアウトのあとの通信の切れでは、画面を作り直さない
    const groups = new Map();
    S.items.forEach((i) => groups.set(i.table, [...(groups.get(i.table) || []), i]));
    const list = [...groups.entries()].map(([t, its]) => ({ t, its, at: Math.min(...its.map((i) => new Date(i.orderedAt).getTime())) })).sort((a, b) => a.at - b.at);
    const cards = list.map((g) => {
      const m = waitMin(g.at), k = tone(m);
      const rows = blocksOf(g.its).map((b) => {
        const all = [b.head, ...b.tops];
        return `<div class="cq-item${all.some((x) => S.fresh.has(x.id)) ? ' fresh' : ''}"><div class="nm">${esc(b.head.name)} <b>× ${b.head.qty}</b>${b.head.kind === 'entrance' ? ' <span class="tag-in">入場</span>' : ''}${topLines(b, 'tp')}</div><button class="btn btn-soft" data-act="serve" data-ids="${all.map((x) => x.id).join(',')}">提供</button></div>`;
      }).join('');
      return `<div class="cq-card ${k}"><div class="cq-top"><span class="t">${esc(g.t)}</span><span class="wait ${k}">${m}分</span></div>
        <div class="cq-items">${rows}</div>
        <button class="btn btn-lg btn-blue" data-act="serve-all" data-table="${esc(g.t)}">全部提供</button></div>`;
    }).join('');
    const servedRows = blocksOf(S.served)
      .map(
        (b) => `<div class="sv-row"><span class="tm">${hhmm(b.head.servedAt)}</span><span class="tb">${esc(b.head.table)}</span><span class="nm">${esc(b.head.name)} <b>× ${b.head.qty}</b>${b.head.kind === 'entrance' ? ' <span class="tag-in">入場</span>' : ''}${topLines(b, 'tp')}</span></div>`,
      )
      .join('');
    const servedView = S.served.length
      ? `<p class="muted small" style="margin:0 0 8px">提供した順(新しい順)に、直近${S.served.length}件を表示しています。</p><div class="sv-list">${servedRows}</div>`
      : `<div class="empty-big"><b>提供済みの注文はまだありません</b><p class="muted small">提供すると、ここに表示されます。</p></div>`;
    const queueView = list.length
      ? `<p class="summary">未提供 <b>${S.items.length}</b> 品 / ${list.length} 卓</p><div class="cq-grid">${cards}</div>`
      : `<div class="empty-big"><b>未提供の注文はありません</b><p class="muted small">新しい注文が入るとここに表示されます。</p></div>`;
    const c = S.confirm;
    const confirmHtml = c
      ? `<div class="overlay"><div class="modal"><h3>提供しますか?</h3>
          <p style="margin:12px 0;font-size:22px;font-weight:800">${esc(c.title)}</p>
          <p class="muted small">${esc(c.sub)}</p>
          <div class="acts"><button class="btn btn-gray" data-act="confirm-no">キャンセル</button>
          <button class="btn btn-blue" data-act="confirm-yes">提供する</button></div></div></div>`
      : '';
    const tab = (v, label) => `<button class="btn ${S.view === v ? 'btn-blue' : 'btn-ghost'}" data-act="view" data-v="${v}">${label}</button>`;
    const ws = `<span class="ws${S.online ? '' : ' off'}"><i></i>${S.online ? '接続中' : '再接続中…'}</span>`;
    root.innerHTML = `<div class="app"><header class="hdr"><h1>勇志祭 | Cafe</h1><nav class="nav">${ws}
      <button class="btn btn-sm btn-gray" data-act="logout">ログアウト</button></nav></header>
      <main class="main"><div style="display:flex;gap:8px;margin-bottom:14px">${tab('queue', '未提供')}${tab('served', '提供済み')}</div>${S.err ? `<p class="err" style="text-align:center">${esc(S.err)}</p>` : ''}${S.view === 'served' ? servedView : queueView}</main></div>${confirmHtml}`;
  }

  async function refresh() {
    try {
      const q = await api('GET', '/api/cafe/queue');
      S.offset = new Date(q.serverTime).getTime() - Date.now();
      S.warn = q.warnMin;
      S.danger = q.dangerMin;
      const ids = new Set(q.items.map((i) => i.id));
      S.fresh = new Set(S.known ? q.items.filter((i) => !S.known.has(i.id)).map((i) => i.id) : []);
      S.known = ids;
      S.items = q.items;
      if (S.view === 'served') S.served = (await api('GET', '/api/cafe/served')).items;
      S.err = '';
      if (S.fresh.size) setTimeout(() => { S.fresh.clear(); render(); }, 2500);
    } catch (e) {
      if (e.status === 401) {
        store.clear();
        return showLogin('ログインの有効期限が切れました');
      }
      S.err = e.message;
    }
    render();
  }
  let pending = null;
  const schedule = () => { clearTimeout(pending); pending = setTimeout(refresh, 150); };

  async function serve(ids) {
    const r = await Promise.allSettled(ids.map((id) => api('POST', `/api/cafe/items/${id}/serve`)));
    if (r.some((x) => x.status === 'rejected')) toast('提供済みにできなかった品があります');
    refresh();
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'login') return login();
    if (act === 'logout') {
      store.clear();
      Object.assign(S, { items: [], served: [], view: 'queue', confirm: null, known: null, fresh: new Set(), err: '', online: false });
      return showLogin('');
    }
    if (act === 'view') {
      S.view = b.dataset.v;
      S.confirm = null;
      return refresh();
    }
    if (act === 'serve') {
      const ids = String(b.dataset.ids || b.dataset.id || '').split(',').map(Number);
      const its = S.items.filter((i) => ids.includes(i.id));
      if (!its.length) return;
      S.confirm = { ids: its.map((i) => i.id), title: `${its[0].table}:${describe(its)}`, sub: '提供済みにすると、取り消せません。' };
      return render();
    }
    if (act === 'serve-all') {
      const its = S.items.filter((i) => i.table === b.dataset.table);
      if (!its.length) return;
      S.confirm = {
        ids: its.map((i) => i.id),
        title: `${b.dataset.table} の全部(${blocksOf(its).length}品)`,
        sub: `${describe(its)}。提供済みにすると、取り消せません。`,
      };
      return render();
    }
    if (act === 'confirm-no') {
      S.confirm = null;
      return render();
    }
    if (act === 'confirm-yes') {
      const ids = S.confirm ? S.confirm.ids : [];
      S.confirm = null;
      b.disabled = true; // 連打を防ぐ
      render();
      return serve(ids);
    }
  });

  function start() {
    S.known = null;
    refresh();
    if (S.ws) S.ws.close();
    S.ws = connect({
      path: '/ws/staff',
      authMsg: () => ({ type: 'auth', token: store.get() }),
      onStatus: (s) => { S.online = s === 'open'; render(); },
      onOpen: refresh, // 再接続したときも、取り直す
      onMessage: (m) => ['order.created', 'item.served', 'session.changed', 'reset'].includes(m.type) && schedule(),
      onAuthError: () => { store.clear(); showLogin('ログインの有効期限が切れました'); },
    });
  }

  setInterval(() => store.get() && render(), 30000); // 待ち時間の表示を更新
  setInterval(() => store.get() && refresh(), 30000); // 通知が届かなかったときの保険
  if (store.get()) start(); else showLogin();
})();