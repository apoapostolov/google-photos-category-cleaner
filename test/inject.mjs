#!/usr/bin/env node
// Inject a content script into the live page's main world (no extension reload needed), then run a
// probe expression against it. Usage: node inject.mjs <port> <script.js> <probe.js>
import { readFileSync } from 'node:fs';

const [PORT = '9461', SRC, PROBE] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => res(ws));
  ws.addEventListener('error', () => rej(new Error('cdp connect failed')));
});
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
    setTimeout(() => { if (pending.delete(n)) rej(new Error('timeout ' + method)); }, 30000);
  });
}
const evaluate = async (call, expression) => {
  const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (out.exceptionDetails) return 'EXCEPTION: ' + (out.exceptionDetails.exception?.description || '').slice(0, 700);
  return out.result.value;
};

try {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('https://photos.google.com'));
  if (!page) throw new Error('no photos.google.com tab');
  const call = client(await connect(page.webSocketDebuggerUrl));
  await call('Runtime.enable');
  await sleep(800);

  const src = readFileSync(SRC, 'utf8');
  // The script guards against double injection; clear the guard so this run measures the new code.
  await evaluate(call, `(() => { window.__pbtLoaded = false; window.__pbt = null; const h = document.getElementById('pbt-host'); if (h) h.remove(); return 'reset'; })()`);
  const injected = await evaluate(call, `(() => { try { ${src}\n; return 'injected:' + !!window.__pbt; } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log(injected);
  await sleep(700);

  const result = await evaluate(call, readFileSync(PROBE, 'utf8'));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 1));
} catch (e) {
  console.error('FAIL', e.message);
  process.exit(1);
}
process.exit(0);
