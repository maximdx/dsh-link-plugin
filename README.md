# dsh-link-plugin

One DSH browser plugin that gives the composer Codex-style link behaviour and
renders Markdown links in sent user messages.

## What it does

1. **Markdown takeover composer** — replaces the native plain-text composer
   with a CodeMirror 6 editor (live Markdown rendering, `Enter` sends,
   `Shift+Enter` breaks the line, a render/source toggle, attachment bar,
   model/permission/command/queue faces). Inherited from
   `dsh-markdown-input`; see `patches/README.md` for the exact fork.
2. **Paste a URL onto selected text** — select `repo`, press `Cmd/Ctrl+V` with
   `https://github.com/...` on the clipboard: the selection becomes
   `[repo](https://github.com/...)` and is **rendered immediately** as the
   underlined `repo` (no raw Markdown shown; source reappears only while the
   caret is inside the link). One `Cmd/Ctrl+Z` reverts it.
3. **Sent-message link rendering** — in the chat history, `[repo](url)` in a
   user message renders as a brand icon (GitHub, npm, ... via the host's
   `LinkIconMedium`) + underlined label, alternating with the host's own
   user-text projection. Model input and copy/clipboard keep the Markdown
   source.
4. **Graceful fallback** — if the takeover card cannot mount (host drift,
   missing services), it reverts to the native composer with the draft intact,
   and the merged-in native-composer paste interceptor still turns
   "selection + URL paste" into a Markdown link.

## Target

DSH Desktop / Web **0.2.1-rc.2** (macOS desktop tested). The upstream base is
the `0.2.0-rc.x` line; this fork is re-verified against 0.2.1-rc.2.

Known limits:

- Upstream's own "user messages as Markdown" seat is disabled on 0.2.1-rc.2
  (the host's `projectUserText` primitive is gone). User bubbles therefore stay
  plain text except for the link rendering this plugin adds.
- Composer links render as an underlined label (no favicon) and are not
  clickable while editing; sent-bubble links open in a new window.
- The base is an alpha upstream; a future `dsh-markdown-input` release that
  supports 0.2.1 natively should be preferred over re-applying these patches.

## Install into a profile

```sh
cp -R <this-dir> ~/.dsh/profiles/desktop/plugins/dsh-link-plugin
# ~/.dsh/profiles/desktop/package.json:
#   "dependencies": { "dsh-link-plugin": "file:./plugins/dsh-link-plugin" }
#   "dsh": { "profile": { "bundles": [ ..., "dsh-link-plugin" ] } }
cd ~/.dsh/profiles/desktop && pnpm install
```

The profile host HMR recomposes live; restart DSH if the row does not appear.
Disable it from the sidebar **Plugins** page to get the native composer back.

## Maintenance

- Rebuild `lib/client.js`: `python3 patches/apply-patches.py /path/to/unpacked/dsh-markdown-input`
- Re-test the merged bundle without a browser: `node patches/smoke.mjs`
  (fake lazy-CJS host; asserts the extras register, the rule matches and the
  renderer output shape).
- License: MIT; upstream attribution in `LICENSE` and `THIRD_PARTY_NOTICES.md`.
