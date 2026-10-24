'use strict';
// 管理者画面(Admin)。商品の管理・卓の操作・QR・データを扱う。
// ログインは、管理者のPIN(環境変数 ADMIN_PIN)。見た目の部品は /shared/ui.css。
(() => {
  const { esc, yen, store, api } = window.YS;
  const root = document.getElementById('app');

  const CATS = [
    ['drink', 'ドリンク'],
    ['food', 'フード'],
    ['game', '追加ゲーム'],
  ];
  const TITLES = { menu: '商品管理', tables: '卓の操作', qr: 'QR', data: 'データ' };
  const STATE = { free: ['空き', ''], open: ['使用中', 'badge-blue'], paying: ['会計中', 'badge-orange'] };

  const S = {
    token: store.get(),
    view: 'menu',
    menu: [],
    tables: [],
    qr: {}, // 卓名 → { svg }
    loading: false,
    add: { category: 'drink', name: '', price: '', games: '1', toppings: '', err: '' },
    modal: null, // { type, ..., err }
    busy: false,
    loginErr: '',
  };

  // ---------- 通知(画面の作り直しで消えないよう、別の場所に置く) ----------
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
    toastTimer = setTimeout(() => toastEl.classList.add('hide'), 2600);
  }

  // ---------- 通信 ----------
  // ログインが切れていたら、ログイン画面に戻す
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

  function logout(msg) {
    store.clear();
    S.token = null;
    S.modal = null;
    S.loginErr = msg || '';
    S.view = 'menu';
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
      const r = await api('POST', '/api/admin/login', { body: { pin } });
      S.token = r.token;
      store.set(r.token, r.expiresAt);
      S.view = 'menu';
      await loadMenu();
    } catch (e) {
      S.loginErr = e.message;
    }
    S.busy = false;
    render();
  }

  async function loadMenu() {
    S.menu = (await call('GET', '/api/admin/menu')).items;
  }
  async function loadTables() {
    S.tables = (await call('GET', '/api/pos/tables')).tables;
  }
  async function loadQr() {
    await loadTables();
    const list = await Promise.all(
      S.tables.map((t) =>
        call('GET', `/api/admin/tables/${encodeURIComponent(t.table)}/qr`).then((r) => [t.table, r.svg]),
      ),
    );
    S.qr = {};
    for (const [name, svg] of list) S.qr[name] = svg;
  }

  // 読み込みつきで、画面を切り替える
  async function show(view) {
    S.view = view;
    S.modal = null;
    S.loading = view !== 'data';
    render();
    try {
      if (view === 'menu') await loadMenu();
      if (view === 'tables') await loadTables();
      if (view === 'qr') await loadQr();
    } catch (e) {
      if (!e.silent) toast(e.message);
    }
    S.loading = false;
    render();
  }

  // ---------- 画面 ----------
  function header() {
    return `<header class="hdr"><h1>勇志祭 | Admin：${esc(TITLES[S.view])}</h1><nav class="nav">
      <button class="btn btn-sm btn-blue" data-act="go" data-v="menu">商品管理</button>
      <button class="btn btn-sm btn-lime" data-act="go" data-v="tables">卓の操作</button>
      <button class="btn btn-sm btn-purple" data-act="go" data-v="qr">QR</button>
      <button class="btn btn-sm btn-indigo" data-act="go" data-v="data">データ</button>
      <button class="btn btn-sm btn-gray" data-act="logout">ログアウト</button></nav></header>`;
  }

  function viewLogin() {
    return `<div class="app"><header class="hdr"><h1>Admin</h1></header>
      <div class="center"><div class="card">
        <div class="field"><label for="pin">管理者のPIN</label>
          <input id="pin" class="input" type="password" autocomplete="off" autocapitalize="off" placeholder="PINを入力"></div>
        ${S.loginErr ? `<p class="err">${esc(S.loginErr)}</p>` : ''}
        <div style="height:16px"></div>
        <button class="btn btn-lg btn-blue" data-act="login" ${S.busy ? 'disabled' : ''}>${S.busy ? '確認中…' : 'ログイン'}</button>
      </div></div></div>`;
  }

  // ----- 商品管理 -----
  function viewMenu() {
    const a = S.add;
    const typeField = `<div class="field"><label for="at">商品タイプ</label><select id="at" class="input">
      ${CATS.map(([k, l]) => `<option value="${k}"${a.category === k ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`;
    const toppingField =
      a.category === 'food'
        ? `<div class="field"><label for="atop">トッピング(カンマで区切る)</label>
            <input id="atop" class="input" placeholder="例: マヨネーズ, ソース, 青のり" value="${esc(a.toppings)}"></div>`
        : '';
    const gamesField =
      a.category === 'game'
        ? `<div class="field"><label for="ag">ゲーム回数(1つ買うと増える回数)</label>
            <input id="ag" class="input" inputmode="numeric" value="${esc(a.games)}"></div>`
        : '';
    const form = `<section class="card"><p class="sec-title">新しい商品を追加</p>
      <div class="form-row">
        ${typeField}
        <div class="field"><label for="an">名前</label><input id="an" class="input" maxlength="30" value="${esc(a.name)}"></div>
        ${toppingField}
        <div class="field"><label for="ap">値段(円)</label><input id="ap" class="input" inputmode="numeric" value="${esc(a.price)}"></div>
        ${gamesField}
        <button class="btn btn-blue" data-act="add" ${S.busy ? 'disabled' : ''}>追加</button>
      </div>
      ${a.err ? `<p class="err">${esc(a.err)}</p>` : ''}
      <p class="muted small" style="margin:10px 0 0">追加した商品は、すぐに販売中になります。トッピングは、フードにだけ付けられます(値段はかかりません)。</p></section>`;

    if (S.loading && !S.menu.length) return form + '<p class="muted">読み込み中…</p>';
    const groups = CATS.map(([k, l]) => {
      const items = S.menu.filter((m) => m.category === k);
      if (!items.length) return '';
      const rows = items
        .map((m) => {
          const sub = [yen(m.price)];
          if (m.category === 'game') sub.push(`${m.games}回ぶん`);
          const tops =
            m.category === 'food' && m.toppings && m.toppings.length
              ? `<div class="sub">トッピング: ${m.toppings.map((t) => esc(t)).join(' ・ ')}</div>`
              : '';
          return `<div class="row${m.onSale ? '' : ' off'}"><div>
            <div class="name">${esc(m.name)} ${m.onSale ? '' : '<span class="badge">販売終了</span>'}</div>
            <div class="sub">${sub.join(' ・ ')}</div>${tops}</div>
            <div class="acts"><button class="btn btn-sm btn-blue" data-act="edit" data-id="${esc(m.id)}">編集</button>
            <button class="btn btn-sm btn-red" data-act="del" data-id="${esc(m.id)}">削除</button></div></div>`;
        })
        .join('');
      return `<p class="sec-head">${l}(${items.length})</p>${rows}`;
    }).join('');
    return form + `<p class="sec-head" style="margin-top:6px">登録済み商品リスト</p>` + (groups || '<p class="muted">商品がありません。</p>');
  }

  // ----- 卓の操作 -----
  function tableCard(t, extra) {
    const [label, cls] = STATE[t.state] || [t.state, ''];
    const info =
      t.state === 'free'
        ? ''
        : `${t.people}名 ・ ${yen(t.total)}${t.unserved ? ` ・ 未提供 ${t.unserved}品` : ''}`;
    return `<div class="tcard ${t.state === 'free' ? '' : esc(t.state)}"><div class="tname">${esc(t.table)}</div>
      <span class="badge ${cls}">${label}</span><div class="tinfo">${esc(info)}</div>${extra || ''}</div>`;
  }
  function viewTables() {
    const bar = `<div class="bar"><span class="muted small">10秒ごとに自動で更新されます</span>
      <button class="btn btn-sm btn-gray" data-act="reload">更新</button></div>`;
    if (S.loading && !S.tables.length) return bar + '<p class="muted">読み込み中…</p>';
    const cards = S.tables
      .map((t) =>
        tableCard(
          t,
          t.state === 'paying'
            ? `<button class="btn btn-sm btn-yellow" data-act="reopen" data-id="${esc(t.table)}">使用中に戻す</button>`
            : '',
        ),
      )
      .join('');
    return (
      bar +
      `<div class="note">「使用中に戻す」は、お客様が会計ボタンを間違えて押したときに使います。戻すと、お客様は、また注文できます。</div>` +
      `<div class="grid">${cards}</div>`
    );
  }

  // ----- QR -----
  function viewQr() {
    if (S.loading && !Object.keys(S.qr).length) return '<p class="muted">読み込み中…</p>';
    const cards = S.tables
      .map((t) => {
        const free = t.state === 'free';
        const svg = S.qr[t.table] || '';
        return tableCard(
          t,
          `${svg}<button class="btn btn-sm btn-blue" data-act="png" data-id="${esc(t.table)}">画像保存</button>
           <button class="btn btn-sm btn-red" data-act="rotate" data-id="${esc(t.table)}" ${free ? '' : 'disabled'}>再発行</button>
           ${free ? '' : '<div class="muted small">使用中の卓は、再発行できません</div>'}`,
        );
      })
      .join('');
    return (
      `<div class="note">QRコードには、卓ごとの鍵が入っています。<b>お客様以外に、見せないでください。</b>「再発行」をすると、古いQRコードは使えなくなります(印刷し直して、貼り替えてください)。</div>` +
      `<div class="grid">${cards}</div>`
    );
  }

  // ----- データ -----
  function viewData() {
    return `<section class="card danger"><p class="sec-title">注文データの削除</p>
      <p style="margin:0 0 12px">すべての<b>注文・会計の記録</b>を削除します。<b>元に戻せません。</b><br>
      商品(メニュー)・卓・QRコードは、消えません。</p>
      <p class="muted small" style="margin:0 0 14px">本番の前に、試験で作ったデータを消すときに使います。営業中は、押さないでください。</p>
      <button class="btn btn-red" data-act="resetOpen">全て削除する…</button></section>`;
  }

  // ----- 確認の画面(モーダル) -----
  function modalHtml() {
    const m = S.modal;
    if (!m) return '';
    const err = m.err ? `<p class="err">${esc(m.err)}</p>` : '';
    let body = '';
    if (m.type === 'edit') {
      body = `<h3>商品を編集</h3>
        <div class="field"><label for="en">商品名</label><input id="en" class="input" maxlength="30" value="${esc(m.name)}"></div>
        <div class="field"><label for="ep">値段(円)</label><input id="ep" class="input" inputmode="numeric" value="${esc(m.price)}"></div>
        ${m.category === 'food' ? `<div class="field"><label for="etop">トッピング(カンマで区切る)</label><input id="etop" class="input" placeholder="例: マヨネーズ, ソース" value="${esc(m.toppings)}"></div>` : ''}
        <div class="field"><label>販売の状態</label><div class="seg" style="grid-template-columns:1fr 1fr;margin:0">
          <button class="${m.onSale ? 'on' : ''}" data-act="sale" data-v="1">販売中</button>
          <button class="${m.onSale ? '' : 'on'}" data-act="sale" data-v="0">販売終了</button></div></div>
        ${err}<div class="acts"><button class="btn btn-gray" data-act="close">キャンセル</button>
        <button class="btn btn-blue" data-act="saveEdit" ${S.busy ? 'disabled' : ''}>保存</button></div>`;
    } else if (m.type === 'delete') {
      body = `<h3>「${esc(m.name)}」を削除</h3>
        <p>削除すると、元に戻せません。</p>
        <p class="muted small">一度でも注文された商品は、削除できません(その場合は、「販売終了」にしてください)。</p>
        ${err}<div class="acts"><button class="btn btn-gray" data-act="close">キャンセル</button>
        <button class="btn btn-red" data-act="doDelete" ${S.busy ? 'disabled' : ''}>削除する</button></div>
        ${m.canOff ? '<div class="acts one"><button class="btn btn-yellow" data-act="offSale">代わりに、販売終了にする</button></div>' : ''}`;
    } else if (m.type === 'reopen') {
      body = `<h3>卓 ${esc(m.table)} を、使用中に戻す</h3>
        <p>お客様が、また注文できるようになります。</p>
        ${err}<div class="acts"><button class="btn btn-gray" data-act="close">キャンセル</button>
        <button class="btn btn-yellow" data-act="doReopen" ${S.busy ? 'disabled' : ''}>戻す</button></div>`;
    } else if (m.type === 'rotate') {
      body = `<h3>卓 ${esc(m.table)} のQRを再発行</h3>
        <p>古いQRコードは、<b>使えなくなります</b>。印刷し直して、貼り替えてください。</p>
        ${err}<div class="acts"><button class="btn btn-gray" data-act="close">キャンセル</button>
        <button class="btn btn-red" data-act="doRotate" ${S.busy ? 'disabled' : ''}>再発行する</button></div>`;
    } else if (m.type === 'reset') {
      body = `<h3>注文データを、すべて削除</h3>
        <p>注文・会計の記録が、<b>すべて消えます。元に戻せません。</b></p>
        <div class="field"><label for="rc">確認のため、「リセット」と入力してください</label>
          <input id="rc" class="input" autocomplete="off" placeholder="リセット"></div>
        ${err}<div class="acts"><button class="btn btn-gray" data-act="close">キャンセル</button>
        <button id="doReset" class="btn btn-red" data-act="doReset" disabled>削除する</button></div>`;
    }
    return `<div class="overlay"><div class="modal">${body}</div></div>`;
  }

  function render() {
    if (!S.token) {
      root.innerHTML = viewLogin();
      return;
    }
    const body = { menu: viewMenu, tables: viewTables, qr: viewQr, data: viewData }[S.view]();
    root.innerHTML = `<div class="app">${header()}<main class="main">${body}</main></div>${modalHtml()}`;
  }

  // ---------- 操作 ----------
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : null;
  };
  // 画面を作り直しても、入力が消えないように、いまの入力を取り込む
  function captureAdd() {
    const a = S.add;
    const n = val('an'), p = val('ap'), g = val('ag'), t = val('atop');
    if (n !== null) a.name = n;
    if (p !== null) a.price = p;
    if (g !== null) a.games = g;
    if (t !== null) a.toppings = t;
  }
  function captureEdit() {
    const n = val('en'), p = val('ep'), t = val('etop');
    if (n !== null) S.modal.name = n;
    if (p !== null) S.modal.price = p;
    if (t !== null) S.modal.toppings = t;
  }
  const findItem = (id) => S.menu.find((m) => m.id === id);
  // 「マヨ, ソース」のような入力を、名前の配列にする(区切りは「,」「、」「,」と改行。空と重複は除く)
  function parseToppings(text) {
    const out = [];
    for (const raw of String(text || '').split(/[,、，\n]/)) {
      const n = raw.trim();
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }
  // 入力のエラー(なければ空)。サーバーと同じ上限
  const toppingError = (list) =>
    list.length > 20 ? 'トッピングは、20個までです' : list.some((n) => n.length > 30) ? 'トッピング名は、30文字以内にしてください' : '';

  // 通信を伴う操作は、二重に押されないようにする
  async function guarded(fn) {
    if (S.busy) return;
    S.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      if (!e.silent && S.modal) S.modal.err = e.message;
      else if (!e.silent) toast(e.message);
    }
    S.busy = false;
    render();
  }

  const ACT = {
    login,
    logout: () => logout(''),
    go: (d) => show(d.v),
    close() {
      S.modal = null;
      render();
    },
    reload: () => show(S.view),

    // --- 商品 ---
    add() {
      captureAdd();
      const a = S.add;
      const name = a.name.trim();
      const price = a.price.trim();
      const games = a.games.trim();
      const bad = (m) => {
        a.err = m;
        render();
      };
      if (!name || name.length > 30) return bad('商品名は、1〜30文字で入力してください');
      if (!/^\d{1,6}$/.test(price) || Number(price) > 100000) return bad('値段は、0〜100000の整数で入力してください');
      if (a.category === 'game' && (!/^\d{1,2}$/.test(games) || Number(games) < 1 || Number(games) > 20)) {
        return bad('ゲーム回数は、1〜20の整数で入力してください');
      }
      const tops = a.category === 'food' ? parseToppings(a.toppings) : [];
      if (toppingError(tops)) return bad(toppingError(tops));
      const body = { category: a.category, name, price: Number(price) };
      if (a.category === 'game') body.games = Number(games);
      if (a.category === 'food') body.toppings = tops;
      return guarded(async () => {
        try {
          await call('POST', '/api/admin/menu', body);
        } catch (e) {
          a.err = e.message;
          throw Object.assign(e, { silent: true });
        }
        a.name = '';
        a.price = '';
        a.toppings = '';
        a.err = '';
        await loadMenu();
        toast(`${name} を追加しました`);
      });
    },
    edit(d) {
      const m = findItem(d.id);
      if (!m) return;
      S.modal = {
        type: 'edit',
        id: m.id,
        category: m.category,
        name: m.name,
        price: String(m.price),
        onSale: m.onSale,
        toppings: (m.toppings || []).join(', '),
        err: '',
      };
      render();
    },
    sale(d) {
      captureEdit();
      S.modal.onSale = d.v === '1';
      render();
    },
    saveEdit() {
      captureEdit();
      const m = S.modal;
      const name = m.name.trim();
      if (!name || name.length > 30) {
        m.err = '商品名は、1〜30文字で入力してください';
        return render();
      }
      if (!/^\d{1,6}$/.test(m.price.trim()) || Number(m.price) > 100000) {
        m.err = '値段は、0〜100000の整数で入力してください';
        return render();
      }
      const body = { name, price: Number(m.price), onSale: m.onSale };
      if (m.category === 'food') {
        const tops = parseToppings(m.toppings);
        if (toppingError(tops)) {
          m.err = toppingError(tops);
          return render();
        }
        body.toppings = tops;
      }
      return guarded(async () => {
        await call('PUT', `/api/admin/menu/${encodeURIComponent(m.id)}`, body);
        S.modal = null;
        await loadMenu();
        toast('保存しました');
      });
    },
    del(d) {
      const m = findItem(d.id);
      if (!m) return;
      S.modal = { type: 'delete', id: m.id, name: m.name, err: '', canOff: false };
      render();
    },
    doDelete() {
      const m = S.modal;
      return guarded(async () => {
        try {
          await call('DELETE', `/api/admin/menu/${encodeURIComponent(m.id)}`);
        } catch (e) {
          if (e.code === 'item_in_use') m.canOff = true; // 注文の記録がある商品は、販売終了にする
          throw e;
        }
        S.modal = null;
        await loadMenu();
        toast(`${m.name} を削除しました`);
      });
    },
    offSale() {
      const m = S.modal;
      return guarded(async () => {
        await call('PUT', `/api/admin/menu/${encodeURIComponent(m.id)}`, { onSale: false });
        S.modal = null;
        await loadMenu();
        toast(`${m.name} を販売終了にしました`);
      });
    },

    // --- 卓の操作 ---
    reopen(d) {
      S.modal = { type: 'reopen', table: d.id, err: '' };
      render();
    },
    doReopen() {
      const m = S.modal;
      return guarded(async () => {
        await call('POST', `/api/admin/tables/${encodeURIComponent(m.table)}/reopen`);
        S.modal = null;
        await loadTables();
        toast(`卓 ${m.table} を、使用中に戻しました`);
      });
    },

    // --- QR ---
    async png(d) {
      try {
        const res = await fetch(`/api/admin/tables/${encodeURIComponent(d.id)}/qr?format=png`, {
          headers: { Authorization: 'Bearer ' + S.token },
          cache: 'no-store',
        });
        if (res.status === 401 || res.status === 403) return logout('ログインの有効期限が切れました。もう一度ログインしてください。');
        if (!res.ok) throw new Error('画像を取得できませんでした');
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = `qr-${d.id}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } catch (e) {
        toast(e.message || '画像を保存できませんでした');
      }
    },
    rotate(d) {
      S.modal = { type: 'rotate', table: d.id, err: '' };
      render();
    },
    doRotate() {
      const m = S.modal;
      return guarded(async () => {
        await call('POST', `/api/admin/tables/${encodeURIComponent(m.table)}/rotate-key`);
        S.modal = null;
        await loadQr();
        toast(`卓 ${m.table} のQRを再発行しました。印刷し直してください`);
      });
    },

    // --- データ ---
    resetOpen() {
      S.modal = { type: 'reset', err: '' };
      render();
    },
    doReset() {
      if (val('rc') !== 'リセット') return;
      return guarded(async () => {
        await call('POST', '/api/admin/reset', { confirm: 'リセット' });
        S.modal = null;
        toast('注文データを、すべて削除しました');
      });
    },
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = ACT[b.dataset.act];
    if (fn) fn(b.dataset);
  });
  // 入力のたびに、画面は作り直さない(入力欄の状態だけ、更新する)
  root.addEventListener('input', (e) => {
    if (e.target.id === 'rc') {
      const btn = document.getElementById('doReset');
      if (btn) btn.disabled = e.target.value !== 'リセット';
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'at') {
      captureAdd();
      S.add.category = e.target.value;
      S.add.err = '';
      render();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'pin') login();
  });

  // 卓の画面は、10秒ごとに自動で更新する(確認の画面が開いているときと、見ていないときは止める)
  setInterval(() => {
    if (S.token && S.view === 'tables' && !S.modal && !S.busy && !document.hidden) {
      loadTables().then(render).catch(() => {});
    }
  }, 10000);

  // ---------- 起動 ----------
  (async () => {
    if (!S.token) return render();
    try {
      await loadMenu();
      render();
    } catch (e) {
      if (!e.silent) {
        toast(e.message);
        render();
      }
    }
  })();
})();