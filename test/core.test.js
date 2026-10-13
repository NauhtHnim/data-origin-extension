const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/core.js');

const src = (url, body, extra) => Object.assign({ kind: 'fetch', method: 'GET', url, status: 200, t: 1, body: JSON.stringify(body) }, extra);
const one = (text) => core.parseDisplayed(text)[0];
const paths = (r) => r.hits.map((h) => h.path);

test('parses currency, commas, suffixes, percent, sign', () => {
  assert.strictEqual(one('$1,234.56').value, 1234.56);
  assert.strictEqual(one('$1.23K').value, 1230);
  assert.strictEqual(one('$1.23K').unit, 10);
  assert.strictEqual(one('4.5M').value, 4500000);
  assert.strictEqual(one('12.5%').percent, true);
  assert.strictEqual(one('−3.2%').value, -3.2);
  assert.strictEqual(one('12 Mar').value, 12);
});

test('expands subscript-zero prices', () => {
  const t = one('$0.0₅123');
  assert.ok(Math.abs(t.value - 0.00000123) < 1e-15);
  assert.strictEqual(t.sig, 3);
});

test('matches a rounded and suffixed value to its raw field', () => {
  const sources = [src('https://x/api/tokens', { data: { items: [{ mcap: 999 }, { mcap: 1234.5678, name: 'PEPE' }] } })];
  const r = core.findMatches(one('$1.23K'), sources);
  assert.deepStrictEqual(paths(r), ['data.items[1].mcap']);
  assert.strictEqual(r.hits[0].scale.f, 1);
});

test('matches truncation as well as rounding', () => {
  const r = core.findMatches(one('1.23'), [src('u', { v: 1.239 })]);
  assert.strictEqual(r.hits.length, 1);
});

test('matches a ratio shown as percent', () => {
  const r = core.findMatches(one('12.5%'), [src('u', { apy: 0.12549, other: 7 })]);
  assert.deepStrictEqual(paths(r), ['apy']);
  assert.strictEqual(r.hits[0].scale.f, 100);
});

test('matches wei and 6-decimal strings', () => {
  const sources = [src('u', { bal: '1234500000000000000', usdc: '2500000' })];
  assert.deepStrictEqual(paths(core.findMatches(one('1.2345'), sources)), ['bal']);
  assert.deepStrictEqual(paths(core.findMatches(one('2.50'), sources)), ['usdc']);
});

test('prefers the unscaled match over a scaled one', () => {
  const r = core.findMatches(one('1.50'), [src('u', { cents: 150, usd: 1.5 })]);
  assert.deepStrictEqual(paths(r), ['usd', 'cents']);
});

test('does not rescale when few digits are shown', () => {
  const r = core.findMatches(one('5'), [src('u', { a: 5, b: 500, c: 0.05 })]);
  assert.deepStrictEqual(paths(r), ['a']);
  assert.ok(r.note);
});

test('collapses repeats of the same field and keeps the newest', () => {
  const sources = [
    src('u', { rows: [{ p: 42.17 }, { p: 42.17 }] }, { t: 1 }),
    src('u', { rows: [{ p: 42.17 }] }, { t: 5 }),
  ];
  const r = core.findMatches(one('42.17'), sources);
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].count, 3);
  assert.strictEqual(r.hits[0].source.t, 5);
});

test('reads socket frames and line-delimited bodies', () => {
  const ws = { kind: 'ws', method: 'WS', url: 'wss://x', t: 1, body: '{"price":3.14159}' };
  const sse = { kind: 'fetch', method: 'GET', url: 'u', t: 1, body: 'data: {"a":1}\n\ndata: {"price":3.14159}\n' };
  assert.strictEqual(core.findMatches(one('3.142'), [ws]).hits.length, 1);
  assert.strictEqual(core.findMatches(one('3.142'), [sse]).hits[0].path, 'line3:price');
});

test('matches on-screen text against string fields', () => {
  const r = core.findText('pepe', [src('u', { items: [{ name: 'PEPE' }, { name: 'PEPE2' }] })]);
  assert.deepStrictEqual(paths(r), ['items[0].name']);
});

test('builds a curl command', () => {
  const c = core.buildCurl({ kind: 'fetch', method: 'POST', url: 'https://x/a', reqHeaders: { 'content-type': 'application/json' }, reqBody: '{"q":"it\'s"}' });
  assert.strictEqual(c, `curl 'https://x/a' -X POST -H 'content-type: application/json' --data-raw '{"q":"it'\\''s"}'`);
});

test('ranks an exact rescaled fit above a loose one', () => {
  const r = core.findMatches(one('1.2345'), [src('u', { marketCap: 1234567.89, balanceWei: '1234500000000000000' })]);
  assert.deepStrictEqual(paths(r), ['balanceWei', 'marketCap']);
});

test('locates the hit line inside the pretty-printed response', () => {
  const source = src('u', { data: { items: [{ mcap: 1 }, { mcap: 1234.5678, 'odd key': 'x' }] } });
  const hit = core.findMatches(one('$1.23K'), [source]).hits[0];
  const out = core.locate(source, hit.path);
  assert.strictEqual(out.lines[out.index].trim(), '"mcap": 1234.5678,');
  assert.deepStrictEqual(JSON.parse(out.lines.join('\n')), JSON.parse(source.body));
});

test('locates a hit inside a line-delimited body', () => {
  const sse = { kind: 'fetch', method: 'GET', url: 'u', t: 1, body: 'data: {"a":1}\n\ndata: {"price":3.14159}\n' };
  const out = core.locate(sse, 'line3:price');
  assert.strictEqual(out.lines[out.index].trim(), '"price": 3.14159');
});
