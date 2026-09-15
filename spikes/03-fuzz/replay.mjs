// Replays one fuzz generation under Node Pyodide (see replay.py).
// Usage: node replay.mjs <core.zip> <world>.apworld <yamls dir> <seed>
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const [corePath, apworldPath, yamlsDir, seed] = process.argv.slice(2);
const pyodideDir = new URL("../../vendor/pyodide/", import.meta.url).pathname;
const { loadPyodide } = await import(join(pyodideDir, "pyodide.mjs"));
const bytes = (path) => {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const py = await loadPyodide({ indexURL: pyodideDir, env: { SKIP_REQUIREMENTS_UPDATE: "1" }, stdout: () => {}, stderr: () => {} });
await py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} });
py.unpackArchive(bytes(corePath), "zip", { extractDir: "/" });
py.FS.writeFile(`/ap/archipelago/worlds/${basename(apworldPath)}`, bytes(apworldPath));
py.FS.mkdirTree("/replay");
for (const name of readdirSync(yamlsDir).filter((n) => n.endsWith(".yaml"))) {
  py.FS.writeFile(`/replay/${name}`, bytes(join(yamlsDir, name)));
}
py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`);
py.runPython(readFileSync(new URL("./replay.py", import.meta.url), "utf8"), { filename: "replay.py" });
console.log(py.globals.get("replay")("/replay", seed));
process.exit(0);
