#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This packaging script must be run on macOS."
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install it from https://nodejs.org/ and rerun this file."
  read -r -p "Press Enter to close..."
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22 or newer is required. Current version: $(node --version)"
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is required to stage the bundled QEMU runtime. Install it from https://brew.sh/ and rerun this file."
  read -r -p "Press Enter to close..."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to stage the bundled QEMU runtime."
  read -r -p "Press Enter to close..."
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Warning: this Mac is not Apple Silicon. The script will still build the ARM64 target."
fi

echo "Installing locked dependencies..."
npm ci

echo "Staging bundled QEMU and building the Apple Silicon macOS app..."
npm run package:mac:arm64

echo "Build complete. Opening the release folder..."
open "$PROJECT_DIR/release"
