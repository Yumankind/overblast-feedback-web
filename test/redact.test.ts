import { test } from 'node:test';
import assert from 'node:assert/strict';
import './dom.ts';
import { contextUrl, luhn, networkUrl, redact, REDACTED } from '../src/redact.ts';

test('bearer tokens lose the credential and keep the scheme', () => {
  assert.equal(redact('Authorization: Bearer abcDEF123456.xyz-_~+/='), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('Basic dXNlcjpwYXNzd29yZA=='), `Basic ${REDACTED}`);
  // Prose that happens to follow the word is left alone.
  assert.equal(redact('Basic information about the cart'), 'Basic information about the cart');
});

test('API keys by their prefixes', () => {
  const keys = [
    'sk-proj-abcdefghijklmnopqrstuvwx',
    'sk-ant-api03-abcdefghijklmnop',
    'sk_live_51HabcdEFGHijkl',
    'rk_test_abcdefgh1234',
    'ob_live_abcdef1234567890',
    'ob_test_abcdef1234567890',
    'obfk_ABCDEFGHIJKLMNOPQRSTUVWX',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  ];
  for (const k of keys) {
    const out = redact(`using key ${k} now`);
    assert.equal(out, `using key ${REDACTED} now`, k);
  }
});

test('JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(redact(`session ${jwt}`), `session ${REDACTED}`);
});

test('card numbers: Luhn-valid and issuer-like only', () => {
  assert.equal(luhn('4242424242424242'), true);
  assert.equal(luhn('4242424242424241'), false);
  assert.equal(redact('card 4242 4242 4242 4242 declined'), `card ${REDACTED} declined`);
  assert.equal(redact('card 4242-4242-4242-4242'), `card ${REDACTED}`);
  assert.equal(redact('amex 378282246310005'), `amex ${REDACTED}`);
  // Fails Luhn: kept.
  assert.equal(redact('order 4242424242424241'), 'order 4242424242424241');
  // A millisecond timestamp passes Luhn one time in ten, and starts with 1: kept.
  for (const t of ['1760440000123', '1760440000124', '1760440000125', '1760440000126', '1760440000127']) {
    assert.equal(redact(`t=${t}`), `t=${t}`);
  }
  // Too short or too long: kept.
  assert.equal(redact('424242424242'), '424242424242');
});

test('secret pairs keep the name, lose the value', () => {
  assert.equal(redact('login password=hunter2&user=ana'), `login password=${REDACTED}&user=ana`);
  assert.equal(redact('{"token":"abc.def","id":3}'), `{"token":"${REDACTED}","id":3}`);
  assert.equal(redact("access_token: 'xyz'"), `access_token: '${REDACTED}'`);
  assert.equal(redact('client_secret = s3cr3t'), `client_secret = ${REDACTED}`);
  assert.equal(redact('X-Api-Key: abc123'), `X-Api-Key: ${REDACTED}`);
  // Words that only contain the names are left alone.
  assert.equal(redact('max_tokens=1200 tokenizer=cl100k author: Ana'), 'max_tokens=1200 tokenizer=cl100k author: Ana');
});

test('redaction is idempotent', () => {
  const once = redact('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc password=x Bearer abcdefghijkl');
  assert.equal(redact(once), once);
  assert.ok(!once.includes(']]'));
});

test('context url: fragment dropped, query kept, token-like values redacted', () => {
  assert.equal(contextUrl('https://a.example/cart?step=2&token=abc#frag'), `https://a.example/cart?step=2&token=${REDACTED}`);
  assert.equal(
    contextUrl('https://a.example/cb?code=xyz&state=123&Access_Token=q&page=4'),
    `https://a.example/cb?code=${REDACTED}&state=${REDACTED}&Access_Token=${REDACTED}&page=4`,
  );
  // Relative to the page.
  assert.equal(contextUrl('/x?y=1'), 'https://shop.example.com/x?y=1');
  assert.ok(contextUrl(`https://a.example/${'p'.repeat(3000)}`).length <= 2000);
});

test('network url: no query, no fragment, ≤ 500', () => {
  assert.equal(networkUrl('https://api.example.com/cart?id=3&token=x#y'), 'https://api.example.com/cart');
  assert.equal(networkUrl('/api/items?q=1'), 'https://shop.example.com/api/items');
  assert.equal(networkUrl('data:text/plain,hello'), 'data:…');
  assert.ok(networkUrl(`https://a.example/${'p'.repeat(800)}`).length <= 500);
  // A secret in the path is still redacted.
  assert.equal(networkUrl('https://api.example.com/v1/keys/sk-proj-abcdefghijklmnopqrstuv'), `https://api.example.com/v1/keys/${REDACTED}`);
});
