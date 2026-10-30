(() => {
  const out = { steps: [] };
  const P = window.__pbt;
  out.steps.push('api=' + (!!P));
  out.scan = P.scan();
  out.labels = P.itemCheckboxes().slice(0, 4).map((el) => el.getAttribute('aria-label'));

  // Select the first three items, then read the toolbar that only exists while something is picked.
  return (async () => {
    const boxes = P.itemCheckboxes().slice(0, 3);
    for (const b of boxes) { b.click(); await new Promise((r) => setTimeout(r, 250)); }
    await new Promise((r) => setTimeout(r, 800));
    out.afterSelect = {
      checked: P.itemCheckboxes().filter((e) => e.getAttribute('aria-checked') === 'true').length,
      header: (() => { const t = document.querySelector('[role="toolbar"]'); return t ? t.innerText.replace(/\n/g, ' | ').slice(0, 120) : null; })(),
      buttons: [...document.querySelectorAll('[role="toolbar"] button, [role="toolbar"] [role="button"]')]
        .map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim())
        .filter(Boolean),
      deleteFound: (() => { const d = P.findDeleteButton(); return d ? d.label : null; })(),
      toolbarCount: document.querySelectorAll('[role="toolbar"]').length
    };
    // Leave the page exactly as found.
    P.clearSelection();
    await new Promise((r) => setTimeout(r, 600));
    out.afterClear = P.itemCheckboxes().filter((e) => e.getAttribute('aria-checked') === 'true').length;
    return JSON.stringify(out, null, 1);
  })();
})()
