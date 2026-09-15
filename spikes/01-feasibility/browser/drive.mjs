// Usage: node drive.mjs <chrome|firefox> '<query string>' [port] [out.json]
import puppeteer from "/home/troy/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
import { writeFileSync } from "node:fs";

const BROWSERS = {
  chrome: { browser: "chrome", executablePath: "/usr/bin/google-chrome-stable" },
  firefox: { browser: "firefox", executablePath: "/usr/bin/firefox-bin" },
};
const [name, query, port = "8231", outPath] = process.argv.slice(2);
const browser = await puppeteer.launch({ ...BROWSERS[name], headless: true, protocolTimeout: 3_000_000 });
try {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.message}`));
  await page.goto(`http://localhost:${port}/browser/index.html?${query}`);
  // A fatal wasm error may leave the worker silent instead of posting, so also stop when progress stalls.
  let lastMessages = -1;
  let stalledSince = Date.now();
  let probe;
  for (;;) {
    probe = await page.evaluate(() => window.probe);
    if (probe.done) break;
    if (probe.messages !== lastMessages) {
      lastMessages = probe.messages;
      stalledSince = Date.now();
    } else if (probe.last !== null && Date.now() - stalledSince > 20_000) {
      probe.error = "stalled after last ok";
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(probe.result ?? probe, null, 1));
  const { result, ...rest } = probe;
  console.log(name, JSON.stringify(rest).slice(0, 1500), typeof result === "string" ? result : "");
} finally {
  await browser.close();
}
