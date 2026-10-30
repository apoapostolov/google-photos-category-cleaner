(() => {
  const P = window.__pbt;
  const out = {};
  const ticks = [];
  return (async () => {
    out.headerBefore = P.scan().headerCount;
    const res = await P.selectAll({
      onTick: (t) => { ticks.push(t); if (t.rounds >= 8) P.state.stop = true; }
    });
    out.result = res;
    out.ticks = ticks;
    // Google's own count must exceed what is rendered at once (virtualized grid).
    out.renderedNow = P.itemCheckboxes().length;
    out.headerAfter = P.scan().headerCount;
    P.clearSelection();
    await new Promise((r) => setTimeout(r, 800));
    out.headerAfterClear = P.scan().headerCount;
    out.checkedAfterClear = P.itemCheckboxes().filter((e) => e.getAttribute('aria-checked') === 'true').length;
    return JSON.stringify(out, null, 1);
  })();
})()
