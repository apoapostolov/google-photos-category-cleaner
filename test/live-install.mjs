#!/usr/bin/env node
// Install the unpacked extension into the running Chrome (launched through the junctioned
// user-data-dir, which is what makes CDP available), then prove it: registry entry, injected panel
// on the real Google Photos page, and one read-only scan of the live DOM.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.argv[2] || '9461';
const EXT = process.env.EXT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_URL = process.argv[3] || 'https://photos.google.com/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(ws) {
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  return {
    events,
    call: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const n = id++;
      pending.set(n, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (pending.delete(n)) rej(new Error('timeout ' + method)); }, 25000);
    }),
  };
}

const connect = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => res(ws));
  ws.addEventListener('error', () => rej(new Error('cdp connect failed: ' + url)));
});

(async () => {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log('chrome:', version.Browser);
  const browser = client(await connect(version.webSocketDebuggerUrl));

  const loaded = await browser.call('Extensions.loadUnpacked', { path: EXT });
  const id = loaded.id;
  console.log('installed id:', id);

  // Chrome's own registry, read from the browser it wrote to.
  const internals = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('chrome://extensions-internals/')}`, { method: 'PUT' })).json();
  const rep = client(await connect(internals.webSocketDebuggerUrl));
  await sleep(2500);
  const text = await rep.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  let entry = null;
  try { entry = JSON.parse(text.result.value).find((e) => e.id === id); } catch (e) { /* not json */ }
  console.log('registry:', entry ? JSON.stringify({ location: entry.location, status: entry.registry_status, reasons: entry.disable_reasons, version: entry.version, permissions: entry.permissions && entry.permissions.active }) : 'NOT LISTED');

  // Real page: does the panel actually appear, and what does the live DOM look like?
  const page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(TARGET_URL)}`, { method: 'PUT' })).json();
  const tab = client(await connect(page.webSocketDebuggerUrl));
  await tab.call('Page.enable');
  await tab.call('Runtime.enable');
  await sleep(8000);

  const url = await tab.call('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  console.log('page url:', url.result.value);

  const panel = await tab.call('Runtime.evaluate', { expression: "!!document.getElementById('pbt-host')", returnByValue: true });
  console.log('panel injected in page world:', panel.result.value);

  const shot = await tab.call('Page.captureScreenshot', { format: 'png' });
  const out = process.env.PBT_SCREENSHOT || 'pbt-live.png';
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', out);

  // Content scripts live in an isolated world; find it and run the page model there.
  const contexts = [];
  tab.events.forEach((e) => {
    if (e.method === 'Runtime.executionContextCreated') contexts.push(e.params.context);
  });
  const isolated = contexts.filter((c) => c.auxData && c.auxData.isDefault === false);
  console.log('isolated worlds:', isolated.map((c) => `${c.id}:${c.name}`).join(', ') || 'none');
  let scanned = null;
  for (const ctx of isolated) {
    try {
      const r = await tab.call('Runtime.evaluate', {
        expression: 'window.__pbt ? JSON.stringify(window.__pbt.scan()) : "no-api"',
        contextId: ctx.id, returnByValue: true
      });
      if (r.result.value && r.result.value !== 'no-api') { scanned = r.result.value; break; }
    } catch (e) { /* try the next context */ }
  }
  console.log('live scan:', scanned || 'could not reach the content-script world');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
