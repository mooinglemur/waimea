// Pyodide side of the spike. Usage: node bench.mjs <tree.zip> '<json config>' <out.json>
import { readFileSync, writeFileSync } from "node:fs";

const [zipPath, configJson, outPath] = process.argv.slice(2);
const PYODIDE = "/home/troy/src/kalapana/vendor/pyodide/";
const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
const now = () => performance.now();
const phases = {};
const phase = async (name, fn) => {
  const start = now();
  const value = await fn();
  phases[name] = (now() - start) / 1000;
  return value;
};

const py = await phase("loadPyodide", () =>
  loadPyodide({ indexURL: PYODIDE, env: { SKIP_REQUIREMENTS_UPDATE: "1" } }));
await phase("loadPackage", () => py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} }));
await phase("unpack", () => {
  const buf = readFileSync(zipPath);
  py.unpackArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), "zip", { extractDir: "/" });
});
await phase("prepare", () => py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import kalapana_boot
kalapana_boot.prepare()
sys.argv = ["/ap/fuzz.py"]
`));

const module = py._module;
const heapBytes = () => module.HEAPU8.length;
const benchFile = new URL("./bench.py", import.meta.url);
py.runPython(readFileSync(benchFile, "utf8"), { filename: "bench.py" });

let result;
try {
  result = await phase("bench", () => JSON.parse(py.globals.get("bench")(configJson, heapBytes)));
} catch (e) {
  result = { crash: String(e.stack ?? e).slice(-4000) };
}
result.phases = phases;
result.nodeRss = process.memoryUsage().rss;
result.heapFinal = heapBytes();
writeFileSync(outPath, JSON.stringify(result, null, 1));
process.exit(0);
