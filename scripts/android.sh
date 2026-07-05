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

exec bun tauri android "$@"
