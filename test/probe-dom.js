(() => {
  const r = {};
  const all = [...document.querySelectorAll('[role="checkbox"]')];
  r.checkboxCount = all.length;
  r.imageCount = document.querySelectorAll('img').length;
  r.checkboxSamples = all.slice(0, 5).map((el) => {
    const b = el.getBoundingClientRect();
    return {
      label: el.getAttribute('aria-label'),
      checked: el.getAttribute('aria-checked'),
      hidden: el.getAttribute('aria-hidden'),
      box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
      outer: el.outerHTML.slice(0, 220)
    };
  });

  // What actually wraps a thumbnail in the grid?
  const img = document.querySelector('img');
  if (img) {
    const path = [];
    let e = img;
    for (let i = 0; i < 9 && e; i++) {
      path.push(
        e.tagName.toLowerCase() +
        (e.getAttribute('role') ? '[role=' + e.getAttribute('role') + ']' : '') +
        (e.getAttribute('jsaction') ? '[jsaction=' + e.getAttribute('jsaction').slice(0, 40) + ']' : '') +
        (e.id ? '#' + e.id : '')
      );
      e = e.parentElement;
    }
    r.imgPath = path.join(' < ');
    r.imgOuter = img.outerHTML.slice(0, 300);
  }

  // Any element carrying a "select" style label (English or Bulgarian)?
  const labelled = [...document.querySelectorAll('[aria-label]')];
  r.firstLabels = labelled.slice(0, 25).map((x) => x.getAttribute('aria-label'));
  r.selectish = labelled
    .filter((x) => /select|избор|избери|checkbox/i.test(x.getAttribute('aria-label') || ''))
    .slice(0, 10)
    .map((x) => x.tagName.toLowerCase() + ' role=' + (x.getAttribute('role') || '-') + ' :: ' + x.getAttribute('aria-label'));

  // Toolbar / header buttons that exist before anything is selected.
  r.buttons = [...document.querySelectorAll('button, [role="button"]')]
    .slice(0, 40)
    .map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim().slice(0, 40))
    .filter(Boolean);
  r.toolbars = document.querySelectorAll('[role="toolbar"]').length;
  r.docLang = document.documentElement.lang;
  return JSON.stringify(r, null, 1);
})()
