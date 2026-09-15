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
  1. fetch and verify the pinned inputs (`inputs.json`, in Kalapana's format);
  2. build AP's core bundle, precompiled, with vendored wheels and runtime stubs;
  3. copy the app.
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

### Unit tests

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
- **Server.** The server never receives or imports an apworld.
- **Results.** Results can be forged, which is why Waimea is self-service only.

## Pyodide constraints

From Kalapana's spikes (Node, Chrome 153, Firefox 155) and Waimea's spike 1:

- **Python version.** Stay on Pyodide 0.29.x (Python 3.13). AP's `ModuleUpdate` rejects 3.14.
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
2. **Unit tests in Pyodide.** The equivalent of `ap_tests.py` for one apworld, with other worlds unloaded.
3. **Fuzz driver.** The orchestrator and workers, timeouts and restarts, and a CI-compatible
   `report.json`.
4. **Hook variants.** The in-process hooks, then the determinism design.
5. **Web app, server and image.**
6. **Self-check**, if it proves worthwhile.

Out of scope: replacing the index CI, posting results to GitHub or apdiff-viewer, game clients, and anything
that needs native executables.

## Open questions

1. **Coverage.** Kalapana showed 449 of 507 index worlds import under Pyodide, but that doesn't show how
   many generate.
2. **`test/general` under Pyodide**, with only the world under test loaded.
3. **Default run counts.** CI's 5000 runs take about 80 minutes for a Stardew-sized world in Chrome at four
   workers.
4. **Determinism design:** a second worker with `SharedArrayBuffer`, or the comparison moved into the
   orchestrator.
