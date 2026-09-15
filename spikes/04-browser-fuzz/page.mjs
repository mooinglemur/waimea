// Runs one fuzz variant in browser module workers with Waimea's real modules, optionally calibrating first.
// Query: world=<module> variant=<name> runs=N jobs=N [timeout=30] [calibrate=1] [seed=waimea]
// Progress and the result land in window.probe for drive.mjs.
import { calibrate, scaledTimeout } from "/web/calibration.mjs";
import { runVariant } from "/web/fuzz-orchestrator.mjs";
import { VARIANTS } from "/web/fuzz-variants.mjs";

const params = new URLSearchParams(location.search);
const out = document.getElementById("out");
const probe = (window.probe = { done: false, error: null, phase: "starting", progress: null, result: null });
const show = () => (out.textContent = JSON.stringify(probe, null, 1).slice(0, 4000));

const fetchBuffer = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
};

const spawn = ({ onMessage, onError }) => {
  const worker = new Worker("/web/fuzz-worker.mjs", { type: "module" });
  worker.onmessage = (event) => onMessage(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    onError(`worker error: ${event.message}`);
  };
  return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() };
};

try {
  const module = params.get("world");
  const variant = VARIANTS.find((v) => v.name === (params.get("variant") ?? "default"));
  const jobs = Number(params.get("jobs") ?? 2);
  const runs = Number(params.get("runs") ?? 10);
  const ciTimeout = Number(params.get("timeout") ?? 30);
  const shared = {
    pyodideUrl: new URL("/pyodide/pyodide.mjs", location.href).href,
    indexURL: new URL("/pyodide/", location.href).href,
    core: await fetchBuffer("/data/core.zip"),
  };
  const started = performance.now();
  let timeoutSeconds = ciTimeout;
  let calibration = null;
  if (params.get("calibrate")) {
    probe.phase = "calibrating";
    show();
    calibration = await calibrate({ spawn, init: shared, jobs, calibration: await (await fetch("/deploy/calibration.json")).json() });
    timeoutSeconds = scaledTimeout(ciTimeout, calibration.factor);
  }
  probe.phase = "fuzzing";
  show();
  const result = await runVariant({
    spawn,
    init: {
      ...shared,
      apworld: { module, bytes: await fetchBuffer(`/data/${module}.apworld`) },
      config: { apworld: module, runs, timeout: timeoutSeconds, hooks: variant.hook ? [variant.hook] : [] },
    },
    apworld: module,
    runs,
    jobs,
    timeoutSeconds,
    heapLimitBytes: 1536 * 2 ** 20,
    seed: params.get("seed") ?? "waimea",
    onProgress: (progress) => {
      probe.progress = progress;
      show();
    },
  });
  const logs = Object.entries(result.files).filter(([path]) => path.endsWith(".log"));
  probe.result = {
    variant: variant.name,
    userAgent: navigator.userAgent,
    seconds: +((performance.now() - started) / 1000).toFixed(1),
    timeoutSeconds,
    calibration,
    report: result.report,
    counters: result.counters,
    // Head and tail: a fatal error's log starts with the error line and ends in wasm frames.
    sampleLogs: logs.slice(0, 2).map(([path, text]) => [path, text.length <= 1600 ? text : `${text.slice(0, 800)}\n[...]\n${text.slice(-800)}`]),
  };
} catch (err) {
  probe.error = String(err?.stack ?? err);
} finally {
  probe.phase = "done";
  probe.done = true;
  show();
}
