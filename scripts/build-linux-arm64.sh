#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${LINUX_ARM64_IMAGE:-ubuntu:24.04}"
TARGET="${LINUX_TARGET:-aarch64-unknown-linux-gnu}"
BUNDLES="${LINUX_BUNDLES:-deb}"
TARGET_DIR="${LINUX_TARGET_DIR:-/work/src-tauri/target-linux-arm64}"

docker run --rm --platform linux/arm64 \
  -e CI=1 \
  -e LINUX_TARGET="${TARGET}" \
  -e LINUX_BUNDLES="${BUNDLES}" \
  -e CARGO_TARGET_DIR="${TARGET_DIR}" \
  -v "${REPO_ROOT}:/work" \
  -v aether-linux-arm64-node-modules:/work/node_modules \
  -v aether-linux-arm64-cargo:/root/.cargo \
  -v aether-linux-arm64-rustup:/root/.rustup \
  -v aether-linux-arm64-bun:/root/.bun \
  -w /work \
  "${IMAGE}" \
  bash -lc '
    set -euo pipefail

    export DEBIAN_FRONTEND=noninteractive
    export PATH="/root/.bun/bin:/root/.cargo/bin:${PATH}"

    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      build-essential \
      pkg-config \
      file \
      unzip \
      xz-utils \
      patchelf \
      libssl-dev \
      libgtk-3-dev \
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev

    if ! command -v bun >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash
    fi

    if ! command -v rustup >/dev/null 2>&1; then
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
    fi

    rustup default stable
    rustup target add "${LINUX_TARGET}"

    bun install --frozen-lockfile
    bun run typecheck:web
    bun run tauri build --target "${LINUX_TARGET}" --bundles "${LINUX_BUNDLES}" --ci

    echo
    echo "Linux arm64 artifacts:"
    find "${CARGO_TARGET_DIR}/${LINUX_TARGET}/release/bundle" -maxdepth 5 -type f -print 2>/dev/null || true
  '
