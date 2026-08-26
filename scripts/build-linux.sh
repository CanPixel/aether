#!/usr/bin/env bash
set -euo pipefail

# Build a Linux Tauri package inside a Docker container, so Linux-only toolchains
# and dependencies never touch the host. Arch is parametrized; defaults to arm64.
#
#   pnpm run linux:arm64:build   # aarch64 .deb
#   pnpm run linux:x64:build     # x86_64 .deb
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
  -v "aether-linux-${ARCH_SLUG}-pnpm:/root/.local/share/pnpm" \
  -w /work \
  "${IMAGE}" \
  bash -lc '
    set -euo pipefail

    export DEBIAN_FRONTEND=noninteractive
    export PATH="/root/.local/share/pnpm:/root/.cargo/bin:${PATH}"

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

    if ! command -v node >/dev/null 2>&1; then
      # Ubuntu 24.04 ships Node 18 in apt, but the release scripts and
      # `node --test` rely on the native TypeScript support added in 22.6+, so
      # take an official build rather than the distro one.
      NODE_VERSION="v24.14.1"
      case "$(uname -m)" in
        aarch64) NODE_ARCH="arm64" ;;
        x86_64)  NODE_ARCH="x64" ;;
        *) echo "unsupported arch for node install: $(uname -m)" >&2; exit 1 ;;
      esac
      curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1
    fi

    # corepack reads the pinned version out of the "packageManager" field in
    # package.json, so the container runs exactly the pnpm the repo declares
    # instead of whatever is newest. (No apostrophes in this block: the whole
    # script is passed to bash -lc inside single quotes.)
    export PNPM_HOME="/root/.local/share/pnpm"
    corepack enable pnpm --install-directory "${PNPM_HOME}"

    if ! command -v rustup >/dev/null 2>&1; then
      curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
    fi

    rustup default stable
    rustup target add "${LINUX_TARGET}"

    pnpm install --frozen-lockfile
    pnpm run typecheck:web
    pnpm run tauri build --target "${LINUX_TARGET}" --bundles "${LINUX_BUNDLES}" --ci

    if compgen -G "${CARGO_TARGET_DIR}/${LINUX_TARGET}/release/bundle/deb/*.deb" > /dev/null; then
      scripts/normalize-deb-package.sh "${CARGO_TARGET_DIR}/${LINUX_TARGET}/release/bundle/deb/"*.deb
    fi

    echo
    echo "Linux ${LINUX_ARCH_SLUG} artifacts:"
    find "${CARGO_TARGET_DIR}/${LINUX_TARGET}/release/bundle" -maxdepth 5 -type f -print 2>/dev/null || true
  '
