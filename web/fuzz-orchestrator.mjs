// Schedules one fuzz variant's generations across Pyodide workers, as fuzz.py's process pool does
// natively, and builds its report. It doesn't depend on the environment: the caller's spawn() starts a
// worker running web/fuzz-worker.mjs (a browser Worker, or worker_threads under Node).
//
// Differences from fuzz.py, all forced by having no processes or threads:
// - Timeouts: a generation past the timeout has its worker terminated. A fresh worker boots and asks the
//   main-process hooks to reclassify the timeout, as fuzz.py's timeout handler does. The killed run's
//   partial output is lost, so its log holds only the timeout line.
// - Memory: a worker whose wasm heap passes heapLimitBytes after a run is replaced, since wasm memory is
//   never returned.
// - Fatal errors: a worker whose interpreter fails (often a JavaScript stack overflow) counts a failure
//   under FATAL_KEY and is replaced. fuzz.py counts a crashed pool worker as a failure too.
// - Seeds: run i's YAMLs come from random.seed(`${seed}-${i}`), so a run can be reproduced.

export const TIMEOUT_KEY = "<class 'TimeoutError'>";
export const FATAL_KEY =
  "Fatal error in the browser's Python interpreter (often a JavaScript stack overflow; may pass natively)";

/**
 * @param {object} options
 * @param {(handlers: {onMessage: (m: object) => void, onError: (text: string) => void}) => {post: (m: object) => void, terminate: () => void}} options.spawn
 * @param {object} options.init       the init message for each worker, less its type
 * @param {string} options.apworld    apworld module name, the key fuzz.py's report uses
 * @param {number} options.runs
 * @param {number} options.jobs
 * @param {number} options.timeoutSeconds  0 for none
 * @param {number} options.heapLimitBytes  0 for none
 * @param {string} options.seed
 * @param {(i: number) => number} [options.generationSeed]  pins run i's generation seed (calibration)
 * @param {(progress: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]  aborting ends the variant with the runs completed so far
 * @returns {Promise<{report: object, files: Record<string, string>, counters: object, game: string | null,
 *   durations: {i: number, outcome: string, seconds: number}[]}>}  durations: generation time of each run
 *   that finished in its worker (not timeouts or fatal errors)
 */
export function runVariant({ spawn, init, apworld, runs, jobs, timeoutSeconds, heapLimitBytes, seed, generationSeed, onProgress = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    const stats = { success: 0, failure: 0, timeout: 0, ignored: 0 };
    const errors = {};
    const files = {};
    const counters = { restarts: 0, heapRestarts: 0, timeouts: 0, fatal: 0, bootSeconds: [] };
    const durations = [];
    const slots = [];
    let next = 0;
    let completed = 0;
    let finished = false;
    let game = null;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      for (const slot of slots) {
        clearTimeout(slot.timer);
        slot.worker?.terminate();
        slot.worker = null;
      }
      if (error) {
        reject(error);
        return;
      }
      const report = { stats: { total: completed, ...stats }, errors };
      files["fuzz_output/report.json"] = JSON.stringify(report);
      resolve({ report, files, counters, game, durations, aborted: Boolean(signal?.aborted) });
    };

    const addError = (key, i) => {
      errors[apworld] ??= {};
      (errors[apworld][key] ??= []).push(i);
    };
    // dump_generation_output's layout: fuzz_output/<error|timeout|ignored>/<apworld>/<run>/
    const addDump = (kind, i, dumpFiles) => {
      for (const [name, text] of Object.entries(dumpFiles)) files[`fuzz_output/${kind}/${apworld}/${i}/${name}`] = text;
    };
    const record = (outcome) => {
      stats[outcome]++;
      completed++;
      onProgress({ completed, runs, stats: { ...stats }, counters: { ...counters, bootSeconds: undefined } });
    };

    function start(slot) {
      const worker = spawn({
        onMessage: (message) => slot.worker === worker && onMessage(slot, message),
        onError: (text) => slot.worker === worker && onCrash(slot, text),
      });
      slot.worker = worker;
      slot.state = "booting";
      worker.post({ type: "init", ...init });
    }

    function replace(slot) {
      clearTimeout(slot.timer);
      slot.worker?.terminate();
      slot.worker = null;
      counters.restarts++;
      if (!finished) start(slot);
    }

    function dispatch(slot) {
      if (finished) return;
      if (signal?.aborted || next >= runs) {
        slot.worker?.terminate();
        slot.worker = null;
        slot.state = "done";
        if (slots.every((s) => s.state === "done")) finish();
        return;
      }
      slot.i = next++;
      slot.yamls = null;
      slot.state = "preparing";
      slot.worker.post({ type: "run", i: slot.i, seed: `${seed}-${slot.i}`, generationSeed: generationSeed?.(slot.i) });
    }

    function onTimeout(slot) {
      counters.timeouts++;
      slot.pendingTimeout = { i: slot.i, yamls: slot.yamls ?? {} };
      replace(slot);
    }

    function onCrash(slot, text) {
      if (finished) return;
      clearTimeout(slot.timer);
      if (slot.state === "booting" || slot.state === "reclassifying") {
        finish(new Error(`A fuzz worker failed while starting:\n${text}`));
        return;
      }
      if (slot.state === "preparing" || slot.state === "generating") {
        counters.fatal++;
        addError(FATAL_KEY, slot.i);
        addDump("error", slot.i, { ...(slot.yamls ?? {}), [`${slot.i}.log`]: text });
        record("failure");
      }
      replace(slot);
    }

    function onMessage(slot, message) {
      if (finished) return;
      switch (message.type) {
        case "ready":
          game = message.game;
          counters.bootSeconds.push(+message.seconds.toFixed(2));
          if (slot.pendingTimeout) {
            slot.state = "reclassifying";
            slot.worker.post({ type: "timeoutOutcome" });
          } else {
            dispatch(slot);
          }
          break;
        case "started":
          slot.yamls = message.yamls;
          slot.state = "generating";
          if (timeoutSeconds > 0) slot.timer = setTimeout(() => onTimeout(slot), timeoutSeconds * 1000);
          break;
        case "result":
          clearTimeout(slot.timer);
          if (message.key != null) addError(message.key, slot.i);
          if (message.dump) addDump(message.dump.kind, slot.i, message.dump.files);
          if (message.seconds != null) durations.push({ i: slot.i, outcome: message.outcome, seconds: message.seconds });
          record(message.outcome);
          if (heapLimitBytes > 0 && message.heapBytes > heapLimitBytes) {
            counters.heapRestarts++;
            replace(slot);
          } else {
            dispatch(slot);
          }
          break;
        case "timeoutOutcome": {
          // As fuzz.py's timeout handler: dump unless reclassified as a success, then count. With no
          // exception, a failure is keyed "None".
          const { i, yamls } = slot.pendingTimeout;
          slot.pendingTimeout = null;
          const outcome = message.outcome;
          if (outcome !== "success") {
            const kind = { failure: "error", timeout: "timeout", ignored: "ignored" }[outcome];
            addDump(kind, i, { ...yamls, [`${i}.log`]: `[...] Generation killed here after ${timeoutSeconds}s` });
          }
          if (outcome === "timeout") addError(TIMEOUT_KEY, i);
          else if (outcome === "failure") addError("None", i);
          record(outcome);
          dispatch(slot);
          break;
        }
        case "fatal":
          onCrash(slot, message.text);
          break;
        case "setupError":
          finish(new Error(`Fuzz setup failed:\n${message.text}`));
          break;
        case "prepareError":
          // fuzz.py generates YAMLs in its main process, where an exception ends the whole run.
          finish(new Error(`YAML generation failed for run ${slot.i}:\n${message.text}`));
          break;
      }
    }

    signal?.addEventListener("abort", () => {
      for (const slot of slots) {
        if (slot.state !== "done") {
          clearTimeout(slot.timer);
          slot.worker?.terminate();
          slot.worker = null;
          slot.state = "done";
        }
      }
      finish();
    });

    if (runs <= 0) {
      finish();
      return;
    }
    for (let j = 0; j < Math.min(jobs, runs); j++) {
      const slot = { worker: null, state: "idle", i: null, yamls: null, timer: null, pendingTimeout: null };
      slots.push(slot);
      start(slot);
    }
  });
}
