#!/bin/bash
# Pyodide and native for each world run side by side; worlds run concurrently only with enough cores.
cd "$(dirname "$0")"
one() { # world runs tag
  cfg="{\"world\":\"$1\",\"runs\":$2,\"seed\":5000}"
  timeout 3000 node bench.mjs tree-$1.zip "$cfg" out/$3-pyo-$1.json > out/$3-pyo-$1.log 2>&1 &
  (cd native-$1/ap && timeout 3000 ../../venv/bin/python ../../bench.py "$cfg" > ../../out/$3-nat-$1.json 2> ../../out/$3-nat-$1.log) &
}
if [ "$(nproc)" -ge 10 ]; then
  one apquest 100 full; one tunic 100 full; one stardew_valley 100 full; one tunic 1000 long; wait
else
  one apquest 100 full; one tunic 100 full; wait
  one stardew_valley 100 full; wait
  one tunic 1000 long; wait
fi
echo done
