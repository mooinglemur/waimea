// A test worker: one Pyodide interpreter that describes an uploaded apworld (runtime/apworld_info.py) or runs
// its unit tests the way the index CI does (runtime/unit_tests.py). It runs as a browser module worker.
//
// Messages in:  init {pyodideUrl, indexURL, core, apworld: {bytes}, packages?}
//               inspect
//               unitTests {module, version, game, apquestPath, annotations?}
// Messages out: ready {seconds} | setupError {text}
//               inspected {info}
//               events {events}, repeatedly, then unitTestsDone {status, files} | fatal {text}

let py = null;
const UPLOAD = "/uploads/upload.apworld";

const post = (message) => globalThis.postMessage(message);
const describe = (err) => {
  const text = String(err?.stack ?? err);
  return text.length <= 4000 ? text : `${text.slice(0, 2000)}\n[...]\n${text.slice(-2000)}`;
};

async function init({ pyodideUrl, indexURL, core, apworld, packages = ["pyyaml", "orjson", "jinja2"] }) {
  const started = performance.now();
  const { loadPyodide } = await import(pyodideUrl);
  py = await loadPyodide({ indexURL, env: { SKIP_REQUIREMENTS_UPDATE: "1" }, stdout: () => {}, stderr: () => {} });
  await py.loadPackage(packages, { messageCallback: () => {} });
  py.unpackArchive(new Uint8Array(core), "zip", { extractDir: "/" });
  py.FS.mkdirTree("/uploads");
  py.FS.writeFile(UPLOAD, new Uint8Array(apworld.bytes));
  py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`);
  return { seconds: (performance.now() - started) / 1000 };
}

function readFiles(dir) {
  if (!py.FS.analyzePath(dir).exists) return {};
  const files = {};
  for (const name of py.FS.readdir(dir)) {
    if (name !== "." && name !== "..") files[name] = py.FS.readFile(`${dir}/${name}`, { encoding: "utf8" });
  }
  return files;
}

function unitTests({ module, version, game, apquestPath, annotations }) {
  py.FS.mkdirTree("/annotations");
  if (annotations) py.FS.writeFile(`/annotations/${module}.toml`, annotations);
  // Batched, and flushed at each test's end: subtests can produce thousands of results.
  let batch = [];
  const flush = () => {
    if (batch.length) post({ type: "events", events: batch });
    batch = [];
  };
  const emit = (text) => {
    const event = JSON.parse(text);
    batch.push(event);
    if (event.type !== "result" || batch.length >= 200) flush();
  };
  // unit_tests.load_apworld stages its own copy as <module>.apworld, so the upload's name doesn't matter.
  const status = py.pyimport("unit_tests").run(UPLOAD, apquestPath, module, version, game, "/annotations", "/out", emit);
  flush();
  return { status, files: readFiles("/out") };
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
    case "inspect":
      try {
        post({ type: "inspected", info: JSON.parse(py.pyimport("apworld_info").describe(UPLOAD)) });
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
    case "unitTests":
      try {
        post({ type: "unitTestsDone", ...unitTests(data) });
      } catch (err) {
        post({ type: "fatal", text: describe(err) });
      }
      break;
  }
};
