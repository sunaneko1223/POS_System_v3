'use strict';
// WebSocket の接続元(Origin)の確認。他のサイトのページから、勝手につながれるのを防ぐ。
// Origin が無い接続(ブラウザ以外のツール)は通す。その場合も、あとで必ず認証が要る。

function firstHost(v) {
  return String(v || '').split(',')[0].trim().toLowerCase();
}

function allowedHosts(headers, publicBaseUrl) {
  const hosts = new Set();
  if (headers.host) hosts.add(firstHost(headers.host));
  if (headers['x-forwarded-host']) hosts.add(firstHost(headers['x-forwarded-host']));
  if (publicBaseUrl) {
    try {
      hosts.add(new URL(publicBaseUrl).host.toLowerCase());
    } catch {
      /* 不正な値は無視 */
    }
  }
  return hosts;
}

function originAllowed(headers, publicBaseUrl) {
  const origin = headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts(headers, publicBaseUrl).has(host);
}

module.exports = { originAllowed };
