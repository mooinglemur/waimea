# Spike 2: unit tests in Pyodide

Runs `runtime/unit_tests.py`, CI's `ap_tests.py` harness adapted for Pyodide, under Node. Run on
2026-09-15, with inputs from `deploy/inputs.json`: AP fork `f04b3a3`, lobby `ap_tests.py` at `f74266a`,
Pyodide 0.29.4.

## Results

TUNIC and Stardew Valley, each packaged from the AP fork as an `.apworld`, loaded with APQuest from its own
zip and with no other worlds present:

| World | Pyodide tests | Pyodide time | Native `ap_tests.py` (CPython 3.13.14) |
|---|---|---|---|
| TUNIC | 205 passed | 0.9 s after a 1.4 s boot | 205 passed, 0.5 s |
| Stardew Valley | 205 passed | 10.7 s after a 1.5 s boot | 205 passed, 8.6 s |

- **Test counts.** Both runtimes plan the same 205 tests: 3 from the `WorldTestBase` battery and 202 from
  `test/general`.
- **Subtest events.** Pyodide sent 2,021 result events for TUNIC and 5,514 for Stardew, most of them
  subtests.
- **Heap.** 50 MiB for TUNIC and 60 MiB for Stardew at the end.

**The Stardew leak.** Before the patch in `runtime/waimea_boot.py`, Stardew failed
`test.general.test_memory.TestWorldMemory.test_leak` under Pyodide ("World leaked a reference"):
- **Reproduced natively.** Native CPython 3.13.2, the version Pyodide embeds, failed the same way.
- **Version bisect.** 3.12.14 (CI's series) passed, and so did 3.13.3, 3.13.4, 3.13.5, 3.13.7, 3.13.9,
  3.13.11 and 3.13.14.
- **Cause.** Replacing only `functools.singledispatchmethod` with 3.13.3's version made 3.13.2 free the
  multiworld. That points to CPython gh-127750: 3.13.2's per-instance cache keeps instances alive, and
  Stardew's logic classes use `singledispatchmethod`.
- **Patch.** The patch disables that cache on 3.13.2, and Stardew then passes.

## Files

- `make_tree.py <world> <out dir> <ap_tests.py>`: builds `tree.zip`, which unpacks at `/`. It holds AP's
  source tree without worlds, `ap_tests.py`, vendored wheels and sources, and `runtime/`. It also writes
  `apquest.apworld` and `<world>.apworld`.
- `run.mjs <out dir> <world> <game> <results dir>`: boots Pyodide, runs the tests, prints progress, and
  writes `events.json` and the `.aptest` and `.toml` files.
- `leak_probe.py` and `leak_probe.mjs`: check whether a solo multiworld survives `gc.collect()`.
  `leak_probe.py` also runs natively, with `APWORLD`, `APQUEST` and `GAME` set and AP's root as the
  working directory.
- `leak_roots.py`: an attempt to list what refers to a leaked multiworld from outside it. It reports mostly
  noise, because a world's module-level data is reachable from the multiworld; the version bisect is what
  found the cause.

The native baseline ran the lobby's `ap_tests.py` and `handler.py` in CI's layout: AP's root with both
scripts, `supported/apquest-0.6.7.apworld`, and `custom/<world>-0.0.0.apworld`. It used a venv with AP's
requirements plus `tomlkit`, `semver`, `opentelemetry-api` and `requests`.
