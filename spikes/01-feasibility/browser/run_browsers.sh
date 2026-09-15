#!/bin/bash
# Chrome and Firefox side by side; worlds one after another in each browser.
cd "$(dirname "$0")"
PORT=8232
node serve.mjs $PORT > serve-bench.log 2>&1 &
for i in $(seq 1 50); do curl -fs -o /dev/null http://localhost:$PORT/browser/index.html && break; timeout 0.2 tail -f /dev/null; done

one_browser() {
  for w in tunic stardew_valley; do
    timeout 3000 node drive.mjs "$1" "mode=bench&world=$w&runs=100" $PORT ../out/browser-$1-$w.json > ../out/browser-$1-$w.log 2>&1
  done
}
one_browser chrome &
one_browser firefox &
wait %2 %3

for p in $(pgrep -f "^node serve.mjs $PORT\$"); do kill "$p"; done
timeout 2 tail -f /dev/null
echo "port $PORT listeners: $(ss -ltn "sport = :$PORT" | tail -n +2 | wc -l)"
