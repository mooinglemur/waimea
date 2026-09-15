// Drives the real page like a person would, against a running server/main.mjs:
// upload an apworld, choose the Quick preset, keep only the given variants at the given run counts, start,
// wait for the summary, save the report, and take screenshots in light and dark.
// Usage: node check.mjs <chrome|firefox> <server port> <world.apworld> '<variant>=<runs>,...' <out dir> [jobs]
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const puppeteerPath = process.env.PUPPETEER_CORE
  ?? `${process.env.HOME}/src/kalapana/spikes/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`;
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);

const [browserName, port, apworldPath, variantsArg, outDirArg, jobs = "2"] = process.argv.slice(2);
const outDir = resolve(outDirArg);
const downloads = join(outDir, "downloads");
mkdirSync(downloads, { recursive: true });
const executablePath = browserName === "firefox" ? "/usr/bin/firefox-bin" : "/usr/bin/google-chrome-stable";
const requested = Object.fromEntries(variantsArg.split(",").filter(Boolean).map((p) => p.split("=")).map(([k, v]) => [k, Number(v)]));
// `unit=0` turns the unit tests off, for worlds whose generation is too slow to test (fixtures/waimea_slow).
const { unit, ...wanted } = requested;
const unitTests = unit !== 0;
const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

const browser = await puppeteer.launch({
  browser: browserName,
  executablePath,
  headless: true,
  protocolTimeout: 3_600_000,
  ...(browserName === "firefox"
    ? { extraPrefsFirefox: { "browser.download.dir": downloads, "browser.download.folderList": 2, "browser.download.useDownloadDir": true, "browser.helperApps.neverAsk.saveToDisk": "application/zip" } }
    : {}),
});
const problems = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => ["error", "warn"].includes(msg.type()) && problems.push(`console ${msg.type()}: ${msg.text()}`));
  if (browserName === "chrome") {
    const session = await page.createCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  }

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !document.getElementById("apworld").disabled, { timeout: 60_000 });
  await (await page.$("#apworld")).uploadFile(apworldPath);
  await page.waitForFunction(() => !document.getElementById("options").hidden || !document.getElementById("inspect-error").hidden, { timeout: 120_000 });
  const inspected = await page.evaluate(() => ({ status: document.getElementById("message").textContent, world: document.getElementById("world").innerText, error: document.getElementById("inspect-error").hidden ? null : document.getElementById("inspect-error").textContent.slice(0, 500) }));
  console.log(`[${seconds()}s] inspected: ${JSON.stringify(inspected)}`);
  if (inspected.error) throw new Error("inspection failed");
  await page.screenshot({ path: join(outDir, `${browserName}-options.png`), fullPage: true });

  // Quick preset, then keep only the wanted variants at their counts.
  await page.evaluate(() => [...document.querySelectorAll(".segmented button")].find((b) => b.textContent === "Quick").click());
  const presetRuns = await page.evaluate(() => [...document.querySelectorAll(".variants tbody tr")].map((tr) => tr.querySelector('input[type="number"]').value));
  console.log(`[${seconds()}s] Quick preset run counts: ${presetRuns.join(",")}`);
  await page.evaluate((wanted, jobs, unitTests) => {
    const unitBox = document.querySelector("#options label.check input");
    if (unitBox.checked !== unitTests) unitBox.click();
    for (const tr of document.querySelectorAll(".variants tbody tr")) {
      const name = tr.querySelector(".variant-name").textContent;
      const box = tr.querySelector('input[type="checkbox"]');
      const runs = tr.querySelector('input[type="number"]');
      if (box.disabled) continue;
      if (box.checked !== name in wanted) box.click();
      if (name in wanted) {
        runs.value = wanted[name];
        runs.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    const workers = document.querySelector(".option-row input");
    workers.value = jobs;
    workers.dispatchEvent(new Event("change", { bubbles: true }));
  }, wanted, Number(jobs), unitTests);
  await page.click('#options button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById("run").hidden, { timeout: 30_000 });

  // Mid-run: a snapshot of the section lines, and an expanded completed unit-test section if it's done.
  await page.waitForFunction(() => /passed|failed|crashed/.test(document.querySelector(".section .counts")?.textContent ?? ""), { timeout: 600_000 });
  const midRun = await page.evaluate(() => [...document.querySelectorAll(".section > summary, .fuzz-status")].map((s) => s.innerText.replace(/\s+/g, " ").trim()));
  console.log(`[${seconds()}s] after unit tests: ${JSON.stringify(midRun)}`);
  await page.evaluate(() => {
    const unit = document.querySelector(".section");
    unit.open = true;
    const failing = unit.querySelector(".group.has-failures");
    if (failing) failing.open = true;
  });
  await page.screenshot({ path: join(outDir, `${browserName}-running.png`), fullPage: true });

  await page.waitForFunction(() => !document.getElementById("summary").hidden, { timeout: 3_000_000 });
  const finished = await page.evaluate(() => ({
    summary: document.getElementById("summary-text").textContent,
    status: document.getElementById("message").textContent,
    sections: [...document.querySelectorAll(".section > summary, .fuzz-status")].map((s) => s.innerText.replace(/\s+/g, " ").trim()),
    stopDisabled: document.getElementById("stop").disabled,
  }));
  console.log(`[${seconds()}s] finished: ${JSON.stringify(finished, null, 1)}`);

  // Open every failing error class and its first run, as a person would to read the log.
  await page.evaluate(() => {
    for (const section of document.querySelectorAll(".section")) {
      for (const group of section.querySelectorAll(".group.has-failures")) group.open = true;
    }
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.querySelectorAll(".runs .run").forEach((run, i) => i < 1 && (run.open = true)));
  await page.screenshot({ path: join(outDir, `${browserName}-done-light.png`), fullPage: true });
  await page.evaluate(() => document.querySelector('[data-set="dark"]').click());
  await page.screenshot({ path: join(outDir, `${browserName}-done-dark.png`), fullPage: true });
  await page.evaluate(() => document.querySelector('[data-set="system"]').click());

  await page.click("#save");
  for (let i = 0; i < 40 && !readdirSync(downloads).some((f) => f.endsWith(".zip")); i++) await new Promise((r) => setTimeout(r, 250));
  const saved = readdirSync(downloads).filter((f) => f.endsWith(".zip")).map((f) => `${f} (${statSync(join(downloads, f)).size} bytes)`);
  console.log(`[${seconds()}s] downloaded: ${JSON.stringify(saved)}`);
} catch (err) {
  problems.push(`check failed: ${err.stack ?? err}`);
} finally {
  console.log(`problems: ${JSON.stringify(problems, null, 1)}`);
  await browser.close();
}
