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
import pathlib, shutil, sys
root = pathlib.Path(sys.argv[1]) / "src-tauri" / "src"
work = pathlib.Path(sys.argv[2])

# The real module *shape* is reproduced rather than flattened, and that matters
# more than it looks. Both platform files are named windows.rs and both open with
# `use super::*`, which brings the parent's `mod windows` into scope alongside the
# `windows` crate — a bare `windows::` path is then ambiguous (E0659). An earlier
# version of this harness stripped `use super::*` while inlining, which deleted
# the glob import that causes the collision: the check passed locally on code that
# could not compile on Windows at all. So: same file names, same nesting, same
# glob imports, and only the crate-root items are stubbed.
for parent in ("content_blocking", "browsing_data"):
    (work / "src" / parent).mkdir(parents=True, exist_ok=True)
    shutil.copy(root / parent / "windows.rs", work / "src" / parent / "windows.rs")
    # Stands in for the real parent module: declares the child under the same name
    # and re-exports it, exactly as content_blocking.rs and browsing_data.rs do.
    (work / "src" / f"{parent}.rs").write_text(
        "use super::*;\n\n"
        "#[cfg(windows)]\n"
        "mod windows;\n"
        "#[cfg(windows)]\n"
        "#[allow(unused_imports)]\n"
        "pub use windows::*;\n"
    )

# Only what the platform files actually take from the crate root. blocked_hosts is
# a stub because the real one is unit-tested on the host; everything else has to
# be the genuine type or the WebView2 signatures are not really being checked.
(work / "src" / "lib.rs").write_text(
    "#![allow(dead_code)]\n\n"
    "use std::sync::{Arc, Mutex};\n"
    "use tauri::{AppHandle, Manager, Webview};\n"
    "use url::Url;\n\n"
    # Declared before the `mod` lines below, which is what puts them in textual
    # scope for the child modules — no re-export needed, and adding one only
    # earns an unused-import error under -D warnings.
    "macro_rules! diag_error { ($($arg:tt)*) => { eprintln!($($arg)*) }; }\n"
    "macro_rules! diag_info { ($($arg:tt)*) => { eprintln!($($arg)*) }; }\n\n"
    "fn blocked_hosts() -> Vec<String> { Vec::new() }\n\n"
    "pub mod content_blocking;\n"
    "pub mod browsing_data;\n"
)
PY

  # Target dir outside the throwaway crate, like the Linux step's cache volume: the
  # scaffolding is rebuilt each run but tauri and webview2-com are not, which is
  # the difference between a four-minute check and a ten-second one.
  (cd "${WORK}" && CARGO_TARGET_DIR="${REPO_ROOT}/src-tauri/target-platform-check-windows" \
    cargo clippy --target x86_64-pc-windows-msvc -- -D warnings) \
    || fail "windows cross type-check"
fi

if [[ "${FAILED}" -eq 0 ]]; then
  printf '\n\033[32mAll available platforms checked.\033[0m\n'
else
  printf '\n\033[31mOne or more platforms failed.\033[0m\n'
fi
exit "${FAILED}"
