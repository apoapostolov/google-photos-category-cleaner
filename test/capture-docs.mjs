#!/usr/bin/env node
// Render the icon PNGs and capture the README screenshots. This file is the reproduction command
// recorded in docs/screenshots.md: re-run it after any UI change instead of hand-cropping images.
//
//   node test/capture-docs.mjs
//
// Icon: docs/icon.svg -> icons/icon-{16,32,48,128}.png (manifest) and docs/icon-512.png (README,
// social preview). Source of truth stays the SVG.
// Screenshots: the panel over the synthetic fixture, and the toolbar popup. The fixture is
// deliberately fake so no real account data can reach a public repo.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9459;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'docs', 'screenshots');
const ICONS = join(ROOT, 'icons');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    setTimeout(() => { if (pending.delete(n)) rej(new Error('timeout ' + method)); }, 25000);
  });
}
const connect = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => res(ws));
  ws.addEventListener('error', () => rej(new Error('cdp connect failed')));
});
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/');

async function openTab(page) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(page)}`, { method: 'PUT' })).json();
  const call = client(await connect(t.webSocketDebuggerUrl));
  await call('Page.enable');
  await call('Runtime.enable');
  return call;
}

async function shoot(call, width, height, outPath, dpr = 2) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  await sleep(400);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('wrote', outPath);
}

const profile = mkdtempSync(join(tmpdir(), 'cpc-docs-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('chrome did not start');
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(ICONS, { recursive: true });

  // ---- icon renders: one HTML page per size keeps the SVG edge-to-edge with no margins
  const svg = readFileSync(join(ROOT, 'docs', 'icon.svg'), 'utf8');
  for (const size of [16, 32, 48, 128, 512]) {
    const page = join(profile, `icon-${size}.html`);
    writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    const call = await openTab(fileUrl(page));
    await call('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const out = size === 512 ? join(ROOT, 'docs', 'icon-512.png') : join(ICONS, `icon-${size}.png`);
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('wrote', out);
  }

  // ---- screenshot: the panel on its own, cut out of the page
  const fixture = await openTab(fileUrl(join(ROOT, 'test', 'fixture.html')));
  await fixture('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const src = readFileSync(join(ROOT, 'content.js'), 'utf8');
  await fixture('Runtime.evaluate', { expression: `(() => { ${src}\n; return true; })()`, userGesture: true });
  await sleep(500);

  // Drive the panel the way a person would, so the shot carries real state and a real count.
  const state = await fixture('Runtime.evaluate', {
    expression: `(async () => {
      const r = document.getElementById('pbt-host').shadowRoot;
      r.getElementById('pbt-scan').click();
      await new Promise((z) => setTimeout(z, 500));
      r.getElementById('pbt-select').click();
      await new Promise((z) => setTimeout(z, 4500));
      return r.getElementById('pbt-status').textContent;
    })()`,
    awaitPromise: true, userGesture: true
  });
  console.log('panel state:', state.result.value);

  // Hide the page behind it and drop the backdrop, so only the card is in the file. The panel is
  // opaque with rounded corners and a shadow; anything left visible would show through the corners.
  const rectJson = await fixture('Runtime.evaluate', {
    expression: `(() => {
      const host = document.getElementById('pbt-host');
      for (const el of [...document.body.children]) el.style.visibility = 'hidden';
      for (const el of [...document.documentElement.children]) {
        if (el !== host && el.tagName !== 'HEAD') el.style.visibility = 'hidden';
      }
      host.style.right = '24px';
      host.style.bottom = '24px';
      const b = host.getBoundingClientRect();
      return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height });
    })()`,
    returnByValue: true
  });
  const rect = JSON.parse(rectJson.result.value);
  await fixture('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await sleep(300);
  const pad = 26;
  const panelShot = await fixture('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: rect.x - pad, y: rect.y - pad, width: rect.w + pad * 2, height: rect.h + pad * 2, scale: 2 }
  });
  writeFileSync(join(SHOTS, `panel-${VERSION}.png`), Buffer.from(panelShot.data, 'base64'));
  console.log('wrote', join(SHOTS, `panel-${VERSION}.png`), `${Math.round(rect.w)}x${Math.round(rect.h)} css px`);

  // ---- screenshot: the toolbar popup, served by the real extension
  const browserWs = await connect(version.webSocketDebuggerUrl);
  const browser = client(browserWs);
  const loaded = await browser('Extensions.loadUnpacked', { path: ROOT });
  const popup = await openTab(`chrome-extension://${loaded.id}/popup.html`);
  await sleep(700);
  await shoot(popup, 340, 420, join(SHOTS, `popup-${VERSION}.png`));

  // ---- hero banner: product-proof, 1280x640, composed from the icon and the panel shot
  // 1x on purpose: the template's measured constant is 1280x640.
  const hero = await openTab(fileUrl(join(ROOT, 'docs', 'hero.html')));
  await sleep(800);
  await shoot(hero, 1280, 640, join(ROOT, 'docs', 'hero.png'), 1);

  console.log('\nreproduce: node test/capture-docs.mjs');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  process.exit(process.exitCode || 0);
}
