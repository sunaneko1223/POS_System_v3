'use strict';
// サーバー内のできごとの通知口。あとで WebSocket がここを聞いて、画面に反映します。
//   'session.changed' { table, sessionId, state }
//   'order.created'   { table, sessionId, orderId }
//   'item.served'     { table, sessionId, itemId }
const { EventEmitter } = require('events');
const events = new EventEmitter();
events.setMaxListeners(50);
module.exports = events;
