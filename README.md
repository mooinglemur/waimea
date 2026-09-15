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
- `inputs.json`: pinned inputs in Kalapana's format, copied from Kalapana as a starting point. It will be
  re-pinned to the CI's Archipelago fork, fuzzer and Universal Tracker versions.
