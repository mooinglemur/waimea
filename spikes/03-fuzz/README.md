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

`check-determinism`, run on 2026-09-15 after it was built with paired workers, 2 pairs:

| Test | Waimea (Pyodide) | Native `fuzz.py` |
|---|---|---|
| `waimea_nondeterministic` fixture, 6 runs | 6 failures, "Itempool: Same items but different order", 2.5 s | the same 6 failures, 1 s |
| TUNIC, 12 runs | 12 successes, 13.3 s | 12 successes, 6 s |
| APQuest, 20 runs | 20 successes, 3.5 s | not run |
| TUNIC, 12 runs, 1 s timeout | 5 successes, 7 timeouts; 12 worker restarts, 5 of them regenerating partners | not run |

Each failure's "first diff" names different tokens per pair and per runtime, since it follows each
interpreter's hash order.

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

### Apworlds that misbehave in CI

Two index apworlds that misbehave in CI were used as test cases:
- **SM64EX Spicy 1.0.2** (`sm64ex_spicy`) is slow enough that CI's 5000-run fuzz outlasts its 6-hour job
  limit.
- **Librarian 2.0.3** (`librarian`) fails unit tests and some fuzz variants.

These runs shared the machine with about 30 other processes, so timings are only rough.

**Unit tests.** Both fail the same 2 of 205 tests in Waimea as in CI's native `ap_tests.py`, and pass the
rest:

| Apworld | Failing test | Failure |
|---|---|---|
| Librarian | `test_locations.TestBase.test_location_group`, group Goal | `'Library Tidied' not found` |
| Librarian | `test_locations.TestBase.test_location_group`, group Milestones | a missing milestone location |
| Spicy | `test_groups.TestNameGroups.test_location_name_groups_not_empty` | the Castle group is empty |
| Spicy | `test_options.TestOptions.test_options_have_doc_string`, option `accessibility` | no doc string |

The Milestones message names a different missing location on each side, because set iteration order
follows string hashing; the test and its outcome are the same.

**Librarian fuzzing, 20 runs per variant.** Neither side hit a generation failure:
- all comparable variants matched native within noise;
- the differences were a few ignored runs and timeouts, from different seeds and contention;
- one Waimea timeout under `check-collect-accessibility` was reclassified by the hook as ignored, and
  dumped under `fuzz_output/ignored/`, as `fuzz.py`'s timeout handler does.

**Librarian fuzzing, 100 runs per variant, 4 jobs.** These ran two variant pairs at a time to limit
contention:

| Variant | Waimea | Native |
|---|---|---|
| `default` and five check variants | 100 successes each | 100 successes each |
| `check-collect-accessibility` | 94 successes, 6 ignored | 99 successes, 1 ignored |
| `check-ut` | 96 successes, 2 failures, 2 timeouts | 96 successes, 4 failures |

The five check variants were `check-indirect-conditions`, `check-item-location-count`,
`check-lambda-capture`, `check-placement-item-location-refs` and `check-static-output-placement`.

- **The `check-ut` failures are one real Librarian bug, found by both runtimes.** All six failure logs
  report Librarian's "Complete N Rows" locations (N from 1 up to 6 depending on the seed) as "in server
  logic but not expected in UT". The Universal Tracker hook then marks the run failed without an
  exception, so both sides log `NoneType: None` and key it `"None"`.
- **Timeouts don't show what they would have been.** Waimea's two `check-ut` timeouts may be further cases
  of that bug that ran long; a killed run's log holds only the timeout line.
- **Waimea's 6 ignored runs under `check-collect-accessibility` were all timeouts.** Each dump log holds
  only the kill line. That hook does heavy work after generating, pushing some runs past 30 s in the
  slower runtime, and it reclassifies a timeout as ignored, as in CI.

**Spicy fuzzing, 10 runs, 30 s timeout:**

| | Successes | Failures | Timeouts | Wall time |
|---|---|---|---|---|
| Waimea | 3 | 0 | 7 | 169 s |
| Native | 5 | 1 (`FillError`) | 4 | 112 s |

Waimea generates slower, so more of Spicy's generations cross the same wall-clock limit.

**With a calibrated timeout.** Spicy was rerun for 12 runs on 2 workers with the machine otherwise quiet:

| | Timeout | Successes | Failures | Timeouts | Wall time |
|---|---|---|---|---|---|
| Native | 30 s | 10 | 1 (`FillError`) | 1 | 112 s |
| Waimea | 35 s (calibrated, factor 1.16×) | 7 | 0 | 5 | 191 s |

- **Load matters natively too.** The quiet native run timed out once in 12 runs, against 4 in 10 when the
  machine was busy.
- **The gap is mostly sampling.** Waimea still timed out 5 times against native's 1, but the two sides
  generated different random YAMLs. A matched measurement explains the gap.

**Matched slowdown.** The same 12 Spicy runs were generated on both sides, with YAML seeds
`waimea-calibration-<i>` and generation seeds `1000000 + i`, on 2 workers with no effective timeout.
Every run succeeded on both sides.

| Measure | Value |
|---|---|
| Native generation time | 4.0 s to 41.3 s, median 21.0 s |
| Waimea ÷ native, per run | median 1.21×, range 0.93× to 1.82× |
| Timeouts, native at 30 s | 2 of 12 (runs at 31.7 s and 41.3 s) |
| Timeouts, Waimea at 35 s | 3 of 12 (42.3 s, 45.4 s and 42.7 s) |

- **Calibration was about right for Spicy.** Its median slowdown, 1.21×, is close to TUNIC's calibration
  factor of 1.16×.
- **The remaining differences:**
  - per-run variation around that median, which can still flip a borderline run (from 0.93× to 1.82× here);
  - random YAMLs, which differ between runtimes, so a small unpinned sample says little.
- **Spicy is borderline even natively.** Its generations cluster around the 30-second limit.

**Replay.** Native's `FillError` run was replayed from its YAML and seed (`443369993`) with `replay.py`.
Waimea and native both raised the same `FillError`, listing the same unreachable Hazy Maze Cave locations
(Waimea took 6.5 s). So a failing generation reproduces exactly across runtimes, and is classified and keyed
the same.

Not covered yet:
- a fatal interpreter error during fuzzing;
- `--dump-ignored`, meta YAMLs and `-n` ranges;
- browsers.

## Files

- `run.mjs --core <core.zip> --apworld <world>.apworld --variant <name> --runs N --out <dir>`: runs a
  variant and writes `<out>/<variant>/fuzz_output/` and `summary.json`. The summary holds the report,
  worker restarts, heap restarts, timeouts, fatal errors and boot times.
  - Optional: `--jobs` (default 4), `--timeout` seconds (default 30), `--heap-limit-mib` (default 1536),
    and `--seed` (default `waimea`; run i uses `<seed>-<i>`).
  - `--calibration deploy/calibration.json` first runs the timeout calibration workload
    (`web/calibration.mjs`) on the same worker count, then scales `--timeout` by the factor. The summary
    records the calibration and the timeout used.
  - Pitfall: Pyodide passes a JavaScript `null` to Python as `JsNull`, not `None`. An optional argument must
    be left out entirely rather than passed as `null`. `web/fuzz-worker.mjs` once passed a `null` generation
    seed, and every ordinary run failed.
  - Variant names and hooks come from `web/fuzz-variants.mjs`.
- `replay.py` and `replay.mjs`: replay one generation from its YAMLs and seed, natively or under Pyodide, to
  check that an outcome reproduces. `fuzz.call_generate` draws its seed from `random.randint`, so the
  replay pins that one call. Pass a folder holding only YAMLs: AP's `Generate` reads every file in it as a
  player file, so a dump's `.log` beside them breaks the replay.
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
