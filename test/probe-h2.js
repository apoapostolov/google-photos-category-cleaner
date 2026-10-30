(() => {
  const P = window.__pbt;
  return (async () => {
    const boxes = P.itemCheckboxes().slice(0, 4);
    for (const b of boxes) { b.click(); await new Promise((r) => setTimeout(r, 200)); }
    await new Promise((r) => setTimeout(r, 1200));
    const out = { checkedDom: P.itemCheckboxes().filter((e) => e.getAttribute('aria-checked') === 'true').length };
    out.viaTextContent = [];
    out.viaInnerText = [];
    for (const el of document.querySelectorAll('div, span')) {
      const tc = (el.textContent || '').trim();
      if (tc.length && tc.length <= 60 && /selected/i.test(tc)) {
        out.viaTextContent.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 30), tc, len: tc.length });
      }
      const it = (el.innerText || '').trim();
      if (it.length && it.length <= 60 && /selected/i.test(it)) {
        out.viaInnerText.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 30), it });
      }
    }
    out.viaTextContent = out.viaTextContent.slice(0, 8);
    out.viaInnerText = out.viaInnerText.slice(0, 8);
    out.headerCount = P.scan().headerCount;
    P.clearSelection();
    return JSON.stringify(out, null, 1);
  })();
})()
