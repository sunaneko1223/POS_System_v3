'use strict';
// レジ(pos)の画面。流れ: レジ1(卓の選択) → レジ2(お支払い) → レジ3(お会計完了)。レジ4は、取引履歴。
// ログインは、レジのPIN(環境変数 POS_PIN)。見た目の部品は /shared/ui.css と /pos/pos.css。
(() => {
  const { esc, yen, store, api, connect, groupItems, toppingName } = window.YS;
  const root = document.getElementById('app');

  const STATE = { free: ['空き', ''], open: ['使用中', 'badge-blue'], paying: ['会計中', 'badge-orange'] };
  const TITLES = { tables: 'レジ1', pay: 'レジ2', done: 'レジ3', history: 'レジ4' }; // ヘッダーに出す画面の名前
  const DENOMS = [
    [10000, '1万円札'], [5000, '5千円札'], [1000, '千円札'], [500, '500円玉'], [100, '100円玉'],
    [50, '50円玉'], [10, '10円玉'], [5, '5円玉'], [1, '1円玉'],
  ];
  const MAX_DIGITS = 7; // お預かり金額の桁数の上限

  const S = {
    token: store.get(),
    view: 'tables',
    tables: [], loaded: false,
    sel: null, detail: null,
    recv: '', // お預かり金額(数字の文字列)
    done: null, hist: null, q: '',
    modal: null, busy: false, ws: 'closed', error: '', loginErr: '',
  };
  let sock = null;
  let timers = [];
  let loadTimer = null;

  // ---------- 小さな部品 ----------
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
  const p2 = (n) => String(n).padStart(2, '0');
  const fmtAt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  };
  // おつりを、お札・硬貨に分ける(大きいものから)
  function breakdown(change) {
    const out = [];
    let rest = change;
    for (const [v, label] of DENOMS) {
      const n = Math.floor(rest / v);
      if (n > 0) {
        out.push([label, n]);
        rest -= n * v;
      }
    }
    return out;
  }
  // フードと、そのトッピングを、1つのまとまりにする(フードがないトッピングは、単独で出す)
  const blocksOf = (items) => groupItems(items).flatMap((g) => (g.head ? [g] : g.tops.map((t) => ({ head: t, tops: [] }))));
  const tname = (t, b) => toppingName(t.name, b.head.name) + (b.head.qty > 1 ? ` × ${t.qty}` : '');
  const blockSum = (b) => [b.head, ...b.tops].reduce((a, x) => a + x.unitPrice * x.qty, 0);
  const recvNum = () => Number(S.recv || 0);
  // 無料チケット: 1枚で、1人ぶんの入場料が無料。枚数は、卓が作られた時刻ごとに覚える(同じ卓の次のお客様に、引き継がない)
  // 無料チケット: 枚数はサーバーに保存してある(「適用」で保存。リロードや別の端末でも消えない)
  const tkCount = (d) => d.total.freeTickets || 0;
  const tkDiscount = (d) => d.total.discount || 0;
  const totalOf = (d) => d.total.total; // サーバーが、無料チケットを引いて計算した合計
  const stateRank = { paying: 0, open: 1, free: 2 };
  // 会計できる卓: 会計中と、使用中(お客様が会計ボタンを押していなくても、レジから会計できる)
  const payable = (d) => !!d && (d.state === 'paying' || d.state === 'open');
  const sortedTables = () => S.tables.map((t, i) => [t, i]).sort((a, b) => stateRank[a[0].state] - stateRank[b[0].state] || a[1] - b[1]).map((x) => x[0]);

  // ---------- 通信 ----------
  async function call(method, path, body) {
    try {
      return await api(method, path, { token: S.token, body });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        logout('ログインの有効期限が切れました。もう一度ログインしてください。');
        e.silent = true;
      }
      throw e;
    }
  }
  async function loadTables() {
    S.tables = (await call('GET', '/api/pos/tables')).tables;
    S.loaded = true;
  }
  async function loadDetail() {
    if (!S.sel) return;
    const d = await call('GET', `/api/pos/tables/${encodeURIComponent(S.sel)}`);
    if (d.state === 'free') {
      if (S.view === 'pay') toast(`卓 ${S.sel} は、もう空きです`);
      S.sel = null;
      S.detail = null;
      if (S.view === 'pay') S.view = 'tables';
    } else {
      S.detail = d;
      if (S.view === 'pay' && !payable(d)) {
        toast(`卓 ${d.table} は、会計中ではなくなりました`);
        S.view = 'tables';
      }
    }
  }
  async function loadHistory() {
    S.hist = await call('GET', '/api/pos/history');
  }
  async function load() {
    if (!S.token) return;
    try {
      await loadTables();
      if (S.sel && (S.view === 'tables' || S.view === 'pay')) await loadDetail();
      if (S.view === 'history') await loadHistory();
      S.error = '';
    } catch (e) {
      if (!e.silent) S.error = e.message;
    }
    render();
  }
  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(load, 150);
  }

  // ---------- ログイン・ログアウト ----------
  function stop() {
    if (sock) sock.close();
    sock = null;
    timers.forEach(clearInterval);
    timers = [];
  }
  function start() {
    stop();
    sock = connect({
      path: '/ws/staff',
      authMsg: () => ({ type: 'auth', token: S.token }),
      onStatus: (s) => {
        S.ws = s;
        if (S.token) render(); // ログアウトのあとの通信の切れでは、ログイン画面を作り直さない
      },
      onOpen: load,
      onMessage: (m) => {
        if (['order.created', 'item.served', 'session.changed', 'menu.changed', 'reset'].includes(m.type)) scheduleLoad();
      },
      onAuthError: () => logout('ログインの有効期限が切れました。もう一度ログインしてください。'),
    });
    // 通知が届かなかったときの保険: 30秒ごとに取り直す
    timers.push(setInterval(load, 30000));
    load();
  }
  function logout(msg) {
    store.clear();
    stop();
    Object.assign(S, { token: null, view: 'tables', tables: [], loaded: false, sel: null, detail: null, recv: '', done: null, hist: null, q: '', modal: null, busy: false, loginErr: typeof msg === 'string' ? msg : '' });
    render();
  }
  async function login() {
    const el = document.getElementById('pin');
    const pin = el ? el.value : '';
    if (!pin) {
      S.loginErr = 'PINを入力してください';
      return render();
    }
    S.busy = true;
    S.loginErr = '';
    render();
    try {
      const r = await api('POST', '/api/auth/login', { body: { pin, role: 'pos' } });
      S.token = r.token;
      store.set(r.token, r.expiresAt);
      S.busy = false;
      start();
      return;
    } catch (e) {
      S.loginErr = e.message;
    }
    S.busy = false;
    render();
  }

  // ---------- 画面の部品 ----------
  function header() {
    const ws = `<span class="ws${S.ws === 'open' ? '' : ' off'}"><i></i>${S.ws === 'open' ? '接続中' : '再接続中…'}</span>`;
    // 取引履歴 / 戻る(お会計完了の画面には、置かない。「次の会計へ」で進む)
    const mid = {
      tables: '<button class="btn btn-sm btn-indigo" data-act="history">取引履歴</button>',
      pay: '<button class="btn btn-sm btn-red" data-act="back">戻る</button>',
      history: '<button class="btn btn-sm btn-indigo" data-act="back">戻る</button>',
    }[S.view] || '';
    return `<header class="hdr"><h1>勇志祭 | POS：${TITLES[S.view]}</h1><nav class="nav">${ws}${mid}
      <button class="btn btn-sm btn-gray" data-act="logout" ${S.busy ? 'disabled' : ''}>ログアウト</button></nav></header>`;
  }

  // 卓の注文内容(右のパネル)
  function panelHtml() {
    const d = S.detail;
    if (!S.sel) return '<div class="empty">卓を選ぶと、注文内容が出ます</div>';
    if (!d) return '<div class="empty">読み込み中…</div>';
    const lines = blocksOf(d.items.filter((i) => i.category !== 'game'))
      .map((b) => {
        const served = [b.head, ...b.tops].every((x) => x.status === 'served');
        return `<div class="line"><div><div class="nm">${esc(b.head.name)} × ${b.head.qty}</div>
          ${b.tops.map((t) => `<div class="tp">・${esc(tname(t, b))}</div>`).join('')}
          <div class="sub">${b.head.kind === 'entrance' ? '入場料に含む' : yen(blockSum(b))}</div></div>
          <span class="badge ${served ? 'badge-green' : 'badge-orange'}">${served ? '提供済み' : '未提供'}</span></div>`;
      })
      .join('');
    const games = d.items.filter((i) => i.category === 'game');
    const gameLines = games
      .map((i) => `<div class="line"><div><div class="nm">${esc(i.name)} × ${i.qty}</div><div class="sub">${yen(i.unitPrice * i.qty)}</div></div></div>`)
      .join('');
    const paying = payable(d);
    const unserved = d.unserved || [];
    const warn = paying && unserved.length
      ? `<div class="note">未提供の品目があります(${unserved.map((i) => `${esc(i.name)}×${i.qty}`).join('、')})。お支払いの前に、お客様に確認してください。</div>`
      : '';
    return `<div class="line" style="border-top:1px solid var(--line)"><div><div class="nm">入場料 × ${d.people}名</div></div><span>${yen(d.total.entranceFee)}</span></div>
      ${tkCount(d) ? `<div class="line"><div><div class="nm">無料チケット × ${tkCount(d)}枚</div></div><span>−${yen(tkDiscount(d))}</span></div>` : ''}
      <div class="lines">${lines}${gameLines}</div>
      <div class="sum"><span>合計</span><span class="yen">${yen(totalOf(d))}</span></div>${warn}
      <button class="btn btn-lg btn-yellow" style="margin-bottom:10px" data-act="tkOpen" ${paying ? '' : 'disabled'}>無料チケット</button>
      <button class="btn btn-lg btn-green" data-act="goPay" ${paying ? '' : 'disabled'}>会計へ進む</button>
      ${d.state === 'open' ? '<p class="muted small" style="margin:10px 0 0;text-align:center">お客様は、まだ会計ボタンを押していません(このまま会計できます)。</p>' : ''}`;
  }

  function viewTables() {
    if (!S.loaded) return '<p class="muted">読み込み中…</p>';
    const cards = sortedTables()
      .map((t) => {
        const [label, cls] = STATE[t.state] || [t.state, ''];
        const info = t.state === 'free' ? '' : `${t.people}名 ・ ${yen(t.total)}${t.unserved ? ` ・ 未提供 ${t.unserved}品` : ''}`;
        return `<div class="tcard ${esc(t.state)}${S.sel === t.table ? ' sel' : ''}" data-act="pick" data-t="${esc(t.table)}">
          <div class="tname">${esc(t.table)}</div><span class="badge ${cls}">${label}</span><div class="tinfo">${esc(info)}</div></div>`;
      })
      .join('');
    return `<div class="split"><div><div class="grid">${cards || '<p class="muted">卓がありません</p>'}</div></div>
      <aside class="panel card"><p class="sec-title">ご注文内容${S.sel ? `(卓 ${esc(S.sel)})` : ''}</p>${panelHtml()}</aside></div>`;
  }

  function viewPay() {
    const d = S.detail;
    if (!d) return '<p class="muted">読み込み中…</p>';
    const total = totalOf(d);
    const got = recvNum();
    const enough = got >= total;
    const change = enough ? got - total : 0;
    const k = (v) => `<button class="key" data-act="key" data-k="${v}">${v}</button>`;
    const unserved = d.unserved || [];
    const warn = unserved.length
      ? `<div class="note">未提供の品目があります(${unserved.map((i) => `${esc(i.name)}×${i.qty}`).join('、')})。会計すると、これらは提供済みになります。</div>`
      : '';
    return `${warn}<div class="pay"><div class="amounts">
        <p class="pay-table">卓 ${esc(d.table)} ・ ${d.people}名</p>
        ${tkCount(d) ? `<p class="muted small" style="margin:-6px 0 12px">無料チケット × ${tkCount(d)}枚(−${yen(tkDiscount(d))})</p>` : ''}
        <div class="amt-label">お支払い金額</div><div class="amt">${yen(total)}</div>
        <div class="amt-label">お預かり金額</div><div class="amt blue">${yen(got)}</div>
        <div class="amt-label">おつり</div><div class="amt green">${yen(change)}</div>
        <div class="short">${got > 0 && !enough ? `あと ${yen(total - got)} 足りません` : ''}</div></div>
      <div><div class="keypad">${k(7)}${k(8)}${k(9)}${k(4)}${k(5)}${k(6)}${k(1)}${k(2)}${k(3)}${k(0)}
        <button class="key bs" data-act="bs" aria-label="1文字消す">⌫</button><button class="key clr" data-act="clr">C</button></div>
        <button class="btn btn-lg btn-green" data-act="confirm" ${enough && !S.busy ? '' : 'disabled'}>${S.busy ? '会計中…' : '会計確定'}</button></div></div>`;
  }

  function viewDone() {
    const r = S.done;
    if (!r) return '';
    const bd = r.change > 0 ? breakdown(r.change) : [];
    const change = bd.length
      ? bd.map(([l, n]) => `<div class="l"><span>${l}</span><span>× ${n}</span></div>`).join('')
      : '<div class="none">おつりなし</div>';
    const items = blocksOf(r.items)
      .map(
        (b) =>
          `<div class="l"><span>${esc(b.head.name)} ×${b.head.qty}</span><span>${b.head.kind === 'entrance' ? '入場料に含む' : yen(blockSum(b))}</span></div>` +
          b.tops.map((t) => `<div class="l tp"><span>・${esc(tname(t, b))}</span><span></span></div>`).join(''),
      )
      .join('');
    return `<div class="done"><div class="big-label">卓番号</div><div class="big-no">${esc(r.table)}</div>
      <div class="big-label">おつり合計</div><div class="big-amt">${yen(r.change > 0 ? r.change : 0)}</div>
      <p class="muted small" style="margin:6px 0 0">お預かり ${yen(r.received)} ・ 合計 ${yen(r.total)}</p>
      <div class="cols"><div><h3>おつり内訳</h3><div class="box">${change}</div></div>
        <div><h3>ご購入内容</h3><div class="box"><div class="l"><span>入場料 ×${r.people}名</span><span>${yen(r.entranceFee)}</span></div>${r.freeTickets ? `<div class="l"><span>無料チケット × ${r.freeTickets}枚</span><span>−${yen(r.discount)}</span></div>` : ''}${items}</div></div></div>
      <button class="btn btn-lg btn-blue" data-act="next">次の会計へ</button></div>`;
  }

  function viewHistory() {
    if (!S.hist) return '<p class="muted">読み込み中…</p>';
    const h = S.hist;
    const q = S.q.trim().toLowerCase();
    const list = h.sales.filter((s) => !q || s.table.toLowerCase().includes(q));
    const cards = list
      .map((s) => {
        const lines = [`<div class="li">入場料 ×${s.people}名 (${yen(s.entranceFee)})</div>`]
          .concat(s.freeTickets ? [`<div class="li">無料チケット × ${s.freeTickets}枚(−${yen(s.freeTicketDiscount)})</div>`] : [])
          .concat(
            blocksOf(s.items).map(
              (b) =>
                `<div class="li">${esc(b.head.name)} ×${b.head.qty} (${b.head.kind === 'entrance' ? '入場料に含む' : yen(b.head.unitPrice)})</div>` +
                b.tops.map((t) => `<div class="li tp">・${esc(tname(t, b))}</div>`).join(''),
            ),
          )
          .join('');
        // 上の行: 左に卓番号、右に合計金額。そのあと日時・購入内容。右下に預り・おつり
        const money = s.received === null ? '' : `預り: ${yen(s.received)}${s.change === null ? '' : ` / おつり: ${yen(s.change)}`}`;
        return `<div class="sale"><div class="top"><b class="tb">卓 ${esc(s.table)}</b><span class="sale-amt">${yen(s.total)}</span></div>
          <div class="at">${fmtAt(s.closedAt)}</div>${lines}${money ? `<div class="foot2">${money}</div>` : ''}</div>`;
      })
      .join('');
    const empty = h.sales.length ? '<p class="muted">該当する取引がありません。</p>' : '<p class="muted">まだ取引がありません。</p>';
    return `<div class="field" style="margin-bottom:14px"><input id="q" class="input" placeholder="卓番号で検索" value="${esc(S.q)}" autocomplete="off"></div>
      <section class="card"><p class="sec-title">売上集計</p><div class="stats">
        <div>総売上: <b class="ok">${yen(h.summary.totalSales)}</b></div><div>取引件数: <b>${h.summary.count} 件</b></div>
        <div>割引合計: <b class="neg">−${yen(h.summary.freeTicketDiscount || 0)}</b></div><div>無料チケット使用数: <b>${h.summary.freeTicketCount || 0} 枚</b></div></div></section>
      ${cards || empty}${h.shown < h.summary.count ? `<p class="muted small">新しい順に、直近${h.shown}件を表示しています。</p>` : ''}`;
  }

  function modalHtml() {
    const m = S.modal;
    if (!m) return '';
    if (m.type === 'unserved') {
      return `<div class="overlay"><div class="modal"><h3>未提供の品目があります</h3>
        <p>${m.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('、')}</p>
        <p class="muted small">お客様に、提供済みか確認しましたか。会計すると、これらは提供済みになります。</p>
        <div class="acts"><button class="btn btn-gray" data-act="modalNo">戻る</button>
        <button class="btn btn-green" data-act="modalYes" ${S.busy ? 'disabled' : ''}>確認して会計</button></div></div></div>`;
    }
    if (m.type === 'force') {
      const d = S.detail;
      if (!d) return '';
      return `<div class="overlay"><div class="modal"><h3>会計に進みますか?</h3>
        <p>卓 ${esc(d.table)} のお客様は、まだ会計ボタンを押していません。</p>
        <p class="muted small">レジで会計すると、お客様は追加の注文ができなくなります。</p>
        <div class="acts"><button class="btn btn-gray" data-act="modalNo">戻る</button>
        <button class="btn btn-green" data-act="forceYes">会計へ進む</button></div></div></div>`;
    }
    if (m.type === 'ticket') {
      const d = S.detail;
      if (!d) return '';
      const per = d.total.entranceFee / d.people;
      const btns = Array.from({ length: d.people + 1 }, (_, i) => `<button class="${i === m.n ? 'on' : ''}" data-act="tkPick" data-n="${i}">${i}名</button>`).join('');
      return `<div class="overlay"><div class="modal"><h3>無料チケット</h3>
        <p>無料チケットを使う人数を選んでください(1枚で、1名ぶんの入場料 ${yen(per)} が無料)。</p>
        <div class="seg">${btns}</div>
        <p class="small">${m.n > 0 ? `${m.n}名 × ${yen(per)} = −${yen(per * m.n)}` : '使わない'}</p>
        <div class="acts"><button class="btn btn-gray" data-act="modalNo">戻る</button>
        <button class="btn btn-green" data-act="tkApply" ${S.busy ? 'disabled' : ''}>適用</button></div></div></div>`;
    }
    return '';
  }

  function viewLogin() {
    return `<div class="app"><header class="hdr"><h1>レジ</h1></header><div class="center"><div class="card">
      <div class="field"><label for="pin">レジのPIN</label>
        <input id="pin" class="input" type="password" autocomplete="off" autocapitalize="off" placeholder="PINを入力"></div>
      ${S.loginErr ? `<p class="err">${esc(S.loginErr)}</p>` : ''}
      <div style="height:16px"></div>
      <button class="btn btn-lg btn-blue" data-act="login" ${S.busy ? 'disabled' : ''}>${S.busy ? '確認中…' : 'ログイン'}</button></div></div></div>`;
  }

  function render() {
    if (!S.token) {
      root.innerHTML = viewLogin();
      return;
    }
    // 検索欄に入力中は、画面を作り直しても、入力の位置を保つ
    const a = document.activeElement;
    const keepQ = a && a.id === 'q';
    const caret = keepQ ? a.selectionStart : null;
    const main = { tables: viewTables, pay: viewPay, done: viewDone, history: viewHistory }[S.view]();
    root.innerHTML = `<div class="app">${header()}<main class="main">${S.error ? `<p class="err">通信エラー: ${esc(S.error)}</p>` : ''}${main}</main></div>${modalHtml()}`;
    if (keepQ) {
      const el = document.getElementById('q');
      if (el) {
        el.focus();
        if (caret !== null && el.setSelectionRange) el.setSelectionRange(caret, caret);
      }
    }
  }

  // ---------- 操作 ----------
  async function doCheckout(force) {
    const d = S.detail;
    if (!d || S.busy) return;
    const received = recvNum();
    S.busy = true;
    render();
    try {
      const body = { received }; // 無料チケットは、サーバーに保存した枚数を使う
      if (d.state === 'open') body.force = true; // お客様が会計ボタンを押していない卓
      if (force) body.confirmUnserved = true;
      const r = await call('POST', `/api/pos/tables/${encodeURIComponent(d.table)}/checkout`, body);
      S.modal = null;
      S.done = {
        table: d.table, people: d.people, items: d.items.filter((i) => i.category !== 'game' || i.unitPrice > 0),
        entranceFee: d.total.entranceFee, freeTickets: r.freeTickets || 0, discount: r.discount || 0,
        total: r.total, received: r.received ?? received,
        change: r.change ?? (r.received ?? received) - r.total,
      };
      S.view = 'done';
      S.sel = null;
      S.detail = null;
      S.recv = '';
      try { await loadTables(); } catch (e) { /* 一覧は、あとで更新される */ }
    } catch (e) {
      if (!e.silent) {
        if (e.code === 'unserved_items') {
          S.modal = { type: 'unserved', items: (e.data && e.data.items) || d.unserved || [] };
        } else if (e.code === 'not_paying' || e.code === 'table_free') {
          S.modal = null;
          toast(e.message);
          S.view = 'tables';
          S.busy = false;
          await load();
          return;
        } else {
          S.modal = null;
          toast(e.message);
        }
      }
    }
    S.busy = false;
    render();
  }

  function key(k) {
    if (S.view !== 'pay' || S.busy) return;
    if (k === 'bs') S.recv = S.recv.slice(0, -1);
    else if (k === 'clr') S.recv = '';
    else if (S.recv.length < MAX_DIGITS) S.recv = (S.recv + k).replace(/^0+(?=\d)/, '');
    render();
  }
  function confirmPay() {
    const d = S.detail;
    if (!d || S.busy || recvNum() < totalOf(d)) return;
    if (d.unserved && d.unserved.length) {
      S.modal = { type: 'unserved', items: d.unserved };
      return render();
    }
    return doCheckout(false);
  }

  const ACT = {
    login,
    logout: () => logout(''),
    async pick(d) {
      const t = S.tables.find((x) => x.table === d.t);
      if (!t) return;
      if (t.state === 'free') return toast(`卓 ${t.table} は、空き卓です`);
      S.sel = t.table;
      S.detail = null;
      render();
      try {
        await loadDetail();
      } catch (e) {
        if (!e.silent) toast(e.message);
      }
      render();
    },
    goPay() {
      if (!payable(S.detail)) return;
      // お客様が会計ボタンを押していない卓は、確認してから進む
      if (S.detail.state === 'open') {
        S.modal = { type: 'force' };
        return render();
      }
      S.view = 'pay';
      S.recv = '';
      render();
    },
    forceYes() {
      if (!payable(S.detail)) return;
      S.modal = null;
      S.view = 'pay';
      S.recv = '';
      render();
    },
    back() {
      S.view = 'tables';
      S.modal = null;
      render();
      load();
    },
    key: (d) => key(d.k),
    bs: () => key('bs'),
    clr: () => key('clr'),
    confirm: confirmPay,
    tkOpen() {
      const d = S.detail;
      if (!payable(d)) return;
      S.modal = { type: 'ticket', n: tkCount(d) };
      render();
    },
    tkPick(d) {
      if (!S.modal || S.modal.type !== 'ticket') return;
      S.modal.n = Number(d.n);
      render();
    },
    // 無料チケットを適用する: 枚数をサーバーに保存する(お客様の画面にも、すぐ反映される)
    async tkApply() {
      const d = S.detail;
      if (!d || S.busy || !S.modal || S.modal.type !== 'ticket') return;
      const n = Math.max(0, Math.min(S.modal.n, d.people));
      S.busy = true;
      render();
      try {
        await call('POST', `/api/pos/tables/${encodeURIComponent(d.table)}/tickets`, { freeTickets: n });
        S.modal = null;
        await loadDetail(); // 新しい合計を取り直す
        toast(n > 0 ? `無料チケット ${n}枚を適用しました` : '無料チケットを外しました');
      } catch (e) {
        if (!e.silent) toast(e.message);
      }
      S.busy = false;
      render();
    },
    modalNo() {
      S.modal = null;
      render();
    },
    modalYes: () => doCheckout(true),
    next() {
      S.view = 'tables';
      S.done = null;
      render();
      load();
    },
    async history() {
      S.view = 'history';
      S.q = '';
      S.hist = null;
      render();
      try {
        await loadHistory();
      } catch (e) {
        if (!e.silent) toast(e.message);
      }
      render();
    },
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = ACT[b.dataset.act];
    if (fn) fn(b.dataset);
  });
  root.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      S.q = e.target.value;
      render();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pin') login();
  });
  // パソコンのキーボードでも、数字を入れられる(お支払いの画面だけ)
  document.addEventListener('keydown', (e) => {
    if (!S.token || S.view !== 'pay' || S.modal) return;
    if (/^\d$/.test(e.key)) key(e.key);
    else if (e.key === 'Backspace') key('bs');
    else if (e.key === 'Enter') confirmPay();
  });

  // ---------- 起動 ----------
  if (S.token) start();
  else render();
})();