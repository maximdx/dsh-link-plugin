# Third-party notices

`lib/client.js` started as the published browser bundle of **dsh-markdown-input
0.2.0-alpha.20** by long6177 (MIT):

- npm: https://www.npmjs.com/package/dsh-markdown-input
- repo: https://github.com/long6177/dsh-markdown-input

The following are bundled inside that upstream artifact and remain under their
own MIT licenses:

- CodeMirror 6 packages (`@codemirror/*`, `@lezer/*`) — MIT, Marijn Haverbeke
- turndown — MIT, Dom Christie
- dsh-markdown-input's own source — MIT, long6177

Local modifications are documented in `patches/README.md`; the reproducible
rebuild script is `patches/apply-patches.py`.
