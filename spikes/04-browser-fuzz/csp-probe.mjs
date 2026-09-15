// Checks the real server's worker Content Security Policy from inside apworld code.
//
// Loads the real page from server/main.mjs, then runs one generation of the waimea_netprobe fixture
// through /fuzz-orchestrator.mjs and /fuzz-worker.mjs, so the worker runs under the server's worker
// policy. The fixture's failure message says what its requests did.
// Usage: node csp-probe.mjs <chrome|firefox> <server port> <waimea_netprobe.apworld>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const puppeteerPath = process.env.PUPPETEER_CORE
  ?? `${process.env.HOME}/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const [browserName, port, apworldPath] = process.argv.slice(2);
const executablePath = browserName === "firefox" ? "/usr/bin/firefox-bin" : "/usr/bin/google-chrome-stable";
const apworld = readFileSync(apworldPath).toString("base64");

const browser = await puppeteer.launch({ browser: browserName, executablePath, headless: true, protocolTimeout: 300_000 });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const outcome = await page.evaluate(async (apworldBase64) => {
    const { runVariant } = await import("/fuzz-orchestrator.mjs");
    const manifest = await (await fetch("/manifest.json")).json();
    const core = await (await fetch(manifest.core.url)).arrayBuffer();
    const bytes = Uint8Array.from(atob(apworldBase64), (c) => c.charCodeAt(0)).buffer;
    const spawn = ({ onMessage, onError }) => {
      const worker = new Worker("/fuzz-worker.mjs", { type: "module" });
      worker.onmessage = (event) => onMessage(event.data);
      worker.onerror = (event) => { event.preventDefault(); onError(`worker error: ${event.message}`); };
      return { post: (m) => worker.postMessage(m), terminate: () => worker.terminate() };
    };
    const result = await runVariant({
      spawn,
      init: {
        pyodideUrl: new URL(`${manifest.pyodide.base}pyodide.mjs`, location.href).href,
        indexURL: new URL(manifest.pyodide.base, location.href).href,
        core,
        apworld: { module: "waimea_netprobe", bytes },
        config: { apworld: "waimea_netprobe", runs: 1, timeout: 60, hooks: [] },
      },
      apworld: "waimea_netprobe",
      runs: 1,
      jobs: 1,
      timeoutSeconds: 60,
      heapLimitBytes: 0,
      seed: "csp-probe",
    });
    return { stats: result.report.stats, errors: Object.keys(Object.values(result.report.errors)[0] ?? {}) };
  }, apworld);
  console.log(browserName, JSON.stringify(outcome));
} finally {
  await browser.close();
}
