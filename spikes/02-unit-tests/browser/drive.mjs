// Usage: node drive.mjs <chrome|firefox> <world> <game> [port]
// puppeteer-core comes from Kalapana's spikes (PUPPETEER_CORE overrides the path).
import { pathToFileURL } from "node:url";

const puppeteerPath = process.env.PUPPETEER_CORE
  ?? `${process.env.HOME}/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  firefox: { browser: "firefox", executablePath: "/usr/bin/firefox-bin" },
};
const [name, world, game, port = "8233"] = process.argv.slice(2);
const started = Date.now();
const browser = await puppeteer.launch({ ...BROWSERS[name], headless: true, protocolTimeout: 1_800_000 });
try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(`http://localhost:${port}/index.html?world=${encodeURIComponent(world)}&game=${encodeURIComponent(game)}`);
  let probe;
  for (;;) {
    probe = await page.evaluate(() => window.probe);
    if (probe.done || Date.now() - started > 1_500_000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const summary = {
    booted: probe.booted,
    plan: probe.plan,
    results: probe.results,
    stops: probe.stops,
    outcomes: probe.outcomes,
    done: probe.doneEvent,
    finished: probe.finished,
    error: probe.error,
  };
  console.log(name, world, JSON.stringify(summary));
} finally {
  await browser.close();
}
