# tests/e2e — real-UI acceptance harness (developer tooling)

This directory is **not** part of the shipped plugin. It is the browser-level
acceptance run used to verify the plugin against a real DSH desktop/web build
when `tools/compat-check.mjs` reports drift, or before shipping a change.

It drives an **isolated** `dsh web` instance with headless Chrome over the
Chrome DevTools Protocol and asserts the whole user path:

1. the plugin's bundle row is present in `window.__DSH_BOOT__.entries`;
2. the server did not print a `skipping profile bundle` compatibility error;
3. the plugin logs its `[dsh-link-plugin] active: …` info line, with no
   warnings/errors/exceptions;
4. the hidden paste anchor mounted inside the composer card
   (`span[data-dsh-link-anchor]`);
5. typing `hello repo world`, selecting `repo`, and pasting
   `https://github.com/foo/bar` turns the draft into
   `hello [repo](https://github.com/foo/bar) world`;
6. Enter-to-send renders a user bubble with `a.dsh-mdlink[href=…]`, the brand
   icon (GitHub octocat), the underlined label, no raw Markdown;
7. an unknown host gets the generic chain-link glyph;
8. a non-URL paste over a selection keeps native behaviour (no `[`).

The last full run (2026-10-24, DSH `0.2.1-rc.3`, commit `be72761`) passed
15/15; see `docs/verify/` screenshots and the matrix in the repo history /
commit message.

## Prerequisites

- macOS with the DSH desktop app installed (its `app.asar` carries the DSH
  runtime; the script does not need the app running).
- Node >= 22 (this harness uses the global `WebSocket`; the plugin itself only
  needs Node >= 20).
- Google Chrome installed.
- An **isolated** DSH home. Never point this at `~/.dsh` and never test against
  the running desktop app: the harness replaces the profile's plugin copy.

## Setup (one-time per DSH version)

```sh
# 1. Extract the DSH tree from the installed app (Python; same layout as
#    ~/.dsh/profiles/<profile> but disposable).
python3 tests/e2e/extract-asar.py \
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar" \
  /tmp/dsh-asar "dsh/"
rsync -a "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh/" \
  /tmp/dsh-asar/dsh/   # native modules

# 2. Isolated DSH home with a copy of a working profile.
mkdir -p /tmp/dsh-home/profiles
cp -R ~/.dsh/profiles/desktop /tmp/dsh-home/profiles/e2e

# 3. Launch the isolated web server (prints a tokenized URL on stdout).
DSH_HOME=/tmp/dsh-home \
  node /tmp/dsh-asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --profile e2e --port 3099 --no-open

# 4. Headless Chrome with CDP (keep it running in another shell).
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9311 \
  --user-data-dir=/tmp/chrome-e2e-harness --no-first-run about:blank
```

The extraction helper is a ~40-line asar reader (header: `u32 4`, `u32
headerSize`, NUL-padded JSON tree; data base `8 + headerSize`) — or use any
asar tool you trust.

## Install a candidate bundle into the isolated profile

```sh
tests/e2e/install-variant.sh /path/to/plugin-candidate
```

It swaps `<isolated-profile>/node_modules/dsh-link-plugin` (and the `plugins/`
mirror), prints the installed version/engines/sha256, then restart the server
from step 3.

## Run the acceptance

```sh
node tests/e2e/c-e2e.mjs \
  --url 'http://127.0.0.1:3099/?token=<printed token>' \
  --out /tmp/e2e/run \
  --server-log /tmp/e2e/run/server.log
```

`--out` receives `result.json`, `console.json`, screenshots and the full
console/exception capture. The process exits after writing `result.json`; the
`verdict` field is `PASS` only when every check in the script's `checks`
object is true. `cdp.mjs` is the minimal CDP client (Node global `WebSocket`,
no dependencies).

Notes:

- The host's Lexical `PASTE_COMMAND` calls `preventDefault()` on every paste,
  so `defaultPrevented` alone is **not** proof the plugin intercepted it —
  assert the resulting draft text instead (the script does).
- The isolated profile has no DeepSeek credentials, so turns end with
  `ACCOUNT_SIGN_IN_REQUIRED`; user-message send and bubble rendering, which is
  what we verify, still work.
