(() => {
  const P = window.__pbt;
  return (async () => {
    const before = P.scan();
    P.clearSelection();
    await new Promise((r) => setTimeout(r, 1200));
    const after = P.scan();
    return JSON.stringify({ before: { header: before.headerCount, checked: before.checked }, after: { header: after.headerCount, checked: after.checked } }, null, 1);
  })();
})()
