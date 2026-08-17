#!/usr/bin/env bash
# Rebuild the macOS iconset and ICNS from the checked-in 1024px sRGB master.
#
# 🔴 build/icon.png 必须遵守 Apple 的 macOS 图标网格（2.1.1 起）：
#   1024×1024 画布，图形本体 824×824 居中，四周各留 100px **透明**边，圆角半径 185px（体宽 22.5%）。
#   图形铺满画布会让 Dock 里的图标比所有别家 app 大一圈——2.1.0 踩过这个坑。
#
# 网页用的 public/assets/anjian-icon.png 是**另一种裁法**：
#   从母版裁掉那 100px 透明边、只留 824 本体再缩到 256（CSS 自己加圆角与尺寸，带透明边会显小并露底色）。
#   母版换了以后网页图标也要重出，本脚本不管它。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/build/icon.png"
ICONSET="$ROOT/build/icon.iconset"

if [[ ! -f "$SOURCE" ]]; then
  echo "missing icon source: $SOURCE" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "icon:build requires macOS sips and Node.js" >&2
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done

node "$ROOT/tools/build-icns.mjs"
