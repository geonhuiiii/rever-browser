#!/bin/bash
# Dev-mode only: the macOS dock label and the bold menu-bar title come from
# Electron.app's Info.plist, not from app.setName(), so `bun run dev` shows
# "Electron". Patch the bundle name and ad-hoc re-sign (editing Info.plist
# invalidates the seal on arm64). Runs from postinstall so a reinstall of the
# electron package re-applies it. Packaged builds don't need this — there
# electron-builder's productName takes over.
set -euo pipefail

APP="$(dirname "$0")/../node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
NAME="Rever Browser"

[ "$(uname)" = "Darwin" ] || exit 0
[ -f "$PLIST" ] || exit 0

current="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$PLIST" 2>/dev/null || echo '')"
if [ "$current" = "$NAME" ]; then
  exit 0
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName $NAME" "$PLIST"
if [ -n "$current" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NAME" "$PLIST"
else
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $NAME" "$PLIST"
fi

codesign --force --sign - "$APP" 2>/dev/null
echo "[patch-electron-name] Electron.app renamed to '$NAME' and re-signed"
