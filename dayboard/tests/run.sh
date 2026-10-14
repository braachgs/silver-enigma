#!/usr/bin/env bash
# Run Day Board's browser tests. Serves the repo root on 127.0.0.1:8765 if
# nothing is listening there, then runs each suite; screenshots go to ./out.
set -u
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
OUT="$(pwd)/out"; mkdir -p "$OUT"
if ! curl -s -o /dev/null -m 3 http://127.0.0.1:8765/dayboard/; then
  (cd "$ROOT" && nohup python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &)
  sleep 1
fi
status=0
for t in tour.js local-test.js google-test.js flap-test.js review-fixes-test.js swipe-test.js dates-test.js; do
  echo "=== $t"
  node "$t" "$OUT" || status=1
done
exit $status
