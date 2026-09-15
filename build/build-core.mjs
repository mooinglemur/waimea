// Builds the core bundle under Pyodide, so its bytecode matches the browser's Python.
// Usage: node build/build-core.mjs <vendor dir> <output dir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [vendorArg, outArg] = process.argv.slice(2);
if (!vendorArg || !outArg) {
  console.error("usage: node build/build-core.mjs <vendor dir> <output dir>");
  process.exit(2);
}
const vendorDir = resolve(vendorArg);
const outDir = resolve(outArg);
const runtimeDir = resolve(new URL("../runtime", import.meta.url).pathname);
mkdirSync(outDir, { recursive: true });

const { loadPyodide } = await import(join(vendorDir, "pyodide", "pyodide.mjs"));
const py = await loadPyodide({ indexURL: `${join(vendorDir, "pyodide")}/` });
for (const [mountPoint, hostPath] of Object.entries({ "/vendor": vendorDir, "/runtime": runtimeDir, "/out": outDir })) {
  py.FS.mkdirTree(mountPoint);
  py.FS.mount(py.FS.filesystems.NODEFS, { root: hostPath }, mountPoint);
}

const started = performance.now();
const script = new URL("./build_core.py", import.meta.url).pathname;
py.runPython(readFileSync(script, "utf8"), { filename: script });
const result = JSON.parse(py.globals.get("result"));
result.seconds = +((performance.now() - started) / 1000).toFixed(1);
writeFileSync(join(outDir, "core.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
