/*
 * Google Photos Bulk Select & Delete — content script.
 *
 * Everything here drives the real page with synthetic clicks. Google Photos ships obfuscated class
 * names, so every lookup goes through ARIA roles plus a label dictionary (English + Bulgarian +
 * a few others), and every failure prints what was actually on the page instead of guessing.
 *
 * Nothing runs on load. The panel appears collapsed and no page state changes until a button is
 * pressed.
 */
(() => {
  'use strict';
  if (window.__pbtLoaded) return;
  window.__pbtLoaded = true;

  // ---------------------------------------------------------------- vocabulary
  // Ordered longest-first so "delete permanently" wins over "delete".
  const DELETE_WORDS = [
    'delete permanently', 'delete forever', 'delete from trash', 'remove permanently',
    'move to trash', 'move to bin', 'empty trash', 'delete album', 'delete',
    'изтрий завинаги', 'изтриване завинаги', 'премахни завинаги', 'премести в кошчето',
    'изпразни кошчето', 'изтрий', 'изтриване', 'изтриване на албума', 'премахни',
    'endgültig löschen', 'in den papierkorb', 'löschen',
    'supprimer définitivement', 'mettre à la corbeille', 'supprimer',
    'eliminar definitivamente', 'mover a la papelera', 'eliminar',
    'excluir permanentemente', 'mover para a lixeira', 'excluir',
    'удалить навсегда', 'переместить в корзину', 'удалить',
    'usuń trwale', 'przenieś do kosza', 'usuń',
    'silmek', 'kalıcı olarak sil'
  ];
  const CANCEL_WORDS = [
    'cancel', 'отказ', 'abbrechen', 'annuler', 'cancelar', 'отмена', 'anuluj', 'iptal'
  ];
  const SELECT_ALL_WORDS = [
    'select all', 'избери всички', 'избор на всички', 'alle auswählen', 'tout sélectionner',
    'seleccionar todo', 'selecionar tudo', 'выбрать все', 'zaznacz wszystko', 'tümünü seç'
  ];
  const CONFIRM_HINT = /permanently|forever|завинаги|trash|bin|кошчет|delete|изтри/i;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hasWord = (label, words) => words.some((w) => label.includes(w));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  // aria-label, title and visible text often repeat each other; keep one copy of each distinct
  // string and join them, so a mismatch between the label and the text cannot hide a match.
  const labelOf = (el) =>
    [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-tooltip'),
      el.textContent
    ]
      .map(norm)
      .filter((s, i, all) => s && all.indexOf(s) === i)
      .join(' ');

  // ---------------------------------------------------------------- page model
  const STATE = { running: false, stop: false, lastSelected: 0 };

  /**
   * Every [role=checkbox] that belongs to a grid item.
   *
   * Two traps in the real DOM: each tile checkbox carries its own jsaction, so closest('[jsaction]')
   * returns the checkbox itself and a "the tile has an <img>" test always fails; and thumbnails are
   * painted, not <img> elements. So the tile is identified by walking up to the first ancestor that
   * holds a link or a painted thumbnail, and the select-all boxes are excluded by label instead.
   */
  function itemCheckboxes() {
    return [...document.querySelectorAll('[role="checkbox"]')].filter((el) => {
      if (!visible(el)) return false;
      if (el.closest('[role="toolbar"], header')) return false;
      const label = labelOf(el);
      if (hasWord(label, SELECT_ALL_WORDS)) return false;
      return true;
    });
  }

  function selectAllCheckbox() {
    return [...document.querySelectorAll('[role="checkbox"]')]
      .filter(visible)
      .find((el) => hasWord(labelOf(el), SELECT_ALL_WORDS)) || null;
  }

  const checkedCount = () =>
    itemCheckboxes().filter((el) => el.getAttribute('aria-checked') === 'true').length;

  /**
   * The number Google itself reports in the selection header ("3 selected").
   *
   * This is the only honest count: the grid is virtualized, so when you scroll, tiles leave the DOM
   * while staying selected in Google's model. Counting checkboxes in the DOM undercounts, and can
   * even fall while the real selection grows.
   */
  function headerCount() {
    const rx = /(\d[\d\s.,]*)\s*(selected|избран|ausgewählt|sélectionné|seleccionado|selecionado|выбрано|zaznaczono|seçildi)/i;
    for (const el of document.querySelectorAll('div, span')) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      const m = text.match(rx);
      if (!m) continue;
      const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  /** Buttons that are visible right now, with the label we would match them on. */
  function actionButtons(root = document) {
    return [...root.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .filter(visible)
      .map((el) => ({ el, label: labelOf(el) }));
  }

  function findDeleteButton() {
    const candidates = actionButtons()
      .filter((b) => hasWord(b.label, DELETE_WORDS) && !hasWord(b.label, CANCEL_WORDS))
      // Prefer a control inside the selection toolbar: that is the batch action, not a per-tile menu.
      .sort((a, b) => {
        const at = a.el.closest('[role="toolbar"]') ? 0 : 1;
        const bt = b.el.closest('[role="toolbar"]') ? 0 : 1;
        return at - bt;
      });
    return candidates[0] || null;
  }

  /** The button that carries out the delete inside an open confirmation dialog. */
  function findConfirmButton() {
    const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
      .filter(visible)
      .pop();
    if (!dialog) return { dialog: null, button: null, labels: [] };
    const buttons = actionButtons(dialog);
    const labels = buttons.map((b) => b.label);
    const matching = buttons.filter(
      (b) => hasWord(b.label, DELETE_WORDS) && !hasWord(b.label, CANCEL_WORDS)
    );
    // A "delete permanently" button beats a plain "delete" when both somehow exist.
    matching.sort((a, b) => (CONFIRM_HINT.test(b.label) ? 1 : 0) - (CONFIRM_HINT.test(a.label) ? 1 : 0));
    return { dialog, button: matching[0] || null, labels };
  }

  /** The element that actually scrolls the grid — not always document.scrollingElement. */
  function scrollContainer() {
    const probe = [document.scrollingElement, ...document.querySelectorAll('div, c-wiz, main')];
    let best = null;
    let bestGap = 200;
    for (const el of probe) {
      if (!el || !el.scrollHeight) continue;
      const gap = el.scrollHeight - el.clientHeight;
      if (gap <= bestGap) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && el !== document.scrollingElement) continue;
      best = el;
      bestGap = gap;
    }
    return best;
  }

  // ---------------------------------------------------------------- actions
  function scan() {
    const items = itemCheckboxes();
    const sa = selectAllCheckbox();
    const del = findDeleteButton();
    const sc = scrollContainer();
    const albumLinks = albumHrefs();
    return {
      url: location.href,
      title: document.title,
      items: items.length,
      checked: checkedCount(),
      headerCount: headerCount(),
      selectAllBox: sa ? labelOf(sa) : null,
      deleteButton: del ? del.label : null,
      albumTiles: albumLinks.length,
      scroller: sc ? `${sc.tagName.toLowerCase()} ${sc.clientWidth}x${sc.clientHeight} / ${sc.scrollHeight}` : 'none'
    };
  }

  /**
   * Select whatever has been rendered so far, clicking each item at most once.
   *
   * The dedupe is not an optimisation, it is correctness: Google's grid re-renders tiles as you
   * scroll, and a re-rendered tile can come back with aria-checked="false" even though Google still
   * holds it in the selection. Clicking that tile again toggles it OFF, which is how naive
   * select-all scripts end up deleting less than the count they show.
   */
  const CLEARED = new WeakSet();
  async function selectLoaded(seen) {
    let clicks = 0;
    for (const box of itemCheckboxes()) {
      if (STATE.stop) break;
      if (box.getAttribute('aria-checked') === 'true') continue;
      const key = labelOf(box) || null;
      if (key && seen.has(key)) continue;
      if (!key && CLEARED.has(box)) continue;
      if (key) seen.add(key);
      CLEARED.add(box);
      box.click();
      clicks++;
      if (clicks % 20 === 0) await wait(120);
    }
    return clicks;
  }

  /** Scroll the whole grid, selecting as items stream in, until Google's own count stops growing. */
  async function selectAll({ onTick } = {}) {
    STATE.stop = false;
    const seen = new Set();
    let rounds = 0;
    let stable = 0;
    let lastCount = 0;
    await selectLoaded(seen);
    for (;;) {
      if (STATE.stop || rounds > 800) break;
      const sc = scrollContainer();
      if (sc) sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(600, sc.clientHeight));
      else window.scrollBy(0, Math.max(600, innerHeight));
      await wait(700);
      const added = await selectLoaded(seen);
      const header = headerCount();
      const total = header ?? checkedCount();
      if (onTick) onTick({ rounds, checked: checkedCount(), header, added });
      if (total > lastCount) {
        lastCount = total;
        stable = 0;
      } else if (++stable >= 3) {
        break;
      }
      rounds++;
    }
    STATE.lastSelected = headerCount() ?? checkedCount();
    return { checked: checkedCount(), header: headerCount(), rounds, seen: seen.size };
  }

  /** Click delete, then confirm the dialog Google raises. */
  async function deleteSelected() {
    const found = findDeleteButton();
    if (!found) {
      return {
        ok: false,
        reason: 'no delete button on the page',
        seen: actionButtons().slice(0, 24).map((b) => b.label).filter(Boolean)
      };
    }
    found.el.click();
    await wait(700);
    let { button, labels, dialog } = findConfirmButton();
    if (dialog && !button) {
      return { ok: false, reason: 'dialog opened but no confirm button matched', labels };
    }
    if (button) {
      button.el.click();
      await wait(900);
      const still = findConfirmButton();
      if (still.dialog && still.button) still.button.el.click();
      return { ok: true, clicked: found.label, confirmed: button.label, labels };
    }
    // No dialog: Google deletes straight away for some views (album view, some trash states).
    return { ok: true, clicked: found.label, confirmed: null, labels: [] };
  }

  async function waitForGridChange(before, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await wait(400);
      const now = itemCheckboxes().length;
      if (now !== before) return now;
    }
    return itemCheckboxes().length;
  }

  /** Select → delete, repeatedly, until a pass finds nothing to select. */
  async function autoRun({ maxPasses = 50, onTick } = {}) {
    if (STATE.running) return { ok: false, reason: 'already running' };
    STATE.running = true;
    STATE.stop = false;
    const passes = [];
    try {
      for (let pass = 1; pass <= maxPasses; pass++) {
        if (STATE.stop) break;
        const before = itemCheckboxes().length;
        const sel = await selectAll({ onTick: (t) => onTick && onTick({ ...t, pass, phase: 'selecting' }) });
        const selected = sel.header || sel.checked;
        if (onTick) onTick({ pass, phase: 'selected', selected, checked: sel.checked, header: sel.header });
        if (selected === 0 && sel.checked === 0) {
          passes.push({ pass, selected: 0, result: 'nothing left to select' });
          break;
        }
        const del = await deleteSelected();
        passes.push({ pass, selected, ...del });
        if (onTick) onTick({ pass, phase: 'deleted', selected, del });
        if (!del.ok) break;
        await waitForGridChange(before);
      }
    } finally {
      STATE.running = false;
    }
    return { ok: true, passes };
  }

  function clearSelection() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    const x = actionButtons().find((b) => /close|cancel|отказ|затвор/i.test(b.label) && b.el.closest('[role="toolbar"]'));
    if (x) x.el.click();
  }

  // ---------------------------------------------------------------- album walk
  /** Album / document tiles on the current page, as absolute URLs, without the current page. */
  function albumHrefs() {
    const here = location.href.split('#')[0];
    const out = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href || href === here) continue;
      if (!/\/(album|documents|shared)\//.test(href)) continue;
      if (!visible(a)) continue;
      out.set(href, (a.getAttribute('aria-label') || a.innerText || href).trim());
    }
    return [...out.entries()].map(([href, name]) => ({ href, name }));
  }

  const RESUME_KEY = 'pbt-album-walk';

  function readResume() {
    try {
      return JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function writeResume(v) {
    try {
      if (v) sessionStorage.setItem(RESUME_KEY, JSON.stringify(v));
      else sessionStorage.removeItem(RESUME_KEY);
    } catch (e) {
      /* private mode */
    }
  }

  /**
   * Walk album tiles one at a time: open, select everything, delete, come back. A full navigation
   * loses in-page state, so the queue lives in sessionStorage and a reload resumes it.
   */
  async function startAlbumWalk({ maxAlbums = 200 } = {}) {
    const list = albumHrefs();
    if (!list.length) return { ok: false, reason: 'no album tiles on this page' };
    writeResume({ queue: list.map((a) => a.href), names: list.map((a) => a.name), index: 0, done: [], back: location.href, max: maxAlbums });
    return resumeAlbumWalk();
  }

  async function resumeAlbumWalk() {
    const st = readResume();
    if (!st) return { ok: false, reason: 'nothing queued' };
    const results = st.done || [];
    const startIndex = st.index || 0;
    for (let i = startIndex; i < st.queue.length && i < st.max; i++) {
      if (STATE.stop) {
        writeResume(st);
        return { ok: false, reason: 'stopped', results };
      }
      const href = st.queue[i];
      st.index = i + 1;
      writeResume(st);
      log(`album ${i + 1}/${st.queue.length}: ${st.names[i] || href}`);
      location.href = href;
      return { ok: true, navigating: href, results };
    }
    // Finished.
    writeResume(null);
    if (st.back) location.href = st.back;
    return { ok: true, finished: true, results };
  }

  /** Called after a navigation left an album walk in progress. */
  async function continueAlbumWalkIfNeeded() {
    const st = readResume();
    if (!st) return;
    const name = st.names[(st.index || 1) - 1] || '';
    log(`resuming album walk — this page: ${name}`);
    await wait(2500);
    const sel = await selectAll({ onTick: (t) => log(`  selecting… ${t.checked}`) });
    const selected = sel.header || sel.checked;
    if (!selected) {
      log('  nothing selectable here — skipped');
      await resumeAlbumWalk();
      return;
    }
    const del = await deleteSelected();
    log(`  delete: ${del.ok ? 'clicked' : 'FAILED — ' + del.reason}`);
    const st2 = readResume();
    if (st2) {
      st2.done = (st2.done || []).concat([{ href: location.href, selected, ok: del.ok }]);
      writeResume(st2);
    }
    await wait(1500);
    await resumeAlbumWalk();
  }

  // ---------------------------------------------------------------- UI
  const LINES = [];
  function paintLog() {
    const box = document.getElementById('pbt-log');
    if (box) box.textContent = LINES.slice(-200).join('\n');
  }
  function log(msg) {
    const stamp = new Date().toLocaleTimeString();
    LINES.push(`[${stamp}] ${msg}`);
    paintLog();
  }

  function diagnose() {
    const report = {
      when: new Date().toISOString(),
      scan: scan(),
      itemCheckboxLabels: itemCheckboxes().slice(0, 8).map(labelOf),
      allCheckboxLabels: [...document.querySelectorAll('[role="checkbox"]')].slice(0, 8).map(labelOf),
      buttons: actionButtons().slice(0, 40).map((b) => b.label).filter(Boolean),
      dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => norm(d.innerText).slice(0, 200)),
      albums: albumHrefs().slice(0, 10),
      userAgent: navigator.userAgent
    };
    const text = JSON.stringify(report, null, 2);
    console.log('[photos-bulk] diagnostic\n' + text);
    return text;
  }

  function buildPanel() {
    if (document.getElementById('pbt-host')) return;
    const host = document.createElement('div');
    host.id = 'pbt-host';
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483647; right:16px; bottom:16px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          font: 13px/1.4 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
          width: 336px; max-height: 70vh; display: flex; flex-direction: column;
          background: #17181c; color: #e8e8ea; border: 1px solid #34363d;
          border-radius: 12px; box-shadow: 0 12px 34px rgba(0,0,0,.45); overflow: hidden;
        }
        header {
          display: flex; align-items: center; gap: 8px; padding: 8px 10px;
          background: #1e2026; cursor: grab; user-select: none;
        }
        header b { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; opacity: .8; font-weight: 600; }
        header .grow { flex: 1; }
        header button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; opacity: .7; }
        header button:hover { opacity: 1; background: #2c2f36; }
        .body { padding: 10px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
        .row { display: flex; gap: 6px; }
        button.act {
          flex: 1; font: inherit; font-weight: 600; padding: 7px 8px; cursor: pointer;
          color: #e8e8ea; background: #262931; border: 1px solid #3a3d45; border-radius: 8px;
        }
        button.act:hover { background: #2f333c; }
        button.act:disabled { opacity: .4; cursor: not-allowed; }
        button.danger { background: #4a1f22; border-color: #6d2c31; }
        button.danger:hover { background: #5a262a; }
        #pbt-log {
          font: 11px/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
          white-space: pre-wrap; word-break: break-word;
          max-height: 190px; overflow: auto; background: #101114; border: 1px solid #2a2d33;
          border-radius: 8px; padding: 7px; color: #b9bcc4; min-height: 62px;
        }
        label.arm { display: flex; gap: 7px; align-items: flex-start; font-size: 12px; color: #f0b5b5; }
        label.arm input { margin-top: 2px; }
        .hint { font-size: 11px; opacity: .55; }
        .status { font-size: 12px; color: #9fe3a8; min-height: 1.3em; }
      </style>
      <div class="card">
        <header id="pbt-drag">
          <b>Category Cleaner</b><span class="grow"></span>
          <button id="pbt-min" title="Collapse">—</button>
        </header>
        <div class="body" id="pbt-body">
          <div class="row">
            <button class="act" id="pbt-scan">Scan</button>
            <button class="act" id="pbt-select">Select all</button>
          </div>
          <div class="row">
            <button class="act" id="pbt-clear">Clear selection</button>
            <button class="act" id="pbt-diag">Diagnose</button>
          </div>
          <div class="status" id="pbt-status"></div>
          <button class="act danger" id="pbt-delete" disabled>Delete selected</button>
          <label class="arm"><input type="checkbox" id="pbt-arm"> I understand the delete is permanent for items in Trash.</label>
          <button class="act danger" id="pbt-auto" disabled>Auto: select + delete until empty</button>
          <div class="row">
            <button class="act" id="pbt-stop" disabled>Stop</button>
            <button class="act" id="pbt-walk">Album walk</button>
          </div>
          <div id="pbt-log">Ready. Scan first — nothing is deleted until you press Delete.</div>
          <div class="hint">Delete selected = one batch. Auto repeats until a pass finds nothing. Stop ends both.</div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (id) => root.getElementById(id);
    const status = $('pbt-status');
    const setStatus = (t) => { status.textContent = t; };
    const busy = (on) => {
      for (const id of ['pbt-scan', 'pbt-select', 'pbt-delete', 'pbt-auto', 'pbt-walk', 'pbt-clear']) $(id).disabled = on;
      $('pbt-stop').disabled = !on;
    };
    const armGate = () => {
      const armed = $('pbt-arm').checked;
      $('pbt-delete').disabled = !armed;
      $('pbt-auto').disabled = !armed;
    };
    $('pbt-arm').addEventListener('change', armGate);

    $('pbt-min').addEventListener('click', () => {
      const b = $('pbt-body');
      b.style.display = b.style.display === 'none' ? 'flex' : 'none';
    });

    // Drag by the header.
    let drag = null;
    $('pbt-drag').addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = host.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = r.left + 'px';
      host.style.top = r.top + 'px';
    });
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      host.style.left = Math.max(0, e.clientX - drag.x) + 'px';
      host.style.top = Math.max(0, e.clientY - drag.y) + 'px';
    });
    addEventListener('pointerup', () => { drag = null; });

    $('pbt-scan').addEventListener('click', () => {
      const s = scan();
      log(`scan: ${s.items} selectable items · ${s.checked} checked · header ${s.headerCount ?? '—'}`);
      log(`      delete button: ${s.deleteButton || 'not found'} · album tiles: ${s.albumTiles}`);
      log(`      scroller: ${s.scroller}`);
      setStatus(`${s.items} items loaded`);
    });

    $('pbt-select').addEventListener('click', async () => {
      busy(true);
      setStatus('selecting…');
      const res = await selectAll({ onTick: (t) => { setStatus(`selecting… ${t.checked}`); } });
      busy(false);
      armGate();
      setStatus(`selected: ${res.header ?? res.checked} (${res.checked} in view)`);
      log(`select all finished: ${res.checked} in view, header says ${res.header ?? '—'}, ${res.rounds} scroll passes`);
    });

    $('pbt-delete').addEventListener('click', async () => {
      busy(true);
      const res = await deleteSelected();
      busy(false);
      armGate();
      if (res.ok) {
        log(`delete: clicked "${res.clicked}"${res.confirmed ? `, confirmed "${res.confirmed}"` : ', no dialog'}`);
        setStatus('delete sent');
      } else {
        log(`delete FAILED: ${res.reason}`);
        if (res.seen) log('      buttons on page: ' + res.seen.join(' | '));
        if (res.labels) log('      dialog buttons: ' + res.labels.join(' | '));
        setStatus('delete failed — see log');
      }
    });

    $('pbt-auto').addEventListener('click', async () => {
      if (!confirm('Delete everything on this page, repeatedly, until nothing is left?')) return;
      busy(true);
      log('auto run started');
      const res = await autoRun({
        onTick: (t) => {
          if (t.phase === 'selected') setStatus(`pass ${t.pass}: ${t.selected} selected`);
          if (t.phase === 'selecting') setStatus(`pass ${t.pass}: selecting… ${t.checked}`);
        }
      });
      busy(false);
      armGate();
      for (const p of res.passes) log(`  pass ${p.pass}: ${p.selected} selected → ${p.ok ? 'deleted' : p.result || p.reason}`);
      setStatus(`auto finished (${res.passes.length} passes)`);
    });

    $('pbt-stop').addEventListener('click', () => {
      STATE.stop = true;
      log('stop requested');
    });

    $('pbt-clear').addEventListener('click', () => { clearSelection(); setStatus('selection cleared'); });

    $('pbt-diag').addEventListener('click', () => {
      const text = diagnose();
      log('diagnostic written to the console. Copy the block below:');
      log(text.slice(0, 4000));
    });

    $('pbt-walk').addEventListener('click', async () => {
      const list = albumHrefs();
      if (!list.length) {
        log('album walk: no album tiles on this page');
        setStatus('no album tiles');
        return;
      }
      if (!confirm(`Walk ${list.length} album tiles: open each, select everything, delete.\nProgress survives page reloads. Continue?`)) return;
      log(`album walk queued: ${list.length} albums`);
      busy(true);
      await startAlbumWalk({});
    });

    // Re-attach if Google's renderer wipes the node.
    const mo = new MutationObserver(() => {
      if (!document.getElementById('pbt-host')) document.documentElement.appendChild(host);
    });
    mo.observe(document.documentElement, { childList: true });
  }

  // ---------------------------------------------------------------- boot
  buildPanel();
  window.__pbt = {
    scan, selectAll, deleteSelected, autoRun, clearSelection, diagnose,
    itemCheckboxes, selectAllCheckbox, findDeleteButton, findConfirmButton, albumHrefs,
    state: STATE, log, startAlbumWalk, continueAlbumWalkIfNeeded
  };

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'pbt-show-panel') {
        const host = document.getElementById('pbt-host');
        if (host) host.scrollIntoView({ block: 'nearest' });
      }
    });
  } catch (e) {
    /* running outside an extension host (test harness) */
  }

  // A walk in progress survives the navigation it caused.
  continueAlbumWalkIfNeeded().catch((e) => log('album walk error: ' + e.message));
})();
