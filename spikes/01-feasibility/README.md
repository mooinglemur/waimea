# Spike 1: feasibility

Findings are in `docs/spike-01-feasibility.md`. `results/` holds the raw JSON from that run and
`summary.txt`, the output of `summarize.py`.

These are one-off scripts, kept as they ran, not tools. To run them again, work in a scratch directory
laid out as they expect:

- **Kalapana's vendored inputs:** its Pyodide and AP source are read by absolute path from
  `~/src/kalapana/vendor`, and `browser/drive.mjs` uses the puppeteer-core in `~/src/kalapana/spikes/node_modules`.
- **The pinned fuzzer** unpacked in `../fuzzer`, next to this directory:
  `https://codeload.github.com/ionium-ap/Archipelago-fuzzer/tar.gz/17227d793cc1088ae9be5fe97421e73bb683efdf`.
- **A native baseline venv** in `venv/`: Python 3.13 with `pyyaml orjson schema platformdirs colorama pathspec
  typing_extensions jinja2 websockets jellyfish bsdiff4 certifi`.
- **Per-world trees** built with `python make_tree.py <world> tree-<world>.zip`, then unzipped into
  `native-<world>/`.
- **An `out/` directory**, where `run_full.sh` and `browser/run_browsers.sh` write results and
  `summarize.py` reads them.

Scripts:

- `run_full.sh`: native and Node Pyodide benchmarks (`bench.py` and `bench.mjs`).
- `browser/run_browsers.sh`: the same benchmark in Chrome and Firefox workers, using `serve.mjs`,
  `drive.mjs`, `index.html` and `worker.mjs`. `drive.mjs` with `mode=stack` runs the stack probe.
- `stack2.mjs` and `stack3.mjs`: recursion depth under Node. `hashcheck.mjs` checks hash randomization
  across Pyodide instances.
