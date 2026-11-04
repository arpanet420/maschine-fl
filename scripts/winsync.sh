#!/usr/bin/env bash
# Copies the working tree (uncommitted changes too) to the Windows machine and runs a command there,
# in PowerShell, from C:\dev\maschine-fl with Node on PATH. No command: just copy.
#   scripts/winsync.sh 'npm ci'
#   scripts/winsync.sh 'npm test'
# docs/windows.md has the setup. Needs `ssh winbox` to work, so the same network as the PC.
set -euo pipefail

HOST="${MK3D_WIN_HOST:-winbox}"
NODE_DIR='C:\dev\tools\node-v24.11.1-win-x64'
REMOTE_DIR='C:\dev\maschine-fl'

cd "$(dirname "$0")/.."
archive="$(mktemp -t mk3d-winsync)"
trap 'rm -f "$archive"' EXIT

git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --null -T - -czf "$archive"
scp -q "$archive" "$HOST:mk3d-winsync.tgz"
# Everything but node_modules goes first, so files removed here don't stay there.
ssh "$HOST" "\$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force '$REMOTE_DIR' | Out-Null; Get-ChildItem '$REMOTE_DIR' -Force | Where-Object { \$_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force; tar -xzf \"\$HOME\\mk3d-winsync.tgz\" -C '$REMOTE_DIR'; Remove-Item \"\$HOME\\mk3d-winsync.tgz\""

if [ "$#" -gt 0 ]; then
  ssh "$HOST" "\$env:Path='$NODE_DIR;'+\$env:Path; Set-Location '$REMOTE_DIR'; $*; exit \$LASTEXITCODE"
fi
