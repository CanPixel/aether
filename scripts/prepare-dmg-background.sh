#!/usr/bin/env bash
#
# Render the DMG installer background from the SVG source.
#
# Finder does not use SVG files directly for DMG window backgrounds. Keep the
# SVG as the editable source of truth, then render a 1x/2x PNG pair and combine
# them into a high-DPI TIFF for tools that can use it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="build/dmg-background.svg"
PNG_1X="build/dmg-background.png"
PNG_2X="build/dmg-background@2x.png"
TIFF="build/dmg-background.tiff"
WIDTH=660
HEIGHT=420

[[ -f "$SRC" ]] || { echo "ERROR: missing SVG background source: $SRC" >&2; exit 1; }
[[ -f "build/dmg-orb.png" ]] || { echo "ERROR: missing SVG embedded asset: build/dmg-orb.png" >&2; exit 1; }

RENDERER=""
if command -v rsvg-convert >/dev/null 2>&1; then
  RENDERER="rsvg"
elif command -v magick >/dev/null 2>&1; then
  RENDERER="magick"
elif [[ -f "$PNG_1X" && -f "$PNG_2X" ]]; then
  echo "WARN: rsvg-convert/magick not found; using existing rendered PNG backgrounds." >&2
else
  echo "ERROR: install librsvg (rsvg-convert) or ImageMagick (magick) to render $SRC." >&2
  exit 1
fi

render_png() {
  local width="$1"
  local height="$2"
  local out="$3"

  if [[ "$RENDERER" == "rsvg" ]]; then
    rsvg-convert --width "$width" --height "$height" --format png --output "$out" "$SRC"
  elif [[ "$RENDERER" == "magick" ]]; then
    magick -background none -density 144 "$SRC" -resize "${width}x${height}!" "$out"
  fi
}

if [[ -n "$RENDERER" ]]; then
  render_png "$WIDTH" "$HEIGHT" "$PNG_1X"
  render_png "$((WIDTH * 2))" "$((HEIGHT * 2))" "$PNG_2X"
fi

tiffutil -cathidpicheck "$PNG_1X" "$PNG_2X" -out "$TIFF"

echo "==> rendered DMG background from $SRC"
sips -g pixelWidth -g pixelHeight "$PNG_1X" "$PNG_2X" >/dev/null
tiffutil -info "$TIFF" | awk '/Image Width|Resolution:/ { print "    " $0 }'
