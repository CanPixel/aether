#!/usr/bin/env bash
#
# audit.sh — `pnpm audit` with a narrow, self-invalidating suppression list.
#
# Why this exists:
#   Advisories are matched against the version string in pnpm-lock.yaml, and
#   `pnpm audit` has no notion of `patchedDependencies`, so a dependency we have
#   genuinely fixed under patches/ is still reported forever. A plain audit
#   therefore cannot reach a clean exit here, and a permanently-red audit is a
#   red flag nobody reads.
#
#   Rather than blanket-ignoring, this wrapper drops two specific advisory IDs
#   and re-proves the justification for each on every run. Anything else --
#   including a *third* image-size advisory -- still fails.
#
#   The suppression deliberately lives here and not in pnpm's `auditConfig`, so
#   that a bare `pnpm audit` keeps telling the unvarnished truth. Use this
#   wrapper for a pass/fail signal; use `pnpm audit` to see everything.
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
#     (every version ever published -- there is no patched release, despite what
#     the "Patched versions >=2.0.3" column claims), but 0.7.5 predates the JXL
#     and HEIF parsers entirely; lib/types/ ships neither. There is no vulnerable
#     code on disk to reach.
#
#   Reachability, for both: image-size arrives only via appdmg, which calls it at
#   exactly one site -- measuring our own design-assets background PNG during
#   `pnpm run dmg` on a developer/CI machine. appdmg copies the .icns volume icon
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

resolved="$(grep -oE '^  image-size@[0-9]+\.[0-9]+\.[0-9]+' pnpm-lock.yaml | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"

justified=1
if [[ "$resolved" != "$EXPECTED_VERSION" ]]; then
  echo "==> image-size resolves to '${resolved:-<absent>}', not ${EXPECTED_VERSION}."
  echo "    The suppression rationale in $(basename "${BASH_SOURCE[0]}") no longer applies."
  justified=0
elif ! grep -qE "^[[:space:]]*image-size@${EXPECTED_VERSION//./\\.}:[[:space:]]*patches/" pnpm-workspace.yaml; then
  echo "==> pnpm-workspace.yaml no longer wires up image-size@${EXPECTED_VERSION}."
  echo "    The ICNS fix is not being applied; refusing to suppress."
  justified=0
elif [[ ! -f "patches/image-size@${EXPECTED_VERSION}.patch" ]]; then
  echo "==> patches/image-size@${EXPECTED_VERSION}.patch is missing."
  justified=0
fi

if [[ "$justified" -eq 0 ]]; then
  echo "==> running a bare audit; re-review the image-size finding before re-adding any ignore."
  echo
  exec pnpm audit
fi

report="$(mktemp -t aether-audit)"
trap 'rm -f "$report"' EXIT
# pnpm audit exits nonzero whenever anything is found; we decide pass/fail below.
pnpm audit --json >"$report" 2>/dev/null || true

if [[ ! -s "$report" ]]; then
  echo "==> pnpm audit produced no output (offline? registry error?)" >&2
  exit 2
fi

echo "==> pnpm audit (suppressing ${#IGNORES[@]} reviewed image-size advisories; see $(basename "${BASH_SOURCE[0]}"))"
node -e '
const fs = require("fs");
const [reportPath, ...ignored] = process.argv.slice(1);
let data;
try {
  data = JSON.parse(fs.readFileSync(reportPath, "utf8"));
} catch {
  console.error("==> could not parse pnpm audit output; running bare audit is advised");
  process.exit(2);
}
const found = Object.values(data.advisories || {});
const seen = new Set(found.map((a) => a.github_advisory_id));
const remaining = found.filter((a) => !ignored.includes(a.github_advisory_id));

// A suppression for something no longer reported is dead weight, and dead
// suppressions are how an ignore list turns into a blanket one. Say so.
for (const id of ignored) {
  if (!seen.has(id)) {
    console.log(`==> ${id} is no longer reported -- drop it from IGNORES in scripts/audit.sh`);
  }
}

if (remaining.length === 0) {
  console.log("==> no unreviewed advisories");
  process.exit(0);
}
console.log(`==> ${remaining.length} unreviewed advisor${remaining.length === 1 ? "y" : "ies"}:`);
for (const a of remaining) {
  console.log(`  ${a.severity}: ${a.module_name} -- ${a.title}`);
  console.log(`    ${a.github_advisory_id}  https://github.com/advisories/${a.github_advisory_id}`);
}
process.exit(1);
' "$report" "${IGNORES[@]}"
