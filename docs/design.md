# Waimea: Archipelago tests and fuzzing in the browser

Waimea runs an apworld's unit tests and generation fuzzing in the browser, the way the Archipelago-index
CI runs them natively. An apworld author picks a `.apworld` file, presses Start, and watches the tests run.
Python runs client-side in Pyodide (WebAssembly), and the apworld never leaves the browser.

Nothing is built yet beyond the feasibility spike (`docs/spike-01-feasibility.md`). This document records
the plan, the constraints behind it, and the decisions taken so far.

## Summary

- **The browser does the work.** The server hosts static assets only: the page, the Pyodide runtime and a
  precompiled Archipelago core bundle. Web Workers load the uploaded apworld and run AP's tests and the
  fuzzer's generation loop.
- **Results match CI's format.** The saved report is a zip laid out like the CI's artifacts, so the index
  CI's aggregation scripts read it unchanged.
- **Not authoritative.** Results produced in someone's browser can be forged. Waimea is for authors
  checking their own work before opening a pull request; it doesn't replace the index CI, and results aren't
  posted anywhere.
- **Borrowed structure.** The structure comes from Kalapana (`mooinglemur/kalapana`), which already runs
  Archipelago generation and Universal Tracker in Pyodide:
  - pinned inputs verified by sha256;
  - core bundles;
  - runtime stubs;
  - a Node server with no npm dependencies;
  - the look and feel.

## What is mirrored

The index CI (`ionium-ap/archipelago-index-ci`, `index-validate.yml`) runs these jobs against apworld code.
Each runs sandboxed with `env -i`, `unshare -rn` and a Kata microVM, from the `ap-checker` image, which
builds on the lobby's `ap-worker` image.

| Job | Runs | Waimea |
|---|---|---|
| `unit-tests` | the lobby's `ap_tests.py`: the `WorldTestBase` battery plus `test/general` discovery, in one process | Planned |
| `fuzz` (11-variant matrix) | `run_fuzz.py`, which runs the fuzzer's `fuzz.py` with `-j 4 -t 30` | Planned, except the determinism variant at first |
| `check` | `self_check.py`, which builds the options template and validates it with the lobby's `checker.YamlChecker` | Later, if worthwhile |
| `network-audit` | `min_generate.py` under a socket monkeypatch | Not needed; see Security |

**Pins in CI:**
- the lobby's `ap-worker` image pins `ionium-ap/Archipelago` at `f04b3a3457efbca6fde29beaf70c7f7f0016cdc8`;
- it pins `ionium-ap/Archipelago-fuzzer` at `17227d793cc1088ae9be5fe97421e73bb683efdf`, whose `fuzz.py` and
  `hooks/` are copied into AP's root;
- two hooks come from `Mysteryem/Archipelago-fuzzer` at other commits (see `docker/ap-checker/Dockerfile`
  in the CI repository).

Waimea pins the same commits.

### Fuzz variants

From `run_fuzz.py`. Run counts in CI come from `FUZZ_RUNS_FULL` (default 5000) and `FUZZ_RUNS_CHECK`
(default 500).

| Variant | Hook | CI runs |
|---|---|---|
| `default` | none | 5000 |
| `no-restrictive-starts` | `hooks.with_empty:Hook` | 5000 |
| `check-collect-accessibility` | `hooks.collect_accessibility_test:Hook` | 500 |
| `check-determinism` | `hooks.determinism:Hook` | 500 |
| `check-gerpocalypse` | `hooks.gerpocalypse:Hook` | 500 |
| `check-indirect-conditions` | `hooks.indirect_conditions:Hook` | 500 |
| `check-item-location-count` | `hooks.item_location_count:Hook` | 500 |
| `check-lambda-capture` | `hooks.detect_rule_variable_capture_issues:Hook` | 500 |
| `check-placement-item-location-refs` | `hooks.check_placement_item_location_references:Hook` | 500 |
| `check-static-output-placement` | `hooks.detect_output_placement_changes:Hook` | 500 |
| `check-ut` | `worlds.tracker.fuzzer_hook:Hook`, from `tracker.apworld` | 500 |

When the index has `fuzz-meta/<world>/` YAMLs, CI runs each variant once per meta config.

## The web app

1. The user picks an `.apworld` with the browser's file picker. If it holds several worlds, the user
   chooses one. The version comes from the apworld's manifest.

   **Deferred: URL entry.** An apworld URL field, usually for a GitHub release asset, would need a server
   relay. The page can't fetch those downloads itself: neither `github.com`'s redirect nor
   `release-assets.githubusercontent.com` sends `Access-Control-Allow-Origin` (checked 2026-09-15). No relay
   will be built, so URL entry waits until an apworld host allows cross-origin downloads.
2. The page lists the tests to run, each section with a checkbox:
   - the unit tests;
   - each fuzz variant, with an editable run count;
   - a worker count, defaulting to about `min(4, cores - 1)`;
   - a per-generation timeout, defaulting to CI's 30 seconds;
   - optional file pickers for an expectation-annotations TOML and a fuzz-meta YAML. By default neither is
     used, so every test is expected to pass.

   The determinism variant is listed as not yet supported.
3. **Start** runs the unit tests, then each fuzz variant in turn. Each section shows:
   - a colored dot, green or red, or a spinner while running;
   - passed/total or failed/total.

   A completed section can be expanded while later ones run:
   - **Unit tests:** the `WorldTestBase` battery, then each `test/general` module, then each test with its
     traceback. Subtests are folded into their test.
   - **Fuzz variants:** failure classes with counts, then example tracebacks, then the YAMLs that caused
     them.
4. Unit-test failures don't stop the fuzz variants. **Stop** ends the run cleanly and still offers a
   partial report. Leaving the page mid-run asks for confirmation.
5. When everything finishes, the page shows a summary and a link to save the full report.

The page uses Kalapana's CSS tokens and theme selector (light, dark and system) from the start.

### Report

The report is a zip built in the browser:

```
unittest-report/<world>/<version>/<apworld>.aptest   only when a test failed, errored or unexpectedly passed
unittest-report/<world>/<version>/<apworld>.toml     regenerated expectations
fuzz-report/<world>/<version>/<variant>/fuzz_output/report.json
fuzz-report/<world>/<version>/<variant>/fuzz_output/{error,timeout}/<world>/<run>/   YAMLs and log
summary.md          the same shape as the CI's PR comment
environment.json    AP and fuzzer commits, Pyodide version, browser, worker count, run counts, seeds
```

The `unittest-report` and `fuzz-report` trees are what the CI's `aggregate_unittests.py` and
`aggregate_fuzz.py` read.

## Architecture

### Server and image

- **Server.** A small Node 26 server with no npm dependencies, adapted from Kalapana's `server/http.mjs`.
  It handles compression, cache headers and content security policies. It keeps no data volume and never
  runs world code.
- **Image.** A multi-stage image:
  1. fetch and verify the pinned inputs (`deploy/fetch-inputs.mjs`);
  2. build the core bundle (`build/build-core.mjs`);
  3. copy the app.
- **Core bundle.** `core.zip` unpacks at `/` in each worker, laid out as CI's `ap-checker` image is,
  because fuzzer hooks hardcode its paths (`with_empty` reads `/ap/empty.apworld`, `gerpocalypse` reads
  `/ap/supported_worlds/kh1-<version>.apworld`):
  - `ap/archipelago/`: AP's source tree as `prepare_worlds.sh` leaves it (only `generic` and the `_*`
    support packages in `worlds/`), plus the pinned `fuzz.py` and `hooks/`, the lobby's `ap_tests.py`, and
    `worlds/tracker.apworld`, which CI's image adds for every job;
  - `ap/supported_worlds/`: APQuest and Kingdom Hearts zipped as `<world>-<AP version>.apworld`;
  - `ap/empty.apworld`: the empty world;
  - `site-packages/`: vendored wheels and source packages, and `runtime/`.

  **How it's built.** The build runs `build/build_core.py` under Pyodide, so bytecode comes from exactly the
  Python the browser runs. Sources stay in the bundle: unittest discovery finds tests by their `.py` files,
  and tracebacks show source lines. Each source also gets an unchecked hash-based `.pyc` in `__pycache__`,
  which imports use without checking the source; every imported AP module did in the TUNIC and Stardew
  runs.

  **Result.** Timestamps are fixed, so two builds are byte-identical. It is 14 MB and builds in under
  2 seconds.
- **CI.** GitLab CI runs `node --test` and syntax checks, then builds with buildah. There is no deploy job.
- **Headers.**
  - The page's policy allows scripts only from Waimea and denies other connections.
  - Workers get a policy that allows no network at all.
  - COOP/COEP are added only if the determinism check ends up needing `SharedArrayBuffer`.

### Orchestrator and workers

The fuzzer's generation itself is plain in-process Python: `call_generate` builds an argparse `Namespace`
and calls `Generate.main` and `Main.main`, and the random option YAMLs are also made in Python. What doesn't
port is the orchestration around it:

| `fuzz.py` mechanism | Problem in Pyodide | Replacement |
|---|---|---|
| `multiprocessing.Pool` with fork | No processes | N Web Workers, each with its own Pyodide, each looping generations |
| `threading.Timer` in the worker, and a watchdog doing `os.kill(pid, SIGTERM)` | No threads or signals | The orchestrator times each generation, `terminate()`s the worker and boots a fresh one |
| `multiprocessing.Manager().Queue` | No processes | `postMessage` |
| `redirect_stdout/stderr`, temp dirs, `fuzz_output/` | Works, in memory | Emscripten's in-memory filesystem; results sent to the orchestrator |
| Terminal progress output | Cosmetic | Dropped |

So the driver reuses `fuzz.py`'s YAML generation, `call_generate`, outcome classification and hook calls
(`setup_main`, `setup_worker`, `before_generate`, `after_generate`, `reclassify_outcome`, `finalize`). It
doesn't run `fuzz.py`'s `__main__`.

**Settings worth preserving:**
- `-g` (apworld module name), `-r` (runs), `-j` (jobs), `-n` (YAMLs per run, or a range), `-t` (timeout);
- `-m` (meta YAML) and `--hook` (repeatable);
- `--skip-output`, `--dump-ignored`, `--with-static-worlds` and `--sample-from`.

**Worker lifecycle:**
- **Heap threshold.** Between generations the orchestrator checks the worker's wasm heap, and restarts the
  worker past a threshold of about 1.5 GB. A wasm heap never shrinks, and heavy worlds grow it by megabytes
  per generation.
- **Fatal errors.** A fatal Pyodide error, usually a JS stack overflow, gets its own outcome: its YAMLs are
  recorded and the worker is restarted, as for a timeout.
- **Restart cost.** A fresh worker is ready in about 1.5 seconds.

The page and the Pyodide runner are built separately. The page is developed against a fake worker that
sends the same messages.

**As built.**
- **Modules.** Three modules make up the driver:
  - `web/fuzz-orchestrator.mjs` runs one variant;
  - `web/fuzz-worker.mjs` runs inside each worker;
  - `runtime/fuzz_worker.py` is its Python side.

  The orchestrator doesn't depend on the environment: its caller supplies `spawn()`, which starts a
  browser `Worker`, or a `worker_threads` worker under Node (`spikes/03-fuzz/`). `web/fuzz-variants.mjs`
  holds CI's variant table.
- **A worker's life.** A worker boots from `core.zip` and stages the apworld under test in `worlds/`, as
  `run_fuzz.py` does. It then imports `fuzz.py` as a module, so its pool-driving `__main__` never runs.
  Each run is two steps:
  - `prepare(i, seed)` writes the run's YAMLs as `fuzz.py`'s main loop does, seeded with `<seed>-<i>` so
    any run can be reproduced, and posts them to the orchestrator;
  - `generate()` follows `gen_wrapper`: output captured, hooks called, outcome classified, then
    `dump_generation_output`'s files and `write_report`'s error key returned.
- **Hooks.**
  - **Setup.** `setup_main` runs in every worker, standing in for the main process whose state a forked
    pool worker would inherit. `setup_worker` then runs on separate instances.
  - **Timeouts.** The orchestrator times each generation from the worker's `started` message. At the
    limit it terminates the worker, and the replacement asks the main-process hook instances to
    reclassify the timeout, as `fuzz.py`'s timeout handler does. This matters: most check hooks count any
    other outcome, a timeout included, as ignored, and `gerpocalypse` counts a timeout as a success. The
    killed run's partial output is lost, so its log holds only the timeout line.
- **Report.** The orchestrator collects outcomes into `report.json`, with the same `stats` and `errors`
  keys as `fuzz.py`, and keeps dumped files at their `fuzz_output/` paths. CI's `aggregate_fuzz.py`
  renders an identical comment from Waimea's and native's output.
- **Differences from `fuzz.py`:**
  - a `setup_worker` failure stops the variant with that error, where natively every run fails;
  - a fatal interpreter error counts a failure under its own descriptive key, where a crashed pool worker
    counts one under `"None"`;
  - a worker is restarted when its heap passes the limit.

### Fuzz timeout calibration

CI gives each generation 30 seconds of wall-clock time on its runner. Generation in the browser is 1.3× to
2× slower than native, and the user's machine may differ from the runner, so an unscaled limit times out
generations that would pass in CI. With 10 runs of SM64EX Spicy at 30 seconds, Waimea timed out 7 and
native 4. So Waimea scales the limit by a measured factor.

- **Workload.** Fixed TUNIC generations (TUNIC is bundled in `supported_worlds/` for this). Run `i`'s YAML
  comes from the seed `waimea-calibration-<i>`, and its generation seed is pinned to `1000000 + i`, so every
  runtime does the same work. `deploy/calibration.json` holds these values and the reference: CI's
  per-run generation times for 40 runs on 4 workers, measured by `calibration/measure_native.py`.
- **Reference.** It's measured by the index CI's manual `waimea-calibration` job, on the same
  `k8s-sandboxed` runners as the fuzz jobs. Two runs came back on 2026-09-15:

  | Runner | CPU | Median per generation |
  |---|---|---|
  | One of the fleet's slowest | Xeon E5-2690 v4 | 0.291 s |
  | The fleet's fastest | Xeon Gold 6248 | 0.259 s |

  Both ran Python 3.12.14 with 6 CPUs per pod. The slow runner is about 12% slower. Waimea uses the slow
  runner's reference: a CI job can land on any runner, so Waimea flags any generation that could time out
  on a slow one.
- **Measuring.** Before fuzzing, `web/calibration.mjs` runs the first runs of that workload through the
  fuzz orchestrator, on the worker count the fuzz will use: 12 runs, or 3 per worker when there are more
  than 4. That captures Pyodide's overhead, the machine, and the chosen worker count's load together.
- **The factor.** It is the median of each matched run's local time over its reference time, clamped to
  between 0.5× and 4×. The timeout is CI's 30 seconds times the factor, rounded up. Both are reported with
  the results.
  - A factor below 1× is allowed. A machine faster than CI's runner gets a shorter timeout, because 30
    seconds on it buys more work than CI allows; flooring the factor at 1× would pass generations CI times
    out.
  - The floor guards against a bad measurement.
  - Under Pyodide, a Ryzen 9 5900X desktop measured 0.79× to 0.80× against the slow runner, which is a
    timeout of about 24 seconds.
- **Earlier, against a stand-in.** Before CI's reference existed, the same desktop's native timings stood
  in for it. They were 1.57× faster than the slow runner per run, so factors measured against them were
  too high. Under Node:
  - the reference was stable, with medians of 0.1893, 0.1893 and 0.1886 seconds over three runs;
  - the factor rose with worker count: 1.14× at 2 workers, 1.21× at 4, and 1.28× at 8, for timeouts of
    35, 37 and 39 seconds;
  - calibration took about 4 seconds of measurement, plus worker boots.
- **Limits.**
  - The ratio varies by world (1.29× for TUNIC against 1.41× for Stardew Valley under Node), so TUNIC only
    approximates the world under test. It held for SM64EX Spicy, the heaviest world tested:
    - on the same pinned runs, Spicy's median slowdown was 1.21× against TUNIC's factor of 1.16×;
    - at those timeouts (Waimea 35 seconds, native 30), 3 of 12 runs would time out in Waimea and 2
      natively.
  - Individual runs vary around the median (0.93× to 1.82× for Spicy), so a run near the limit can still
    time out in Waimea and pass natively, or the reverse. The report should say so.
  - Anything that changes after calibration, such as a throttled background tab, isn't captured.
  - The reference must be remeasured when CI's runner fleet, the pinned Archipelago or fuzzer, or the
    workload changes.

### Unit tests

`runtime/unit_tests.py` runs them the way CI does:
- **Harness.** CI's own harness, the lobby's `ap_tests.py`, is pinned in `deploy/inputs.json` and
  placed in AP's root. `unit_tests.py` imports it for its expectation-annotation logic and repeats its
  `__main__` block, so test ids, outcomes and the `.aptest` and `.toml` files match.
- **Loading.** `ap_tests.py` gets its apworlds from the lobby's `handler.py`, which needs OpenTelemetry
  and requests. `unit_tests.py` stands in for it and loads apworlds the same way: `zipimport` plus AP's
  `WorldSource`, with the manifest's `world_version` applied. Like the handler, it first copies each
  apworld to `<module>.apworld`, because the file's stem becomes the module name. As in CI's image, APQuest
  and the world under test load from zipped apworlds, and `worlds/` otherwise holds only the tracker's
  apworld, which `ap_tests.py` unloads.
- **Events.** It emits one JSON event per test (`plan`, `start`, `result`, `stop`, `done`) for the page:
  - a subtest's result carries its parent's id;
  - a test with a failed subtest gets no result of its own, so the page closes each test on `stop`;
  - CI's harness stops the whole run at the first unexpected error, and `done` says so;
  - subtests make the stream large (about 5,500 results for Stardew Valley's 205 tests), so the page
    batches updates rather than rendering each event;
  - some tests create a varying number of subtests from run to run, so the page shows progress by test
    against the planned count and never treats a subtest total as fixed.

What `ap_tests.py` itself does:
- **Harness.** `ap_tests.py` runs everything with `unittest` in one process:
  `loadTestsFromTestCase(WorldTest)` plus `discover("test/general", top_level_dir=".")`.
- **Loaded worlds.** It loads the world under test and APQuest, then unloads every other world except
  "Test Game" and "Archipelago".
- **Expectations.** It reads per-world expectation TOMLs and writes `.aptest` and `.toml` output.
- **Portability.** No file in AP's `test/general` or `test/bases.py` uses `subprocess`, `multiprocessing`,
  `threading`, sockets or asyncio.
- **Dependencies.** The only extra pure-Python packages it needs are `tomlkit` and `semver`.
- **Working directory.** Test discovery is relative, so it must run with AP's root as the working directory.

### Hooks

- The pinned fuzzer's `hooks/` holds twelve files, and only `determinism.py` uses processes. The other CI
  hooks are in-process Python.
- `check-ut` uses UT 0.2.26, matching the CI image. Kalapana pins 0.3.3. When CI re-pins UT, Waimea
  follows.
- **Determinism** starts `sys.executable hooks/determinism.py <ap_path>` in `setup_worker`. After each
  generation it pickles the run's `args` over a pipe, waits while the child regenerates the same seed, and
  compares serialized multiworld states. The separate interpreter is the point: it catches differences from
  import order and hash randomization. Each Pyodide instance randomizes string hashes differently, so a
  second worker keeps that value. There are two designs:
  - a second worker, with `SharedArrayBuffer` and `Atomics.wait` for the blocking wait, which needs COOP and
    COEP headers; or
  - moving the comparison into the orchestrator: worker A generates and serializes, worker B regenerates,
    and the orchestrator compares. This changes the hook's shape.

### Self-check

`checker.py` rolls settings and applies rules in process. But it imports `opentelemetry` and `sentry_sdk`,
which would need stubs, and it needs AP's `data/options.yaml` template and `jinja2`.

## Security

- **Worker isolation.** World code runs only in Web Workers, whose policy allows no network. That replaces
  `unshare -rn` and the network audit. A worker can't reach the page's DOM or localStorage. Kalapana's
  `workerPolicy` shows the pattern.
- **Verified in Chrome and Firefox.** A probe apworld running under `server/main.mjs`'s worker policy
  could fetch Waimea's own `/healthz`, but its cross-origin request was blocked before leaving the browser
  (`spikes/04-browser-fuzz/`, "The worker security policy").
- **Server.** The server never receives or imports an apworld.
- **Results.** Results can be forged, which is why Waimea is self-service only.

## Pyodide constraints

From Kalapana's spikes (Node, Chrome 153, Firefox 155) and Waimea's spike 1:

- **Python version.** Stay on Pyodide 0.29.x (Python 3.13). AP's `ModuleUpdate` rejects 3.14, and later
  Pyodide releases (`314.x`) embed 3.14.
- **Python 3.13.2 bugs.** Every Pyodide 0.29 release embeds CPython 3.13.2, while CI runs 3.12. A bug
  fixed in a later 3.13 release can make a test fail only in Waimea. One is known and patched in
  `waimea_boot.py`: gh-127750, where `functools.singledispatchmethod`'s cache keeps instances alive.
  Stardew Valley failed `test_memory.test_leak` from it; native CPython 3.13.2 reproduced the failure;
  3.12 and 3.13.3 to 3.13.14 passed; and disabling the cache fixed it.
- **No threads, subprocesses or signals.** JSPI, which would allow blocking on async work, is Chrome-only.
- **Native code.** Worlds needing native packages Pyodide lacks fail to load. Worlds that call native
  executables during generation, such as ALttP's Enemizer, won't generate.
- **Package memory.** Loading every vendored Pyodide package costs a few hundred MB per interpreter.
- **Speed.** Generation is 1.3× to 2× slower than native CPython. Chrome is close to Node; Firefox is the
  slowest.
- **Heap growth.** Heaps grow with some worlds: about 3 MiB per generation for Stardew Valley, with no
  plateau after 300 runs, and `gc.collect()` doesn't help. Other worlds stay flat.
- **Stack depth.** Pure-Python recursion is fine. Calls that pass through C, such as nested `__call__` rule
  objects, use the engine's stack:
  - a Chrome worker crashes fatally at about 450 levels;
  - Node crashes at about 900;
  - Firefox raises `RecursionError` at 1000.

  Lowering Python's recursion limit would fail legitimate recursion, so fatal errors are handled by
  restarting the worker instead. Such a result may pass natively, and the report should say so.

## Milestones

1. **Feasibility spike.** Done: `docs/spike-01-feasibility.md`.
2. **Unit tests in Pyodide.** The equivalent of `ap_tests.py` for one apworld, with other worlds
   unloaded. The runner (`runtime/unit_tests.py`) passes all 205 tests for TUNIC and Stardew Valley,
   matching native:
   - under Node;
   - in Chrome and Firefox workers;
   - from the core bundle (`spikes/02-unit-tests/`).
3. **Fuzz driver.** The orchestrator and workers, timeouts and restarts, and a CI-compatible
   `report.json`. Built and checked under Node (`spikes/03-fuzz/`):
   - TUNIC's `default` and seven hook variants match native `fuzz.py`;
   - timeouts and heap restarts work;
   - CI's `aggregate_fuzz.py` renders identical output.

   Since then, also checked:
   - generation failures, including one real bug reproduced by both runtimes (`spikes/03-fuzz/`);
   - browser workers in Chrome and Firefox (`spikes/04-browser-fuzz/`);
   - a fatal interpreter error, which Chrome records as a failure and recovers from by replacing the
     worker.

   Still to check: meta YAMLs, `--dump-ignored` and YAML-count ranges.
4. **Hook variants.** The in-process hooks, then the determinism design.
5. **Web app, server and image.**
   - **Built.** The server, image, CI and page shell.
     - The server serves the page, the Pyodide runtime, a content-hashed core bundle and a manifest, with
       separate page and worker security policies.
     - The image builds reproducibly (the same core bundle hash as a local build) and runs as an
       unprivileged user.
   - **To do.** The test runner UI: picker, test list, progress, details, summary and report.
6. **Self-check**, if it proves worthwhile.

Out of scope: replacing the index CI, posting results to GitHub or apdiff-viewer, game clients, and anything
that needs native executables.

## Open questions

1. **Coverage.** Kalapana showed 449 of 507 index worlds import under Pyodide, but that doesn't show how
   many generate.
2. **Default run counts.** CI's 5000 runs take about 80 minutes for a Stardew-sized world in Chrome at four
   workers.
3. **Determinism design:** a second worker with `SharedArrayBuffer`, or the comparison moved into the
   orchestrator.
4. **Showing reclassified timeouts.** Most check hooks turn a timeout into "ignored". With 100 runs of
   Librarian under `check-collect-accessibility`, Waimea reported 6 ignored runs, all timeouts, where
   native reported 1. The report should count timeouts separately from what hooks reclassify them to.
