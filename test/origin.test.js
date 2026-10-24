'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { originAllowed } = require('../server/middleware/origin');

test('Originが無い接続は通す(認証は別に必要)', () => {
  assert.equal(originAllowed({ host: 'a.example' }, ''), true);
});

test('Originのホストが、接続先のホストと同じなら通す', () => {
  assert.equal(originAllowed({ host: 'a.example', origin: 'https://a.example' }, ''), true);
  assert.equal(originAllowed({ host: 'A.example', origin: 'https://a.EXAMPLE' }, ''), true);
});

test('別のサイトからのOriginは断る', () => {
  assert.equal(originAllowed({ host: 'a.example', origin: 'https://evil.example' }, ''), false);
  assert.equal(originAllowed({ host: 'a.example', origin: 'null' }, ''), false);
  assert.equal(originAllowed({ host: 'a.example', origin: 'not a url' }, ''), false);
});

test('x-forwarded-host と PUBLIC_BASE_URL のホストも許可する', () => {
  assert.equal(
    originAllowed({ host: 'internal:3000', 'x-forwarded-host': 'a.example', origin: 'https://a.example' }, ''),
    true
  );
  assert.equal(originAllowed({ host: 'internal:3000', origin: 'https://b.example' }, 'https://b.example/'), true);
  assert.equal(originAllowed({ host: 'internal:3000', origin: 'https://c.example' }, 'https://b.example/'), false);
});
