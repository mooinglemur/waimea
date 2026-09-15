// The page: choose an apworld, set options, run the session, watch it, and save the report.

import { append, dot, formatSeconds, h, setDot } from "./dom.mjs";
import { FuzzVariantView } from "./fuzz-view.mjs";
import { CI_TIMEOUT_SECONDS, VARIANTS } from "./fuzz-variants.mjs";
import { buildReport } from "./report.mjs";
import { PRESETS, applyPreset, defaultPlan, inspectApworld, pairedJobs, runSession } from "./session.mjs";
import { UnitTestsView } from "./unit-view.mjs";
import { createZip } from "./zip.mjs";

const $ = (id) => document.getElementById(id);

const state = {
  manifest: null,
  core: null,
  file: null,
  apworldBytes: null,
  info: null,
  plan: null,
  running: false,
  controller: null,
  record: null,
  report: null,
};

function setStatus(marker, text) {
  setDot($("state"), marker);
  $("message").textContent = text;
}

const spawner = (script) => ({ onMessage, onError }) => {
  const worker = new Worker(script, { type: "module" });
  worker.onmessage = (event) => onMessage(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    // A worker the browser refused to start, or discarded, reports an event with no message at all.
    const where = event.filename ? ` (${event.filename}:${event.lineno})` : "";
    onError(event.message
      ? `worker error: ${event.message}${where}`
      : `the browser stopped the worker without an error${where}; it may be short of memory`);
  };
  return { post: (message) => worker.postMessage(message), terminate: () => worker.terminate() };
};

async function fetchOk(url, as) {
  const response = await fetch(url, { cache: as === "json" ? "no-cache" : "default" });
  if (!response.ok) {
    const err = new Error(`${url}: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return as === "json" ? response.json() : response.arrayBuffer();
}

// During a rollout the manifest and the bundle it names can come from pods on different images, so a
// missing bundle is retried once with a fresh manifest.
async function loadRuntime() {
  for (let attempt = 0; ; attempt++) {
    const manifest = await fetchOk("/manifest.json", "json");
    try {
      const core = await fetchOk(manifest.core.url, "buffer");
      return { manifest, core };
    } catch (err) {
      if (err.status !== 404 || attempt > 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

// --- choosing an apworld ---

async function onFileChosen() {
  const file = $("apworld").files[0];
  if (!file || state.running) return;
  state.file = file;
  state.info = null;
  $("options").hidden = true;
  $("world").hidden = true;
  $("inspect-error").hidden = true;
  $("apworld").disabled = true;
  setStatus("running", `Checking ${file.name}…`);
  try {
    if (!state.core) Object.assign(state, await loadRuntime());
    state.apworldBytes = await file.arrayBuffer();
    const info = await inspectApworld({
      manifest: state.manifest,
      core: state.core,
      apworldBytes: state.apworldBytes,
      spawnTestWorker: spawner("/test-worker.mjs"),
      baseUrl: location.href,
    });
    if (!info.ok) {
      setStatus("fail", `${file.name} couldn't be loaded.`);
      $("inspect-error").textContent = [info.error, info.log].filter(Boolean).join("\n");
      $("inspect-error").hidden = false;
      return;
    }
    state.info = info;
    renderWorld(info);
    renderOptions();
    setStatus("", `${file.name} is ready to test.`);
  } catch (err) {
    setStatus("fail", `Couldn't check ${file.name}: ${err.message}`);
  } finally {
    $("apworld").disabled = state.running;
  }
}

function renderWorld(info) {
  const { manifest } = info;
  const rows = [
    ["Game", info.games.length === 1 ? info.games[0] : `${info.games.length} games`],
    ["Module", info.module],
    ["Version", info.version ?? "not set in archipelago.json (reported as 0.0.0)"],
    manifest?.authors?.length ? ["Authors", manifest.authors.join(", ")] : null,
    manifest?.minimum_ap_version ? ["Needs Archipelago", manifest.minimum_ap_version] : null,
  ].filter(Boolean);
  $("world").replaceChildren(h("dl", { class: "facts" }, rows.map(([term, value]) => [h("dt", {}, term), h("dd", {}, value)])));
  $("world").hidden = false;
}

// --- options ---

function renderOptions() {
  const previous = state.plan;
  const plan = defaultPlan(navigator.hardwareConcurrency);
  if (previous) {
    // Keep choices across a rerun or a different file.
    Object.assign(plan, { unitTests: previous.unitTests, jobs: previous.jobs, halvePairedJobs: previous.halvePairedJobs, preset: previous.preset });
    plan.variants = previous.variants.map((v) => ({ ...v }));
  }
  state.plan = plan;
  const form = $("options");
  const cores = navigator.hardwareConcurrency || 2;

  const gamePicker =
    state.info.games.length > 1
      ? h("label", {}, "Game ", h("select", { id: "game" }, state.info.games.map((g) => h("option", { value: g }, g))))
      : null;

  const presetButtons = PRESETS.map((preset) =>
    h("button", {
      type: "button",
      "aria-pressed": String(plan.preset === preset.id),
      title: preset.description,
      onclick: (e) => {
        applyPreset(plan, preset.id);
        for (const button of presetButtons) button.setAttribute("aria-pressed", String(button === e.currentTarget));
        for (const entry of plan.variants) runInputs.get(entry.name).value = entry.runs;
      },
    }, preset.label),
  );

  // A paired variant (check-determinism) runs two interpreters per worker, so it can use the worker count as
  // pairs, at twice the memory, or halve it. Only one pair is possible with one worker.
  const pairsLabel = (count) => `${count} worker ${count === 1 ? "pair" : "pairs"}`;
  const fullPairs = h("input", { type: "radio", name: "paired-jobs", onchange: () => { plan.halvePairedJobs = false; syncPaired(); } });
  const halfPairs = h("input", { type: "radio", name: "paired-jobs", onchange: () => { plan.halvePairedJobs = true; syncPaired(); } });
  const fullPairsText = h("span", {});
  const halfPairsText = h("span", {});
  const syncPaired = () => {
    if (plan.jobs < 2) plan.halvePairedJobs = false;
    halfPairs.disabled = plan.jobs < 2;
    fullPairs.checked = !plan.halvePairedJobs;
    halfPairs.checked = plan.halvePairedJobs;
    fullPairsText.textContent = `${pairsLabel(plan.jobs)}, uses the same amount of CPU and twice the RAM`;
    halfPairsText.textContent = `${pairsLabel(pairedJobs({ jobs: plan.jobs, halvePairedJobs: true }))}, uses half the CPU, and the same amount of RAM`;
  };
  syncPaired();

  // Header checkbox: on when every selectable variant is on, indeterminate when only some are.
  const selectable = VARIANTS.filter((v) => !v.unsupported);
  const enableInputs = new Map();
  const selectAll = h("input", {
    type: "checkbox",
    "aria-label": "Run every variant",
    onchange: (e) => {
      for (const variant of selectable) {
        const entry = plan.variants.find((v) => v.name === variant.name);
        entry.enabled = e.target.checked;
        enableInputs.get(variant.name).checked = entry.enabled;
      }
      syncSelectAll();
    },
  });
  const syncSelectAll = () => {
    const on = selectable.filter((v) => plan.variants.find((e) => e.name === v.name).enabled).length;
    selectAll.checked = on === selectable.length;
    selectAll.indeterminate = on > 0 && on < selectable.length;
  };

  const runInputs = new Map();
  const rows = VARIANTS.map((variant) => {
    const entry = plan.variants.find((v) => v.name === variant.name);
    const enabled = h("input", {
      type: "checkbox",
      checked: entry.enabled,
      disabled: Boolean(variant.unsupported),
      "aria-label": `Run ${variant.name}`,
      onchange: (e) => {
        entry.enabled = e.target.checked;
        syncSelectAll();
      },
    });
    enableInputs.set(variant.name, enabled);
    const runs = h("input", {
      type: "number",
      min: 1,
      max: 100000,
      value: entry.runs,
      disabled: Boolean(variant.unsupported),
      "aria-label": `${variant.name} runs`,
      oninput: (e) => {
        entry.runs = Math.max(1, Math.floor(Number(e.target.value) || 1));
        // An edited count no longer matches a preset.
        for (const button of presetButtons) button.setAttribute("aria-pressed", "false");
        plan.preset = null;
      },
    });
    runInputs.set(variant.name, runs);
    return h(
      "tr",
      { class: variant.unsupported ? "unsupported" : "" },
      h("td", {}, enabled),
      h("td", {},
        h("div", { class: "variant-name" }, variant.name),
        h("div", { class: "hint" }, variant.unsupported ?? variant.description),
        variant.paired
          ? h("div", { class: "variant-option", role: "radiogroup", "aria-label": "Workers for check-determinism" },
              h("div", {}, `${variant.name} requires a pair of workers for each run`),
              h("label", {}, fullPairs, fullPairsText),
              h("label", {}, halfPairs, halfPairsText))
          : null),
      h("td", { class: "runs-cell" }, runs),
    );
  });
  syncSelectAll();

  form.replaceChildren();
  // append() skips the game picker when there's only one game.
  append(form, [
    h("h2", {}, "Tests to run"),
    gamePicker,
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: plan.unitTests, onchange: (e) => (plan.unitTests = e.target.checked) }), " Unit tests: the WorldTestBase battery and Archipelago's test/general"),
    h("div", { class: "fuzz-head" }, h("h3", {}, "Fuzz variants"), h("div", { class: "segmented", role: "group", "aria-label": "Run-count preset" }, h("span", { class: "hint" }, "Run counts"), presetButtons)),
    h("p", { class: "hint" },
      `CI runs 5000 generations for the first two variants and 500 for the rest. Many apworlds finish those in minutes; heavy ones can take hours in a browser, which Quick is for. `,
      `Generations time out after CI's ${CI_TIMEOUT_SECONDS} seconds, scaled by how fast this browser is compared with CI's runner, measured before fuzzing starts.`),
    h("table", { class: "variants" }, h("thead", {}, h("tr", {}, h("th", {}, selectAll), h("th", {}, "Variant"), h("th", { class: "runs-cell" }, "Runs"))), h("tbody", {}, rows)),
    h("div", { class: "option-row" },
      h("label", {}, "Workers ", h("input", { type: "number", min: 1, max: cores, value: plan.jobs, onchange: (e) => { plan.jobs = Math.min(cores, Math.max(1, Math.floor(Number(e.target.value) || 1))); syncPaired(); } })),
      h("span", { class: "hint" }, `Each worker is a Python interpreter using a few hundred MB. This device reports ${cores} cores.`)),
    h("details", { class: "extra-files" },
      h("summary", {}, "Optional files"),
      h("label", {}, "Expected-failure annotations (TOML) ", h("input", { id: "annotations", type: "file", accept: ".toml" })),
      h("p", { class: "hint" }, "The index's per-world annotations, which mark known failures as expected."),
      h("label", {}, "Fuzz meta (YAML) ", h("input", { id: "meta", type: "file", accept: ".yaml,.yml" })),
      h("p", { class: "hint" }, "Option overrides and constraints for generated YAMLs, as in the index's fuzz-meta.")),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Start")),
  ]);
  form.hidden = false;
}

// --- running ---

function warnBeforeLeaving(event) {
  event.preventDefault();
  event.returnValue = "";
}

async function onStart(event) {
  event.preventDefault();
  if (state.running || !state.info) return;
  const plan = state.plan;
  plan.seed = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  plan.annotations = (await $("annotations")?.files[0]?.text()) ?? null;
  plan.metaYaml = (await $("meta")?.files[0]?.text()) ?? null;
  const game = $("game")?.value ?? state.info.games[0];
  const world = { module: state.info.module, version: state.info.version, game };

  state.running = true;
  state.controller = new AbortController();
  state.record = null;
  window.addEventListener("beforeunload", warnBeforeLeaving);
  $("options").hidden = true;
  $("summary").hidden = true;
  $("apworld").disabled = true;
  $("stop").disabled = false;
  $("stop").hidden = false;
  $("stop").textContent = "Stop";
  $("run").hidden = false;
  setStatus("running", `Testing ${state.file.name}…`);

  const unitView = new UnitTestsView();
  const fuzzHeader = h("div", { class: "fuzz-status" }, dot(), h("span", {}, "Fuzzing waits for the unit tests."));
  const fuzzViews = new Map(VARIANTS.map((v) => [v.name, new FuzzVariantView(v)]));
  const sections = [];
  if (plan.unitTests) sections.push(unitView.element);
  const selected = plan.variants.filter((v) => v.enabled && !VARIANTS.find((d) => d.name === v.name).unsupported);
  if (selected.length) sections.push(fuzzHeader);
  for (const variant of VARIANTS) {
    const entry = plan.variants.find((v) => v.name === variant.name);
    const view = fuzzViews.get(variant.name);
    if (entry.enabled && !variant.unsupported) view.queue(entry.runs);
    else view.skip(variant.unsupported ?? "not selected");
    sections.push(view.element);
  }
  $("sections").replaceChildren(...sections);

  const setFuzzStatus = (marker, text) => {
    setDot(fuzzHeader.firstChild, marker);
    fuzzHeader.lastChild.textContent = text;
  };
  let timeoutSeconds = CI_TIMEOUT_SECONDS;

  try {
    state.record = await runSession({
      manifest: state.manifest,
      core: state.core,
      apworldBytes: state.apworldBytes,
      world,
      plan,
      spawnTestWorker: spawner("/test-worker.mjs"),
      spawnFuzzWorker: spawner("/fuzz-worker.mjs"),
      baseUrl: location.href,
      signal: state.controller.signal,
      onEvent: (e) => {
        switch (e.type) {
          case "unitTestsStart": return unitView.start();
          case "unitTestEvents": return unitView.handle(e.events);
          case "unitTestsDone": return unitView.finish(e.unitTests);
          case "calibrating": return setFuzzStatus("running", "Measuring this browser's speed to set the timeout…");
          case "calibrated":
            timeoutSeconds = e.timeoutSeconds;
            return setFuzzStatus(e.error ? "fail" : "pass", e.error
              ? `Couldn't measure this browser's speed, so CI's ${CI_TIMEOUT_SECONDS} s timeout applies. (${e.error.split("\n")[0]})`
              : `Timeout: ${e.timeoutSeconds} s per generation (CI's ${CI_TIMEOUT_SECONDS} s × ${e.calibration.factor.toFixed(2)} for this browser).`);
          case "fuzzStart": return fuzzViews.get(e.variant).start(e.runs);
          case "fuzzProgress": return fuzzViews.get(e.variant).progress(e.progress);
          case "fuzzDone": return fuzzViews.get(e.variant).done(e, world.module, timeoutSeconds);
        }
      },
    });
    finishRun();
  } catch (err) {
    setStatus("fail", `The run failed: ${err.message}`);
  } finally {
    state.running = false;
    window.removeEventListener("beforeunload", warnBeforeLeaving);
    $("stop").hidden = true;
    $("apworld").disabled = false;
  }
}

function finishRun() {
  const { record } = state;
  state.report = buildReport({ manifest: state.manifest, record, userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency });
  const parts = [];
  let failed = false;
  if (record.unitTests) {
    const { status } = record.unitTests;
    if (status === 0) parts.push("unit tests passed");
    else {
      failed = true;
      parts.push(status === "crash" ? "the unit tests crashed" : status === "stopped" ? "the unit tests were stopped" : "unit tests failed");
    }
  }
  const ran = record.fuzz.filter((entry) => entry.result);
  const withFailures = ran.filter((entry) => entry.result.report.stats.failure > 0);
  const broken = record.fuzz.filter((entry) => entry.error);
  // Timeouts aren't failures, but a variant that only timed out isn't a clean pass either.
  const timedOut = ran.filter((entry) => {
    const { report, counters } = entry.result;
    return report.stats.failure === 0 && Math.max(counters.timeouts ?? 0, report.stats.timeout) > 0;
  });
  let warned = false;
  if (ran.length || broken.length) {
    failed ||= withFailures.length > 0 || broken.length > 0;
    warned ||= timedOut.length > 0;
    parts.push(`${withFailures.length} of ${ran.length + broken.length} fuzz variants had failures${broken.length ? ` (${broken.length} couldn't run)` : ""}`);
    if (timedOut.length) parts.push(`${timedOut.length} timed out without failing`);
  }
  const elapsed = formatSeconds((new Date(record.finishedAt) - new Date(record.startedAt)) / 1000);
  const summary = parts.length ? `${parts[0][0].toUpperCase()}${parts.join("; ").slice(1)}.` : "Nothing was selected to run.";
  $("summary-text").textContent = `${record.aborted ? "Stopped early. " : ""}${summary} Took ${elapsed}.`;
  $("summary").hidden = false;
  setStatus(record.aborted ? "" : failed ? "fail" : warned ? "warn" : "pass", record.aborted ? `Stopped testing ${state.file.name}.` : `Finished testing ${state.file.name}.`);
}

async function onSave() {
  if (!state.report) return;
  const zip = await createZip(state.report.files);
  const { module, version } = state.record.world;
  const stamp = state.record.startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const link = h("a", { href: url, download: `waimea-${module}-${version}-${stamp}.zip`, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// --- startup ---

$("apworld").addEventListener("change", onFileChosen);
$("options").addEventListener("submit", onStart);
$("stop").addEventListener("click", () => {
  state.controller?.abort();
  $("stop").disabled = true;
  $("stop").textContent = "Stopping…";
});
$("save").addEventListener("click", onSave);
$("again").addEventListener("click", () => {
  $("summary").hidden = true;
  renderOptions();
  $("options").scrollIntoView({ behavior: "smooth" });
});

setStatus("running", "Loading the test runtime…");
try {
  state.manifest = await fetchOk("/manifest.json", "json");
  const { archipelago, pyodide, site } = state.manifest;
  // Set by the server's WAIMEA_SITE_NAME.
  if (site?.name) {
    document.querySelector(".brand").textContent = site.name;
    document.title = site.name;
  }
  $("version").textContent = `waimea · Archipelago ${archipelago.version} (${archipelago.repository}@${archipelago.commit.slice(0, 7)}) · Pyodide ${pyodide.version}`;
  $("apworld").disabled = false;
  setStatus("", "Choose an apworld file to see the tests that will run.");
} catch (err) {
  setStatus("fail", `Couldn't load the test runtime: ${err.message}`);
}
