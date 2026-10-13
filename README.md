# Data Origin

Click a number on a web page and see which network response it came from, and at which JSON path.

## Install (Brave or Chrome)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Reload the page you want to inspect. Capture starts at page load.

## Use

- **Alt+Shift+click** any value on the page. This works at any time.
- Or click the toolbar icon (Alt+Shift+D), then click a value. Esc cancels.
- Or type a value into the panel's box and press Enter.

Each result shows the request, the JSON path, the raw value, and how the raw value relates to what is on screen.
The buttons copy the path, the URL, or a curl command, and `log` prints the full response to the console.
`view` opens the request details and the response body, scrolled to the matched value and highlighted.

An extension cannot open DevTools or select a row in the built-in Network tab. To find the same request there, use `copy url` and paste it into the Network tab filter box.

## What it understands

| On screen | Raw value it finds |
|---|---|
| `$1.23K`, `4.5M`, `1,234.56` | the unrounded number |
| `12.55%` | `0.12549` (ratio) or `1255` (bps) |
| `1.2345` | `"1234500000000000000"` (wei), also 6, 8 and 9 decimals |
| `$0.0₅123` | `0.00000123456` |
| `HOOD` | a string field with the same text |

Sources captured: `fetch`, `XMLHttpRequest`, WebSocket text frames, and Next.js `__NEXT_DATA__`.

## Limits

- A value computed from several fields (a sum, a ratio, a price times a balance) has no single source and will not match.
- Values with one or two digits match many fields. The panel warns and does not try rescaling.
- Requests made inside web workers or service workers, `EventSource` streams, and binary socket frames are not captured.
- It runs on every site by default. Restrict it under the extension's **Site access** setting if you prefer.
- Nothing leaves the page. The extension makes no requests and stores nothing.

## Develop

```sh
node --test test/core.test.js     # matching logic
node demo/server.js               # demo page on http://localhost:4599
PUPPETEER=/path/to/node_modules/puppeteer-core \
BROWSER="/path/to/Google Chrome for Testing" node test/e2e.js   # real extension in a browser
```

Branded Chrome ignores `--load-extension`, so the browser test needs Chrome for Testing.

- `src/core.js`: parsing of on-screen text, scaling rules, ranking. Add new scalings to `SCALES`.
- `src/inject.js`: network capture and the panel.
