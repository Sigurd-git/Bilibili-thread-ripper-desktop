#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'macOS 请使用本脚本；Windows 请使用 install.ps1。' >&2
  exit 1
fi
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$script_directory/macos/installer.cjs" "$@"
fi
# Reuse the official runtime, including on Macs that do not have Node/npm installed.
btr_runtime='/Applications/哔哩哔哩.app/Contents/MacOS/哔哩哔哩'
for ((argument=1; argument<=$#; argument++)); do
  if [[ "${!argument}" == --source ]]; then
    next_argument=$((argument+1))
    if ((next_argument > $#)); then echo '--source 缺少应用路径。' >&2; exit 1; fi
    source_bundle="${!next_argument}"
    source_executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$source_bundle/Contents/Info.plist")
    btr_runtime="$source_bundle/Contents/MacOS/$source_executable"
  fi
done
if [[ ! -x "$btr_runtime" ]]; then
  echo '未找到官方客户端的运行时；请使用 --source /完整路径/哔哩哔哩.app 或安装 Node.js。' >&2
  exit 1
fi
exec env ELECTRON_RUN_AS_NODE=1 "$btr_runtime" "$script_directory/macos/installer.cjs" "$@"
