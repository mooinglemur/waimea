// Runs a whole session with the real modules against a running server/main.mjs, headless:
// inspect the apworld, unit tests, calibration, then the chosen fuzz variants, then the report zip.
// Usage: node probe.mjs <chrome|firefox> <server port> <world.apworld> '<variant>=<runs>,...' [jobs] [out.zip]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const puppeteerPath = process.env.PUPPETEER_CORE
  ?? `${process.env.HOME}/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const [browserName, port, apworldPath, variantsArg, jobsArg = "2", zipPath] = process.argv.slice(2);
const executablePath = browserName === "firefox" ? "/usr/bin/firefox-bin" : "/usr/bin/google-chrome-stable";
const variants = Object.fromEntries(variantsArg.split(",").filter(Boolean).map((pair) => {
  const [name, runs] = pair.split("=");
  return [name, Number(runs)];
}));

const browser = await puppeteer.launch({ browser: browserName, executablePath, headless: true, protocolTimeout: 3_600_000 });
try {
  const page = await browser.newPage();
  page.on("console", (msg) => msg.text().startsWith("[probe]") && console.log(msg.text()));
  await page.goto(`http://127.0.0.1:${port}/`);
  const outcome = await page.evaluate(async (apworldBase64, variants, jobs) => {
    const { defaultPlan, inspectApworld, runSession } = await import("/session.mjs");
    const { buildReport } = await import("/report.mjs");
    const { createZip } = await import("/zip.mjs");
    const say = (text) => console.log(`[probe] ${text}`);
    const spawner = (script) => ({ onMessage, onError }) => {
      const worker = new Worker(script, { type: "module" });
      worker.onmessage = (event) => onMessage(event.data);
      worker.onerror = (event) => { event.preventDefault(); onError(`worker error: ${event.message}`); };
      return { post: (m) => worker.postMessage(m), terminate: () => worker.terminate() };
    };
    const manifest = await (await fetch("/manifest.json")).json();
    const core = await (await fetch(manifest.core.url)).arrayBuffer();
    const apworldBytes = Uint8Array.from(atob(apworldBase64), (c) => c.charCodeAt(0)).buffer;
    const common = { manifest, core, apworldBytes, spawnTestWorker: spawner("/test-worker.mjs"), baseUrl: location.href };

    let started = performance.now();
    const info = await inspectApworld(common);
    say(`inspected in ${((performance.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(info).slice(0, 300)}`);
    if (!info.ok) return { info };

    const plan = defaultPlan(navigator.hardwareConcurrency);
    plan.jobs = jobs;
    plan.seed = "probe";
    for (const v of plan.variants) {
      v.enabled = v.name in variants;
      if (v.enabled) v.runs = variants[v.name];
    }
    const counts = {};
    const unitOutcomes = {};
    let plannedTests = 0;
    started = performance.now();
    const record = await runSession({
      ...common,
      world: { module: info.module, version: info.version, game: info.games[0] },
      plan,
      spawnFuzzWorker: spawner("/fuzz-worker.mjs"),
      onEvent: (event) => {
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        if (event.type === "unitTestEvents") {
          for (const e of event.events) {
            if (e.type === "plan") plannedTests = e.tests.length;
            if (e.type === "result" && !e.parent) unitOutcomes[e.outcome] = (unitOutcomes[e.outcome] ?? 0) + 1;
          }
        }
        if (["unitTestsDone", "calibrated", "fuzzDone", "sessionDone"].includes(event.type)) {
          say(`${((performance.now() - started) / 1000).toFixed(1)}s ${event.type} ${event.variant ?? ""} ${
            event.type === "fuzzDone" ? JSON.stringify(event.result?.report.stats ?? event.error ?? event.skipped)
            : event.type === "calibrated" ? `timeout ${event.timeoutSeconds}s factor ${event.calibration?.factor?.toFixed(2)}`
            : event.type === "unitTestsDone" ? `status ${event.unitTests.status}` : ""}`);
        }
      },
    });
    const { files, summary } = buildReport({ manifest, record, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency });
    const zip = await createZip(files);
    let binary = "";
    for (let i = 0; i < zip.length; i += 0x8000) binary += String.fromCharCode(...zip.subarray(i, i + 0x8000));
    return {
      info,
      seconds: +((performance.now() - started) / 1000).toFixed(1),
      eventCounts: counts,
      plannedTests,
      unitOutcomes,
      timeoutSeconds: record.timeoutSeconds,
      paths: files.map((f) => f.path),
      summary,
      zipBase64: btoa(binary),
    };
  }, readFileSync(apworldPath).toString("base64"), variants, Number(jobsArg));

  if (zipPath && outcome.zipBase64) writeFileSync(zipPath, Buffer.from(outcome.zipBase64, "base64"));
  const { zipBase64, summary, ...rest } = outcome;
  console.log(JSON.stringify({ ...rest, paths: rest.paths?.length, zipBytes: zipBase64 ? Buffer.from(zipBase64, "base64").length : 0 }, null, 1));
  console.log("----- summary.md -----");
  console.log(summary);
} finally {
  await browser.close();
}
