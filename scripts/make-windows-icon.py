#!/usr/bin/env python3
"""Generate build/icon.ico from resources/icon.png.

The source artwork uses the macOS convention of a large transparent inset,
which makes the Windows taskbar icon render visibly smaller than other apps.
This script crops the artwork to its visible bounds (plus a small margin) so
the .ico fills its canvas the way Windows icons are expected to.

Usage: python3 scripts/make-windows-icon.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "resources" / "icon.png"
TARGET = ROOT / "build" / "icon.ico"

# Fraction of the cropped artwork size kept as transparent margin on each side.
MARGIN = 0.02
SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit(f"{SOURCE} is fully transparent")

    left, top, right, bottom = bbox
    margin = round(max(right - left, bottom - top) * MARGIN)
    left = max(left - margin, 0)
    top = max(top - margin, 0)
    right = min(right + margin, image.width)
    bottom = min(bottom + margin, image.height)

    # Pad the crop to a square so the artwork is not stretched.
    width = right - left
    height = bottom - top
    side = max(width, height)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(image.crop((left, top, right, bottom)), ((side - width) // 2, (side - height) // 2))

    frames = [square.resize((size, size), Image.LANCZOS) for size in SIZES]
    frames[-1].save(TARGET, format="ICO", append_images=frames[:-1], sizes=[(s, s) for s in SIZES])
    print(f"Wrote {TARGET} with sizes {SIZES} (content fills {(1 - 2 * MARGIN) * 100:.0f}% of canvas)")


if __name__ == "__main__":
    main()
