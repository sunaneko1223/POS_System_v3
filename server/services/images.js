'use strict';
// メニューの画像。web/public/images/ に「商品名.拡張子」(例: ラムネ.jpg)で置くと、お客様の画面に出る。
// 置かれたファイルは、10秒ごとに見直す(再起動なしで、足したり消したりできる)。
const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'web', 'public', 'images');
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const TTL_MS = 10000;
const URL_BASE = '/public/images/';

// 日本語のファイル名は、OSによって濁点の持ち方がちがう(「ド」が1文字か2文字か)。そろえてから比べる。
const norm = (s) => String(s).normalize('NFC');

function createImageIndex(dir = DEFAULT_DIR, now = Date.now) {
  let at = -Infinity;
  let map = new Map();

  function load() {
    const t = now();
    if (t - at < TTL_MS) return map;
    at = t;
    const next = new Map();
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (!EXT.has(ext)) continue; // 画像以外(README.txt など)は、無視する
        const base = norm(path.basename(f, path.extname(f)));
        if (!next.has(base)) next.set(base, f); // 同じ名前が複数あるときは、ファイル名の早いほう
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[画像] フォルダを読めませんでした:', e.message);
    }
    map = next;
    return map;
  }

  // 商品名 → 画像のURL(なければ null)
  function imageFor(name) {
    const f = load().get(norm(name));
    return f ? URL_BASE + encodeURIComponent(f) : null;
  }
  return { imageFor };
}

module.exports = { createImageIndex };