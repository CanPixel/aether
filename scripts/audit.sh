#!/usr/bin/env bash
#
# audit.sh — `bun audit` with a narrow, self-invalidating suppression list.
#
# Why this exists:
#   `bun audit` matches advisories against the version string in bun.lock. It has
#   no notion of `patchedDependencies`, so a dependency we have genuinely fixed in
#   `patches/` is still reported forever. Plain `bun audit` therefore cannot reach
#   a clean exit here, and a permanently-red audit is a red flag nobody reads.
#
#   Rather than blanket-ignoring, this wrapper suppresses two specific advisory
#   IDs and re-proves the justification for each on every run. Anything else --
#   including a *third* image-size advisory -- still fails the build.
#
# The suppressed advisories, and why:
#
#   GHSA-w3rx-r6r6-pgpr (image-size: ICNS infinite loop)
#     Real, and it reproduces on stock 0.7.5: an ICNS entry declaring length 0
#     never advances imageOffset, so `calculate()` spins forever. We fix it in
#     patches/image-size@0.7.5.patch, which breaks out of the loop on any entry
#     that does not cover its own 8-byte header. Verified: the crafted input
#     hangs unpatched and returns immediately with the patch applied.
#
#   GHSA-5p2g-fcmc-qvqq (image-size: JXL and HEIF infinite loops)
#     Not applicable to the version we resolve. The advisory range is "<= 2.0.2"
#     (every version ever published -- there is no patched release), but 0.7.5
#     predates the JXL and HEIF parsers entirely; lib/types/ ships neither. There
#     is no vulnerable code on disk to reach.
#
#   Reachability, for both: image-size arrives only via appdmg, which calls it at
#   exactly one site -- measuring our own design-assets background PNG during
#   `bun run dmg` on a developer/CI machine. appdmg copies the .icns volume icon
#   with fs.copyFile and never parses it. No attacker-supplied image is decoded.
#
# The guards below exist so this file cannot quietly outlive its own reasoning:
# if image-size ever resolves to a different version, or the patch stops being
# wired up, the suppression is withdrawn and the audit runs bare.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# The exact version the rationale above was written against.
EXPECTED_VERSION="0.7.5"
IGNORES=(GHSA-w3rx-r6r6-pgpr GHSA-5p2g-fcmc-qvqq)

resolved="$(grep -oE '\["image-size@[0-9]+\.[0-9]+\.[0-9]+"' bun.lock | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"

justified=1
if [[ "$resolved" != "$EXPECTED_VERSION" ]]; then
  echo "==> image-size resolves to '${resolved:-<absent>}', not ${EXPECTED_VERSION}."
  echo "    The suppression rationale in $(basename "${BASH_SOURCE[0]}") no longer applies."
  justified=0
elif ! grep -q '"image-size@'"${EXPECTED_VERSION}"'"' package.json; then
  echo "==> patchedDependencies no longer wires up image-size@${EXPECTED_VERSION}."
  echo "    The ICNS fix is not being applied; refusing to suppress."
  justified=0
elif [[ ! -f "patches/image-size@${EXPECTED_VERSION}.patch" ]]; then
  echo "==> patches/image-size@${EXPECTED_VERSION}.patch is missing."
  justified=0
fi

if [[ "$justified" -eq 0 ]]; then
  echo "==> running a bare audit; re-review the image-size finding before re-adding any ignore."
  echo
  exec bun audit
fi

args=()
for id in "${IGNORES[@]}"; do
  args+=(--ignore "$id")
done

echo "==> bun audit (suppressing ${#IGNORES[@]} reviewed image-size advisories; see $(basename "${BASH_SOURCE[0]}"))"
bun audit "${args[@]}"
echo "==> no unreviewed advisories"
