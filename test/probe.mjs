#!/usr/bin/env node
// Read the live Google Photos DOM from inside the extension's isolated world and print the raw
// structure, so the selectors can be fixed from evidence instead of guesses.
const PORT = process.argv[2] || '9461';
const EXPR_FILE = process.argv[3];
const { readFileSync } = await import('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.addEventListener('open', () => res(ws));
  ws.addEventListener('error', () => rej(new Error('cdp connect failed')));
});
function client(ws) {
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  return { events, call: (method, params = {}) => new Promise((res, rej) => {
    const n = id++;
    pending.set(n, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending.delete(n)) rej(new Error('timeout ' + method)); }, 25000);
  }) };
}

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.startsWith('https://photos.google.com'));
  if (!page) { console.log('no photos.google.com tab open'); process.exit(1); }
  const tab = client(await connect(page.webSocketDebuggerUrl));
  await tab.call('Runtime.enable');
  await sleep(1200);
  const worlds = tab.events.filter((e) => e.method === 'Runtime.executionContextCreated')
    .map((e) => e.params.context).filter((c) => c.auxData && c.auxData.isDefault === false);
  const world = worlds.find((c) => /Bulk/.test(c.name)) || worlds[0];
  const expr = readFileSync(EXPR_FILE, 'utf8');
  const out = await tab.call('Runtime.evaluate', { expression: expr, contextId: world.id, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) console.log('EXCEPTION', JSON.stringify(out.exceptionDetails).slice(0, 600));
  console.log(typeof out.result.value === 'string' ? out.result.value : JSON.stringify(out.result.value, null, 1));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
