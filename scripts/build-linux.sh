#!/usr/bin/env bash
set -euo pipefail

# Build a Linux Tauri package inside a Docker container, so Linux-only toolchains
# and dependencies never touch the host. Arch is parametrized; defaults to arm64.
#
#   bun run linux:arm64:build   # aarch64 .deb
#   bun run linux:x64:build     # x86_64 .deb
#
# Overridable via env:
#   LINUX_DOCKER_PLATFORM (default linux/arm64)   docker --platform
#   LINUX_TARGET          (default aarch64-unknown-linux-gnu)   rust target triple
#   LINUX_ARCH_SLUG       (default arm64)   names the target dir + cache volumes
#   LINUX_BUNDLES         (default deb)     e.g. deb,appimage
#   LINUX_IMAGE           (default ubuntu:24.04)
#
# Note: building x86_64 on an arm64 host (or vice-versa) runs under QEMU emulation,
# which is very slow for the llama.cpp C++ compile. Prefer native CI for the other
# arch when you can.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${LINUX_IMAGE:-${LINUX_ARM64_IMAGE:-ubuntu:24.04}}"
PLATFORM="${LINUX_DOCKER_PLATFORM:-linux/arm64}"
TARGET="${LINUX_TARGET:-aarch64-unknown-linux-gnu}"
ARCH_SLUG="${LINUX_ARCH_SLUG:-arm64}"
BUNDLES="${LINUX_BUNDLES:-deb}"
TARGET_DIR="${LINUX_TARGET_DIR:-/work/src-tauri/target-linux-${ARCH_SLUG}}"

docker run --rm --platform "${PLATFORM}" \
  -e CI=1 \
  -e LINUX_TARGET="${TARGET}" \
  -e LINUX_BUNDLES="${BUNDLES}" \
  -e LINUX_ARCH_SLUG="${ARCH_SLUG}" \
  -e CARGO_TARGET_DIR="${TARGET_DIR}" \
  -v "${REPO_ROOT}:/work" \
  -v "aether-linux-${ARCH_SLUG}-node-modules:/work/node_modules" \
  -v "aether-linux-${ARCH_SLUG}-cargo:/root/.cargo" \
  -v "aether-linux-${ARCH_SLUG}-rustup:/root/.rustup" \
  -v "aether-linux-${ARCH_SLUG}-bun:/root/.bun" \
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
      cmake \
      clang \
      libclang-dev \
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
    echo "Linux ${LINUX_ARCH_SLUG} artifacts:"
    find "${CARGO_TARGET_DIR}/${LINUX_TARGET}/release/bundle" -maxdepth 5 -type f -print 2>/dev/null || true
  '
