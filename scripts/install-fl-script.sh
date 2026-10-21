#!/usr/bin/env bash
# Symlink the MK3 Bridge script into FL Studio's hardware-script folder, so edits apply on reload.
set -euo pipefail

SOURCE="$(cd "$(dirname "$0")/.." && pwd)/fl-script/MK3Bridge"
HARDWARE_DIR="${HOME}/Documents/Image-Line/FL Studio/Settings/Hardware"
TARGET="${HARDWARE_DIR}/MK3Bridge"

if [[ ! -d "$HARDWARE_DIR" ]]; then
  echo "FL Studio's hardware folder was not found: $HARDWARE_DIR" >&2
  echo "Start FL Studio once so it creates its settings folders, then rerun." >&2
  exit 1
fi

if [[ -L "$TARGET" ]]; then
  if [[ "$(readlink "$TARGET")" == "$SOURCE" ]]; then
    echo "Already installed: $TARGET -> $SOURCE"
    exit 0
  fi
  echo "$TARGET is a symlink to somewhere else: $(readlink "$TARGET")" >&2
  echo "Remove it yourself if it should point here, then rerun." >&2
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  echo "$TARGET already exists and is not a symlink; leaving it alone." >&2
  exit 1
fi

ln -s "$SOURCE" "$TARGET"
echo "Installed: $TARGET -> $SOURCE"
echo "In FL Studio: Options > MIDI Settings, see docs/setup.md."
