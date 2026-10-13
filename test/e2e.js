// Loads the real unpacked extension in a browser against the demo site and
// checks that clicking each on-screen value names the right request and path.
// Usage: node test/e2e.js   (needs puppeteer-core resolvable, see README)
const path = require('path');
const assert = require('assert');
const puppeteer = require(process.env.PUPPETEER || 'puppeteer-core');

const EXT = path.resolve(__dirname, '..');
const EXEC = process.env.BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  process.env.PORT = '4598';
  const server = require('../demo/server.js');
  const browser = await puppeteer.launch({
    executablePath: EXEC,
    headless: process.env.HEADFUL ? false : 'new',
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--window-size=1200,800'],
    defaultViewport: { width: 1200, height: 800 },
  });
  let failed = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('http://localhost:4598/');
    await page.waitForFunction(() => document.getElementById('live').textContent !== '…' && document.getElementById('total').textContent !== '…' && document.querySelectorAll('#rows tr').length === 2);
    assert.ok(await page.evaluate(() => !!window.__dataOrigin), 'extension did not inject into the page');

    // Alt+Shift+click an element, then read the first result row from the panel.
    const trace = async (selector) => {
      const el = await page.$(selector);
      const box = await el.boundingBox();
      await page.keyboard.down('Alt'); await page.keyboard.down('Shift');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
      return page.evaluate(() => {
        const root = document.querySelector('data-origin-panel').shadowRoot;
        const hit = root.querySelector('.hit');
        if (!hit) return null;
        return {
          shown: root.querySelector('.token').firstChild.textContent.trim(),
          method: hit.querySelector('.method').textContent,
          url: hit.querySelector('.url').title,
          path: hit.querySelector('.path').textContent,
          tag: hit.querySelector('.tag').textContent,
        };
      });
    };

    const cases = [
      ['subscript price', '#rows tr:nth-child(1) td:nth-child(2) span', 'GET', '/api/tokens?chain=4663', 'data.items[0].priceUsd'],
      ['market cap split across spans', '#rows tr:nth-child(1) td:nth-child(3) span:nth-child(2)', 'GET', '/api/tokens?chain=4663', 'data.items[0].marketCap'],
      ['ratio shown as percent', '#rows tr:nth-child(1) td:nth-child(4) span', 'GET', '/api/tokens?chain=4663', 'data.items[0].change24h'],
      ['wei balance', '#rows tr:nth-child(1) td:nth-child(5) span', 'GET', '/api/tokens?chain=4663', 'data.items[0].balanceWei'],
      ['negative percent, second row', '#rows tr:nth-child(2) td:nth-child(4) span', 'GET', '/api/tokens?chain=4663', 'data.items[1].change24h'],
      ['XHR total with commas', '#total', 'POST', '/api/portfolio', 'summary.totalUsd'],
      ['WebSocket frame', '#live', 'WS', '/live', 'tick.price'],
      ['plain text field', '#rows tr:nth-child(2) td:nth-child(1) span', 'GET', '/api/tokens?chain=4663', 'data.items[1].symbol'],
    ];
    for (const [name, selector, method, urlEnd, jsonPath] of cases) {
      const got = await trace(selector);
      const ok = got && got.method === method && got.url.endsWith(urlEnd) && got.path === jsonPath;
      if (!ok) failed++;
      console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(got));
    }

    // Toolbar path: the function the toolbar button runs turns pick mode on.
    await page.evaluate(() => window.__dataOrigin.toggle());
    const pickOn = await page.evaluate(() => document.querySelector('data-origin-panel').shadowRoot.querySelector('button.on') !== null);
    console.log((pickOn ? 'PASS' : 'FAIL') + '  toggle turns pick mode on');
    if (!pickOn) failed++;
    await page.keyboard.press('Escape');

    await trace('#rows tr:nth-child(1) td:nth-child(3) span:nth-child(2)');
    const viewed = await page.evaluate(() => {
      const root = document.querySelector('data-origin-panel').shadowRoot;
      Array.from(root.querySelectorAll('.hit button')).find((b) => b.textContent === 'view').click();
      const mark = root.querySelector('pre .mark');
      const pre = mark && mark.parentElement;
      return mark && { line: mark.textContent.trim(), visible: mark.offsetTop >= pre.scrollTop + pre.offsetTop - 1 && mark.offsetTop <= pre.scrollTop + pre.offsetTop + pre.clientHeight };
    });
    const viewOk = viewed && viewed.line === '"marketCap": 1234567.89,' && viewed.visible;
    console.log((viewOk ? 'PASS' : 'FAIL') + '  view highlights the value in the response  ' + JSON.stringify(viewed));
    if (!viewOk) failed++;
    await page.screenshot({ path: path.join(EXT, 'demo', 'screenshot.png') });
    console.log(errors.length ? 'page errors: ' + JSON.stringify(errors) : 'no page errors');
    if (errors.length) failed++;
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? failed + ' check(s) failed' : 'all checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
