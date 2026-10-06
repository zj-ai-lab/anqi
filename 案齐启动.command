#!/bin/bash
set -euo pipefail
ANQI_ROOT="$(cd "$(dirname "$0")" && pwd)"
ANQI_APP="$ANQI_ROOT/build-local/案齐本地版.app"
if [ ! -x "$ANQI_APP/Contents/MacOS/ANQI" ]; then
  /usr/bin/python3 "$ANQI_ROOT/tools/build-desktop-launcher.py"
fi
/usr/bin/open "$ANQI_APP"
