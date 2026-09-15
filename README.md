# waimea

Archipelago apworld unit tests and generation fuzzing, running in the browser. An author picks an
`.apworld`, and Pyodide Web Workers run the same tests and fuzz variants as the
[Archipelago-index](https://github.com/ionium-ap/Archipelago-index) CI. The results can be saved as a report
in the CI's artifact format. The apworld never leaves the browser.

Waimea is a local, self-service check, not a replacement for the index CI: results produced in a browser
can't be trusted by anyone else.

## Status

Planning. The feasibility spike is done, and nothing else is built yet.

- `docs/design.md`: the plan, constraints and decisions.
- `docs/spike-01-feasibility.md`: speed, memory, stack depth and hash randomization, measured under Pyodide
  in Node, Chrome and Firefox.
- `spikes/01-feasibility/`: the spike's scripts and raw results.
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
  - the rest are stand-ins for modules Pyodide lacks (some adapted from Kalapana).
- `web/`: browser-side modules. So far these are the fuzz orchestrator (`fuzz-orchestrator.mjs`), its
  worker (`fuzz-worker.mjs`) and CI's variant table (`fuzz-variants.mjs`).
- `build/`: builds `core.zip`, the Archipelago runtime each worker unpacks, in CI's image layout.
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
docker build -f deploy/Dockerfile -t waimea .
```

## Server

`server/` has no npm dependencies and never receives or runs an apworld. It serves:

| Route | Notes |
|---|---|
| `/` and `web/` | The page. `no-cache` with ETags. |
| `/manifest.json` | Pinned versions, the Pyodide and core bundle URLs, and the timeout calibration. |
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
| `WAIMEA_VENDOR_DIR` | `vendor/` | Pinned inputs; the server reads `inputs.json` and `pyodide/`. |
| `WAIMEA_CORE_BUNDLE` | `build/out/core.zip` | The core bundle. |
| `WAIMEA_CALIBRATION` | `deploy/calibration.json` | The fuzz timeout calibration reference. |

The image (`deploy/Dockerfile`) fetches and verifies the inputs, builds the core bundle under Pyodide, and
keeps only Pyodide, the bundle, the server and the page.

## License

MIT; see `LICENSE`.
