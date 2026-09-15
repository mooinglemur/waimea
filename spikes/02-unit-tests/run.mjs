// Runs runtime/unit_tests.py under Node Pyodide.
// Usage: node run.mjs <out dir from make_tree.py> <world folder> <game name> <results dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [treeDir, world, game, resultsDir] = process.argv.slice(2);
const PYODIDE = new URL("../../vendor/pyodide/", import.meta.url).pathname;
const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
const bytes = (path) => {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const started = performance.now();
const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);
const py = await loadPyodide({ indexURL: PYODIDE, env: { SKIP_REQUIREMENTS_UPDATE: "1" } });
await py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} });
py.unpackArchive(bytes(join(treeDir, "tree.zip")), "zip", { extractDir: "/" });
py.FS.mkdirTree("/uploads");
py.FS.writeFile(`/uploads/${world}.apworld`, bytes(join(treeDir, `${world}.apworld`)));
py.FS.mkdirTree("/supported");
py.FS.writeFile("/supported/apquest.apworld", bytes(join(treeDir, "apquest.apworld")));
py.FS.mkdirTree("/annotations");
py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`);
console.log(`[${elapsed()}s] booted`);

mkdirSync(resultsDir, { recursive: true });
const events = [];
let planned = 0;
let done = 0;
const emit = (text) => {
  const event = JSON.parse(text);
  events.push(event);
  if (event.type === "plan") {
    planned = event.tests.length;
    console.log(`[${elapsed()}s] plan: ${planned} tests`);
  } else if (event.type === "result") {
    if (!event.parent) done++;
    if (event.outcome !== "success") {
      console.log(`[${elapsed()}s] ${event.outcome} ${event.id}${event.traceback ? `\n${event.traceback.trim().split("\n").slice(-3).join("\n")}` : ""}`);
    }
  } else if (event.type === "done") {
    console.log(`[${elapsed()}s] done: ${JSON.stringify(event)}`);
  }
};

let status;
try {
  py.globals.set("emit", emit);
  status = py.runPython(`
import unit_tests
unit_tests.run("/uploads/${world}.apworld", "/supported/apquest.apworld", "${world}", "0.0.0", ${JSON.stringify(game)}, "/annotations", "/out", emit)
`);
} catch (err) {
  console.log(`[${elapsed()}s] crashed: ${String(err.stack ?? err).slice(-3000)}`);
  status = "crash";
}
for (const name of py.FS.analyzePath("/out").exists ? py.FS.readdir("/out") : []) {
  if (!name.startsWith(".")) writeFileSync(join(resultsDir, name), py.FS.readFile(`/out/${name}`));
}
writeFileSync(join(resultsDir, "events.json"), JSON.stringify(events, null, 1));
console.log(`[${elapsed()}s] status ${status}, ${done} top-level results of ${planned} planned, heap ${(py._module.HEAPU8.length / 2 ** 20).toFixed(0)} MiB`);
process.exit(0);
