'use strict';
const rateLimit = require('express-rate-limit');

function make(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'too_many_requests', message: 'リクエストが多すぎます。少し待ってからもう一度お試しください。' },
      });
    },
  });
}

// apiPerMin は config.yml の security.api_limit_per_min
function createLimiters(apiPerMin) {
  return {
    pingLimiter: make(60 * 1000, 120),
    apiLimiter: make(60 * 1000, apiPerMin),
    loginLimiter: make(60 * 1000, 20),
  };
}

module.exports = { createLimiters };
