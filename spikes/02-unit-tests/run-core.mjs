// Runs runtime/unit_tests.py under Node Pyodide from a built core bundle and an apworld file.
// Usage: node run-core.mjs <core.zip> <world>.apworld <game name> <results dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [corePath, apworldPath, game, resultsDir] = process.argv.slice(2);
const world = basename(apworldPath, ".apworld");
const PYODIDE = new URL("../../vendor/pyodide/", import.meta.url).pathname;
const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
const bytes = (path) => {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const timings = {};
const time = async (label, fn) => {
  const start = performance.now();
  const value = await fn();
  timings[label] = +((performance.now() - start) / 1000).toFixed(2);
  return value;
};

const py = await time("loadPyodide", () => loadPyodide({ indexURL: PYODIDE, env: { SKIP_REQUIREMENTS_UPDATE: "1" } }));
await time("loadPackage", () => py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} }));
await time("unpack", () => {
  py.unpackArchive(bytes(corePath), "zip", { extractDir: "/" });
  py.FS.mkdirTree("/uploads");
  py.FS.writeFile(`/uploads/${world}.apworld`, bytes(apworldPath));
  py.FS.mkdirTree("/annotations");
});
await time("prepare", () => py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`));

const counts = { results: 0, outcomes: {} };
let done = null;
py.globals.set("emit", (text) => {
  const event = JSON.parse(text);
  if (event.type === "result") {
    counts.results++;
    counts.outcomes[event.outcome] = (counts.outcomes[event.outcome] ?? 0) + 1;
    if (event.outcome !== "success") console.log(`${event.outcome} ${event.id}\n${(event.traceback ?? "").trim().split("\n").slice(-3).join("\n")}`);
  } else if (event.type === "plan") {
    counts.planned = event.tests.length;
  } else if (event.type === "done") {
    done = event;
  }
});
py.globals.set("world", world);
py.globals.set("game", game);
let status;
try {
  status = await time("tests", () => py.runPython(`
import unit_tests
unit_tests.run(f"/uploads/{world}.apworld", "/ap/supported_worlds/apquest-0.6.7.apworld", world, "0.0.0", game, "/annotations", "/out", emit)
`));
} catch (err) {
  status = "crash";
  console.log(String(err.stack ?? err).slice(-3000));
}
mkdirSync(resultsDir, { recursive: true });
for (const name of py.FS.analyzePath("/out").exists ? py.FS.readdir("/out") : []) {
  if (!name.startsWith(".")) writeFileSync(join(resultsDir, name), py.FS.readFile(`/out/${name}`));
}
// Whether imports used the bundled bytecode rather than compiling sources.
const cached = py.runPython(`
import sys
mods = [m for m in sys.modules.values() if getattr(m, "__spec__", None) and getattr(m.__spec__, "cached", None) and m.__spec__.origin and m.__spec__.origin.startswith(("/ap/archipelago/", "/site-packages/"))]
import os
f"{sum(os.path.exists(m.__spec__.cached) for m in mods)}/{len(mods)}"
`);
console.log(JSON.stringify({ world, status, timings, ...counts, done, modulesWithBundledPyc: cached, heapMiB: Math.round(py._module.HEAPU8.length / 2 ** 20) }));
process.exit(0);
