# Spike 4: fuzzing in browser workers

## Results

Run on 2026-09-15 in headless Chrome and Firefox on a Ryzen 9 5900X desktop, calibrated against CI's slow
runner (`deploy/calibration.json`). Each browser ran its tests one after another, and the two browsers ran
alongside each other.

| Test | Chrome | Firefox | Native `fuzz.py` |
|---|---|---|---|
| Crash fixture, 6 runs, 2 workers | 6 failures, all fatal: 6 worker restarts, 9.8 s | 6 failures, `maximum recursion depth exceeded`, 3.3 s | 6 failures, `maximum recursion depth exceeded` |
| TUNIC `default`, 20 runs, 2 workers | factor 0.81×, 25 s timeout: 20 successes | factor 0.96×, 29 s timeout: 20 successes | |
| Librarian `check-ut`, 40 runs, 4 workers | factor 0.86×, 26 s timeout: 40 successes | factor 1.01×, 31 s timeout: 40 successes | |
| SM64EX Spicy `default`, 6 runs, 2 workers | factor 0.80×, 25 s timeout: 2 successes, 4 timeouts | factor 0.90×, 28 s timeout: 1 success, 5 timeouts | |

- **Fatal errors work end to end in a browser.** In Chrome each run overflowed the JavaScript stack. It was
  recorded as a failure under Waimea's fatal-error key, its YAML and log were dumped, and the worker was
  replaced (8 boots for 6 runs on 2 workers). Firefox raised `RecursionError` like native Python, under
  the same error key.
- **Calibration tracks the browser.** Firefox generates slower than Chrome and got factors 0.1 to 0.15
  higher. Both were below 1× here: this desktop is faster than CI's slow runner even under Pyodide.
- **Librarian's `check-ut` bug didn't show up.** It hit about 4% of runs natively, so about 1.6 of 40 would
  be expected; none is a likely enough outcome (about 1 in 5).
- **Spicy's timeouts are plausibly what CI sees.** Its median native generation on this desktop was 21 s,
  and CI's slow runner is about 1.57× slower per run, so a typical Spicy generation there would take about
  33 s, past CI's 30-second limit.

**Fatal logs.** In a rerun of 2 runs, each fatal error's log begins "RangeError: Maximum call stack size
exceeded". Chrome keeps only about 10 stack frames, so these logs are short and were never truncated.
- The first summary seemed to lack that line only because this probe page showed each log's last 800
  characters. It now shows the head and the tail.
- `web/fuzz-worker.mjs` also keeps the head and the tail of any error longer than 4,000 characters, instead
  of only the tail. That's a guard for long traces, not a fix for these.

Runs the fuzz driver in real browsers, with the same modules the site will serve:
- `web/fuzz-orchestrator.mjs` and `web/calibration.mjs` run in the page;
- each worker is a browser module `Worker` running `web/fuzz-worker.mjs`.

This checks what the Node spike couldn't: behavior in Chrome's and Firefox's workers, and a fatal
interpreter error during fuzzing.

## The worker security policy

The real server (`server/main.mjs`) gives worker scripts `default-src 'none'; script-src 'self'
'wasm-unsafe-eval'; connect-src 'self'`. To check that it holds against apworld code, `csp-probe.mjs`
loads the real page and runs one generation of the `waimea_netprobe` fixture through
`/fuzz-orchestrator.mjs` and `/fuzz-worker.mjs`. The fixture's `generate_early` makes blocking
`XMLHttpRequest`s, then fails with a message saying what they did:
- one to the worker's own origin (`/healthz`);
- one to a listener on another local port, which logs every request it receives.

| Browser | Same-origin `/healthz` | Cross-origin listener |
|---|---|---|
| Chrome | status 200 | blocked: "NetworkError: Failed to execute 'send' on 'XMLHttpRequest'" |
| Firefox | status 200 | blocked: "NetworkError: A network error occurred." |

The listener logged no request from either browser, only the script's own readiness check. So a blocked
request never leaves the browser. Apworld code can still reach Waimea's own origin, which serves only
static files.

## Files

- `serve.mjs <data dir> [port]` (default port 8234) serves the page and these folders:

  | Path | Serves |
  |---|---|
  | `/web/` | the repository's `web/` |
  | `/pyodide/` | `vendor/pyodide` |
  | `/deploy/` | `deploy/`, for `calibration.json` |
  | `/data/` | the data folder |

- `index.html` and `page.mjs` run one variant. Query parameters are `world=<module>`, `variant=<name>`,
  `runs`, `jobs`, and optionally `timeout` (default 30), `calibrate=1` and `seed`.
  - The page loads `/data/core.zip` and `/data/<world>.apworld`.
  - With `calibrate=1` it calibrates first, then scales the timeout.
  - Progress and the result go in `window.probe`.
- `drive.mjs <chrome|firefox> '<query>' <out.json> [port]` runs the page headless with puppeteer-core
  (from Kalapana's spikes, or `PUPPETEER_CORE`). It prints progress and a summary, and writes the probe to
  `out.json`.
- `make_data.py <data dir>` zips each fixture into `<world>.apworld`. The data folder also needs a
  `core.zip` from `build/build-core.mjs`, and any real apworlds to test.
- `fixtures/waimea_crash/`: a minimal world whose `generate_early` recurses 5,000 levels through
  `__call__`. Natively, and in Firefox workers, it fails with `RecursionError` at Python's default limit.
  In a Chrome worker it overflows the JavaScript stack at about 450 levels, a fatal interpreter error, so
  it exercises Waimea's fatal-error handling. It isn't a real game.
- `fixtures/waimea_netprobe/`: a minimal world whose `generate_early` tries same-origin and
  cross-origin requests through Pyodide's `js` module, then fails with the results. Natively it fails
  with "no js module".
- `fixtures/waimea_nondeterministic/`: a minimal world that builds its item pool by iterating over a set of
  strings, so generation depends on string hash randomization. `check-determinism` fails it in every
  runtime, since its paired interpreter hashes differently. It isn't a real game, and fails
  `test_implemented`'s completion-condition test.
- `fixtures/waimea_slow/`: a minimal world whose `generate_early` busy-loops for 10 minutes, so every
  generation reaches the fuzz timeout. It exercises timeout handling end to end, and the page's yellow
  warning state for a variant that timed out without failing. Run it with unit tests off: the test battery
  generates too, and would spin for the same 10 minutes per test.
- `csp-probe.mjs <chrome|firefox> <server port> <waimea_netprobe.apworld>`: runs that fixture once
  against a running `server/main.mjs`, with a listener on 127.0.0.1:8236 as the cross-origin target.
  - Node's worker threads don't overflow at this depth either; they raise `RecursionError` as Firefox
    does. Spike 1's overflow at about 900 levels was on Node's main thread. So only Chrome exercises the
    fatal path.
