# Spike 3: fuzz driver under Node

Runs one CI fuzz variant with `web/fuzz-orchestrator.mjs` and `web/fuzz-worker.mjs` in Node worker threads,
each worker a Pyodide interpreter booted from `core.zip`. It writes `fuzz_output/` as `fuzz.py` does, so
the native fuzzer and CI's `aggregate_fuzz.py` can be compared against it.

## Results

Run on 2026-09-15 against the pinned AP fork, fuzzer and lobby, using TUNIC and Stardew Valley packaged
from the fork. Runs shared a 24-core machine with each other.

| Test | Waimea (Pyodide) | Native `fuzz.py` |
|---|---|---|
| TUNIC `default`, 100 runs, 4 jobs | 100 successes, 17.7 s | 100 successes, 13 s |
| TUNIC, 7 hook variants, 20 runs each, 2 jobs (see below) | 20 successes each, 22.8–30.6 s | 20 successes each, 14–27 s |
| TUNIC `check-gerpocalypse`, 20 runs | 20 successes, 15.3 s | not runnable outside CI's image |
| TUNIC `no-restrictive-starts`, 20 runs | 7 successes, 13 ignored, 12.3 s | not runnable outside CI's image |
| Stardew `default`, 12 runs, 2 s timeout (first run) | 2 successes, 10 timeouts | 2 successes, 10 timeouts |
| Stardew `default`, 12 runs, 2 s timeout (second run) | 4 successes, 8 timeouts | 1 success, 11 timeouts |

The seven hook variants compared natively were `check-collect-accessibility`,
`check-indirect-conditions`, `check-item-location-count`, `check-lambda-capture`,
`check-placement-item-location-refs`, `check-static-output-placement` and `check-ut`.

- **Report format.** CI's `aggregate_fuzz.py` rendered identical comments from the two `default` outputs.
- **Timeouts.** Each Waimea timeout was keyed `<class 'TimeoutError'>`, as natively, and cost one worker
  replacement. Stardew generations take 2 to 5 seconds, so a 2-second limit lands differently on each
  run; the counts are only comparable within one run.
- **Heap restarts.** With `--heap-limit-mib 1`, 4 TUNIC runs on one worker caused 4 heap restarts and 5
  boots of about 2.1 s each. With 60 MiB, 12 Stardew runs on 2 workers caused none.
- **Boot time.** A fuzz worker is ready in 2.0 to 2.6 s, about 0.5 s more than a unit-test worker. Most
  of the difference is importing `fuzz.py` and setting up hooks.

Two problems were found and fixed along the way:
- **Layout.** Hooks hardcode CI's paths (`/ap/archipelago`, `/ap/supported_worlds`, `/ap/empty.apworld`),
  so the bundle now uses CI's layout.
- **Hook lookup.** The pinned fuzzer's `find_hook` raises for every valid hook when `fuzz.py` is imported
  only once, so `runtime/fuzz_worker.py` looks hooks up without its inverted check. Natively, two copies of
  `fuzz.py` hide the bug.

Not covered yet:
- a run that fails generation, as opposed to succeeding or timing out;
- a fatal interpreter error during fuzzing;
- `--dump-ignored`, meta YAMLs and `-n` ranges;
- browsers.

## Files

- `run.mjs --core <core.zip> --apworld <world>.apworld --variant <name> --runs N --out <dir>`: runs a
  variant and writes `<out>/<variant>/fuzz_output/` and `summary.json`. The summary holds the report,
  worker restarts, heap restarts, timeouts, fatal errors and boot times.
  - Optional: `--jobs` (default 4), `--timeout` seconds (default 30), `--heap-limit-mib` (default 1536),
    and `--seed` (default `waimea`; run i uses `<seed>-<i>`).
  - Variant names and hooks come from `web/fuzz-variants.mjs`.
- `node-worker.mjs`: the `worker_threads` adapter that gives `web/fuzz-worker.mjs` a browser worker's
  `postMessage` and `onmessage`.

## Comparing with native fuzz.py

The native side ran the pinned `fuzz.py` from an unzipped `core.zip`, laid out as `run_fuzz.py` stages it:
- the apworld under test copied to `ap/archipelago/worlds/<module>.apworld`;
- `ap/archipelago/Players/` created, as CI's image does;
- Waimea's `ModuleUpdate.py` stub placed in `ap/archipelago/`;
- run from its own output directory: `python ap/archipelago/fuzz.py -g <module> -r N -j 2 -t 30 [--hook ...]`.

Two cautions:
- **Separate trees.** Concurrent native runs need separate trees, because each writes `host.yaml` in AP's
  root.
- **Hardcoded paths.** `no-restrictive-starts` and `check-gerpocalypse` read hardcoded `/ap/...` paths, so
  they can't run natively outside CI's image.

The native Python was CPython 3.13.14 in a venv with AP's requirements.
