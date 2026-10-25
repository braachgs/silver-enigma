#!/usr/bin/env bash
# Builds the Xeneon Edge widgets into dist/*.icuewidget (iCUE's import format)
# with Corsair's CLI: npm install -g icuewidget-cli (0.5+), or set ICUEWIDGET.
# Each widget gets the shared scripts it uses, the stylesheet and the flap font.
set -euo pipefail
cd "$(dirname "$0")"
ICUEWIDGET=${ICUEWIDGET:-icuewidget}
rm -rf build dist
mkdir -p build dist

assemble() { # widget scripts...
  local w=$1; shift
  cp -r "$w" "build/$w"
  mkdir -p "build/$w/scripts" "build/$w/styles"
  for s in "$@"; do cp "common/$s" "build/$w/scripts/"; done
  cp common/board.css "build/$w/styles/"
  cp common/resources/* "build/$w/resources/"
}
assemble matchboard flapboard.js matches.js net.js
assemble dayboard flapboard.js ics.js departures.js net.js

for w in matchboard dayboard; do
  $ICUEWIDGET validate "build/$w"
  $ICUEWIDGET package "build/$w"
done
find build -maxdepth 2 -name '*.icuewidget' -exec mv {} dist/ \;
ls -la dist
