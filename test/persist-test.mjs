#!/usr/bin/env node
// Does an unpacked install persist across a restart? Test it on a throwaway copy of the profile,
// so nothing here can touch the real one.
//   phase 1: developer mode ON, CDP loadUnpacked, clean exit
//   phase 2: fresh launch of the same dir WITHOUT the debugging-only flags, then read the registry
import { spawn } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.env.CHROME_USER_DATA || `${process.env.LOCALAPPDATA}/Google/Chrome/User Data`;
const DIR = `${process.env.TEMP || '/tmp'}/pbtpersist`;
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

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
const connectWs = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => res(ws));
  ws.addEventListener('error', () => rej(new Error('ws fail')));
});

async function launch(port, extraFlags) {
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${DIR}`, '--profile-directory=Profile 9', '--no-first-run',
    '--no-default-browser-check', ...extraFlags, 'about:blank'
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(300); }
  }
  if (!version) throw new Error('chrome did not start on ' + port);
  const call = client(await connectWs(version.webSocketDebuggerUrl));
  return { proc, call };
}

async function registryEntry(call, port, id) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('chrome://extensions-internals/')}`, { method: 'PUT' })).json();
  const rep = client(await connectWs(t.webSocketDebuggerUrl));
  await sleep(2500);
  const out = await rep('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  try { return JSON.parse(out.result.value).find((e) => e.id === id) || null; } catch { return null; }
}

(async () => {
  rmSync(DIR, { recursive: true, force: true });
  cpSync(`${SRC}/Local State`, `${DIR}/Local State`);
  cpSync(`${SRC}/Profile 9/Preferences`, `${DIR}/Profile 9/Preferences`, { recursive: true });
  const prefsPath = `${DIR}/Profile 9/Preferences`;
  const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.ui = prefs.extensions.ui || {};
  prefs.extensions.ui.developer_mode = true;
  writeFileSync(prefsPath, JSON.stringify(prefs));

  console.log('--- phase 1: install with debugging flags');
  const p1 = await launch(9471, ['--enable-unsafe-extension-debugging']);
  const loaded = await p1.call('Extensions.loadUnpacked', { path: EXT });
  console.log('installed:', loaded.id);
  console.log('before exit:', JSON.stringify(await registryEntry(p1.call, 9471, loaded.id))?.slice(0, 180));
  await p1.call('Browser.close').catch(() => {});
  await sleep(3000);
  // Only ever kill the process this script spawned: a blanket taskkill would take the real browser
  // with it.
  try { p1.proc.kill(); } catch {}

  console.log('--- phase 2: relaunch WITHOUT debugging flags');
  await sleep(1500);
  const p2 = await launch(9472, []);
  const after = await registryEntry(p2.call, 9472, loaded.id);
  console.log('after restart:', after ? JSON.stringify({ location: after.location, status: after.registry_status, reasons: after.disable_reasons }) : 'GONE');
  await p2.call('Browser.close').catch(() => {});
  await sleep(1500);
  try { p2.proc.kill(); } catch {}
  process.exit(after ? 0 : 1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(2); });
