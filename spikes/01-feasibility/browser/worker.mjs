// Spike probe worker. mode=stack: nested __call__ depth until RecursionError or a fatal error.
// mode=bench: bench.py over a tree zip, like bench.mjs does under Node.
import { loadPyodide } from "/pyodide/pyodide.mjs";

const post = (message) => postMessage(message);

self.onmessage = async ({ data: config }) => {
  const phases = {};
  const phase = async (name, fn) => {
    const start = performance.now();
    const value = await fn();
    phases[name] = (performance.now() - start) / 1000;
    return value;
  };
  try {
    const py = await phase("loadPyodide", () => loadPyodide({ indexURL: "/pyodide/", env: { SKIP_REQUIREMENTS_UPDATE: "1" } }));
    if (config.mode === "stack") {
      py.globals.set("report", (depth) => post({ type: "ok", depth }));
      const outcome = py.runPython(`
import sys
sys.setrecursionlimit(${Number(config.limit ?? 0)} or sys.getrecursionlimit())
class Rule:
    def __init__(self, inner): self.inner = inner
    def __call__(self, state): return self.inner(state) if self.inner else True
def chain(n):
    r = None
    for _ in range(n): r = Rule(r)
    return r(None)
def plain(n): return 0 if n == 0 else 1 + plain(n - 1)
fn = plain if "${config.kind ?? "callable"}" == "plain" else chain
result = "no error up to 20000"
depth = 25
while depth <= 20000:
    try:
        fn(depth)
    except RecursionError as e:
        result = f"RecursionError at {depth}"
        break
    report(depth)
    depth += 25
f"limit {sys.getrecursionlimit()}: {result}"
`);
      post({ type: "result", result: outcome });
      return;
    }

    await phase("loadPackage", () => py.loadPackage(["pyyaml", "orjson", "jinja2"], { messageCallback: () => {} }));
    await phase("unpack", async () => {
      const bytes = new Uint8Array(await (await fetch(`/tree-${config.world}.zip`)).arrayBuffer());
      py.unpackArchive(bytes, "zip", { extractDir: "/" });
    });
    py.runPython(`
import sys
sys.path.insert(0, "/site-packages")
import kalapana_boot
kalapana_boot.prepare()
sys.argv = ["/ap/fuzz.py"]
`);
    py.runPython(await (await fetch("/bench.py")).text(), { filename: "bench.py" });
    const module = py._module;
    const cfg = JSON.stringify({ world: config.world, runs: Number(config.runs), seed: 5000 });
    const result = await phase("bench", () => JSON.parse(py.globals.get("bench")(cfg, () => module.HEAPU8.length)));
    result.phases = phases;
    post({ type: "result", result });
  } catch (err) {
    post({ type: "error", text: String(err?.stack ?? err).slice(-3000) });
  }
};
