#!/usr/bin/env bash
# Builds the `latest.json` that the in-app updater reads (tauri-plugin-updater's
# "static" manifest format: a version plus one entry per `{os}-{arch}` target).
#
# Signatures are embedded as strings, so the .sig files produced by the bundler are
# read here and never published as release assets. Any platform whose signature is
# missing is left out of the manifest entirely — the app then reports "no build for
# this platform" rather than downloading something it cannot verify. If no platform
# has a signature at all, nothing is written and the script exits 0: that is the
# normal state before an updater signing key exists (see docs/SIGNING.md).
#
# The shape this produces is locked by `updater_manifest_matches_the_plugin_format`
# in src-tauri/src/lib.rs. Change one and the other fails.
#
# Usage: scripts/updater-manifest.sh <tag> <owner/repo> <artifacts-dir> <out-file>
set -euo pipefail

tag="${1:?tag required, e.g. v1.0.30}"
repo="${2:?repo required, e.g. CanPixel/aether}"
artifacts="${3:?artifacts directory required}"
out="${4:?output file required}"

version="${tag#v}"
base="https://github.com/${repo}/releases/download/${tag}"

read_sig() {
  local source
  source="$(find "$artifacts/$1" -type f -name "$2" 2>/dev/null | sort | head -n 1)"
  [[ -n "$source" ]] && tr -d '\n' < "$source"
}

mac_sig="$(read_sig "aether-macos-updater" "*.app.tar.gz.sig" || true)"
win_sig="$(read_sig "aether-windows-x86_64-updater" "*.exe.sig" || true)"
linux_sig="$(read_sig "aether-linux-x86_64-updater" "*.AppImage.sig" || true)"

if [[ -z "$mac_sig$win_sig$linux_sig" ]]; then
  echo "No updater signatures found under $artifacts; not writing $out." >&2
  exit 0
fi

# The macOS updater archive contains a universal app binary, so both native
# architectures correctly resolve to the same signed tarball.
jq -n \
  --arg version "$version" \
  --arg pub_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg notes "See https://github.com/${repo}/releases/tag/${tag}" \
  --arg mac_sig "$mac_sig" \
  --arg mac_url "$base/AETHER_macOS.app.tar.gz" \
  --arg win_sig "$win_sig" \
  --arg win_url "$base/AETHER_x64-setup.exe" \
  --arg linux_sig "$linux_sig" \
  --arg linux_url "$base/AETHER_amd64.AppImage" \
  '{
    version: $version,
    notes: $notes,
    pub_date: $pub_date,
    platforms: (
      {}
      + (if $mac_sig == "" then {} else {
          "darwin-aarch64": { signature: $mac_sig, url: $mac_url },
          "darwin-x86_64": { signature: $mac_sig, url: $mac_url }
        } end)
      + (if $win_sig == "" then {} else {
          "windows-x86_64": { signature: $win_sig, url: $win_url }
        } end)
      + (if $linux_sig == "" then {} else {
          "linux-x86_64": { signature: $linux_sig, url: $linux_url }
        } end)
    )
  }' > "$out"

echo "Wrote $out for $version with targets:" >&2
jq -c '.platforms | keys' "$out" >&2
