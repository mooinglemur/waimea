# Spike 5: a whole session, headless

`probe.mjs` drives a complete session with Waimea's real modules against a running `server/main.mjs`, in
headless Chrome or Firefox. It exercises everything the page will, without the page's UI.

The session goes:
1. `inspectApworld` describes the upload in a test worker;
2. `runSession` runs unit tests in a test worker, calibrates the fuzz timeout, then runs the chosen
   variants;
3. `buildReport` and `createZip` produce the downloadable report.

```sh
node server/main.mjs &     # WAIMEA_PORT=8235 WAIMEA_HOST=127.0.0.1 in the run below
node spikes/05-session/probe.mjs chrome 8235 librarian.apworld 'default=8,check-ut=8' 2 report.zip
```

Arguments are the browser, the server port, the apworld, the variants with run counts, an optional worker
count (default 2), and an optional path to save the report zip. It prints the inspection, timings for each
step, event counts, `summary.md`, and the zip's size.

## Results

Run on 2026-09-15 in headless Chrome, with Librarian 2.0.3 on 2 workers:

| Step | Result | Finished at |
|---|---|---|
| Inspection | module `librarian`, version `2.0.3` from its manifest, one game | 3.0 s (its own worker) |
| Unit tests | 205 planned, 2 failures: the `test_location_group` Goal and Milestones subtests, as in CI | 5.1 s |
| Calibration | factor 0.77× against CI's slow runner, so a 24 s timeout | 9.3 s |
| `default`, 8 runs | 8 successes | 18.4 s |
| `check-ut`, 8 runs | 8 successes | 31.4 s |

- **Unit-test events.** 484 batches. 204 tests reported a result of their own; the one whose subtests
  failed reports only a stop event, which the page uses to close it.
- **Report.** 81 KB. The zip holds `unittest-report/librarian/2.0.3/` (`.aptest` and `.toml`),
  `fuzz-report/librarian/2.0.3/<variant>/fuzz_output/report.json`, `summary.md` and `environment.json`.
- **CI's tools read it.** Unzipped, CI's `aggregate_unittests.py` and `aggregate_fuzz.py` render the
  same failures and counts as Waimea's `summary.md`.
