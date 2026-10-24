# Local patches over the upstream dsh-markdown-input bundle

`lib/client.js` is **not** hand-written from scratch: it is the published
browser bundle of `dsh-markdown-input@0.2.0-alpha.20` with the changes below
(plus `patches/dsh-link-plugin.extras.js`, appended verbatim).

Rebuild (downloads nothing; point it at an unpacked npm tarball):

```sh
cd /tmp && curl -sLO https://registry.npmjs.org/dsh-markdown-input/-/dsh-markdown-input-0.2.0-alpha.20.tgz
mkdir -p upstream && tar xzf dsh-markdown-input-0.2.0-alpha.20.tgz -C upstream
python3 patches/apply-patches.py /tmp/upstream/package
node --check lib/client.js
```

The script asserts every anchor it edits, so an upstream version that moved
these lines fails loudly instead of producing a silently broken bundle.

## Changes

1. **Module id** `dsh-markdown-input` → `dsh-link-plugin`: the client module
   loader requires the bundle id to equal `package.json.name` (the graph row).
2. **Cordis `inject`** `["slots","locale"]` → `["slots","locale","uiConversation"]`:
   the merged-in user-text rule needs the conversation registry.
3. **`pasteURLAsLink` caret** (CodeMirror lang-markdown): after wrapping the
   selection, set `selection: { anchor: main.to + link.length + 4 }` so the
   caret lands after the inserted link instead of leaving a mapped selection
   that would be replaced by the next keystroke.
4. **Link folding** (live-render): links stay rendered when the caret is on the
   same line; the Markdown source is revealed only while the caret is strictly
   inside the link (`state.selection.ranges.some(...)`). This makes a pasted
   link show up as the underlined label immediately, not as `[label](url)`.
5. **Merged extras** (`patches/dsh-link-plugin.extras.js`): the previous
   dsh-link-plugin half — a `ctx.uiConversation.userText` rule plus keyed
   `conversation.user.text.node` renderer that draws `[label](url)` in sent
   user bubbles as brand icon + underlined label, and a capture-phase paste
   interceptor on the native Lexical composer used only when the Markdown
   takeover degrades. `apply` is wrapped so these register after the takeover.

## Upstream provenance

- base: `dsh-markdown-input@0.2.0-alpha.20` (npm, MIT, long6177,
  https://github.com/long6177/dsh-markdown-input)
- full unified diff for review: `markdown-input.local.patch`
- pre-merge, hand-written implementation kept for reference:
  `legacy-simple-client.js` (not loaded)
