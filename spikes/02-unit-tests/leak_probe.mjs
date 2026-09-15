// Runs leak_probe.py under Node Pyodide. Usage: node leak_probe.mjs <tree dir> <world folder> <game name>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [treeDir, world, game] = process.argv.slice(2);
const PYODIDE = new URL("../../vendor/pyodide/", import.meta.url).pathname;
const { loadPyodide } = await import(`${PYODIDE}pyodide.mjs`);
const bytes = (path) => {
  const buf = readFileSync(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const py = await loadPyodide({ indexURL: PYODIDE, env: { SKIP_REQUIREMENTS_UPDATE: "1" } });
await py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} });
py.unpackArchive(bytes(join(treeDir, "tree.zip")), "zip", { extractDir: "/" });
py.FS.mkdirTree("/uploads");
py.FS.writeFile(`/uploads/${world}.apworld`, bytes(join(treeDir, `${world}.apworld`)));
py.FS.writeFile("/uploads/apquest.apworld", bytes(join(treeDir, "apquest.apworld")));
py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`);
py.runPython(readFileSync(new URL("./leak_probe.py", import.meta.url), "utf8"), { filename: "leak_probe.py" });
console.log(py.globals.get("probe")(`/uploads/${world}.apworld`, "/uploads/apquest.apworld", game));
process.exit(0);
