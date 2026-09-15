// Unit tests in a browser worker: the same steps as ../run.mjs, with events posted to the page.
import { loadPyodide } from "/pyodide/pyodide.mjs";

const fetchBytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

self.onmessage = async ({ data: { world, game } }) => {
  const timings = {};
  const time = async (label, fn) => {
    const start = performance.now();
    const value = await fn();
    timings[label] = +((performance.now() - start) / 1000).toFixed(2);
    return value;
  };
  try {
    const py = await time("loadPyodide", () => loadPyodide({ indexURL: "/pyodide/", env: { SKIP_REQUIREMENTS_UPDATE: "1" } }));
    await time("loadPackage", () => py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} }));
    await time("unpack", async () => {
      py.unpackArchive(await fetchBytes("/tree/tree.zip"), "zip", { extractDir: "/" });
      py.FS.mkdirTree("/uploads");
      py.FS.writeFile(`/uploads/${world}.apworld`, await fetchBytes(`/tree/${world}.apworld`));
      py.FS.mkdirTree("/supported");
      py.FS.writeFile("/supported/apquest.apworld", await fetchBytes("/tree/apquest.apworld"));
      py.FS.mkdirTree("/annotations");
    });
    await time("prepare", () => py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import waimea_boot
waimea_boot.prepare()
`));
    postMessage({ type: "booted", timings });

    // Batch events: Stardew Valley sends thousands of subtest results.
    let batch = [];
    const flush = () => {
      if (batch.length) postMessage({ type: "events", events: batch });
      batch = [];
    };
    py.globals.set("emit", (text) => {
      batch.push(JSON.parse(text));
      if (batch.length >= 200) flush();
    });
    py.globals.set("world", world);
    py.globals.set("game", game);
    const status = await time("tests", () => py.runPython(`
import unit_tests
unit_tests.run(f"/uploads/{world}.apworld", "/supported/apquest.apworld", world, "0.0.0", game, "/annotations", "/out", emit)
`));
    flush();
    postMessage({ type: "finished", status, timings, heapMiB: Math.round(py._module.HEAPU8.length / 2 ** 20) });
  } catch (err) {
    postMessage({ type: "error", text: String(err?.stack ?? err).slice(-4000), timings });
  }
};
