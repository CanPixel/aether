#!/usr/bin/env bash
#
# make-styled-dmg.sh — build a *reliably styled* ÆTHER installer DMG.
#
# Why this exists:
#   Tauri's built-in DMG bundler copies the background PNG into the image but
#   relies on an inline Finder/AppleScript step (`set background picture`) to
#   wire it up as the window background. On modern macOS that step is flaky: it
#   silently reverts to a solid-colour background when the build runs without GUI
#   Finder automation (sandbox / headless tool runners) or when a stale volume of
#   the same name is mounted. The shipped .DS_Store then carries only
#   `backgroundColor*` and no `backgroundImageAlias` — i.e. a "stock" installer.
#
#   appdmg writes the .DS_Store background alias directly (via the `ds-store`
#   library), so it does NOT depend on Finder and is deterministic / CI-safe.
#   This wrapper derives the layout from tauri.conf.json (single source of truth),
#   runs appdmg against the already-built .app, and VERIFIES that the picture
#   background actually landed before declaring success.
#
# Known audit findings:
#   appdmg (0.6.6, last published 2023) pulls in image-size@0.7.5, which is
#   covered by GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq. Both advisories span
#   every published version (<= 2.0.2) and neither has a patched release, so
#   there is nothing to upgrade to. The ICNS loop is fixed locally in
#   patches/image-size@0.7.5.patch; the JXL/HEIF one does not apply to 0.7.5.
#   See scripts/audit.sh for the full reasoning and `pnpm run audit` for a check
#   that withdraws the suppression if either premise stops holding.
#
# Usage: pnpm run dmg        (expects `tauri build --bundles app` to have produced the .app)
#        AETHER_TAURI_TARGET=universal-apple-darwin pnpm run dmg
#        (expects `tauri build --target universal-apple-darwin`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VOLNAME="ÆTHER"
if [[ -n "${AETHER_TAURI_TARGET:-}" ]]; then
  BUNDLE_DIR="src-tauri/target/${AETHER_TAURI_TARGET}/release/bundle"
else
  BUNDLE_DIR="src-tauri/target/release/bundle"
fi
APP="${BUNDLE_DIR}/macos/${VOLNAME}.app"
OUT_DIR="${BUNDLE_DIR}/dmg"
VERSION="$(node -e 'console.log(require("./src-tauri/tauri.conf.json").version)')"
if [[ "${AETHER_TAURI_TARGET:-}" == "universal-apple-darwin" ]]; then
  ARCH="universal"
else
  case "$(uname -m)" in
    arm64) ARCH="aarch64" ;;
    x86_64) ARCH="x64" ;;
    *) ARCH="$(uname -m)" ;;
  esac
fi
OUT="${OUT_DIR}/${VOLNAME}_${VERSION}_${ARCH}.dmg"
BG_PNG="build/dmg-background.png"
BG_TIFF="build/dmg-background.tiff"

[[ -d "$APP" ]] || { echo "ERROR: built app not found at $APP — run 'pnpm run build' (or 'tauri build') first." >&2; exit 1; }

bash scripts/prepare-dmg-background.sh

# Derive everything from tauri.conf.json so the DMG never drifts from config.
SPEC="$(mktemp -u -t aether-appdmg).json"
trap 'rm -f "$SPEC" 2>/dev/null || true' EXIT
BUNDLE_DIR="$BUNDLE_DIR" SPEC="$SPEC" node -e '
  const fs = require("fs");
  const path = require("path");
  const conf = require("./src-tauri/tauri.conf.json");
  const d = conf.bundle.macOS.dmg;
  // tauri.conf paths are relative to src-tauri/; resolve to repo root.
  const fromTauri = (p) => path.resolve("src-tauri", p);
  const spec = {
    title: conf.productName,
    icon: fromTauri(conf.bundle.icon.find((i) => i.endsWith(".icns")) || "../build/icon.icns"),
    background: path.resolve("build/dmg-background.png"),
    "background-color": "#effbff",
    "icon-size": 128,
    format: "UDZO",
    window: { size: { width: d.windowSize.width, height: d.windowSize.height } },
    contents: [
      { x: d.appPosition.x, y: d.appPosition.y, type: "file",
        path: path.resolve(process.env.BUNDLE_DIR + "/macos/" + conf.productName + ".app") },
      { x: d.applicationFolderPosition.x, y: d.applicationFolderPosition.y, type: "link", path: "/Applications" },
    ],
  };
  fs.writeFileSync(process.env.SPEC, JSON.stringify(spec, null, 2));
  console.log(`window ${spec.window.size.width}x${spec.window.size.height}  app(${d.appPosition.x},${d.appPosition.y})  apps(${d.applicationFolderPosition.x},${d.applicationFolderPosition.y})`);
'
echo "==> spec derived from tauri.conf.json"
echo "==> background rendered from SVG: $BG_PNG + $BG_TIFF"

# Hygiene: clear any stale mounts of the same volume name.
detach_mount() {
  local mount="$1"
  [[ -n "$mount" ]] || return 0
  if [[ -e "$mount/${VOLNAME}.app" || -e "$mount/.background" ]]; then
    if hdiutil detach "$mount" -force >/dev/null 2>&1; then
      echo "==> detached stale mount: $mount"
    else
      echo "WARN: could not detach stale mount: $mount" >&2
    fi
  fi
  return 0
}

while IFS= read -r v; do
  detach_mount "$v"
done < <(find /Volumes -maxdepth 1 \( -name "${VOLNAME}" -o -name "${VOLNAME} *" -o -name "dmg.*" \) -print 2>/dev/null || true)

mkdir -p "$OUT_DIR"
rm -f "$OUT"
echo "==> building DMG with appdmg"
pnpm exec appdmg "$SPEC" "$OUT"

# Verify the picture background is actually wired into .DS_Store (not a colour).
echo "==> verifying baked background"
DEV=$(hdiutil attach -readonly -noautoopen -nobrowse "$OUT" | grep -E '^/dev/' | tail -1 | awk '{print $1}')
MNT=$(hdiutil info | awk -v d="$DEV" '$0 ~ d && /\/Volumes\// {i=index($0,"/Volumes/"); print substr($0,i); exit}')
ok=0
if [[ -n "$MNT" ]] \
  && strings -a "$MNT/.DS_Store" 2>/dev/null | grep -q "backgroundImageAlias" \
  && [[ -f "$MNT/.background/dmg-background.tiff" ]] \
  && tiffutil -info "$MNT/.background/dmg-background.tiff" | grep -q "Image Width: 1320 Image Length: 840"; then
  ok=1
fi
hdiutil detach "$DEV" -force >/dev/null 2>&1 || true
if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: DMG is missing a baked retina picture background." >&2
  exit 2
fi

echo "==> OK: picture background baked in"
echo "==> done: $OUT"
ls -lh "$OUT"
