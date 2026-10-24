'use strict';
// エラーの形を統一します: { error: { code, message } }。内部の情報は客に出しません。

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: '見つかりません' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
  }
  // express.json が出すエラー(壊れたJSON、大きすぎる本文)
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: '送られた内容を読み取れませんでした' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: '送られた内容が大きすぎます' } });
  }
  console.error('[error]', req.method, req.path, err);
  res.status(500).json({ error: { code: 'internal', message: 'サーバーでエラーが起きました' } });
}

module.exports = { AppError, notFound, errorHandler };
