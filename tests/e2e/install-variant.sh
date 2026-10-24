#!/bin/bash
# Install a plugin variant into the isolated e2e profile.
# usage: install-variant.sh <variant-dir> [name]
set -euo pipefail
SRC="$1"
NAME="${2:-$(basename "$SRC")}"
PROFILE=/tmp/dsh-home/profiles/e2e
DEST="$PROFILE/node_modules/dsh-link-plugin"
PLUGDIR="$PROFILE/plugins/dsh-link-plugin"
echo "[install] variant=$NAME src=$SRC"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST"/
# keep the file: source dir in sync (used only by pnpm install; harmless mirror)
if [ -d "$PLUGDIR" ]; then rm -rf "$PLUGDIR"; cp -R "$SRC" "$PLUGDIR"; fi
echo "[install] engines: $(node -e 'const p=require(process.argv[1]+"/package.json");console.log(JSON.stringify(p.engines))' "$DEST")"
echo "[install] version: $(node -e 'const p=require(process.argv[1]+"/package.json");console.log(p.version)' "$DEST")"
shasum -a 256 "$DEST/package.json" "$DEST/lib/client.js" | sed 's/^/[install] sha256 /'
