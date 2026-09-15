# Spike 1: feasibility of fuzzing in Pyodide

Run on 2026-09-15, before any design work, to measure four things under Pyodide: generation speed, memory
over many generations, stack depth, and hash randomization between instances. The conclusions are in
`docs/design.md`. Scripts and raw results are in `spikes/01-feasibility/`.

## Setup

- **Inputs:** Kalapana's vendored inputs: AP 0.6.7, Pyodide 0.29.4 (Python 3.13.2), and the pinned fuzzer
  `ionium-ap/Archipelago-fuzzer@17227d7`. The product will pin the CI's AP fork at `f04b3a3` instead. That
  commit wasn't needed to measure the runtime.
- **Tree:** `make_tree.py` zips AP's core, one world, `fuzz.py` with `hooks/`, and Kalapana's runtime stubs,
  laid out like Kalapana's core bundle. Pyodide unpacks it into its in-memory filesystem; native Python runs
  from the same files unzipped.
- **Benchmark:** `bench.py` runs identically in both. For each run it seeds `random` with `seed + i`, then
  calls the fuzzer's `generate_random_yaml` and `call_generate`, with output enabled as in CI. It classifies
  each outcome and samples memory every 10 runs: the wasm heap size under Pyodide, resident memory natively.
- **Runtimes:**
  - native CPython 3.13.14 in a uv venv;
  - Pyodide under Node 26.3;
  - Pyodide in a module Web Worker in headless Chrome and Firefox, driven by puppeteer-core.
- **Worlds:** apquest (tiny), TUNIC (medium, entrance randomizer) and Stardew Valley (heavy, nested rule
  objects).
- **Caveats:**
  - Neither runtime had AP's compiled `_speedups`, so the native baseline may be a little slower than CI's
    image.
  - Up to eight benchmarks shared a 24-core machine, which slightly inflates the browser and Stardew timings.

## Results

### 1. Speed: 1.3× to 2× slower than native

Seconds per generation, 100 runs each unless noted. Every run succeeded.

| World | Native | Node | Chrome | Firefox |
|---|---|---|---|---|
| apquest (mean) | 0.006 | 0.007 (1.09×) | | |
| TUNIC (mean) | 0.495 | 0.638 (1.29×) | 0.667 (1.35×) | 0.956 (1.93×) |
| TUNIC, 1000 runs (mean) | 0.474 | 0.606 (1.28×) | | |
| Stardew (median) | 2.46 | 3.48 (1.41×) | 3.76 (1.53×) | 5.27 (2.14×) |

- **TUNIC:** the native and Pyodide runs used identical YAMLs, so its ratios compare like for like.
- **Stardew:** its YAMLs differ between runtimes, because the fuzzer samples from sets whose order depends on
  the string hash. Its ratios are therefore median to median. The native mean is skewed by one 156-second
  run.
- **Startup:** a fresh interpreter is ready in about 1.5 s. That is 1.2 to 1.4 s for `loadPyodide`, 0.13 s
  for packages and under 0.1 s to unpack the tree.

**Implication.** At four workers, CI's 5000-run variants take about as long as CI plus 30 to 100 percent.
For TUNIC that is roughly 13 minutes in Chrome. For Stardew-sized worlds it is about 80 minutes in Chrome and
more in Firefox. So 5000 runs are workable for a patient user but shouldn't be the default for heavy worlds.
The run-count controls on the page matter.

### 2. Memory: recycle workers by heap size

- **Wasm heap:**
  - TUNIC stayed flat at 50 MiB for 1000 generations.
  - Stardew grew steadily, about 3.2 MiB per generation: 72 MiB at the start, 371 MiB after 100 runs and
    1015 MiB after 300, with no plateau.
  - The growth was the same in Node, Chrome and Firefox.
  - Calling `gc.collect()` after every generation changed nothing.
- **Native memory:** flat at 88 MiB for Stardew. The growth is therefore wasm memory that is never handed
  back, not live Python objects, and a wasm heap never shrinks.

**Implication.** The orchestrator should check the heap size between generations and restart a worker past
a threshold, for example 1.5 GB. A restart costs about 1.5 s, cheap next to a Stardew generation, and a
Stardew-like world would restart roughly every 450 generations. A fixed restart count would either waste
restarts on TUNIC-like worlds or fall short for heavy ones.

### 3. Stack depth: a real limit in Chrome, handled by recycling

Two kinds of recursion behave differently in 3.13 Pyodide.

- **Pure Python calls** don't use the wasm stack. Plain functions and lambdas reached 200,000 levels in Node
  and at least 20,000 in a Chrome worker once the recursion limit was raised. At the default limit of 1000
  they raise a clean `RecursionError`.
- **Calls through C use the engine's stack.** This covers `__call__`, and is probed with a chain of nested
  callable objects, the shape of Stardew's and `rule_builder`'s rule objects. It overflows before Python's
  limit:

  | Runtime | Nested `__call__` depth | What happens |
  |---|---|---|
  | Native CPython | 1000 | `RecursionError` |
  | Node (default stack) | about 900 | fatal Pyodide error; the interpreter is dead |
  | Node `--stack-size=3900` | 3500 | `RecursionError` (C recursion limit) |
  | Chrome worker | about 450 | fatal "Maximum call stack size exceeded", whatever the limit |
  | Firefox worker | 1000 | `RecursionError` at the default limit; fatal at about 1650 if the limit is raised |

  - Lowering the limit to 400 makes Chrome raise `RecursionError` cleanly. It would also fail legitimate
    pure-Python recursion that native Python allows, so it isn't a fix.
  - No `RecursionError` or fatal error occurred in any real generation, including 100 Stardew runs in Chrome.

**Implication.** The orchestrator must treat a fatal error as its own outcome: something like "stack
overflow in the browser", distinct from a failure or a timeout. It records the run's YAML and restarts the
worker, just as for a timeout. The report should tell authors that such a result may pass natively, and
suggest Firefox.

### 5. Hash randomization: each instance differs

Three Pyodide instances in one Node process gave different `hash("archipelago")` values and different
frozenset iteration orders. `sys.flags.hash_randomization` is 1. Hashes are 32-bit under wasm32. A
determinism check that regenerates in a second worker therefore keeps its value.

## Not covered

- **Question 4, generation coverage across index worlds:** only three core worlds were run.
- **Question 6, `test/general` under Pyodide:** this is the first task of the unit-test step.
- **Timeouts:** not exercised. Enforcing them from the orchestrator by terminating the worker is still the
  plan.
- **Hooks:** none were run.
- **Safari:** untested.
