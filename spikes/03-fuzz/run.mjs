// Runs one fuzz variant under Node with web/fuzz-orchestrator.mjs, and writes fuzz_output/ as fuzz.py does.
// Usage: node run.mjs --core core.zip --apworld <world>.apworld --variant default --runs 100 [--jobs 4]
//          [--timeout 30] [--heap-limit-mib 1536] [--seed waimea] [--calibration deploy/calibration.json] --out <dir>
// With --calibration, the calibration workload runs first on the same workers, and --timeout is scaled.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { calibrate, scaledTimeout } from "../../web/calibration.mjs";
import { runVariant } from "../../web/fuzz-orchestrator.mjs";
import { VARIANTS } from "../../web/fuzz-variants.mjs";

const { values: opts } = parseArgs({
  options: {
    core: { type: "string" },
    apworld: { type: "string" },
    variant: { type: "string", default: "default" },
    runs: { type: "string", default: "20" },
    jobs: { type: "string", default: "4" },
    timeout: { type: "string", default: "30" },
    "heap-limit-mib": { type: "string", default: "1536" },
    seed: { type: "string", default: "waimea" },
    calibration: { type: "string" },
    out: { type: "string" },
  },
});
const variant = VARIANTS.find((v) => v.name === opts.variant);
if (!opts.core || !opts.apworld || !opts.out || !variant) {
  console.error("usage: node run.mjs --core core.zip --apworld <world>.apworld --variant <name> --runs N --out <dir>");
  process.exit(2);
}

const pyodideDir = new URL("../../vendor/pyodide/", import.meta.url).pathname;
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const module = basename(opts.apworld, ".apworld");
const runs = Number(opts.runs);
const jobs = Number(opts.jobs);
const shared = {
  pyodideUrl: pathToFileURL(join(pyodideDir, "pyodide.mjs")).href,
  indexURL: pyodideDir,
  core: toArrayBuffer(readFileSync(opts.core)),
};

const spawn = ({ onMessage, onError }) => {
  const worker = new Worker(new URL("./node-worker.mjs", import.meta.url));
  let terminated = false;
  worker.on("message", onMessage);
  worker.on("error", (err) => onError(String(err?.stack ?? err)));
  worker.on("exit", (code) => !terminated && onError(`worker exited with code ${code}`));
  return {
    post: (message) => worker.postMessage(message),
    terminate: () => {
      terminated = true;
      worker.terminate();
    },
  };
};

let timeoutSeconds = Number(opts.timeout);
let calibration = null;
if (opts.calibration) {
  const calibrationStarted = performance.now();
  calibration = await calibrate({ spawn, init: shared, jobs, calibration: JSON.parse(readFileSync(opts.calibration, "utf8")) });
  calibration.seconds = +((performance.now() - calibrationStarted) / 1000).toFixed(1);
  calibration.ciTimeoutSeconds = timeoutSeconds;
  timeoutSeconds = scaledTimeout(timeoutSeconds, calibration.factor);
  calibration.timeoutSeconds = timeoutSeconds;
  console.log(`calibration: ${JSON.stringify(calibration)}`);
}
const init = {
  ...shared,
  apworld: { module, bytes: toArrayBuffer(readFileSync(opts.apworld)) },
  config: { apworld: module, runs, timeout: timeoutSeconds, hooks: variant.hook ? [variant.hook] : [] },
};

const started = performance.now();
let lastPrint = 0;
const result = await runVariant({
  spawn,
  init,
  apworld: module,
  runs,
  jobs,
  paired: Boolean(variant.paired),
  timeoutSeconds,
  heapLimitBytes: Number(opts["heap-limit-mib"]) * 2 ** 20,
  seed: opts.seed,
  onProgress: ({ completed, stats }) => {
    if (performance.now() - lastPrint > 5000 || completed === runs) {
      lastPrint = performance.now();
      console.log(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${completed}/${runs} ${JSON.stringify(stats)}`);
    }
  },
});

const variantDir = join(opts.out, variant.name);
for (const [path, text] of Object.entries(result.files)) {
  const target = join(variantDir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
const summary = {
  variant: variant.name,
  game: result.game,
  seconds: +((performance.now() - started) / 1000).toFixed(1),
  timeoutSeconds,
  calibration,
  report: result.report,
  counters: result.counters,
};
writeFileSync(join(variantDir, "summary.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
process.exit(0);
