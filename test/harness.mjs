#!/usr/bin/env node
// Exercise the content script's click logic against a local fixture that mimics the Google Photos
// grid (Bulgarian labels, real role=checkbox tiles, toolbar delete, confirmation dialog).
// Usage: node test/harness.mjs
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9455;
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function client(ws) {
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const n = id++;
    pending.set(n, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.delete(n)) rej(new Error('timeout ' + method)); }, 20000);
  });
}

async function evaluate(call, expression) {
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || 'eval failed');
  return out.result.value;
}

const profile = mkdtempSync(join(tmpdir(), 'pbt-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'
], { stdio: 'ignore', detached: false });

let exitCode = 1;
try {
  let version;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('chrome did not expose a debugging port');

  // --- 1. manifest accepted by Chrome itself
  const browser = client(await new Promise((res, rej) => {
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', () => rej(new Error('cdp connect failed')));
  }));
  const loaded = await browser('Extensions.loadUnpacked', { path: EXT }).catch((e) => ({ err: e.message }));
  const extId = loaded?.id;
  check('manifest: Chrome accepts the unpacked extension', !!extId, extId ? 'id=' + extId : JSON.stringify(loaded).slice(0, 200));

  // --- 2. content script against the fixture
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const call = client(await new Promise((res, rej) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.addEventListener('open', () => res(ws));
    ws.addEventListener('error', () => rej(new Error('cdp connect failed')));
  }));
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.navigate', { url: 'file:///' + join(EXT, 'test/fixture.html').replace(/\\/g, '/') });
  await sleep(1200);

  const src = readFileSync(join(EXT, 'content.js'), 'utf8');
  await evaluate(call, `(() => { ${src}\n; return true; })()`);
  await sleep(300);

  check('panel: injected into the page', await evaluate(call, `!!document.getElementById('pbt-host')`));
  check('panel: exposed test API', await evaluate(call, `typeof window.__pbt === 'object'`));

  const scan = await evaluate(call, `JSON.stringify(window.__pbt.scan())`);
  const s = JSON.parse(scan);
  check('scan: sees 30 selectable tiles', s.items === 30, `items=${s.items}`);
  check('scan: finds the delete button by Bulgarian label', s.deleteButton === 'изтриване', `label=${s.deleteButton}`);

  const checked = await evaluate(call, `window.__pbt.selectAll({}).then(r => r.checked)`);
  check('select all: selects every tile', checked === 30, `checked=${checked}`);

  const del = await evaluate(call, `window.__pbt.deleteSelected().then(r => JSON.stringify(r))`);
  const d = JSON.parse(del);
  check('delete: clicks the toolbar delete', d.ok === true && d.clicked === 'изтриване', JSON.stringify(d).slice(0, 160));
  check('delete: confirms the dialog', d.confirmed === 'премести в кошчето', `confirmed=${d.confirmed}`);

  const remaining = await evaluate(call, `document.querySelectorAll('.cb').length`);
  const deleted = await evaluate(call, `window.__deleted || 0`);
  check('delete: 30 tiles removed from the grid', remaining === 0 && deleted === 30, `remaining=${remaining} deleted=${deleted}`);

  // --- 3. empty page must stop, not loop
  const auto = await evaluate(call, `window.__pbt.autoRun({maxPasses: 3}).then(r => JSON.stringify(r))`);
  const a = JSON.parse(auto);
  check('auto: stops on an empty page instead of looping', a.ok === true && a.passes.length === 1 && a.passes[0].selected === 0, JSON.stringify(a.passes));

  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (e) {
  console.error('FAIL', e.message);
  exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(exitCode);
}
