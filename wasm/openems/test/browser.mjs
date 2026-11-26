// Headless Chromium test of site/openems/index.html (the Worker + OpenEMS class).
//   node test/browser.mjs [headers|sw]
// headers: the server sends COOP/COEP itself; sw: a plain server, isolation
// comes from coi-sw.js (the GitHub Pages case).
// PLAYWRIGHT: path of a playwright package (default: require('playwright')).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const mode = process.argv[2] || 'headers';
const root = new URL('../../../site/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.xml': 'application/xml' };
const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path.endsWith('/')) path += 'index.html';
  try {
    const body = await readFile(join(root, path));
    const headers = { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (mode === 'headers') Object.assign(headers, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/openems/`;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let ok = false;
try {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Ready.' || document.getElementById('status').classList.contains('bad'), null, { timeout: 30000 });
  const isolated = await page.evaluate(() => crossOriginIsolated);
  console.log(`[${mode}] crossOriginIsolated=${isolated}; status: ${await page.textContent('#status')}`);
  const t0 = Date.now();
  await page.click('#dipole');
  await page.waitForFunction(() => /^Done\.|failed|exited|Error/.test(document.getElementById('status').textContent) || document.getElementById('status').classList.contains('bad'), null, { timeout: 300000 });
  console.log(`[${mode}] ${await page.textContent('#status')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const rows = await page.$$eval('#summary tr', (trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(' ')));
  rows.forEach((r) => console.log('  ' + r));
  const files = await page.$$eval('#files a', (as) => as.map((a) => a.textContent));
  console.log(`  ${files.length} output files, e.g. ${files.slice(0, 4).join(', ')}`);
  await page.screenshot({ path: process.env.SHOT || `/tmp/openems-demo-${mode}.png`, fullPage: true });
  const dmax = Number(/Directivity at 2.45 GHz ([\d.]+) dBi/.exec(rows.join('\n'))?.[1]);
  const s11 = Number(/S11 minimum (-[\d.]+) dB/.exec(rows.join('\n'))?.[1]);
  ok = isolated && Math.abs(dmax - 2.206) < 0.01 && Math.abs(s11 - -30.97) < 0.05 && errors.length === 0;
} finally {
  if (errors.length) console.log('page errors:', errors);
  await browser.close();
  server.close();
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
