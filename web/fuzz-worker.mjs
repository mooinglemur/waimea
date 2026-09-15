// A fuzz worker: one Pyodide interpreter running the pinned fuzzer's generations one at a time, through
// runtime/fuzz_worker.py. It runs as a browser module worker, or under Node through a worker_threads
// adapter that provides postMessage and onmessage.
//
// With role "regenerator" it is instead the paired worker for check-determinism (runtime/determinism_regenerator.py),
// regenerating the runs its fuzz worker hands over.
//
// Messages in:  init {pyodideUrl, indexURL, core, apworld: {module, bytes} | {module, supported}, config, role?, packages?}
//                 (supported names a file in the bundle's /ap/supported_worlds, such as the calibration world)
//               run {i, seed, generationSeed?}
//               resume {response}               a regenerator's response to this worker's request
//               timeoutOutcome
//               regenerate {request}            (regenerator)
// Messages out: ready {game, seconds} | setupError {text}
//               started {i, yamls} then result {outcome, key, dump, heapBytes} | regenerate {request} | fatal {text}
//               prepareError {text}
//               timeoutOutcome {outcome}
//               regenerated {response, heapBytes} | fatal {text}   (regenerator)

let py = null;
let fuzzWorker = null;
let regenerator = null;

const post = (message) => globalThis.postMessage(message);
// A stack overflow's trace runs to thousands of wasm frames, and the useful line ("RangeError: Maximum call
// stack size exceeded") comes first, so a long description keeps its head as well as its tail.
const describe = (err) => {
  const text = String(err?.stack ?? err);
  return text.length <= 4000 ? text : `${text.slice(0, 2000)}\n[...]\n${text.slice(-2000)}`;
};

async function init({ pyodideUrl, indexURL, core, apworld, config, role, packages = ["pyyaml", "orjson", "jinja2"] }) {
  const started = performance.now();
  const { loadPyodide } = await import(pyodideUrl);
  // Generation output is captured per run in Python; anything else printed is noise.
  py = await loadPyodide({ indexURL, env: { SKIP_REQUIREMENTS_UPDATE: "1" }, stdout: () => {}, stderr: () => {} });
  await py.loadPackage(packages, { messageCallback: () => {} });
  py.unpackArchive(new Uint8Array(core), "zip", { extractDir: "/" });
  // The index CI stages the apworld under test in worlds/, where fuzz.py's import of worlds finds it.
  const staged = `/ap/archipelago/worlds/${apworld.module}.apworld`;
  if (apworld.supported) py.FS.writeFile(staged, py.FS.readFile(`/ap/supported_worlds/${apworld.supported}`));
  else py.FS.writeFile(staged, new Uint8Array(apworld.bytes));
  py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`);
  if (role === "regenerator") {
    regenerator = py.pyimport("determinism_regenerator");
    regenerator.setup();
    return { game: null, seconds: (performance.now() - started) / 1000 };
  }
  fuzzWorker = py.pyimport("fuzz_worker");
  const setup = JSON.parse(fuzzWorker.setup(JSON.stringify(config)));
  return { ...setup, seconds: (performance.now() - started) / 1000 };
}

// A generation step's JSON is either the finished run or a request to regenerate it in the paired worker.
function postGeneration(json) {
  const step = JSON.parse(json);
  if (step.regenerate) post({ type: "regenerate", request: step.regenerate });
  else post({ type: "result", ...step, heapBytes: py._module.HEAPU8.length });
}

globalThis.onmessage = async ({ data }) => {
  switch (data.type) {
    case "init":
      try {
        post({ type: "ready", ...(await init(data)) });
      } catch (err) {
        post({ type: "setupError", text: describe(err) });
      }
      break;
    case "run": {
      let prepared;
      try {
        prepared = JSON.parse(fuzzWorker.prepare(data.i, data.seed));
      } catch (err) {
        post({ type: "prepareError", text: describe(err) });
        break;
      }
      post({ type: "started", i: data.i, yamls: prepared.yamls });
      try {
        // Python catches generation errors itself, so anything thrown here is the interpreter failing.
        // Pyodide passes a JavaScript null to Python as JsNull, not None, so leave the argument out entirely
        // when no generation seed is pinned.
        postGeneration(data.generationSeed == null ? fuzzWorker.generate() : fuzzWorker.generate(data.generationSeed));
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
    }
    case "resume":
      try {
        postGeneration(fuzzWorker.resume(JSON.stringify(data.response)));
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
    case "regenerate":
      try {
        const response = JSON.parse(regenerator.regenerate(JSON.stringify(data.request)));
        post({ type: "regenerated", response, heapBytes: py._module.HEAPU8.length });
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
    case "timeoutOutcome":
      try {
        post({ type: "timeoutOutcome", outcome: fuzzWorker.timeout_outcome() });
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
  }
};
