#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/normalize-deb-package.sh path/to/*.deb" >&2
  exit 2
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "ERROR: dpkg-deb is required to normalize Debian package metadata." >&2
  exit 127
fi

for deb in "$@"; do
  [[ -f "$deb" ]] || continue

  (
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT

    dpkg-deb -R "$deb" "$work"
    sed -i 's/^Package: .*/Package: aether/' "$work/DEBIAN/control"
    dpkg-deb --build "$work" "$deb"

    echo "Normalized Debian package metadata for $deb"
    dpkg-deb -I "$deb" | sed -n '1,12p'
  )
done
