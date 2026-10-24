(() => {
  "use strict";
  const { esc, yen, toast, connect, groupItems, toppingName } = YS;
  const rawApi = YS.api;
  // 診断用: 呼んだAPIの結果は、画面には出さず、ブラウザのコンソールにだけ出す
  const api = async (method, path, opts) => {
    const sid4 = ((opts && opts.session) || "").slice(0, 4);
    const name = `${method} ${path.replace("/api/public", "")}${sid4 ? " [" + sid4 + "]" : ""}`;
    try {
      const r = await rawApi(method, path, opts);
      console.debug(
        `[api] ${name} → ok${r && r.sessionId ? ` 発行[${r.sessionId.slice(0, 4)}] created=${r.created} state=${r.state}` : ""}`,
      );
      return r;
    } catch (e) {
      console.debug(`[api] ${name} → ${e.status} ${e.code}`);
      throw e;
    }
  };
  const root = document.getElementById("app");
  const KEY = "yushisai_session";
  const CATS = [
    ["drink", "ドリンク"],
    ["food", "フード"],
    ["game", "追加ゲーム"],
  ];
  const TILE = {
    drink: "bg-sky-100 text-sky-700",
    food: "bg-amber-100 text-amber-800",
    topping: "bg-green-100 text-green-700",
    game: "bg-violet-100 text-violet-700",
  };
  const BTN = "bg-sky-600 text-white";
  const S = {
    screen: "loading",
    menu: null,
    sess: null,
    sid: null,
    table: null,
    key: null,
    tab: "drink",
    cart: {},
    detail: null,
    step: null,
    people: 2,
    ent: {},
    reqId: null,
    busy: false,
    dlg: false,
    msg: "",
    ws: null,
  };

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  };
  const save = (v) => {
    try {
      v
        ? localStorage.setItem(KEY, JSON.stringify(v))
        : localStorage.removeItem(KEY);
    } catch {
      /* 保存できない環境 */
    }
  };
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const item = (id) => S.menu.items.find((i) => i.id === id);
  const newId = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : [...crypto.getRandomValues(new Uint8Array(16))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
  // 席の利用が始まったら、URLから鍵(key)を消す。
  // 会計のあとに「戻る」や再読み込みをしても、鍵がないので、新しい利用を始められない(QRを読み直したときだけ始められる)。
  function stripKey() {
    const u = new URL(location.href);
    if (!u.searchParams.has("key")) return;
    u.searchParams.delete("key");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
  const unserved = () =>
    S.sess
      ? S.sess.items.filter((i) => i.status === "wait" && i.category !== "game")
          .length
      : 0;

  // 画面上の見込みのゲーム回数(表示用。本当の計算はサーバーが行う)
  //   フードで増える分は、上限(max)まで。それを超える分は、追加ゲーム(上限なし)。
  function projectedParts() {
    const g = S.menu.game;
    let food = S.sess
      ? S.sess.items.filter((i) => i.category === "food").reduce((a, i) => a + i.qty, 0)
      : 0;
    let extra = S.sess ? S.sess.games.extra : 0;
    for (const [id, q] of Object.entries(S.cart)) {
      const m = item(id);
      if (m && m.category === "food") food += q;
      if (m && m.category === "game") extra += m.games * q;
    }
    const free = Math.min(g.max, g.initial + g.perFood * food);
    return { free, extra, total: free + extra };
  }
  const projected = () => projectedParts().total;

  // ---------- 画面 ----------
  const stp = (a, id, q) =>
    `<div class="flex items-center gap-3"><button data-act="${a}" data-id="${id}" data-d="-1" aria-label="減らす" class="h-9 w-9 rounded-full border border-gray-300 text-lg">−</button><span class="w-5 text-center font-medium">${q}</span><button data-act="${a}" data-id="${id}" data-d="1" aria-label="増やす" class="h-9 w-9 rounded-full ${BTN} text-lg">+</button></div>`;
  // 画像は、サーバーが返した /public/images/ のものだけ使う(なければ、頭文字のタイルのまま)
  const imgOk = (m) => typeof m.image === "string" && m.image.startsWith("/public/images/");
  // カートの数を変えるボタン。上限(max)に届いたら、＋は押せなくする
  const cstp = (id, q, max) =>
    `<div class="flex shrink-0 items-center gap-2"><button data-act="cq" data-id="${id}" data-d="-1" aria-label="減らす" class="h-9 w-9 rounded-full border border-gray-300 text-lg">−</button><span class="w-5 text-center font-medium">${q}</span><button data-act="cq" data-id="${id}" data-d="1" aria-label="増やす" ${q >= max ? "disabled" : ""} class="h-9 w-9 rounded-full ${BTN} text-lg ${q >= max ? "opacity-40" : ""}">+</button></div>`;
  // カートの1品の、数の上限。トッピングは、付けるフードの数まで(フードがなければ0)
  const cartMax = (m) => (m.category === "topping" ? S.cart[m.parentId] || 0 : S.menu.limits.maxQtyPerItem);
  // トッピングを、フードの数に合わせる(フードがカートにないトッピングは、消す)
  function fitToppings() {
    for (const id of Object.keys(S.cart)) {
      const m = item(id);
      if (!m || m.category !== "topping") continue;
      const max = S.cart[m.parentId] || 0;
      if (max === 0) delete S.cart[id];
      else if (S.cart[id] > max) S.cart[id] = max;
    }
  }
  const tile = (m) =>
    imgOk(m)
      ? `<img src="${esc(m.image)}" alt="${esc(m.name)}" data-img="${esc(m.id)}" loading="lazy" decoding="async" class="h-14 w-14 shrink-0 rounded-lg bg-gray-100" style="object-fit:cover" />`
      : `<div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg text-xl font-bold ${TILE[m.category]}">${esc(m.name[0])}</div>`;
  const bigTile = (m) =>
    imgOk(m)
      ? `<img src="${esc(m.image)}" alt="${esc(m.name)}" data-img="${esc(m.id)}" decoding="async" class="w-full rounded-2xl bg-gray-100" style="height:14rem;object-fit:cover" />`
      : `<div class="flex h-40 w-full items-center justify-center rounded-2xl text-6xl font-bold ${TILE[m.category]}">${esc(m.name[0])}</div>`;
  const meter = (n, max) =>
    `<div class="flex gap-1">${Array.from({ length: max }, (_, i) => `<span class="h-2 flex-1 rounded ${i < n ? "bg-sky-600" : "bg-gray-200"}"></span>`).join("")}</div>`;
  const nav = (
    a,
  ) => `<nav class="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white" style="padding-bottom:env(safe-area-inset-bottom,0px)"><div class="mx-auto grid max-w-md grid-cols-2">
    <button data-act="go" data-id="menu" class="py-3 text-sm ${a === "menu" ? "font-bold text-sky-600" : "text-gray-500"}">メニュー</button>
    <button data-act="go" data-id="status" class="py-3 text-sm ${a === "status" ? "font-bold text-sky-600" : "text-gray-500"}">注文状況${unserved() ? ` <span class="inline-block rounded-full bg-red-500 px-1.5 text-xs text-white">${unserved()}</span>` : ""}</button></div></nav>`;
  const wrap = (h) =>
    `<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-5"><div class="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5">${h}</div></div>`;

  // 会計の画面に出す内訳(商品名+値段 | 個数 | 合計)。割り勘などで、金額を確かめられるようにする
  //   入場ドリンクは、入場料に含まれるので出さない。トッピングは、付けたフードの下に出す。
  //   無料チケット(クーポン)は、レジで「適用」すると、ここに反映される。
  function payDetail() {
    const s = S.sess;
    if (!s) return "";
    const grid = "display:grid;grid-template-columns:1fr auto auto;column-gap:12px;align-items:baseline";
    const row = (name, qty, price, cls) =>
      `<div class="py-1 ${cls || ""}" style="${grid}"><span class="min-w-0 break-words">${name}</span><span class="text-right">${qty}</span><span class="text-right">${price}</span></div>`;
    const fee = s.total.entranceFee / s.people;
    const coupon = s.total.freeTickets
      ? `<div class="py-1 text-right text-red-600">クーポン${s.total.freeTickets}枚適用 −${yen(s.total.discount)}</div>`
      : "";
    const items = groupItems(s.items.filter((i) => i.kind !== "entrance"))
      .map((g) => {
        const one = (i) => row(`${esc(i.name)} ${yen(i.unitPrice)}`, `×${i.qty}`, yen(i.unitPrice * i.qty));
        if (!g.head) return g.tops.map(one).join("");
        const tops = g.tops
          .map((t) =>
            row(`・${esc(toppingName(t.name, g.head.name))}`, `×${t.qty}`, t.unitPrice ? yen(t.unitPrice * t.qty) : "無料", "pl-3 text-gray-500"),
          )
          .join("");
        return one(g.head) + tops;
      })
      .join("");
    return `<div class="mt-6 rounded-xl border border-gray-200 p-4 text-left text-sm" style="margin-bottom:24px">
      <div class="mb-2 font-bold">内訳</div>
      <div class="border-b border-gray-200 pb-2 text-xs text-gray-500" style="${grid}"><span>商品名・値段</span><span class="text-right">個数</span><span class="text-right">合計</span></div>
      ${row(`入場料 ${yen(fee)}`, `×${s.people}`, yen(s.total.entranceFee))}${coupon}${items}</div>`;
  }

  const V = {
    loading: () =>
      '<div class="pt-40 text-center text-gray-500">読み込み中…</div>',
    error: () =>
      `<div class="px-6 pt-32 text-center"><h1 class="mb-2 text-xl font-bold">開けませんでした</h1><p class="text-sm text-gray-600">${esc(S.msg)}</p></div>`,
    end: () =>
      `<div class="px-6 pt-32 text-center"><h1 class="mb-2 text-xl font-bold">ご来店ありがとうございました</h1><p class="text-sm text-gray-600">${esc(S.msg || "会計が完了しました。")}</p></div>`,
    menu() {
      const g = S.sess
        ? S.sess.games
        : { current: S.menu.game.initial, free: S.menu.game.initial, extra: 0, max: S.menu.game.max };
      const rows = S.menu.items
        .filter((i) => i.category === S.tab)
        .map((m) => {
          if (!m.onSale)
            return `<div class="flex items-center gap-3 py-3 opacity-40"><div class="flex-1"><div>${esc(m.name)}</div><div class="text-xs">売り切れ</div></div></div>`;
          const q = S.cart[m.id] || 0;
          // メニューの一覧には、画像(頭文字のタイル)を出さない
          return `<button data-act="detail" data-id="${m.id}" class="flex w-full items-center gap-3 py-3 text-left"><div class="flex-1"><div class="font-medium">${esc(m.name)}</div><div class="text-sm text-gray-600">${yen(m.price)}</div></div>${q ? `<span class="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700">カート ${q}</span>` : ""}<span class="text-xl text-gray-400" aria-hidden="true">›</span></button>`;
        })
        .join("");
      const n = sum(S.cart);
      return `<div class="flex items-center justify-between px-4 pb-2 pt-4"><div><h1 class="text-xl font-bold">${esc(S.menu.event.name)}</h1><div class="text-xs text-gray-500">卓 ${esc(S.table)}</div></div><div class="rounded-full bg-sky-50 px-3 py-1 text-sm font-medium text-sky-700">ゲーム ${g.current}回</div></div>
      <div class="flex gap-2 overflow-x-auto px-4 py-2">${CATS.map(([k, l]) => `<button data-act="tab" data-id="${k}" class="whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${S.tab === k ? BTN + " font-medium" : "bg-gray-100 text-gray-700"}">${l}</button>`).join("")}</div>
      ${S.tab === "food" ? `<p class="px-4 text-xs text-gray-500">フード1品ごとに ゲーム +${S.menu.game.perFood}(フードで増えるのは、最大${S.menu.game.max}回まで。それ以上は、追加ゲーム)</p>` : ""}
      ${S.sess && S.tab === "game" ? `<div class="mx-4 mb-1 rounded-lg bg-gray-50 p-3 text-sm text-gray-600">フードで増えるゲームは、最大${g.max}回までです。それ以上遊ぶときは、追加ゲームを購入してください。<div class="mt-2 font-medium text-gray-700">今のゲーム ${projected()}回(フード分 ${projectedParts().free} / ${g.max} ・ 追加 ${projectedParts().extra}回)</div><div class="mt-2">${meter(projectedParts().free, g.max)}</div></div>` : ""}
      <div class="divide-y divide-gray-100 px-4">${rows}</div>
      <div class="fixed inset-x-0 px-4" style="bottom:calc(env(safe-area-inset-bottom,0px) + 56px)"><div class="mx-auto max-w-md"><button data-act="cart" class="w-full rounded-xl ${BTN} py-3.5 font-bold shadow-lg">カートを見る${n ? ` <span class="ml-1 inline-block rounded-full bg-white px-2 py-0.5 text-xs text-sky-700">${n}</span>` : ""}</button></div></div>${S.sess ? nav("menu") : ""}`;
    },
    detail() {
      const m = item(S.detail.id),
        q = S.detail.qty;
      const tops =
        m.category === "food"
          ? S.menu.items.filter((t) => t.category === "topping" && t.parentId === m.id)
          : [];
      const topRows = tops
        .map((t) =>
          !t.onSale
            ? `<div class="flex items-center justify-between py-2.5 opacity-40"><div><div>${esc(t.name)}</div><div class="text-xs">売り切れ</div></div></div>`
            : `<div class="flex items-center justify-between py-2.5"><div><div>${esc(t.name)}</div><div class="text-sm text-gray-600">${t.price ? "+" + yen(t.price) : "無料"}</div></div>${stp("tq", t.id, S.detail.tops[t.id] || 0)}</div>`,
        )
        .join("");
      const topTotal = tops.reduce((a, t) => a + t.price * (S.detail.tops[t.id] || 0), 0);
      const note =
        m.category === "food"
          ? `フード1品ごとに ゲーム +${S.menu.game.perFood}(フードで増えるのは、最大${S.menu.game.max}回まで)`
          : m.category === "game"
            ? `現在のゲーム ${projected()}回(フードで増える分は、最大${S.menu.game.max}回。それ以上は、追加ゲーム)`
            : "";
      return `<div class="px-4 pt-4"><button data-act="go" data-id="menu" class="text-sm text-sky-700">‹ メニューに戻る</button></div>
      <div class="mt-3 px-4">${bigTile(m)}
      <h1 class="mt-4 text-2xl font-bold">${esc(m.name)}</h1><div class="mt-1 text-xl">${yen(m.price)}</div><p class="mt-3 text-sm text-gray-600">${note}</p>
      <div class="mt-6 flex items-center justify-between"><span class="font-medium">数量</span>${stp("dq", m.id, q)}</div>${tops.length ? `<div class="mt-6"><div class="font-medium">トッピング</div><p class="mb-1 text-xs text-gray-500">フードの数まで、選べます。</p><div class="divide-y divide-gray-100">${topRows}</div></div>` : ""}</div>
      <div class="fixed inset-x-0 px-4" style="bottom:calc(env(safe-area-inset-bottom,0px) + 16px)"><div class="mx-auto max-w-md"><button data-act="addcart" class="w-full rounded-xl ${BTN} py-3.5 font-bold shadow-lg">カートに追加 ・ ${yen(m.price * q + topTotal)}</button></div></div>`;
    },
    confirm() {
      // トッピングは、付けたフードの下にまとめる(フードがカートにないトッピングは、単独で出す)
      const ids = Object.keys(S.cart).filter((id) => item(id)); // メニューから消えた商品は、出さない
      const isUnder = (id) => item(id).category === "topping" && S.cart[item(id).parentId];
      // 1行 = メニュー | 値段 | 操作ボタン
      const row = (cls, name, price, id, q, max) =>
        `<div class="flex items-center gap-3 py-2"><div class="min-w-0 flex-1 break-words ${cls}">${name}</div><div class="w-16 shrink-0 text-right ${cls}">${price}</div>${cstp(id, q, max)}</div>`;
      const lines = ids
        .filter((id) => !isUnder(id))
        .map((id) => {
          const m = item(id);
          const q = S.cart[id];
          const subs = ids
            .filter((t) => isUnder(t) && item(t).parentId === id)
            .map((t) => {
              const tm = item(t);
              const tq = S.cart[t];
              return row("pl-3 text-sm text-gray-600", `・${esc(tm.name)}`, tm.price ? `+${yen(tm.price * tq)}` : "無料", t, tq, cartMax(tm));
            })
            .join("");
          return `<div class="py-0.5">${row("", esc((m.category === "topping" ? "＋" : "") + m.name), yen(m.price * q), id, q, cartMax(m))}${subs}</div>`;
        })
        .join("");
      const sub = Object.entries(S.cart).reduce(
        (a, [id, q]) => a + (item(id) ? item(id).price * q : 0),
        0,
      );
      return `<div class="px-4 pb-1 pt-4"><h1 class="text-xl font-bold">注文の確認</h1></div><div class="px-4"><div class="divide-y divide-gray-100 border-y border-gray-200">${lines}</div>
      <div class="flex justify-between py-3 font-bold"><span>今回の合計</span><span>${yen(sub)}</span></div>
      <div class="mb-3 rounded-lg bg-gray-50 p-3 text-sm">ゲーム回数 ${S.sess.games.current}回 → <b>${projected()}回</b></div>
      <div class="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">注文を確定すると、取り消しや変更はできません。内容をもう一度ご確認ください。</div>
      <div class="grid grid-cols-2 gap-3"><button data-act="go" data-id="menu" class="rounded-xl border border-gray-300 py-3.5">戻る</button><button data-act="order" ${S.busy ? "disabled" : ""} class="rounded-xl ${BTN} py-3.5 font-bold ${S.busy ? "opacity-50" : ""}">${S.busy ? "送信中…" : "注文を確定"}</button></div></div>`;
    },
    status() {
      const s = S.sess;
      // フードと、そのトッピングは、1つのまとまりで表示する。状態は、全部が提供済みのときだけ「提供済み」
      const oneRow = (i, tops, served) =>
        `<div class="flex items-center justify-between py-3"><div><div>${esc(i.name)} × ${i.qty}</div>${tops
          .map((t) => `<div class="pl-3 text-sm text-gray-600">・${esc(toppingName(t.name, i.name))}${i.qty > 1 ? ` × ${t.qty}` : ""}</div>`)
          .join("")}<div class="text-xs text-gray-500">${i.kind === "entrance" ? "入場ドリンク" : i.unitPrice ? yen(i.unitPrice * i.qty) : ""}</div></div>${i.category === "game" ? '<span class="text-xs text-gray-500">反映済み</span>' : `<span class="rounded-full px-2.5 py-1 text-xs ${served ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-800"}">${served ? "提供済み" : "受付済み"}</span>`}</div>`;
      const rows = groupItems(s.items)
        .map((g) =>
          g.head
            ? oneRow(g.head, g.tops, [g.head, ...g.tops].every((x) => x.status === "served"))
            : g.tops.map((t) => oneRow(t, [], t.status === "served")).join(""),
        )
        .join("");
      return `<div class="px-4 pb-1 pt-4"><h1 class="text-xl font-bold">注文状況</h1><div class="text-xs text-gray-500">卓 ${esc(S.table)}</div></div>
      <div class="mt-1 px-4"><div class="mb-3 rounded-xl border border-gray-200 p-3"><div class="mb-2 flex justify-between text-sm"><span class="text-gray-600">ゲーム回数</span><span class="font-bold">${s.games.current}回</span></div>${meter(s.games.free, s.games.max)}<div class="mt-1 text-xs text-gray-500">フード分 ${s.games.free} / ${s.games.max} ・ 追加ゲーム ${s.games.extra}回</div></div>
      <div class="divide-y divide-gray-100 border-y border-gray-200">${rows}</div>
      <div class="space-y-1 py-3 text-sm"><div class="flex justify-between text-gray-600"><span>入場料 ${yen(s.total.entranceFee / s.people)} × ${s.people}名</span><span>${yen(s.total.entranceFee)}</span></div>${s.total.freeTickets ? `<div class="flex justify-between text-red-600"><span>クーポン ${s.total.freeTickets}枚適用</span><span>−${yen(s.total.discount)}</span></div>` : ""}<div class="flex justify-between text-base font-bold"><span>現在の合計</span><span>${yen(s.total.total)}</span></div></div>
      <button data-act="askpay" class="w-full rounded-xl border-2 border-sky-600 py-3.5 font-bold text-sky-700">会計する</button></div>${nav("status")}`;
    },
    // 会計をお待ちください: チェックマーク → 見出し → 注意書き → お支払い合計金額 → 内訳
    paying: () =>
      `<div class="px-6 pt-24"><div class="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-sky-100 text-3xl text-sky-700">✓</div>
      <h1 class="mb-3 text-center text-xl font-bold">会計をお待ちください</h1>
      <div class="mb-6 text-sm text-gray-600"><p class="mb-2 text-center">クーポンをお持ちの方は、スタッフにご提示ください。</p>
        <p class="mb-1 text-xs">※1 現金のみ対応しています。クレジットカード・電子マネー・QRコード決済はご利用になれません。</p>
        <p class="text-xs">※2 個別会計はできません。別々に支払いたい場合も、皆さまでお金を集めて、まとめて1回でお支払いください。</p></div>
      <div class="rounded-xl bg-gray-50 p-4 text-center"><div class="text-xs text-gray-500">お支払い合計金額</div><div class="text-3xl font-bold">${yen(S.sess.total.total)}</div></div>${payDetail()}</div>`,
  };

  function modal() {
    if (S.dlg)
      return wrap(
        `<h2 class="mb-1 text-lg font-bold">会計に進みますか?</h2><p class="mb-1 text-sm text-gray-600">会計に進むと、追加の注文はできなくなります。</p>${unserved() ? '<p class="mb-1 text-sm text-amber-700">まだ届いていない品があります。スタッフがお席で確認します。</p>' : ""}<div class="mt-4 grid grid-cols-2 gap-3"><button data-act="closedlg" class="rounded-xl border border-gray-300 py-3">戻る</button><button data-act="pay" class="rounded-xl ${BTN} py-3 font-bold">会計に進む</button></div>`,
      );
    if (S.step === "people")
      return wrap(
        `<h2 class="text-lg font-bold">いらっしゃいませ</h2><p class="mt-1 text-sm text-gray-600">卓 ${esc(S.table)}・人数を選んでください。</p><div class="my-6 flex items-center justify-center gap-6"><button data-act="pp" data-d="-1" aria-label="減らす" class="h-12 w-12 rounded-full border border-gray-300 text-2xl">−</button><span class="w-12 text-center text-4xl font-bold">${S.people}</span><button data-act="pp" data-d="1" aria-label="増やす" class="h-12 w-12 rounded-full ${BTN} text-2xl">+</button></div><p class="mb-4 text-center text-xs text-gray-500">入場料 ${yen(S.menu.entranceFeePerPerson)}/人(ドリンク代込み)</p><button data-act="tostep2" class="w-full rounded-xl ${BTN} py-3.5 font-bold">次へ</button>`,
      );
    if (S.step === "drink")
      return wrap(`<div class="flex items-baseline justify-between"><h2 class="text-lg font-bold">ドリンクをお選びください！</h2><span class="text-sm ${sum(S.ent) === S.people ? "font-medium text-sky-600" : "text-gray-500"}">${sum(S.ent)} / ${S.people} 杯</span></div>
      <p class="mt-1 text-xs text-amber-700">席の代表の方が1人で、全員分を選んでください。無料チケットをお持ちの方は会計時にスタッフに提示すると無料になります。</p>
      <div class="my-2 divide-y divide-gray-100">${S.menu.items
        .filter((m) => m.category === "drink")
        .map((m) =>
          m.onSale
            ? `<div class="flex items-center gap-3 py-3">${tile(m)}<div class="flex-1">${esc(m.name)}</div>${stp("ent", m.id, S.ent[m.id] || 0)}</div>`
            : `<div class="flex items-center gap-3 py-3 opacity-40">${tile(m)}<div class="flex-1"><div>${esc(m.name)}</div><div class="text-xs">売り切れ</div></div></div>`,
        )
        .join("")}</div>
      <div class="mt-3 grid grid-cols-2 gap-3"><button data-act="back1" class="rounded-xl border border-gray-300 py-3.5">戻る</button><button data-act="start" ${S.busy ? "disabled" : ""} class="rounded-xl ${BTN} py-3.5 font-bold ${S.busy ? "opacity-50" : ""}">メニューへ</button></div>`);
    return "";
  }

  function render() {
    // 詳細を見ている商品が、メニューから消えたとき(管理者画面で削除されたなど)は、メニューに戻す
    if (S.screen === "detail" && (!S.detail || !item(S.detail.id))) {
      S.screen = "menu";
      S.detail = null;
      toast("この商品は、メニューから外れました");
    }
    root.innerHTML =
      (V[S.screen] ? V[S.screen]() : "") +
      (S.screen === "menu" || S.screen === "status" ? modal() : "");
  }
  const fail = (m, reason) => {
    console.debug("[fail]", reason || "-", m);
    S.msg = m;
    S.reason = reason || "";
    S.screen = "error";
    render();
  };
  // 保存してある識別番号は、この画面が使っていたものと同じときだけ消す
  // (別のタブが保存した、有効な識別番号を、巻き込んで消さないため)
  const forget = () => {
    const saved = load();
    if (!saved || saved.sid === S.sid) save(null);
    S.sid = null;
    S.sess = null;
    if (S.ws) {
      S.ws.close();
      S.ws = null;
    }
  };
  const ended = (reason, m) => {
    console.debug("[ended]", reason || "-");
    forget();
    S.reason = reason || "";
    S.msg = m || "";
    S.screen = "end";
    render();
  };

  // ---------- 通信 ----------
  async function refresh(initial, quiet) {
    if (!S.sid) return false;
    try {
      S.sess = await api("GET", "/api/public/session", { session: S.sid });
      if (S.sess.state === "paying") S.screen = "paying";
      else if (S.screen === "paying") S.screen = "status";
      render();
      return true;
    } catch (e) {
      if (e.status === 410 || e.status === 401) {
        if (initial) {
          forget();
          return false;
        }
        if (e.status === 410) ended("refresh-410");
        else {
          forget();
          fail(
            "この識別番号は使えません。QRコードを読み取り直してください。",
            "refresh-401",
          );
        }
        return false;
      }
      if (!quiet) toast(e.message);
      return true;
    }
  }
  // 通知(WebSocket)が届かなかったときの保険: 表示中は30秒ごとに状況を取り直す
  setInterval(() => {
    if (S.sid && !document.hidden && !S.busy) refresh(false, true);
  }, 30000);
  // メニューを取り直す。変わっていたら画面を更新し、選べなくなったドリンクは選択から外す
  async function refreshMenu(quiet) {
    let x;
    try {
      x = await api("GET", "/api/public/menu");
    } catch {
      return false;
    }
    const changed = JSON.stringify(x.items) !== JSON.stringify(S.menu.items);
    S.menu = x;
    let dropped = false;
    for (const id of Object.keys(S.ent)) {
      const m = x.items.find((i) => i.id === id);
      if (!m || !m.onSale || m.category !== "drink") {
        delete S.ent[id];
        dropped = true;
      }
    }
    if (changed || dropped) {
      render();
      if (!quiet)
        toast(
          dropped
            ? "販売が終了したドリンクがあります。選び直してください"
            : "メニューが更新されました",
        );
    }
    return changed || dropped;
  }
  let pending = null;
  const schedule = () => {
    clearTimeout(pending);
    pending = setTimeout(() => refresh(), 150);
  };

  function startWs() {
    if (S.ws) S.ws.close();
    S.ws = connect({
      path: "/ws/public",
      authMsg: () => ({ type: "auth", sessionId: S.sid }),
      onOpen: () => refresh(),
      onMessage: (m) => {
        if (
          ["order.created", "item.served", "session.changed"].includes(m.type)
        )
          schedule();
        if (m.type === "menu.changed")
          api("GET", "/api/public/menu")
            .then((x) => {
              S.menu = x;
              render();
            })
            .catch(() => {});
        if (m.type === "reset")
          ended("reset", "店舗側で記録が初期化されました。");
      },
      onEnded: () => ended("ws-4410"),
      onAuthError: () => {
        forget();
        fail(
          "この識別番号は使えません。QRコードを読み取り直してください。",
          "ws-4401",
        );
      },
    });
  }

  async function startSession() {
    if (S.busy) return;
    if (sum(S.ent) !== S.people)
      return toast(`ドリンクを${S.people}杯分選んでください`);
    S.busy = true;
    render();
    try {
      const r = await api("POST", "/api/public/sessions", {
        body: {
          table: S.table,
          key: S.key,
          people: S.people,
          drinks: Object.entries(S.ent).map(([id, qty]) => ({ id, qty })),
        },
      });
      S.sid = r.sessionId;
      save({ sid: S.sid, table: S.table });
      stripKey();
      S.step = null;
      S.busy = false;
      if (r.created === false)
        toast(
          "同じ席の方が、すでに手続きを済ませていました。人数・ドリンクは、その内容のままです。",
        );
      if (await refresh()) startWs();
    } catch (e) {
      S.busy = false;
      if (e.code === "invalid_qr") return fail(e.message, "create-invalid_qr");
      if (e.code === "item_unavailable") {
        await refreshMenu(true);
        toast(
          "選べなくなったドリンクがありました。メニューを更新したので、選び直してください。",
        );
        return render();
      }
      toast(e.message);
      render();
    }
  }

  async function order() {
    if (S.busy) return;
    S.busy = true;
    render();
    if (!S.reqId) S.reqId = newId(); // 通信が失敗してやり直しても、同じ番号で送る(二重注文を防ぐ)
    try {
      await api("POST", "/api/public/orders", {
        session: S.sid,
        body: {
          requestId: S.reqId,
          items: Object.entries(S.cart).map(([id, qty]) => ({ id, qty })),
        },
      });
      S.cart = {};
      S.reqId = null;
      S.screen = "status";
      toast("注文を受け付けました");
      await refresh();
    } catch (e) {
      if (e.code === "paying") {
        S.screen = "paying";
        await refresh();
      } else {
        if (e.code === "item_unavailable") {
          if (e.data && e.data.itemId) delete S.cart[e.data.itemId];
          fitToppings(); // 消えたフードのトッピングが、カートに残らないようにする
          S.reqId = null;
          S.screen = "menu";
          S.menu = await api("GET", "/api/public/menu").catch(() => S.menu);
        }
        toast(e.message);
      }
    }
    S.busy = false;
    render();
  }

  async function pay() {
    S.dlg = false;
    try {
      await api("POST", "/api/public/checkout-request", { session: S.sid });
      await refresh();
      S.screen = "paying";
    } catch (e) {
      toast(e.message);
    }
    render();
  }

  // ---------- 操作 ----------
  const ACT = {
    tab: (d) => {
      S.tab = d.id;
    },
    go: (d) => {
      S.screen = d.id;
    },
    detail: (d) => {
      S.detail = { id: d.id, qty: 1, tops: {} };
      S.screen = "detail";
    },
    dq(d) {
      const m = item(S.detail.id),
        q = S.detail.qty + Number(d.d);
      if (q < 1 || q > S.menu.limits.maxQtyPerItem) return;
      S.detail.qty = q;
      // フードの数を減らしたら、トッピングも、その数までに揃える
      for (const k of Object.keys(S.detail.tops)) S.detail.tops[k] = Math.min(S.detail.tops[k], q);
    },
    tq(d) {
      const n = (S.detail.tops[d.id] || 0) + Number(d.d);
      if (n < 0 || n > S.detail.qty) return; // トッピングは、フードの数まで
      S.detail.tops[d.id] = n;
    },
    addcart() {
      const m = item(S.detail.id),
        q = S.detail.qty;
      S.cart[m.id] = Math.min(
        S.menu.limits.maxQtyPerItem,
        (S.cart[m.id] || 0) + q,
      );
      // 選んだトッピングも、カートに入れる
      for (const [tid, tq] of Object.entries(S.detail.tops || {})) {
        if (tq > 0) {
          S.cart[tid] = Math.min(S.menu.limits.maxQtyPerItem, (S.cart[tid] || 0) + tq);
        }
      }
      S.reqId = null;
      S.screen = "menu";
      toast("カートに追加しました");
    },
    cart() {
      if (!S.sess) return toast("先に人数とドリンクを選んでください");
      if (!sum(S.cart)) return toast("商品を選んでください");
      S.screen = "confirm";
    },
    // カートの数を変える。0にしたら、カートから消す。空になったら、メニューに戻る
    cq(d) {
      const m = item(d.id);
      if (!m || !S.cart[d.id]) return;
      const n = S.cart[d.id] + Number(d.d);
      if (n > cartMax(m)) return;
      if (n <= 0) delete S.cart[d.id];
      else S.cart[d.id] = n;
      fitToppings(); // フードを減らしたら、トッピングもその数までにする
      S.reqId = null; // 内容が変わったので、新しい注文として送る
      if (!sum(S.cart)) {
        S.screen = "menu";
        toast("カートが空になりました");
      }
    },
    order,
    pay,
    start: startSession,
    askpay: () => {
      S.dlg = true;
    },
    closedlg: () => {
      S.dlg = false;
    },
    pp: (d) => {
      const n = S.people + Number(d.d);
      if (n >= 1 && n <= S.menu.limits.maxPeople) {
        S.people = n;
        S.ent = {};
      }
    },
    tostep2: () => {
      S.step = "drink";
      S.ent = {};
    },
    back1: () => {
      S.step = "people";
    },
    ent(d) {
      const n = (S.ent[d.id] || 0) + Number(d.d);
      if (n < 0) return;
      if (Number(d.d) > 0 && sum(S.ent) >= S.people)
        return toast("人数分まで選べます");
      if (n === 0) delete S.ent[d.id];
      else S.ent[d.id] = n;
    },
  };
  // 画像が読めなかったとき(消された・壊れている)は、その商品だけ頭文字のタイルに戻す
  root.addEventListener(
    "error",
    (e) => {
      const t = e.target;
      if (!t || t.tagName !== "IMG" || !t.dataset.img) return;
      const m = item(t.dataset.img);
      if (!m || !m.image) return;
      m.image = null;
      render();
    },
    true,
  );
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled || !ACT[b.dataset.act]) return;
    ACT[b.dataset.act](b.dataset);
    if (
      b.dataset.act !== "order" &&
      b.dataset.act !== "pay" &&
      b.dataset.act !== "start"
    )
      render();
  });

  // ---------- 起動 ----------
  (async () => {
    render();
    const q = new URLSearchParams(location.search);
    S.table = q.get("table");
    S.key = q.get("key");
    try {
      S.menu = await api("GET", "/api/public/menu");
    } catch (e) {
      return fail(e.message);
    }
    const saved = load();
    if (saved && saved.sid && (!S.table || saved.table === S.table)) {
      S.sid = saved.sid;
      S.table = saved.table;
      const ok = await refresh(true);
      if (ok && !S.sess)
        return fail(
          "通信できませんでした。電波の状態を確認して、ページを再読み込みしてください。",
          "init-network",
        );
      if (ok) {
        S.screen = S.sess.state === "paying" ? "paying" : "menu";
        stripKey();
        startWs();
        return render();
      }
    }
    if (!S.table || !S.key) return fail("お席のQRコードを読み取ってください。");
    // すでに同じ席の方が手続きを済ませているなら、人数・ドリンクの選択は飛ばして、その卓に入る
    try {
      const j = await api("POST", "/api/public/sessions/join", {
        body: { table: S.table, key: S.key },
      });
      if (j.active) {
        S.sid = j.sessionId;
        save({ sid: S.sid, table: S.table });
        const ok = await refresh(true);
        if (ok && !S.sess)
          return fail(
            "通信できませんでした。電波の状態を確認して、ページを再読み込みしてください。",
            "join-network",
          );
        if (ok) {
          S.screen = S.sess.state === "paying" ? "paying" : "menu";
          stripKey();
          startWs();
          return render();
        }
      }
    } catch (e) {
      if (e.code === "invalid_qr") return fail(e.message, "join-invalid_qr");
      // それ以外(通信エラーなど)は、従来どおり人数の選択へ進む
      console.debug("[join]", e.status, e.code);
    }
    S.screen = "menu";
    S.step = "people";
    render();
    const menuTimer = setInterval(() => {
      if (S.sid || !S.step) return clearInterval(menuTimer);
      if (!document.hidden && !S.busy) refreshMenu();
    }, 5000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !S.sid && S.step && !S.busy) refreshMenu();
    });
  })();
})();