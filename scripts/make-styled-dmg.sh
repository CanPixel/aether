#!/usr/bin/env bash
#
# make-styled-dmg.sh: build a reliably styled ÆTHER installer DMG.
#
# Why this exists:
#   Tauri's built-in DMG bundler copies the background PNG into the image but
#   relies on an inline Finder/AppleScript step (`set background picture`) to
#   wire it up as the window background. On modern macOS that step is flaky: it
#   silently reverts to a solid-colour background when the build runs without GUI
#   Finder automation (sandbox / headless tool runners) or when a stale volume of
#   the same name is mounted. The shipped .DS_Store then carries only
#   `backgroundColor*` and no `backgroundImageAlias`, producing a stock installer.
#
#   This wrapper writes the .DS_Store background alias directly, builds the disk
#   image with native macOS tools, and verifies the result. It does not depend on
#   Finder automation or the vulnerable appdmg > image-size dependency chain.
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

[[ "$(uname -s)" == "Darwin" ]] || { echo "ERROR: DMG creation requires macOS." >&2; exit 1; }
[[ -d "$APP" ]] || { echo "ERROR: built app not found at $APP. Run 'pnpm run build' first." >&2; exit 1; }

bash scripts/prepare-dmg-background.sh
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

WORK_DIR="$(mktemp -d -t aether-dmg)"
TEMP_IMAGE="${WORK_DIR}/writable.dmg"
RW_MOUNT=""
VERIFY_DEV=""

cleanup() {
  if [[ -n "$VERIFY_DEV" ]]; then
    hdiutil detach "$VERIFY_DEV" -force >/dev/null 2>&1 || true
  fi
  if [[ -n "$RW_MOUNT" ]]; then
    hdiutil detach "$RW_MOUNT" -force >/dev/null 2>&1 || true
  fi
  rm -f "$TEMP_IMAGE"
  rmdir "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

detach_with_retry() {
  local target="$1"
  local delay
  for delay in 1 2 4 8 16; do
    if hdiutil detach "$target" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

# Use 1.5 times the app size plus 32 MiB for image metadata, the background, and
# filesystem block overhead.
APP_MB="$(du -sm "$APP" | awk '{print $1}')"
IMAGE_MB=$(( (APP_MB * 3 + 1) / 2 + 32 ))

echo "==> creating ${IMAGE_MB} MiB writable image"
hdiutil create "$TEMP_IMAGE" -ov -fs HFS+ -size "${IMAGE_MB}m" -volname "$VOLNAME" >/dev/null
ATTACH_OUTPUT="$(hdiutil attach "$TEMP_IMAGE" -nobrowse -noverify -noautoopen)"
RW_MOUNT="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/\/Volumes\// {i=index($0,"/Volumes/"); print substr($0,i); exit}')"
[[ -n "$RW_MOUNT" ]] || { echo "ERROR: failed to locate mounted writable image." >&2; exit 2; }

mkdir "$RW_MOUNT/.background"
cp "$BG_TIFF" "$RW_MOUNT/.background/dmg-background.tiff"
cp -R "$APP" "$RW_MOUNT/${VOLNAME}.app"
ln -s /Applications "$RW_MOUNT/Applications"
cp build/icon.icns "$RW_MOUNT/.VolumeIcon.icns"

# Set the custom-icon Finder flag without a native Node xattr dependency.
xattr -wx com.apple.FinderInfo \
  0000000000000000040000000000000000000000000000000000000000000000 \
  "$RW_MOUNT"

node_modules/.bin/aether-dmg-metadata "$RW_MOUNT"
sync
bless --folder "$RW_MOUNT" >/dev/null
detach_with_retry "$RW_MOUNT" || { echo "ERROR: could not detach writable image." >&2; exit 2; }
RW_MOUNT=""

echo "==> compressing DMG"
hdiutil convert "$TEMP_IMAGE" -ov -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null

# Verify the picture background is actually wired into .DS_Store (not a colour).
echo "==> verifying baked background"
VERIFY_OUTPUT="$(hdiutil attach -readonly -noautoopen -nobrowse "$OUT")"
VERIFY_DEV="$(printf '%s\n' "$VERIFY_OUTPUT" | awk '/^\/dev\// {print $1}' | tail -1)"
MNT="$(printf '%s\n' "$VERIFY_OUTPUT" | awk '/\/Volumes\// {i=index($0,"/Volumes/"); print substr($0,i); exit}')"
ok=0
if [[ -n "$MNT" ]] \
  && strings -a "$MNT/.DS_Store" 2>/dev/null | grep -q "backgroundImageAlias" \
  && [[ -f "$MNT/.background/dmg-background.tiff" ]] \
  && tiffutil -info "$MNT/.background/dmg-background.tiff" | grep -q "Image Width: 1320 Image Length: 840"; then
  ok=1
fi
hdiutil detach "$VERIFY_DEV" -force >/dev/null 2>&1 || true
VERIFY_DEV=""
if [[ "$ok" -ne 1 ]]; then
  echo "ERROR: DMG is missing a baked retina picture background." >&2
  exit 2
fi

echo "==> OK: picture background baked in"
echo "==> done: $OUT"
ls -lh "$OUT"
