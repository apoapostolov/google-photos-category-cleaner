(() => {
  const P = window.__pbt;
  const out = {};
  const sel = () => P.itemCheckboxes().filter((e) => e.getAttribute('aria-checked') === 'true').length;

  const findHeader = () => {
    // The selection header is whatever renders "N selected" near the top of the page.
    const hits = [];
    for (const el of document.querySelectorAll('div, span, header')) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 60) continue;
      if (!/^\d[\d,\s]*\s*(selected|избран)/i.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20) continue;
      hits.push({ text: t, tag: el.tagName.toLowerCase(), cls: (el.className || '').slice(0, 40), box: [Math.round(r.x), Math.round(r.y)] });
    }
    return hits.slice(0, 6);
  };

  return (async () => {
    const first = P.itemCheckboxes().slice(0, 3);
    for (const b of first) { b.click(); await new Promise((r) => setTimeout(r, 200)); }
    await new Promise((r) => setTimeout(r, 900));
    out.selected = sel();
    out.headerCandidates = findHeader();
    out.headerCountNow = P.scan().headerCount;
    out.selectAllBoxLabel = (P.selectAllCheckbox() || {}).getAttribute ? P.selectAllCheckbox().getAttribute('aria-label') : null;
    P.clearSelection();
    await new Promise((r) => setTimeout(r, 700));
    out.afterClear = sel();

    // Capped scroll-select: five loading rounds only, to prove the loop accumulates.
    const ticks = [];
    const res = await P.selectAll({
      onTick: (t) => { ticks.push({ rounds: t.rounds, checked: t.checked, header: t.header, height: t.height }); if (t.rounds >= 4) P.state.stop = true; }
    });
    out.scrollSelect = { final: res, ticks: ticks.slice(-6) };
    P.clearSelection();
    await new Promise((r) => setTimeout(r, 700));
    out.afterScrollClear = sel();
    return JSON.stringify(out, null, 1);
  })();
})()
