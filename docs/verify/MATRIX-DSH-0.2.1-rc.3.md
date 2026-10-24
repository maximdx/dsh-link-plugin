# Verification report — dsh-link-plugin × DSH 0.2.1-rc.3

> Archived result of the real-UI acceptance run that validated the 0.3.0
> rewrite (2026-10-24). Paths under `/tmp` were the disposable test rig; the
> reproducible harness is in `tests/e2e/`.

Owner: e2e-harness (task-1). Everything ran on isolated copies under /tmp; the live
desktop profile (`~/.dsh/profiles/desktop`), the live app (127.0.0.1:49324/*), and the
repo were never modified. All artifacts are under `/tmp/e2e/`.

## Environment

| Item | Value |
|---|---|
| DSH runtime | 0.2.1-rc.3 / commit `be72761` (from `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`, extracted to `/tmp/dsh-asar/dsh`) |
| CLI entry | `/tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| DSH_HOME | `/tmp/dsh-home` (profiles/e2e = copy of the desktop profile: dsh-link-plugin, dsh-theme-solarized, dsh-sidenote, keep-awake) |
| Server | `DSH_HOME=/tmp/dsh-home node bin.js --profile e2e --port 3099 --no-open` (log: `/tmp/e2e/variants/<v>/server.log`) |
| Browser | headless Google Chrome 155.0.8059.85, CDP ws on `127.0.0.1:9311`, user-data-dir `/tmp/chrome-e2e-harness`, viewport 1440×1000 |
| Node | v26.0.0 (`/opt/homebrew/bin/node`) |
| Auth | isolated profile has no DeepSeek credentials → every turn ends server-side with `ACCOUNT_SIGN_IN_REQUIRED`; this does NOT affect user-message send or bubble rendering |

Exact reproduction commands:

```bash
# baseline (dump config; shows the compatibility preflight skip)
DSH_HOME=/tmp/dsh-home node /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile e2e --dump-config

# install a variant into the isolated profile (whole-dir swap), then start server
/tmp/e2e/scripts/install-variant.sh /tmp/e2e/variants/c-hardened c-hardened
DSH_HOME=/tmp/dsh-home node /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile e2e --port 3099 --no-open
# read printed token URL from stdout, then drive Chrome:
node /tmp/e2e/scripts/c-e2e.mjs --url 'http://127.0.0.1:3099/?token=…' --out /tmp/e2e/variants/c-hardened --server-log /tmp/e2e/variants/c-hardened/server.log
```

Tested artifacts (sha256 of installed `lib/client.js`):

| Variant | Version | engines.dsh (installed) | client.js sha256 |
|---|---|---|---|
| Baseline exact-pin | 0.1.0 (thin) | `"0.2.1-rc.2"` (exact) | `b817337f…` |
| A: thin legacy | 0.1.0 (thin) | `">=0.2.1-rc.2"` | `b817337f…` |
| B: fork 0.2.0 (diagnostic) | 0.2.0 (git HEAD `bbc95a6`) | `">=0.2.1-rc.2"` | `44cd01f0…` |
| C: hardened link-only | 0.3.0 (repo working tree) | absent (only `engines.node`) | `ea1fb810…` |

## Verdict matrix

| Check | Baseline exact | A thin | B fork 0.2.0 | C hardened 0.3.0 |
|---|---|---|---|---|
| server prints `skipping profile bundle "dsh-link-plugin"` | **YES** | no | no | no |
| `__DSH_BOOT__.entries` contains `id:"dsh-link-plugin"` | **NO** (73 entries) | YES (74) | YES (74) | YES (74) |
| plugin console line | none | none (silent) | `[markdown-input] user-message Markdown rendering disabled: primitives Markdown surface incomplete` (info) | `[dsh-link-plugin] active: paste URL over a selection -> Markdown link; sent-message link rendering.` (info) |
| console warnings/errors/exceptions | none | none | none | none |
| composer kind | native lexical | native lexical | **CodeMirror takeover mounts** (`.cm-editor` 752×72 visible; native lexical collapsed to 0×0) | native lexical |
| overlay anchor `conversation.input.overlay` mount | not mounted (plugin skipped) | mounted | mounted | mounted (`span[hidden][data-dsh-link-anchor]` inside `[data-composer-card]`) |
| paste URL over selection | plain URL paste: `hello https://github.com/foo/bar world` | `hello [repo](https://github.com/foo/bar) world` | `hello [repo](https://github.com/foo/bar) world` | `hello [repo](https://github.com/foo/bar) world` |
| sent bubble | raw markdown text, 0 links | `a.dsh-mdlink` icon+underlined label | `a.dsh-mdlink` icon+underlined label | `a.dsh-mdlink` icon+underlined label |
| unknown host `https://example.org/x` | n/a | not tested | not tested | `see docs [page](https://example.org/x)`; bubble shows chain-link svg + label `page` |
| non-URL paste over selection | n/a | not tested | not tested | native plain paste wins: `plain hello test`, no `[`, no plugin transform |
| **Verdict** | **FAIL (plugin skipped — reproduces the user-visible break)** | **PASS** | **PASS** (takeover is NOT broken on rc.3; only its extra Markdown seat degrades) | **PASS — ship candidate** |

C hardened PASS = 15/15 assertions (`pluginRowInBootEntries`, `noServerSkipWarning`,
`noServerIncompatibleLines`, `pluginActiveConsoleInfo`, `noPluginWarnings`,
`noExceptions`, `overlayAnchorMounted`, `githubComposerLink`, `githubPastePrevented`,
`githubBubbleRendered`, `exampleHostComposerLink`, `exampleHostBubbleRendered`,
`exampleHostGenericIcon`, `nonUrlNativePlainPasteWon`, `nonUrlNoBrackets`).

## Baseline visible effect (proof of the rc.3 skip)

Server log line (verbatim, `/tmp/e2e/variants/baseline-exact/server.log`):

```
dsh: skipping profile bundle "dsh-link-plugin": Error: Plugin dsh-link-plugin@0.1.0 is incompatible with dsh 0.2.1-rc.3: requirements {"engines.dsh":"0.2.1-rc.2"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for dsh-link-plugin@0.1.0 on dsh 0.2.1-rc.3 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: not active.
```

Browser consequence, captured with the exact same CDP scenario:
- boot payload has no row: `__DSH_BOOT__.entries.filter(e => e.id === "dsh-link-plugin") === []` (73 entries vs 74 with the plugin loaded);
- paste over selection stays plain: composer `hello https://github.com/foo/bar world` (no `[repo](…)`);
- sent message `hello [repo](https://github.com/foo/bar) world` renders as literal text, `mdlinkCount = 0`;
- screenshots: `baseline-exact/01-paste-no-plugin.png`, `baseline-exact/02-bubble-raw-markdown.png`.

## Host API drift observed on 0.2.1-rc.3

1. **Compatibility preflight (root cause).** Exact `engines.dsh` pin (`"0.2.1-rc.2"`) → whole bundle skipped with a
   `skipping profile bundle` error on stderr; boot manifest then omits the bundle. Accepting fix: engine range
   (`>=0.2.1-rc.2`) or no `engines.dsh` at all (variant C). Note the profile's own `dsh-conversation`-unrelated exact pins
   (e.g. `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`) show the same preflight behavior for stock plugins.
2. **Boot manifest shape unchanged:** `window.__DSH_BOOT__ = { rev, release:{version,commit}, entries:[{id,url,rev,inject?,immediately?}], batches }`; plugin rows appear there when enabled — a good runtime status probe.
3. **Composer slots/props still supplied:** `conversation.input.overlay` (inside `[data-composer-card]`) still provides the
   standard `useInput` / `inputActions` props: C's hidden anchor mounts and `inputActions.insertText(markdown, span)` is
   accepted (composer transform observed). `[data-composer-input][data-lexical-editor][data-phase]` still present.
4. **User text slots unchanged:** rule id `markdown-link` + `conversation.user.text.node` keyed renderer still work; the
   host renders user bubbles through `conversation.user.text.node` inside `[data-chat-flow-kind=user]`/`.bubble`.
5. **Fork-specific primitives drift:** rc.3's primitives namespace no longer exposes `projectUserText` (0 occurrences in
   `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`; `MarkdownText`, `JsonBlock`, `FileTypeIcon`, `Tooltip`,
   `IconCopyOutlineRegular`, `IconCheckOutlineRegular`, `fileSizeText`, `writeClipboard` are present). This is what
   deactivates the fork's own user-message Markdown seat; it is not a general composer failure.
6. **Takeover is not broken on rc.3:** the 0.2.0 CodeMirror composer takeover mounts and is fully visible/functional after
   relaxing engines (`[data-slot="conversation.input.overlay"]` component renders the CM surface; native lexical input is
   kept in the DOM at 0×0 as the input-state host). Rebasing onto upstream `dsh-markdown-input@0.2.1` is a *feature
   question*, not a compatibility blocker.
7. **Paste semantics caveat for test authors:** the host's Lexical paste command reads `clipboardData` and calls
   `preventDefault()` for any paste, so `event.defaultPrevented` alone cannot prove plugin interception. The reliable
   signal is the composer draft text (markdown link inserted ⇒ plugin capture listener ran first and called
   `insertText`).

## Console output (verbatim)

- Baseline exact / A thin: **no console entries at all** (0 events).
- B fork (rc.3, relaxed engines): exactly 1 info line —
  `[markdown-input] user-message Markdown rendering disabled: primitives Markdown surface incomplete`
- C hardened (rc.3): exactly 1 info line —
  `[dsh-link-plugin] active: paste URL over a selection -> Markdown link; sent-message link rendering.`
  No warnings, no errors, no exceptions in any run.

## Artifacts

Scripts (`/tmp/e2e/scripts/`): `cdp.mjs` (minimal CDP client), `e2e.mjs` (generic 2-feature scenario for A/B),
`c-e2e.mjs` (extended C acceptance: known host, unknown host, non-URL paste, overlay probe, console contract),
`baseline-exact.mjs` (exact-pin visible-effect capture), `install-variant.sh` (profile swap), `probe.mjs`, `act.mjs`.

Per-variant (`/tmp/e2e/variants/<name>/`): `result.json`, `console.json`, `server.log`, screenshots:

- Baseline exact: `00-boot.png`, `01-paste-no-plugin.png`, `02-bubble-raw-markdown.png`
  (+ `/tmp/e2e/baseline/dump-config-exact-pin.log`, `page.boot.json`, `page.console.json`, `page.png`)
- A thin: `00-boot.png`, `01-composer-after-paste.png`, `02-composer-crop.png`, `03-sent-full.png`, `04-sent-bubble-crop.png`
- B fork: `00-boot.png`, `01-composer-after-paste.png`, `02-composer-crop.png`, `03-sent-full.png`, `04-sent-bubble-crop.png`
- **C hardened: `00-boot.png`, `00b-overlay-probe.png`, `01-composer-github.png`, `02-bubble-github.png`,
  `03-composer-example-host.png`, `04-bubble-example-host.png`, `05-composer-nonurl-paste.png`** — the key evidence.

Variant file sets (reproducible install dirs): `/tmp/e2e/variants/{baseline-exact,thin,fork,c-hardened}/`
(each a full package: `package.json`, `cordis.patch.yml`, `lib/{index,client}.js`).

## Notes / limitations

- Assistant replies always fail with `ACCOUNT_SIGN_IN_REQUIRED` in this isolated profile (no DeepSeek sign-in). Only the
  user side (composer + user bubble) is asserted, which is exactly what the plugin touches.
- The "Previous Notice"/"Get started" first-run dialogs appear on a fresh Chrome profile; the harness clicks
  Continue/Close before typing. Sessions restored from prior runs are tolerated (assertions target the newest user bubble).
- Variant C was tested from working-tree state `ea1fb810dd6ab65cf4e53aa035e0a2918e671137c6e51ede883bdcd1c7e8e16c`
  (`lib/client.js`); re-run `c-e2e.mjs` after any repo edit (whole workflow is scripted, ~40 s).
