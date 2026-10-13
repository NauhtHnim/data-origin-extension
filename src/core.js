// Pure matching logic. No DOM, no network: runs in the page and in node tests.
(function (root) {
  'use strict';

  const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
  const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

  // displayed = raw * factor. Order is the ranking: earlier = more likely.
  const SCALES = [
    { f: 1, label: 'same value' },
    { f: 100, label: 'raw × 100 (ratio shown as %)' },
    { f: 0.01, label: 'raw ÷ 100 (cents, or bps shown as %)' },
    { f: 1e-3, label: 'raw ÷ 1e3' },
    { f: 1e-4, label: 'raw ÷ 1e4 (bps)' },
    { f: 1e-6, label: 'raw ÷ 1e6 (6 decimals)' },
    { f: 1e-8, label: 'raw ÷ 1e8 (8 decimals)' },
    { f: 1e-9, label: 'raw ÷ 1e9 (gwei)' },
    { f: 1e-18, label: 'raw ÷ 1e18 (wei)' },
  ];

  // "0.0₅123" means 0.00000123 (five zeros after the dot).
  function expandSubscript(text) {
    return text.replace(/0\.0([₀-₉]+)(\d+)/g, (_, sub, digits) => {
      let n = 0;
      for (const ch of sub) n = n * 10 + SUBSCRIPT.indexOf(ch);
      return '0.' + '0'.repeat(n) + digits;
    });
  }

  const NUM_RE = /([-−])?\$?\s?(\d[\d,]*(?:\.\d+)?)\s?([KkMmBbTt](?![A-Za-z]))?\s?(%)?/g;

  // Turn on-screen text into numeric tokens with the precision that was shown.
  function parseDisplayed(text) {
    const out = [];
    if (!text) return out;
    const src = expandSubscript(String(text));
    let m;
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(src))) {
      const digits = m[2].replace(/,+$/, '').replace(/,/g, '');
      const base = parseFloat(digits);
      if (!isFinite(base)) continue;
      const mult = m[3] ? SUFFIX[m[3].toLowerCase()] : 1;
      const dot = digits.indexOf('.');
      const decimals = dot === -1 ? 0 : digits.length - dot - 1;
      const sig = digits.replace('.', '').replace(/^0+/, '').length;
      out.push({
        text: m[0].trim(),
        value: (m[1] ? -1 : 1) * base * mult,
        unit: Math.pow(10, -decimals) * mult, // size of the last shown digit
        sig,
        percent: !!m[4],
      });
    }
    return out;
  }

  const NUMERIC_STRING = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i;

  // Walk a parsed JSON value and call cb(path, raw) for every leaf.
  function flatten(value, cb, maxLeaves) {
    const stack = [['', value]];
    let count = 0;
    while (stack.length) {
      const [path, v] = stack.pop();
      if (v === null || v === undefined) continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) {
          for (let i = v.length - 1; i >= 0; i--) stack.push([path + '[' + i + ']', v[i]]);
        } else {
          const keys = Object.keys(v);
          for (let i = keys.length - 1; i >= 0; i--) {
            const k = keys[i];
            const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? (path ? '.' + k : k) : '[' + JSON.stringify(k) + ']';
            stack.push([path + seg, v[k]]);
          }
        }
        continue;
      }
      if (typeof v === 'number' || typeof v === 'string') {
        cb(path || '(root)', v);
        if (++count >= (maxLeaves || 200000)) return;
      }
    }
  }

  // A body is a JSON string, an already parsed object, NDJSON, or SSE-style lines.
  function parseBody(body) {
    if (body === null || body === undefined) return [];
    if (typeof body === 'object') return [{ prefix: '', value: body }];
    const text = String(body).trim();
    if (!text) return [];
    try {
      return [{ prefix: '', value: JSON.parse(text) }];
    } catch (e) { /* fall through to line mode */ }
    const docs = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && docs.length < 2000; i++) {
      const line = lines[i].replace(/^data:\s*/, '').trim();
      if (line[0] !== '{' && line[0] !== '[') continue;
      try {
        docs.push({ prefix: 'line' + (i + 1) + ':', value: JSON.parse(line) });
      } catch (e) { /* not JSON, skip */ }
    }
    return docs;
  }

  function sourceKey(s) {
    return s.method + ' ' + s.url;
  }

  // Find every leaf whose value, under one of the known scalings, rounds or
  // truncates to what the screen shows.
  function findMatches(token, sources, opts) {
    const limit = (opts && opts.limit) || 40;
    const target = Math.abs(token.value);
    if (target === 0) return { hits: [], note: 'Zero matches too many fields to trace.' };
    // Few shown digits match too much, so only try rescaling with enough digits.
    const scales = SCALES.filter((s, i) => i === 0 || token.sig >= 3 || (i === 1 && token.percent && token.sig >= 2));
    const tol = token.unit * 1.0000001 + target * 1e-12;
    const grouped = new Map();

    for (const src of sources) {
      for (const doc of parseBody(src.body)) {
        flatten(doc.value, (path, raw) => {
          let n;
          if (typeof raw === 'number') n = raw;
          else if (raw.length <= 80 && NUMERIC_STRING.test(raw)) n = Number(raw);
          else return;
          if (!isFinite(n) || n === 0) return;
          const abs = Math.abs(n);
          for (let i = 0; i < scales.length; i++) {
            const err = Math.abs(abs * scales[i].f - target);
            if (err > tol) continue;
            // Collapse repeats (list rows, polling, socket frames) of the same
            // field on the same endpoint.
            const generic = path.replace(/\[\d+\]/g, '[]');
            const key = sourceKey(src) + '|' + generic + '|' + i;
            const prev = grouped.get(key);
            const hit = {
              source: src,
              path: doc.prefix + path,
              raw,
              scale: scales[i],
              scaleRank: SCALES.indexOf(scales[i]),
              err: err / token.unit,
              exact: err <= target * 1e-12,
              count: prev ? prev.count + 1 : 1,
            };
            if (!prev || src.t >= prev.source.t) grouped.set(key, hit);
            else prev.count++;
            return; // best scale for this leaf found
          }
        });
      }
    }

    // Unscaled matches first. Among rescaled ones, how well the value fits
    // (exact, then consistent with rounding, then only with truncation)
    // matters more than which scaling it was.
    const fit = (h) => (h.exact ? 0 : h.err <= 0.5000001 ? 1 : 2);
    const hits = Array.from(grouped.values()).sort(
      (a, b) =>
        (a.scaleRank ? 1 : 0) - (b.scaleRank ? 1 : 0) ||
        fit(a) - fit(b) ||
        a.scaleRank - b.scaleRank ||
        a.err - b.err ||
        b.source.t - a.source.t
    );
    const note = token.sig < 3 ? 'Only ' + token.sig + ' digit(s) shown, so matches are weak.' : '';
    return { hits: hits.slice(0, limit), total: hits.length, note };
  }

  // Exact (case-insensitive) match of on-screen text against string fields.
  function findText(text, sources, opts) {
    const limit = (opts && opts.limit) || 20;
    const needle = String(text || '').trim().toLowerCase();
    if (needle.length < 3 || needle.length > 200) return { hits: [], total: 0 };
    const grouped = new Map();
    for (const src of sources) {
      for (const doc of parseBody(src.body)) {
        flatten(doc.value, (path, raw) => {
          if (typeof raw !== 'string' || raw.length !== needle.length) return;
          if (raw.toLowerCase() !== needle) return;
          const key = sourceKey(src) + '|' + path.replace(/\[\d+\]/g, '[]');
          const prev = grouped.get(key);
          const hit = { source: src, path: doc.prefix + path, raw, scale: { f: 1, label: 'same text' }, exact: true, count: prev ? prev.count + 1 : 1 };
          if (!prev || src.t >= prev.source.t) grouped.set(key, hit);
          else prev.count++;
        });
      }
    }
    const hits = Array.from(grouped.values()).sort((a, b) => b.source.t - a.source.t);
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  // Pretty-print a parsed JSON value. Returns the lines and the index of the
  // line holding the leaf at targetPath (same path syntax as flatten).
  function prettyLines(value, targetPath) {
    const lines = [];
    let index = -1;
    const walk = (v, path, indent, prefix, comma) => {
      if (v !== null && typeof v === 'object') {
        const isArr = Array.isArray(v);
        const keys = isArr ? null : Object.keys(v);
        const n = isArr ? v.length : keys.length;
        if (!n) { lines.push(indent + prefix + (isArr ? '[]' : '{}') + comma); return; }
        lines.push(indent + prefix + (isArr ? '[' : '{'));
        for (let i = 0; i < n; i++) {
          const tail = i < n - 1 ? ',' : '';
          if (isArr) walk(v[i], path + '[' + i + ']', indent + '  ', '', tail);
          else {
            const k = keys[i];
            const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? (path ? '.' + k : k) : '[' + JSON.stringify(k) + ']';
            walk(v[k], path + seg, indent + '  ', JSON.stringify(k) + ': ', tail);
          }
        }
        lines.push(indent + (isArr ? ']' : '}') + comma);
        return;
      }
      if ((path || '(root)') === targetPath) index = lines.length;
      lines.push(indent + prefix + JSON.stringify(v) + comma);
    };
    walk(value, '', '', '', '');
    return { lines, index };
  }

  // The response document a hit lives in, pretty-printed around the hit.
  function locate(source, hitPath) {
    const docs = parseBody(source.body);
    for (const doc of docs) {
      if (doc.prefix && hitPath.indexOf(doc.prefix) !== 0) continue;
      const out = prettyLines(doc.value, hitPath.slice(doc.prefix.length));
      if (out.index !== -1) return out;
    }
    return docs.length ? prettyLines(docs[0].value, null) : { lines: [String(source.body)], index: -1 };
  }

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function buildCurl(src) {
    if (src.kind === 'ws' || src.kind === 'ssr') return '# not an HTTP request: ' + src.url;
    const parts = ['curl', shellQuote(src.url)];
    if (src.method && src.method !== 'GET') parts.push('-X', src.method);
    const headers = src.reqHeaders || {};
    for (const k of Object.keys(headers)) parts.push('-H', shellQuote(k + ': ' + headers[k]));
    if (src.reqBody) parts.push('--data-raw', shellQuote(src.reqBody));
    return parts.join(' ');
  }

  const api = { parseDisplayed, expandSubscript, flatten, parseBody, findMatches, findText, buildCurl, prettyLines, locate, SCALES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__dataOriginCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
