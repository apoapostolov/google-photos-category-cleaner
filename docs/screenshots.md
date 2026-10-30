# Screenshots

Every image in the README is a real capture of the running extension. This table is the record of
what each one shows and how to take it again, because screenshots rot the moment the UI moves.

Re-run `node test/capture-docs.mjs` after any UI change. It rewrites both screenshots and every icon
PNG from `docs/icon.svg`, so nothing here is hand-cropped.

| File | Surface | State captured | Viewport | Version | Reproduce |
| --- | --- | --- | --- | --- | --- |
| `docs/screenshots/panel-1.0.0.png` | The floating panel injected into a Google Photos page | Scan run, then Select all finished — status `selected: 30 (30 in view)`. Arming box unticked, so Delete selected, Auto and Stop are disabled | 338x454 CSS px at 2x, cut out of the page with a transparent backdrop | 1.0.0 | `node test/capture-docs.mjs` |
| `docs/screenshots/popup-1.0.0.png` | The toolbar popup, `chrome-extension://<id>/popup.html`, served by the real extension | Default state, nothing clicked | 340x420 CSS px at 2x | 1.0.0 | `node test/capture-docs.mjs` |
| `docs/icon-512.png` | Hero icon and README mark, from the source `docs/icon.svg` | The same SVG rendered at 512; the 16, 32, 48 and 128 renders go to `icons/` for the manifest | 512x512 | 1.0.0 | `node test/capture-docs.mjs` |

The page behind the panel is `test/fixture.html`, a synthetic 30-tile grid with Bulgarian labels. It
is deliberately not a real Google Photos account: those contain identity documents, receipts and
other people's photos, and a public repo is the wrong place for them.

## Keeping this honest

- When the UI a shot shows changes, capture to a new file with the version in the name
  (`panel-1.2.0.png`), update the README, and leave the old row here until nothing references it.
- The caption must say when content is synthetic. Currently both shots are synthetic.
- If a change alters the panel's size, update the viewport column — a stale size is how a screenshot
  ends up stretched or clipped in the README.
