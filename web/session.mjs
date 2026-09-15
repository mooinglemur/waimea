// Runs a whole test session in the page, reporting progress as events for the UI:
//   1. unit tests, in a test worker;
//   2. the fuzz timeout calibration, once;
//   3. each selected fuzz variant in turn, through the fuzz orchestrator.
// Returns the session record that report.mjs turns into the downloadable report.

import { calibrate, scaledTimeout } from "./calibration.mjs";
import { runVariant } from "./fuzz-orchestrator.mjs";
import { CI_RUNS, CI_TIMEOUT_SECONDS, VARIANTS } from "./fuzz-variants.mjs";

// Run-count presets the page offers as one control. CI's counts are the default: many apworlds fuzz within a
// couple of minutes in CI, so they finish here too. Heavy worlds can take hours, which Quick is for.
export const PRESETS = [
  { id: "ci", label: "CI", description: "The index CI's run counts", runs: CI_RUNS },
  { id: "quick", label: "Quick", description: "A tenth of the index CI's run counts", runs: { full: CI_RUNS.full / 10, check: CI_RUNS.check / 10 } },
];
export const DEFAULT_PRESET = "ci";
export const HEAP_LIMIT_BYTES = 1536 * 2 ** 20;

export const defaultJobs = (cores) => Math.max(1, Math.min(4, (cores || 2) - 1));

/** Sets every variant's run count from a preset. Which variants are enabled is left alone. */
export function applyPreset(plan, presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset ${presetId}`);
  for (const entry of plan.variants) {
    const variant = VARIANTS.find((v) => v.name === entry.name);
    entry.runs = preset.runs[variant.runs];
  }
  plan.preset = preset.id;
  return plan;
}

export function defaultPlan(cores) {
  return applyPreset({
    unitTests: true,
    jobs: defaultJobs(cores),
    variants: VARIANTS.map((v) => ({ name: v.name, enabled: !v.unsupported, runs: 0 })),
    annotations: null,
    metaYaml: null,
  }, DEFAULT_PRESET);
}

export const apquestPath = (manifest) => `/ap/supported_worlds/apquest-${manifest.archipelago.version}.apworld`;

function workerInit(manifest, core, baseUrl) {
  return {
    pyodideUrl: new URL(`${manifest.pyodide.base}pyodide.mjs`, baseUrl).href,
    indexURL: new URL(manifest.pyodide.base, baseUrl).href,
    core,
  };
}

// A test worker driven one request at a time.
function testWorker(spawn) {
  let pending = null;
  const settle = (fn, value) => {
    const request = pending;
    pending = null;
    request?.[fn](value);
  };
  const worker = spawn({
    onMessage: (message) => {
      if (!pending) return;
      if (message.type === "events") pending.onEvents?.(message.events);
      else if (message.type === "fatal" || message.type === "setupError") settle("reject", new Error(message.text));
      else settle("resolve", message);
    },
    onError: (text) => settle("reject", new Error(text)),
  });
  return {
    call(message, onEvents) {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, onEvents };
        worker.post(message);
      });
    },
    // Terminating a worker fires nothing, so a request in flight is rejected here.
    cancel(reason) {
      worker.terminate();
      settle("reject", new Error(reason));
    },
  };
}

/** Describes an apworld in a throwaway test worker: {ok, module, version, manifest, games} or {ok: false, error}. */
export async function inspectApworld({ manifest, core, apworldBytes, spawnTestWorker, baseUrl }) {
  const worker = testWorker(spawnTestWorker);
  try {
    await worker.call({ type: "init", ...workerInit(manifest, core, baseUrl), apworld: { bytes: apworldBytes } });
    return (await worker.call({ type: "inspect" })).info;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    worker.cancel("done");
  }
}

/**
 * @param {object} options
 * @param {object} options.manifest        /manifest.json
 * @param {ArrayBuffer} options.core       the core bundle
 * @param {ArrayBuffer} options.apworldBytes
 * @param {{module: string, version: string | null, game: string}} options.world  from inspectApworld
 * @param {object} options.plan            defaultPlan() as edited, plus seed
 * @param {Function} options.spawnTestWorker
 * @param {Function} options.spawnFuzzWorker
 * @param {string} options.baseUrl         the page's URL, to resolve runtime paths
 * @param {(event: object) => void} options.onEvent
 * @param {AbortSignal} [options.signal]   stops the session; what finished is kept
 */
export async function runSession({ manifest, core, apworldBytes, world, plan, spawnTestWorker, spawnFuzzWorker, baseUrl, onEvent, signal }) {
  const init = workerInit(manifest, core, baseUrl);
  const version = world.version ?? "0.0.0";
  const record = {
    startedAt: new Date().toISOString(),
    world: { ...world, version },
    plan: { ...plan, annotations: plan.annotations ? "(provided)" : null, metaYaml: plan.metaYaml ? "(provided)" : null },
    unitTests: null,
    calibration: null,
    calibrationError: null,
    ciTimeoutSeconds: CI_TIMEOUT_SECONDS,
    timeoutSeconds: CI_TIMEOUT_SECONDS,
    fuzz: [],
    aborted: false,
  };

  if (plan.unitTests && !signal?.aborted) {
    onEvent({ type: "unitTestsStart" });
    const worker = testWorker(spawnTestWorker);
    const stop = () => worker.cancel("stopped");
    signal?.addEventListener("abort", stop);
    try {
      await worker.call({ type: "init", ...init, apworld: { bytes: apworldBytes } });
      const done = await worker.call(
        { type: "unitTests", module: world.module, version, game: world.game, apquestPath: apquestPath(manifest), annotations: plan.annotations },
        (events) => onEvent({ type: "unitTestEvents", events }),
      );
      record.unitTests = { status: done.status, files: done.files };
    } catch (err) {
      record.unitTests = { status: signal?.aborted ? "stopped" : "crash", error: err.message, files: {} };
    } finally {
      signal?.removeEventListener("abort", stop);
      worker.cancel("done");
    }
    onEvent({ type: "unitTestsDone", unitTests: record.unitTests });
  }

  const selected = plan.variants.filter((v) => v.enabled && v.runs > 0 && !VARIANTS.find((d) => d.name === v.name)?.unsupported);
  if (selected.length && !signal?.aborted) {
    onEvent({ type: "calibrating" });
    try {
      record.calibration = await calibrate({ spawn: spawnFuzzWorker, init, jobs: plan.jobs, calibration: manifest.calibration, signal });
      record.timeoutSeconds = scaledTimeout(CI_TIMEOUT_SECONDS, record.calibration.factor);
    } catch (err) {
      // CI's own timeout is the fallback.
      record.calibrationError = err.message;
    }
    onEvent({ type: "calibrated", calibration: record.calibration, error: record.calibrationError, timeoutSeconds: record.timeoutSeconds });
  }

  for (const variant of VARIANTS) {
    const chosen = selected.find((v) => v.name === variant.name);
    if (!chosen) {
      const skipped = variant.unsupported ?? "not selected";
      record.fuzz.push({ variant: variant.name, skipped });
      continue;
    }
    if (signal?.aborted) {
      record.fuzz.push({ variant: variant.name, runs: chosen.runs, skipped: "stopped before it started" });
      onEvent({ type: "fuzzDone", variant: variant.name, skipped: "stopped before it started" });
      continue;
    }
    onEvent({ type: "fuzzStart", variant: variant.name, runs: chosen.runs });
    let entry;
    try {
      const result = await runVariant({
        spawn: spawnFuzzWorker,
        init: {
          ...init,
          apworld: { module: world.module, bytes: apworldBytes },
          config: {
            apworld: world.module,
            runs: chosen.runs,
            timeout: record.timeoutSeconds,
            hooks: variant.hook ? [variant.hook] : [],
            meta_yaml: plan.metaYaml ?? null,
          },
        },
        apworld: world.module,
        runs: chosen.runs,
        jobs: plan.jobs,
        timeoutSeconds: record.timeoutSeconds,
        heapLimitBytes: HEAP_LIMIT_BYTES,
        seed: `${plan.seed}-${variant.name}`,
        signal,
        onProgress: (progress) => onEvent({ type: "fuzzProgress", variant: variant.name, progress }),
      });
      entry = { variant: variant.name, runs: chosen.runs, result };
    } catch (err) {
      entry = { variant: variant.name, runs: chosen.runs, error: err.message };
    }
    record.fuzz.push(entry);
    onEvent({ type: "fuzzDone", ...entry });
  }

  record.aborted = Boolean(signal?.aborted);
  record.finishedAt = new Date().toISOString();
  onEvent({ type: "sessionDone", record });
  return record;
}
