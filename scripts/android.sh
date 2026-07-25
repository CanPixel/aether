#!/usr/bin/env bash
# Wrapper for `tauri android <dev|build|init>`.
#
# The Tauri CLI needs ANDROID_HOME / NDK_HOME, and llama-cpp-sys-2's build
# script separately requires one of ANDROID_NDK / NDK_ROOT / ANDROID_NDK_ROOT —
# it does not read NDK_HOME, so a plain `tauri android build` fails while
# compiling llama.cpp. This resolves the SDK/NDK once and exports every
# spelling the toolchain wants.
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ ! -d "$ANDROID_HOME" ]; then
  echo "Android SDK not found at $ANDROID_HOME — install it or set ANDROID_HOME." >&2
  exit 1
fi

if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
  echo "Android NDK not found under $ANDROID_HOME/ndk — install one via sdkmanager or set NDK_HOME." >&2
  exit 1
fi

export ANDROID_HOME NDK_HOME
export ANDROID_NDK_ROOT="${ANDROID_NDK_ROOT:-$NDK_HOME}"
export ANDROID_NDK="${ANDROID_NDK:-$NDK_HOME}"

# llama-cpp-sys-2 hardcodes -march=armv8-a (2014 baseline) for Android, which
# leaves ggml's dotprod/i8mm/fp16 quantized-matmul kernels compiled out — CPU
# prefill runs several times slower than the silicon allows. Env CFLAGS are
# appended after the build script's own flags, and clang honors the last
# -march, so this override wins. armv8.6-a mandates dotprod+i8mm+bf16 (any
# Snapdragon 8 Gen 1+ / recent flagship); override AETHER_ANDROID_MARCH for
# older devices, e.g. armv8.2-a+dotprod+fp16.
: "${AETHER_ANDROID_MARCH:=armv8.6-a+fp16}"
export CFLAGS_aarch64_linux_android="-march=${AETHER_ANDROID_MARCH}${CFLAGS_aarch64_linux_android:+ ${CFLAGS_aarch64_linux_android}}"
export CXXFLAGS_aarch64_linux_android="-march=${AETHER_ANDROID_MARCH}${CXXFLAGS_aarch64_linux_android:+ ${CXXFLAGS_aarch64_linux_android}}"

# llama.cpp does not compile for 32-bit ARM, and every device that can run
# ÆTHER's local AI stack is arm64 anyway — so builds default to aarch64 only
# unless the caller picks targets explicitly.
args=("$@")
if [ "${1:-}" = "build" ]; then
  case " $* " in
    *" --target "*) ;;
    *) args+=(--target aarch64) ;;
  esac
fi

exec bun tauri android "${args[@]}"
