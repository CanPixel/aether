#!/usr/bin/env bash
set -euo pipefail

# Compile the per-platform code from a single machine.
#
# src/content_blocking/ and src/browsing_data/ are three separate implementations
# against three unrelated native APIs, and only one of them compiles on the
# machine you are sitting at. CI (.github/workflows/checks.yml) covers all three,
# but a round trip through CI to learn that a WebView2 signature was wrong is a
# slow way to find out — this gets the same answer locally in a couple of minutes.
#
#   bash scripts/check-platforms.sh            # host + whatever else is available
#   bash scripts/check-platforms.sh --host     # host platform only
#
# Requirements are optional and skipped with a notice when missing:
#   Linux    Docker (same ubuntu:24.04 image as scripts/build-linux.sh)
#   Windows  rustup target add x86_64-pc-windows-msvc

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ONLY="${1:-}"
FAILED=0

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
skip() { printf '\033[33m-- skipped: %s\033[0m\n' "$1"; }
fail() { printf '\033[31m!! FAILED: %s\033[0m\n' "$1"; FAILED=1; }

step "Host ($(uname -s))"
cargo clippy --manifest-path "${REPO_ROOT}/src-tauri/Cargo.toml" --all-targets -- -D warnings \
  || fail "host cargo clippy"
cargo test --manifest-path "${REPO_ROOT}/src-tauri/Cargo.toml" --lib \
  || fail "host cargo test"

if [[ "$(uname -s)" == "Darwin" ]]; then
  # Only WebKit can say whether the content-blocking rules actually compile; a
  # rejected rule list disables blocking silently at runtime.
  cargo run --manifest-path "${REPO_ROOT}/src-tauri/Cargo.toml" \
    --example verify_content_rules || fail "content blocking rules"
fi

[[ "${HOST_ONLY}" == "--host" ]] && { exit "${FAILED}"; }

step "Linux (Docker)"
if ! docker info >/dev/null 2>&1; then
  skip "Docker is not running"
else
  docker run --rm \
    -v "${REPO_ROOT}:/work" \
    -v "aether-platform-check-cargo:/root/.cargo" \
    -v "aether-platform-check-rustup:/root/.rustup" \
    -e CARGO_TARGET_DIR=/work/src-tauri/target-platform-check \
    -e DEBIAN_FRONTEND=noninteractive \
    -w /work/src-tauri ubuntu:24.04 bash -lc '
      set -e
      export PATH="/root/.cargo/bin:$PATH"
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends \
        ca-certificates curl build-essential cmake clang libclang-dev pkg-config \
        libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
        librsvg2-dev >/dev/null
      command -v cargo >/dev/null 2>&1 || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
      # Unconditional: rustup installs a cargo-clippy *shim* even when the
      # component is missing, so testing for the binary proves nothing.
      rustup component add clippy >/dev/null
      # Populate the registry in one pass first. Resolving and compiling in the
      # same run against a cold cache volume intermittently fails with a bogus
      # "can'\''t find crate for <dep>" on a transitive dependency.
      cargo fetch >/dev/null 2>&1 || true
      cargo clippy --lib -- -D warnings && cargo test --lib
    ' || fail "linux cargo check"
fi

step "Windows (cross type-check)"
if ! rustup target list --installed | grep -q x86_64-pc-windows-msvc; then
  skip "run: rustup target add x86_64-pc-windows-msvc"
else
  # The whole crate cannot cross-check: llama-cpp-sys-2 build-compiles C++ and
  # there is no MSVC cross-toolchain here. `cargo check` never links, though, so
  # a crate containing only the Windows modules and their real dependencies type-
  # checks the WebView2 API usage — which is the part that is easy to get wrong.
  # (Uri() and Source() are out-parameters, not return values. Ask how we know.)
  WORK="$(mktemp -d)"
  trap 'rm -rf "${WORK}"' EXIT
  mkdir -p "${WORK}/src"

  cat > "${WORK}/Cargo.toml" <<'TOML'
[package]
name = "aether-windows-check"
version = "0.0.0"
edition = "2021"

[dependencies]
tauri = { version = "2.11", features = ["unstable"] }
url = "2"

[target.'cfg(windows)'.dependencies]
webview2-com = "0.38"
windows = { version = "0.61", features = ["Win32_Foundation", "Win32_System_Com"] }
TOML

  python3 - "${REPO_ROOT}" "${WORK}" <<'PY'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1]) / "src-tauri" / "src"
work = pathlib.Path(sys.argv[2])

def prepare(path):
    src = path.read_text().replace("use super::*;\n", "")
    src = re.sub(r"diag_(error|info)!", "eprintln!", src)
    # Inner doc comments are only legal at the top of a module.
    return "\n".join(l for l in src.split("\n") if not l.startswith("//!"))

blocking = prepare(root / "content_blocking" / "windows.rs")
blocking = blocking.replace(
    "pub(crate) fn apply_to_webview",
    "fn blocked_hosts() -> Vec<String> { Vec::new() }\n\npub fn apply_to_webview",
).replace("pub(crate) fn compile_on_startup", "pub fn compile_on_startup")
clearing = prepare(root / "browsing_data" / "windows.rs").replace(
    "pub(crate) fn clear", "pub fn clear"
)

(work / "src" / "lib.rs").write_text(
    "use std::sync::{Arc, Mutex};\n"
    "use tauri::{AppHandle, Manager, Webview};\n"
    "use url::Url;\n\n"
    + blocking
    + "\n\npub mod browsing_data {\nuse super::*;\n"
    + clearing
    + "\n}\n"
)
PY

  (cd "${WORK}" && cargo clippy --target x86_64-pc-windows-msvc -- -D warnings) \
    || fail "windows cross type-check"
fi

if [[ "${FAILED}" -eq 0 ]]; then
  printf '\n\033[32mAll available platforms checked.\033[0m\n'
else
  printf '\n\033[31mOne or more platforms failed.\033[0m\n'
fi
exit "${FAILED}"
