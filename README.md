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
- `runtime/`: Python that runs inside Pyodide. `waimea_boot.py` prepares the interpreter,
  `unit_tests.py` runs an apworld's unit tests as CI does, and the rest are stand-ins for modules Pyodide
  lacks (some adapted from Kalapana).

## Development

```sh
node deploy/fetch-inputs.mjs vendor        # pinned inputs into vendor/; needs tar and bzip2
node build/build-core.mjs vendor build/out  # core.zip, the runtime each worker unpacks
```

## License

MIT; see `LICENSE`.
