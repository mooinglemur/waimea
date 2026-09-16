# waimea

Archipelago apworld unit tests and generation fuzzing, running in the browser. An author picks an
`.apworld`, and Pyodide Web Workers run the same tests and fuzz variants as the
[Archipelago-index](https://github.com/ionium-ap/Archipelago-index) CI. The results can be saved as a report
in the CI's artifact format. The apworld never leaves the browser.

Waimea is a local, self-service check, not a replacement for the index CI: results produced in a browser
can't be trusted by anyone else.

## Status

Version 0.1.0, feature-complete. An apworld's unit tests and all eleven of the index CI's fuzz variants run
in the browser, including `check-determinism`, which regenerates each seed in a second interpreter. Results
match native `fuzz.py` and the CI's own aggregators read the saved report.

Waimea mirrors the index CI's `unit-tests` and `fuzz` jobs. The CI's network audit has no counterpart here,
because worker code has no network at all; `docs/design.md` covers that and the rest of the design.

## Layout

- `docs/design.md`: the plan, constraints and decisions.
- `deploy/inputs.json`: pinned inputs, matching the index CI's image:
  - the `ionium-ap/Archipelago` fork and `ionium-ap/Archipelago-fuzzer` commits, and the fuzzer hooks CI
    replaces;
  - the lobby's `ap_tests.py`, the harness CI runs for unit tests;
  - Universal Tracker 0.2.26 and the empty apworld;
  - Pyodide and pure-Python wheels.

  Each is verified by sha256.
- `runtime/`: Python that runs inside Pyodide:
  - `waimea_boot.py` prepares the interpreter;
  - `unit_tests.py` runs an apworld's unit tests as CI does;
  - `fuzz_worker.py` runs fuzz generations for the orchestrator;
  - `waimea_determinism.py` stands in for the determinism hook, and `determinism_regenerator.py` runs in the
    paired worker that regenerates each seed;
  - `apworld_info.py` describes an uploaded apworld (module, manifest, games);
  - the rest are stand-ins for modules Pyodide lacks (some adapted from Kalapana).
- `web/`: the page and its modules.
  - `index.html`, `app.mjs`, `app.css` and `theme.js` are the page.
  - `unit-view.mjs` and `fuzz-view.mjs` render its result sections, and `dom.mjs` builds elements (always
    as text: test names, tracebacks and logs come from apworld code).
  - `session.mjs` runs a whole session (inspection, unit tests, calibration, fuzz variants) as a stream of
    events.
  - `test-worker.mjs` and `fuzz-worker.mjs` are the two worker types.
  - `fuzz-orchestrator.mjs` schedules a variant's generations across workers, pairing them for the
    determinism check.
  - `fuzz-variants.mjs` is CI's variant table.
  - `report.mjs` and `zip.mjs` build the downloadable report.
- `build/`: builds `core.zip`, the Archipelago runtime each worker unpacks, in CI's image layout.
- `server/`: the Node server, including `version.mjs`, which holds Waimea's version number.
- `test/`: `node --test` suites for the server, the fuzz orchestrator, the session plan, the report and the
  zip. They need no browser and no core bundle.
- `web/calibration.mjs`, `calibration/` and `deploy/calibration.json`: fuzz timeout calibration.
  - The browser times a fixed workload against a reference measured natively by
    `calibration/measure_native.py`, and scales CI's 30-second timeout by the difference.
  - The reference in `deploy/calibration.json` comes from the index CI's `waimea-calibration` job, on one
    of its slowest runners.

## Development

```sh
node deploy/fetch-inputs.mjs vendor        # pinned inputs into vendor/; needs tar and bzip2
node build/build-core.mjs vendor build/out  # core.zip, the runtime each worker unpacks
node server/main.mjs                        # http://localhost:8080
node --test 'test/*.test.mjs'
# --build-arg WAIMEA_COMMIT stamps the footer's version; CI passes the pipeline's commit.
docker build -f deploy/Dockerfile --build-arg WAIMEA_COMMIT="$(git rev-parse --short HEAD)" -t waimea .
```

## Server

`server/` has no npm dependencies and never receives or runs an apworld. It serves:

| Route | Notes |
|---|---|
| `/` and `web/` | The page. `no-cache` with ETags. |
| `/manifest.json` | Waimea's version and site name, the pinned versions, the Pyodide and core bundle URLs, and the timeout calibration. |
| `/runtime/pyodide-<version>/*` | The Pyodide runtime. Immutable. |
| `/bundles/core-<sha256>.zip` | The core bundle, named by content. Immutable. |
| `/healthz` | Liveness. |
| `/readyz` | 200 once a core bundle loaded. |

Security headers:
- **The page** gets a Content Security Policy allowing scripts, workers and connections only from Waimea.
- **Worker scripts**, which run apworld code, get their own policy: nothing but Waimea's scripts and
  fetches, plus WebAssembly compilation.
- **Every response** gets `nosniff`, `no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.

| Variable | Default | Purpose |
|---|---|---|
| `WAIMEA_PORT` / `WAIMEA_HOST` | `8080` / `::` | Listen address. A non-integer port, such as the `tcp://...` value Kubernetes injects for a Service named `waimea`, is ignored with a warning. |
| `WAIMEA_SITE_NAME` | `Waimea` | The name at the top left of the page and in the browser tab. The page sets it from `/manifest.json` once that loads. |
| `WAIMEA_COMMIT` | unset | The commit the image was built from, shown in the footer as `<version>+<short hash>`. The image build sets it from its `WAIMEA_COMMIT` build argument; without it the footer shows the version number alone. |
| `WAIMEA_VENDOR_DIR` | `vendor/` | Pinned inputs; the server reads `inputs.json` and `pyodide/`. |
| `WAIMEA_CORE_BUNDLE` | `build/out/core.zip` | The core bundle. |
| `WAIMEA_CALIBRATION` | `deploy/calibration.json` | The fuzz timeout calibration reference. |

The image (`deploy/Dockerfile`) fetches and verifies the inputs, builds the core bundle under Pyodide, and
keeps only Pyodide, the bundle, the server and the page.

## License

MIT; see `LICENSE`.
