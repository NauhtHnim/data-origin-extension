// Runs in the page's own JS world at document_start. Records response bodies,
// then maps a clicked on-screen value back to the request and JSON path.
// Nothing leaves the page: no storage, no network calls of its own.
(function () {
  'use strict';
  if (window.__dataOrigin) return;
  const core = window.__dataOriginCore;
  if (!core) return;

  const MAX_BODY = 8 * 1024 * 1024; // skip single bodies above this
  const MAX_HTTP_BYTES = 80 * 1024 * 1024; // total kept, oldest dropped first
  const MAX_WS_FRAMES = 800;

  const http = [];
  const ws = [];
  let httpBytes = 0;
  let seq = 0;

  function absUrl(u) {
    try { return new URL(u, location.href).href; } catch (e) { return String(u); }
  }

  function addHttp(rec) {
    rec.id = ++seq;
    rec.t = Date.now();
    rec.size = typeof rec.body === 'string' ? rec.body.length : rec.size || 50000;
    http.push(rec);
    httpBytes += rec.size;
    while (httpBytes > MAX_HTTP_BYTES && http.length > 1) httpBytes -= http.shift().size;
    refreshCount();
  }

  function addWs(url, data) {
    ws.push({ id: ++seq, t: Date.now(), kind: 'ws', method: 'WS', url, status: '', body: data });
    if (ws.length > MAX_WS_FRAMES) ws.shift();
    refreshCount();
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) h.forEach((p) => { out[p[0]] = p[1]; });
      else Object.assign(out, h);
    } catch (e) { /* ignore */ }
    return out;
  }

  // ---- capture: fetch ------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const promise = origFetch.apply(this, arguments);
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof Request;
        const url = absUrl(isReq ? input.url : input);
        const method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
        const reqHeaders = headersToObject((init && init.headers) || (isReq ? input.headers : null));
        const reqBody = init && typeof init.body === 'string' ? init.body : null;
        promise.then((res) => {
          try {
            const type = res.headers.get('content-type') || '';
            if (!/json|text\/plain/i.test(type)) return;
            if (Number(res.headers.get('content-length') || 0) > MAX_BODY) return;
            res.clone().text().then((text) => {
              if (text.length <= MAX_BODY) addHttp({ kind: 'fetch', method, url, status: res.status, body: text, reqHeaders, reqBody });
            }, () => {});
          } catch (e) { /* never break the page */ }
        }, () => {});
      } catch (e) { /* never break the page */ }
      return promise;
    };
  }

  // ---- capture: XMLHttpRequest ---------------------------------------------
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open, send = XHR.send, setHeader = XHR.setRequestHeader;
    XHR.open = function (method, url) {
      this.__do = { method: String(method || 'GET').toUpperCase(), url: absUrl(url), reqHeaders: {} };
      return open.apply(this, arguments);
    };
    XHR.setRequestHeader = function (k, v) {
      if (this.__do) this.__do.reqHeaders[k] = v;
      return setHeader.apply(this, arguments);
    };
    XHR.send = function (body) {
      const meta = this.__do;
      if (meta) {
        meta.reqBody = typeof body === 'string' ? body : null;
        this.addEventListener('load', () => {
          try {
            let payload = null, size;
            if (this.responseType === '' || this.responseType === 'text') payload = this.responseText;
            else if (this.responseType === 'json') { payload = this.response; size = Number(this.getResponseHeader('content-length')) || 50000; }
            if (payload === null || payload === undefined) return;
            if (typeof payload === 'string' && (payload.length > MAX_BODY || !/^\s*[\[{]/.test(payload))) return;
            addHttp({ kind: 'xhr', method: meta.method, url: meta.url, status: this.status, body: payload, size, reqHeaders: meta.reqHeaders, reqBody: meta.reqBody });
          } catch (e) { /* never break the page */ }
        });
      }
      return send.apply(this, arguments);
    };
  }

  // ---- capture: WebSocket --------------------------------------------------
  if (window.WebSocket) {
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        const socket = new target(...args);
        try {
          socket.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string' && ev.data.length < 1e6) addWs(socket.url, ev.data);
          });
        } catch (e) { /* never break the page */ }
        return socket;
      },
    });
  }

  // Server-rendered data never appears as a request, so read it from the page.
  function ssrSources() {
    const out = [];
    const el = document.getElementById('__NEXT_DATA__');
    if (el && el.textContent) out.push({ id: 0, t: 0, kind: 'ssr', method: 'HTML', url: location.href + ' (__NEXT_DATA__)', status: '', body: el.textContent });
    return out;
  }

  function allSources() {
    return ssrSources().concat(http, ws);
  }

  // ---- UI ------------------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    .panel { position: fixed; right: 12px; bottom: 12px; width: 460px; max-width: calc(100vw - 24px); max-height: 70vh;
      display: flex; flex-direction: column; background: #14161a; color: #e6e8eb; border: 1px solid #343a43; border-radius: 8px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; z-index: 2147483647; }
    .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #343a43; }
    .title { font-weight: 700; color: #fff; }
    .count { color: #8b93a0; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { font: inherit; color: #e6e8eb; background: #232830; border: 1px solid #3c434e; border-radius: 4px; padding: 2px 7px; cursor: pointer; }
    button:hover { background: #2f3642; }
    button.on { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    .search { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #343a43; }
    input { flex: 1; min-width: 0; font: inherit; color: #e6e8eb; background: #0d0f12; border: 1px solid #3c434e; border-radius: 4px; padding: 3px 6px; }
    .body { overflow: auto; padding: 4px 10px 10px; }
    .hint { color: #8b93a0; padding: 8px 0; }
    .token { margin-top: 10px; padding-bottom: 4px; color: #fff; font-weight: 700; border-bottom: 1px dashed #343a43; }
    .token small { color: #8b93a0; font-weight: 400; }
    .note { color: #d29922; padding-top: 4px; }
    .hit { padding: 7px 0; border-bottom: 1px solid #23272e; }
    .req { display: flex; gap: 6px; align-items: baseline; }
    .method { color: #79c0ff; }
    .status { color: #7ee787; }
    .status.bad { color: #ff7b72; }
    .url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
    .age { color: #8b93a0; white-space: nowrap; }
    .path { color: #ffa657; word-break: break-all; }
    .raw { color: #a5d6ff; word-break: break-all; }
    .tags { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 4px; }
    .tag { color: #8b93a0; border: 1px solid #343a43; border-radius: 10px; padding: 0 6px; }
    .tag.exact { color: #7ee787; border-color: #2f6f3e; }
    .tag.scaled { color: #d29922; border-color: #6b5417; }
    .spacer { flex: 1; }
    .back { display: flex; gap: 6px; align-items: center; padding: 8px 0 6px; }
    .sect { color: #8b93a0; margin-top: 10px; }
    .kv { word-break: break-all; }
    .kv i { color: #8b93a0; font-style: normal; }
    pre { margin: 4px 0 0; padding: 6px 0; background: #0d0f12; border: 1px solid #23272e; border-radius: 4px; overflow: auto;
      max-height: 36vh; white-space: pre; font: inherit; }
    pre span { display: block; padding: 0 8px; min-width: max-content; }
    pre .mark { background: #5a3b00; color: #fff; outline: 1px solid #ffa657; }
    .panel.wide { width: 640px; }
    .box { position: fixed; pointer-events: none; border: 2px solid #1f6feb; background: rgba(31,111,235,.12); border-radius: 2px; z-index: 2147483646; display: none; }
    .box.picked { border-color: #ffa657; background: rgba(255,166,87,.12); }
  `;

  let host, shadow, panel, bodyEl, countEl, pickBtn, inputEl, hoverBox, pickedBox;
  let picking = false;
  let lastTexts = [];
  const CONTEXT_LINES = 400; // lines kept either side of the hit in the viewer

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'onclick') el.addEventListener('click', attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    for (let i = 2; i < arguments.length; i++) if (arguments[i]) el.append(arguments[i]);
    return el;
  }

  function ensureUi() {
    if (host) {
      if (!host.isConnected) document.documentElement.append(host);
      return;
    }
    host = document.createElement('data-origin-panel');
    shadow = host.attachShadow({ mode: 'open' });
    // A constructed sheet is not blocked by the page's style CSP.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];

    countEl = h('span', { class: 'count' });
    pickBtn = h('button', { text: 'pick', title: 'Click a value on the page (Esc cancels)', onclick: () => setPicking(!picking) });
    inputEl = h('input', { placeholder: 'or type a value: 1.23K, 12.5%, a name…', spellcheck: 'false' });
    inputEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') traceTexts([inputEl.value]);
    });
    bodyEl = h('div', { class: 'body' }, h('div', { class: 'hint', text: 'Press pick, then click a number on the page. Alt+Shift+click works any time.' }));
    panel = h('div', { class: 'panel' },
      h('div', { class: 'head' },
        h('span', { class: 'title', text: 'Data Origin' }), countEl, pickBtn,
        h('button', { text: 'clear', title: 'Forget captured responses', onclick: clearAll }),
        h('button', { text: '×', title: 'Close', onclick: () => api.hide() })),
      h('div', { class: 'search' }, inputEl, h('button', { text: 'find', onclick: () => traceTexts([inputEl.value]) })),
      bodyEl);
    hoverBox = h('div', { class: 'box' });
    pickedBox = h('div', { class: 'box picked' });
    shadow.append(hoverBox, pickedBox, panel);
    document.documentElement.append(host);
    refreshCount();
  }

  function refreshCount() {
    if (countEl) countEl.textContent = http.length + ' responses, ' + ws.length + ' socket frames';
  }

  function clearAll() {
    http.length = 0; ws.length = 0; httpBytes = 0;
    refreshCount();
    bodyEl.replaceChildren(h('div', { class: 'hint', text: 'Cleared. Reload or interact with the page to capture again.' }));
  }

  function placeBox(box, el) {
    if (!el) { box.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left - 2 + 'px';
    box.style.top = r.top - 2 + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function setPicking(on) {
    ensureUi();
    picking = on;
    pickBtn.classList.toggle('on', on);
    if (!on) placeBox(hoverBox, null);
  }

  function inOurUi(ev) {
    return host && ev.composedPath && ev.composedPath().indexOf(host) !== -1;
  }

  function age(t) {
    if (!t) return 'page load';
    const s = Math.round((Date.now() - t) / 1000);
    return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
  }

  function copy(text, btn) {
    const done = () => { const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => { btn.textContent = old; }, 900); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.documentElement.append(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function shortUrl(u) {
    try { const x = new URL(u); return x.origin === location.origin ? x.pathname + x.search : x.host + x.pathname + x.search; } catch (e) { return u; }
  }

  function renderHit(hit) {
    const s = hit.source;
    const tags = h('div', { class: 'tags' });
    if (hit.scale.f !== 1) tags.append(h('span', { class: 'tag scaled', text: hit.scale.label }));
    else tags.append(h('span', { class: 'tag exact', text: hit.exact ? 'exact' : 'rounded' }));
    if (hit.count > 1) tags.append(h('span', { class: 'tag', text: 'seen ×' + hit.count }));
    tags.append(h('span', { class: 'spacer' }));
    tags.append(h('button', { text: 'view', title: 'Show the request and the response with this value highlighted', onclick: () => showDetail(hit) }));
    tags.append(h('button', { text: 'path', title: 'Copy the JSON path', onclick: (e) => copy(hit.path, e.currentTarget) }));
    tags.append(h('button', { text: 'url', title: 'Copy the URL', onclick: (e) => copy(s.url, e.currentTarget) }));
    if (s.kind === 'fetch' || s.kind === 'xhr') tags.append(h('button', { text: 'curl', title: 'Copy as curl (includes request headers)', onclick: (e) => copy(core.buildCurl(s), e.currentTarget) }));
    tags.append(h('button', { text: 'log', title: 'Print the full response to the console', onclick: () => {
      const docs = core.parseBody(s.body);
      console.log('[Data Origin]', s.method, s.url, '\n  path:', hit.path, '\n  raw:', hit.raw, '\n  response:', docs.length === 1 ? docs[0].value : docs.map((d) => d.value));
    } }));
    return h('div', { class: 'hit' },
      h('div', { class: 'req' },
        h('span', { class: 'method', text: s.method }),
        s.status !== '' ? h('span', { class: 'status' + (s.status >= 400 ? ' bad' : ''), text: String(s.status) }) : null,
        h('span', { class: 'url', title: s.url, text: '‎' + shortUrl(s.url) }),
        h('span', { class: 'age', text: age(s.t) })),
      h('div', null, h('span', { class: 'path', text: hit.path }), ' = ', h('span', { class: 'raw', text: JSON.stringify(hit.raw) })),
      tags);
  }

  function kv(label, value) {
    return h('div', { class: 'kv' }, h('i', { text: label + ': ' }), String(value));
  }

  // The in-page stand-in for the Network tab's Headers + Preview: request
  // details, then the response body scrolled to the highlighted value.
  function showDetail(hit) {
    const s = hit.source;
    const located = core.locate(s, hit.path);
    const from = located.index === -1 ? 0 : Math.max(0, located.index - CONTEXT_LINES);
    const to = Math.min(located.lines.length, (located.index === -1 ? 0 : located.index) + CONTEXT_LINES + 1);
    const pre = h('pre');
    let mark = null;
    if (from > 0) pre.append(h('span', { text: '… ' + from + ' lines above' }));
    for (let i = from; i < to; i++) {
      const line = h('span', { text: located.lines[i] || ' ' });
      if (i === located.index) { line.className = 'mark'; mark = line; }
      pre.append(line);
    }
    if (to < located.lines.length) pre.append(h('span', { text: '… ' + (located.lines.length - to) + ' lines below' }));

    const headers = s.reqHeaders || {};
    const headerKeys = Object.keys(headers);
    panel.classList.add('wide');
    bodyEl.replaceChildren(
      h('div', { class: 'back' },
        h('button', { text: '← results', onclick: () => { panel.classList.remove('wide'); traceTexts(lastTexts); } }),
        h('span', { class: 'spacer' }),
        h('button', { text: 'copy url', title: 'Paste into the Network tab filter box to find this request there', onclick: (e) => copy(s.url, e.currentTarget) }),
        s.kind === 'fetch' || s.kind === 'xhr' ? h('button', { text: 'copy curl', onclick: (e) => copy(core.buildCurl(s), e.currentTarget) }) : null),
      h('div', { class: 'req' },
        h('span', { class: 'method', text: s.method }),
        s.status !== '' ? h('span', { class: 'status' + (s.status >= 400 ? ' bad' : ''), text: String(s.status) }) : null,
        h('span', { class: 'age', text: age(s.t) + ' · ' + (s.kind === 'ws' ? 'socket frame' : s.kind) })),
      kv('url', s.url),
      kv('path', hit.path),
      kv('raw value', JSON.stringify(hit.raw) + (hit.scale.f !== 1 ? '  (' + hit.scale.label + ')' : '')));
    if (headerKeys.length) {
      bodyEl.append(h('div', { class: 'sect', text: 'Request headers set by the page' }));
      headerKeys.forEach((k) => bodyEl.append(kv(k, headers[k])));
    }
    if (s.reqBody) {
      let shown = s.reqBody;
      try { shown = JSON.stringify(JSON.parse(s.reqBody), null, 2); } catch (e) { /* keep as sent */ }
      bodyEl.append(h('div', { class: 'sect', text: 'Request body' }), h('pre', null, h('span', { text: shown })));
    }
    bodyEl.append(h('div', { class: 'sect', text: 'Response' + (located.index === -1 ? ' (value line not found)' : ', line ' + (located.index + 1) + ' of ' + located.lines.length) }), pre);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    if (mark) pre.scrollTop = Math.max(0, mark.offsetTop - pre.offsetTop - pre.clientHeight / 2);
  }

  function renderSection(label, sub, result) {
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'token' }, label + ' ', h('small', { text: sub })));
    if (result.note) frag.append(h('div', { class: 'note', text: result.note }));
    if (!result.hits.length) frag.append(h('div', { class: 'hint', text: 'No captured response holds this value.' }));
    result.hits.forEach((hit) => frag.append(renderHit(hit)));
    if (result.total > result.hits.length) frag.append(h('div', { class: 'hint', text: '…and ' + (result.total - result.hits.length) + ' more fields.' }));
    return frag;
  }

  // Trace every numeric token found in the given texts, plus the text itself.
  function traceTexts(texts) {
    ensureUi();
    lastTexts = texts;
    panel.classList.remove('wide');
    const sources = allSources();
    const seen = new Set();
    const tokens = [];
    const results = [];
    for (const text of texts) {
      for (const tok of core.parseDisplayed(text)) {
        const key = tok.value + '|' + tok.unit + '|' + tok.percent;
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(tok);
      }
    }
    bodyEl.replaceChildren();
    tokens.slice(0, 6).forEach((tok) => {
      const r = core.findMatches(tok, sources);
      results.push({ token: tok, result: r });
      bodyEl.append(renderSection(tok.text, 'as number ' + tok.value, r));
    });
    const textSeen = new Set();
    for (const text of texts) {
      const t = String(text || '').trim();
      if (!t || textSeen.has(t.toLowerCase()) || /^[\d\s.,$%+\-−KMBTkmbt₀-₉]*$/.test(t)) continue;
      textSeen.add(t.toLowerCase());
      const r = core.findText(t, sources);
      if (r.hits.length) { results.push({ text: t, result: r }); bodyEl.append(renderSection('"' + t + '"', 'as text', r)); }
    }
    if (!bodyEl.childNodes.length) bodyEl.append(h('div', { class: 'hint', text: 'No number or known text found there. Try a different element, or type the value above.' }));
    else if (!sources.length) bodyEl.prepend(h('div', { class: 'note', text: 'Nothing captured yet. Reload the page so requests are recorded from the start.' }));
    bodyEl.scrollTop = 0;
    return results;
  }

  // One value's worth of text for an element: its rendered text when that is
  // a single line, else its raw text when short ("$" + "1.23" + "K" laid out
  // as flex items renders with line breaks between the parts).
  function valueText(n) {
    const shown = (n.innerText || n.textContent || '').trim();
    if (shown && shown.length <= 60 && !/[\t\n]/.test(shown)) return shown;
    const raw = (n.textContent || '').trim();
    return raw && raw.length <= 14 ? raw : '';
  }

  const squash = (t) => t.replace(/\s/g, '');

  // Texts to trace, best first. Ancestors may only EXTEND the clicked value
  // (so "1.23" becomes "$1.23K"); they never add a neighbouring number.
  function textsAt(el, x, y) {
    const own = [];
    try {
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      const node = range && range.startContainer;
      if (node && node.nodeType === 3 && el.contains(node) && node.nodeValue.trim()) own.push(node.nodeValue.trim());
    } catch (e) { /* ignore */ }
    if (typeof el.value === 'string' && el.value) own.push(el.value);
    const self = valueText(el);
    if (self) own.push(self);
    const ownTokens = [];
    own.forEach((t) => core.parseDisplayed(t).forEach((k) => ownTokens.push(squash(k.text))));

    const extended = [];
    let n = el.parentElement;
    for (let i = 0; i < 3 && n && n !== document.body; i++, n = n.parentElement) {
      const t = valueText(n);
      if (!t) break;
      const tokens = core.parseDisplayed(t).map((k) => k.text);
      if (!ownTokens.length) {
        // Clicked a bare "$" or "K": take the nearest value around it.
        if (tokens.length) { extended.push(...tokens); break; }
        continue;
      }
      tokens.forEach((k) => {
        const s = squash(k);
        if (ownTokens.some((o) => s !== o && s.includes(o))) extended.push(k);
      });
    }
    const out = extended.concat(own);
    ['title', 'aria-label'].forEach((a) => { const v = el.getAttribute && el.getAttribute(a); if (v) out.push(v); });
    return out;
  }

  function pickAt(ev) {
    const el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
    if (!el) return;
    ensureUi();
    placeBox(pickedBox, el);
    setTimeout(() => placeBox(pickedBox, null), 2500);
    traceTexts(textsAt(el, ev.clientX, ev.clientY));
  }

  const swallow = (ev) => {
    if (inOurUi(ev)) return false;
    const wanted = picking || (ev.altKey && ev.shiftKey);
    if (!wanted) return false;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    return true;
  };
  ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach((type) => window.addEventListener(type, swallow, true));
  window.addEventListener('click', (ev) => {
    if (!swallow(ev)) return;
    pickAt(ev);
    setPicking(false);
  }, true);
  window.addEventListener('mousemove', (ev) => {
    if (!picking || inOurUi(ev)) { if (hoverBox) placeBox(hoverBox, null); return; }
    placeBox(hoverBox, ev.target && ev.target.nodeType === 1 ? ev.target : null);
  }, true);
  window.addEventListener('keydown', (ev) => {
    if (picking && ev.key === 'Escape') { ev.stopImmediatePropagation(); setPicking(false); }
  }, true);

  const api = {
    toggle() {
      ensureUi();
      if (host.style.display === 'none') { host.style.display = ''; setPicking(true); }
      else setPicking(!picking);
    },
    hide() { setPicking(false); host.style.display = 'none'; },
    find(text) { return traceTexts([String(text)]); },
    sources: allSources,
  };
  Object.defineProperty(window, '__dataOrigin', { value: api, configurable: true });
})();
