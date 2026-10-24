# Third-party notices

## Shipped plugin (0.3.0, link-only)

- **Simple Icons** — brand glyph path data in `lib/client.js` (`BRAND_ICONS`).
  Simple Icons is released under CC0 1.0 Universal:
  https://github.com/simple-icons/simple-icons/blob/master/LICENSE.md
  The brand names and logos are trademarks of their respective owners; the
  glyphs are used here only to identify the site a link points to.
- **React** is provided by the DSH browser module table at runtime and is not
  bundled in this package.

## Historical archive (`archive/takeover/`, not shipped)

The plugin's previous build (0.2.0) was a local fork of **dsh-markdown-input
0.2.0-alpha.20** by long6177 (MIT), whose browser bundle in turn contained:

- CodeMirror 6 packages (`@codemirror/*`, `@lezer/*`) — MIT, Marijn Haverbeke
- turndown — MIT, Dom Christie
- dsh-markdown-input's own source — MIT, long6177

Upstream: https://www.npmjs.com/package/dsh-markdown-input ·
https://github.com/long6177/dsh-markdown-input

The fork and its rebuild/patch scripts are kept under `archive/takeover/` for
provenance only; they are not part of the shipped plugin and are not loaded by
DSH.
