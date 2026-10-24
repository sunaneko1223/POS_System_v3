'use strict';
const { AppError } = require('./error');

// リクエスト本文を zod のスキーマで検証し、検証済みの値に置き換えます。
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body ?? {}); // 本文なしのリクエストは、空のオブジェクトとして検証する
    if (!result.success) {
      return next(new AppError(400, 'invalid_input', '入力内容が正しくありません'));
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validateBody };
