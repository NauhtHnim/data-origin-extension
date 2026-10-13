// Tiny demo site: a strict-CSP page that shows formatted numbers from a fetch,
// an XHR and a WebSocket. Run: node demo/server.js  then open http://localhost:4599
const http = require('http');
const crypto = require('crypto');

const PAGE = `<!doctype html><meta charset="utf-8"><title>Data Origin demo</title>
<link rel="stylesheet" href="/app.css">
<h1>Demo token board</h1>
<table><tr><th>Token</th><th>Price</th><th>Market cap</th><th>24h</th><th>Balance</th></tr>
<tbody id="rows"></tbody></table>
<p>Portfolio total: <b id="total">…</b></p>
<p>Live price: <b id="live">…</b></p>
<script src="/app.js"></script>`;

const CSS = `body{font:15px system-ui;margin:40px;background:#fafafa;color:#111}td,th{padding:6px 14px;text-align:left;border-bottom:1px solid #ddd}`;

const APP = `
const sub = '₀₁₂₃₄₅₆₇₈₉';
function price(p) {
  const m = p.toFixed(20).match(/^0\\.(0+)(\\d{3})/);
  return m && m[1].length > 3 ? '$0.0' + String(m[1].length).split('').map(d => sub[d]).join('') + m[2] : '$' + p.toFixed(4);
}
function cell(...parts) { const td = document.createElement('td'); parts.forEach(p => { const s = document.createElement('span'); s.textContent = p; td.append(s); }); return td; }
fetch('/api/tokens?chain=4663').then(r => r.json()).then(({ data }) => {
  for (const t of data.items) {
    const tr = document.createElement('tr');
    tr.append(cell(t.symbol), cell(price(t.priceUsd)), cell('$', (t.marketCap / 1e6).toFixed(2), 'M'),
      cell((t.change24h * 100).toFixed(2) + '%'), cell((Number(t.balanceWei) / 1e18).toFixed(4)));
    document.getElementById('rows').append(tr);
  }
});
const x = new XMLHttpRequest();
x.open('POST', '/api/portfolio');
x.setRequestHeader('content-type', 'application/json');
x.onload = () => { document.getElementById('total').textContent = '$' + JSON.parse(x.responseText).summary.totalUsd.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
x.send(JSON.stringify({ wallet: '0xabc' }));
const ws = new WebSocket('ws://' + location.host + '/live');
ws.onmessage = (e) => { document.getElementById('live').textContent = JSON.parse(e.data).tick.price.toFixed(3); };
`;

const TOKENS = { data: { items: [
  { symbol: 'PEPE', priceUsd: 0.00000123456, marketCap: 1234567.89, change24h: 0.12549, balanceWei: '1234500000000000000' },
  { symbol: 'HOOD', priceUsd: 0.4182, marketCap: 88213004.5, change24h: -0.0312, balanceWei: '99000000000000000000' },
] } };

const server = http.createServer((req, res) => {
  const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'content-security-policy': "default-src 'self'; connect-src 'self' ws://localhost:*; require-trusted-types-for 'script'" }); res.end(body); };
  if (req.url === '/') return send('text/html', PAGE);
  if (req.url === '/app.js') return send('text/javascript', APP);
  if (req.url === '/app.css') return send('text/css', CSS);
  if (req.url.startsWith('/api/tokens')) return send('application/json', JSON.stringify(TOKENS));
  if (req.url === '/api/portfolio') return send('application/json', JSON.stringify({ summary: { totalUsd: 48213.7712, positions: 7 } }));
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404); res.end();
});

// Minimal WebSocket: handshake, then one text frame.
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const payload = Buffer.from(JSON.stringify({ tick: { symbol: 'PEPE', price: 3.14159 } }));
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  socket.on('error', () => {});
});

const port = Number(process.env.PORT) || 4599;
server.listen(port, () => console.log('demo on http://localhost:' + port));
module.exports = server;
