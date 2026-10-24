#!/usr/bin/env python3
"""Rebuild dsh-link-plugin/lib/client.js from an upstream dsh-markdown-input npm package.

Usage:
  python3 patches/apply-patches.py /path/to/unpacked/npm-package

The upstream package is `dsh-markdown-input@0.2.0-alpha.20` (npm tarball);
`package/` is the unpacked tarball root. The script applies the local fork's
modifications and writes lib/client.js next to this package:

  1. module id "dsh-markdown-input" -> "dsh-link-plugin" (the loader requires
     the bundle id to equal the package name);
  2. cordis `inject` gains "uiConversation" (the merged-in user-text rule needs it);
  3. CodeMirror lang-markdown's pasteURLAsLink: place the caret after the
     inserted link instead of leaving a mapped selection;
  4. live-render Link folding: keep the label rendered even when the caret is
     on the same line; reveal the source only when the caret is strictly
     inside the link;
  5. append patches/dsh-link-plugin.extras.js and wrap `apply` so the merged
     extras (sent-bubble link rendering + native-composer fallback paste-link)
     register after the composer takeover.
"""
import pathlib
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    upstream = pathlib.Path(sys.argv[1])
    here = pathlib.Path(__file__).resolve().parent
    bundle = (upstream / "lib" / "client.js").read_text(encoding="utf-8")
    extras = (here / "dsh-link-plugin.extras.js").read_text(encoding="utf-8")

    old_id = 'window.__ModuleLoader__.load({\n\tid: "dsh-markdown-input",'
    new_id = 'window.__ModuleLoader__.load({\n\tid: "dsh-link-plugin",'
    assert bundle.count(old_id) == 1, "unexpected upstream module id"
    bundle = bundle.replace(old_id, new_id)

    old_inject = 'const inject = ["slots", "locale"];'
    new_inject = 'const inject = ["slots", "locale", "uiConversation"];'
    assert bundle.count(old_inject) == 1, "unexpected upstream inject"
    bundle = bundle.replace(old_inject, new_inject)

    old_caret = "\t\t\t\tuserEvent: \"input.paste\",\n\t\t\t\tscrollIntoView: true\n\t\t\t});\n\t\t\treturn true;\n\t\t} });\n\t\t//#endregion\n\t\t//#region src/client/live-render.ts"
    new_caret = "\t\t\t\tselection: { anchor: main.to + link.length + 4 },\n\t\t\t\tuserEvent: \"input.paste\",\n\t\t\t\tscrollIntoView: true\n\t\t\t});\n\t\t\treturn true;\n\t\t} });\n\t\t//#endregion\n\t\t//#region src/client/live-render.ts"
    assert bundle.count(old_caret) == 1, "unexpected upstream paste dispatch"
    bundle = bundle.replace(old_caret, new_caret)

    old_fold = '\t\t\t\t\tif (syntax === null || marks.length < 3 || syntax.getChild("URL") === null) return;\n\t\t\t\t\tif (touchesActiveLine(doc, active, syntax.from, syntax.to)) return;'
    new_fold = '\t\t\t\t\tif (syntax === null || marks.length < 3 || syntax.getChild("URL") === null) return;\n\t\t\t\t\tif (state.selection.ranges.some((r) => r.from > syntax.from && r.from < syntax.to)) return;'
    assert bundle.count(old_fold) == 1, "unexpected upstream link folding"
    bundle = bundle.replace(old_fold, new_fold)

    tail = '\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\texports.userMessageCapability = userMessageCapability;\n\t\treturn module.exports;'
    new_tail = (extras + '\t\texports.apply = __dshLinkApply;\n\t\texports.inject = inject;\n'
                '\t\texports.userMessageCapability = userMessageCapability;\n'
                '\t\texports.__dshLinkInstall = __dshLinkInstall;\n\t\treturn module.exports;')
    assert bundle.count(tail) == 1, "unexpected upstream exports tail"
    bundle = bundle.replace(tail, new_tail)

    out = pathlib.Path(__file__).resolve().parent.parent / "lib" / "client.js"
    out.write_text(bundle, encoding="utf-8")
    print(f"wrote {out} ({len(bundle)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
