# tools/ — DSH upgrade compatibility checker

`compat-check.mjs` is the durable post-upgrade tripwire for **dsh-link-plugin**.
DSH desktop auto-updates; a plugin can silently stop loading when the installed
DSH runtime no longer matches the plugin's manifest or when a host API the
plugin uses is renamed. This script reads the *installed* `app.asar` directly
and tells you whether the plugin will still load and work.

Dependency-free ESM, Node >= 20, no `npm install` needed.

## Usage

```sh
# default: installed macOS app + this repo + live desktop profile
node tools/compat-check.mjs

# explicit paths
node tools/compat-check.mjs \
  --app "/Applications/DeepSeek Harness.app" \
  --plugin . \
  --profile-dir ~/.dsh/profiles/desktop

# npm/source DSH install instead of the app bundle
node tools/compat-check.mjs --host-modules /path/to/dsh/node_modules

# machine-readable output (same data; one JSON object on stdout)
node tools/compat-check.mjs --json
```

`pnpm verify` runs the default command.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--app <path>` | `$DSH_APP` or `/Applications/DeepSeek Harness.app` | DSH app bundle or its `app.asar`. |
| `--host-modules <dir>` | — | Verify an npm/source install: path to that install's `dsh/node_modules`. |
| `--plugin <dir>` | this repo | Plugin package root to check. |
| `--profile-dir <dir>` | `$DSH_PROFILE_DIR`, else `$DSH_HOME/profiles/desktop`, else `~/.dsh/profiles/desktop` | Live profile whose installed copy is compared with the repo. Use `none` to skip. |
| `--json` | — | Print one JSON object (paths unshortened) instead of the report. |
| `-h`, `--help` | — | Show help. |

Exit codes: `0` PASS or DEGRADED (warnings only), `1` FAIL, `2` bad CLI usage.

## What it checks

1. **Host runtime** — reads `app.asar` with a small pure-JS asar reader
   (Electron/Chromium Pickle header; `unpacked` entries fall back to
   `app.asar.unpacked/`), resolves the real runtime version from
   `dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json`, and counts the
   host client bundles.
2. **Manifest** —
   - `engines.dsh`: **exact pins FAIL** (an exact pin is what made DSH's
     compatibility preflight skip the whole bundle on the rc.2 -> rc.3
     auto-upgrade); a range must actually admit the runtime (npm semver
     semantics, including prerelease rules); absent or satisfied passes.
   - `dsh.bundle.patch` file exists.
   - `exports["./client"]` exists and its target file exists.
   - `dsh.client.platform === "web"`.
3. **Host extension surfaces** — string-searches the installed host JS once
   (bounded at 80 MB, only `@deepseek-ai/*/lib/*.js` and
   `dsh-web-frontend/dist/assets/*.js`) for the APIs the plugin's browser half
   needs: `conversation.input.overlay`, `conversation.user.text.node`,
   `uiConversation.userText.register`, `captureInsertion`, `insertText`,
   `data-composer-input`, `data-composer-card`, and the input-phase literals
   `"plain"` / `"claimed"`. A miss names the degraded feature
   (`paste-link` vs `sent-link-rendering`).
4. **Live profile copy** — compares the repo's `lib/client.js` (sha256),
   `package.json` (`name` / `version` / `dsh.client` / `engines.dsh`) and the
   bundle patch against the installed profile copy
   (`<profile>/node_modules/<pkg>` or `<profile>/plugins/<pkg>`). A stale copy
   means the app keeps loading old code: sync it with `pnpm install` in the
   profile (or reinstall the bundle) and relaunch DSH.
5. **Upgrade resilience** — scans `lib/client.js` for runtime imports. The
   target is **zero** `@deepseek-ai` host imports: undeclared non-seed ones are
   failures, declared ones are warnings. `react` / `react-dom` are seed-allowed.

## Current DSH facts baked into the checker

- App bundle: `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`.
- DSH tree inside: `dsh/`; host client bundles:
  `dsh/node_modules/@deepseek-ai/<pkg>/lib/client.js`; web shell:
  `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/*.js`.
- ASAR header: 8-byte prefix (`u32 4`, `u32 headerSize`), then a header buffer
  at offset 8 (`u32 payloadSize`, `u32 jsonLength`, JSON, padded); file data
  begins at `8 + headerSize`, entries carry `{ offset, size, unpacked? }`.
- Live desktop profile: `~/.dsh/profiles/desktop`.

## If it FAILs after a DSH upgrade

1. Read the FAIL rows: manifest failures are fixed in `package.json`; surface
   failures mean the DSH host API changed and `lib/client.js` must be re-ported
   against the new bundles.
2. Fix the cause, then **reinstall the profile copy** (`pnpm install` in
   `~/.dsh/profiles/desktop`, or reinstall the bundle) — otherwise the app
   keeps running the stale copy the checker warns about.
3. Re-run `node tools/compat-check.mjs --json` (JSON is convenient for CI or
   for attaching to an upgrade report).
