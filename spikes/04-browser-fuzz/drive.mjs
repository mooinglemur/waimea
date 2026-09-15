// Usage: node drive.mjs <chrome|firefox> '<query string>' <out.json> [port]
// puppeteer-core comes from Kalapana's spikes (PUPPETEER_CORE overrides the path).
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const puppeteerPath = process.env.PUPPETEER_CORE
  ?? `${process.env.HOME}/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  firefox: { browser: "firefox", executablePath: "/usr/bin/firefox-bin" },
};
const [name, query, outPath, port = "8234"] = process.argv.slice(2);
const started = Date.now();
const browser = await puppeteer.launch({ ...BROWSERS[name], headless: true, protocolTimeout: 3_600_000 });
let probe;
try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(`http://localhost:${port}/index.html?${query}`);
  let lastPrint = 0;
  for (;;) {
    probe = await page.evaluate(() => window.probe);
    if (probe?.done || Date.now() - started > 3_300_000) break;
    if (Date.now() - lastPrint > 15_000) {
      lastPrint = Date.now();
      const p = probe?.progress;
      console.log(`[${name} ${Math.round((Date.now() - started) / 1000)}s] ${probe?.phase} ${p ? `${p.completed}/${p.runs} ${JSON.stringify(p.stats)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  await browser.close();
}
writeFileSync(outPath, JSON.stringify(probe, null, 1));
const r = probe?.result;
console.log(`${name} ${query}:`, probe?.error
  ? `ERROR ${probe.error.slice(0, 600)}`
  : JSON.stringify({ seconds: r?.seconds, timeout: r?.timeoutSeconds, factor: r?.calibration?.factor, stats: r?.report.stats,
      errors: Object.fromEntries(Object.entries(Object.values(r?.report.errors ?? {})[0] ?? {}).map(([k, v]) => [k.slice(0, 90), v.length])),
      counters: { ...r?.counters, bootSeconds: undefined } }));
