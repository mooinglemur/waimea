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
// - Boot failures: a browser can refuse to start a worker, usually under memory pressure after many restarts.
//   A slot retries with a growing delay; if it keeps failing, that slot retires and the others carry on. The
//   variant ends when the last slot is gone, keeping the runs that finished, with `error` saying why.
// - Paired workers (check-determinism): natively the hook starts a child process per pool worker and blocks
//   on it. Here each worker gets a partner running in the "regenerator" role; a run pauses with a regenerate
//   request, which is passed to the partner, and resumes with its response. The timeout covers both, as
//   fuzz.py's timer covers after_generate. A partner's fatal error becomes the child's error reply, which the
//   hook reports as a failure.

// How often a slot retries a worker that failed to start, and how long it waits between tries. The delays grow
// because the usual cause is memory pressure, which needs time to ease after the failed worker is discarded.
export const BOOT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

export const TIMEOUT_KEY = "<class 'TimeoutError'>";
export const FATAL_KEY =
  "Fatal error in the browser's Python interpreter (often a JavaScript stack overflow; may pass natively)";

/**
 * @param {object} options
 * @param {(handlers: {onMessage: (m: object) => void, onError: (text: string) => void}) => {post: (m: object) => void, terminate: () => void}} options.spawn
 * @param {object} options.init       the init message for each worker, less its type
 * @param {string} options.apworld    apworld module name, the key fuzz.py's report uses
 * @param {number} options.runs
 * @param {number} options.jobs       workers, or worker pairs when paired
 * @param {boolean} [options.paired]  give each worker a regenerating partner (check-determinism)
 * @param {number} options.timeoutSeconds  0 for none
 * @param {number} options.heapLimitBytes  0 for none
 * @param {string} options.seed
 * @param {(i: number) => number} [options.generationSeed]  pins run i's generation seed (calibration)
 * @param {number[]} [options.bootRetryDelays]  waits between retries of a worker that wouldn't start
 * @param {(progress: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]  aborting ends the variant with the runs completed so far
 * @returns {Promise<{report: object, files: Record<string, string>, counters: object, game: string | null,
 *   durations: {i: number, outcome: string, seconds: number}[]}>}  durations: generation time of each run
 *   that finished in its worker (not timeouts or fatal errors)
 */
export function runVariant({ spawn, init, apworld, runs, jobs, paired = false, timeoutSeconds, heapLimitBytes, seed, generationSeed, bootRetryDelays = BOOT_RETRY_DELAYS, onProgress = () => {}, signal }) {
  return new Promise((resolve, reject) => {
    const stats = { success: 0, failure: 0, timeout: 0, ignored: 0 };
    const errors = {};
    const files = {};
    const counters = { restarts: 0, heapRestarts: 0, timeouts: 0, fatal: 0, regeneratorFatal: 0, bootFailures: 0, retiredSlots: 0, bootSeconds: [] };
    const durations = [];
    const slots = [];
    let next = 0;
    let completed = 0;
    let finished = false;
    let game = null;
    let endedEarly = null;

    const stopSlot = (slot) => {
      clearTimeout(slot.timer);
      clearTimeout(slot.bootTimer);
      slot.worker?.terminate();
      slot.worker = null;
      slot.partner?.worker?.terminate();
      if (slot.partner) slot.partner.worker = null;
    };

    const finish = (error) => {
      if (finished) return;
      finished = true;
      for (const slot of slots) stopSlot(slot);
      // Only a variant that produced nothing rejects: with runs completed, the caller gets them and the reason
      // it stopped, so hours of fuzzing aren't lost to one worker the browser wouldn't start.
      if (error && !completed) {
        reject(error);
        return;
      }
      const report = { stats: { total: completed, ...stats }, errors };
      files["fuzz_output/report.json"] = JSON.stringify(report);
      resolve({ report, files, counters, game, durations, aborted: Boolean(signal?.aborted), error: error?.message ?? null });
    };

    // A slot that can't get a worker retires; the variant ends when the last one does.
    const retire = (slot, error) => {
      stopSlot(slot);
      slot.state = "done";
      counters.retiredSlots++;
      endedEarly ??= error;
      if (slots.every((s) => s.state === "done")) finish(next < runs || completed < runs ? endedEarly : null);
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

    // The browser wouldn't start, or immediately lost, this worker. Wait and try again; give up on this slot
    // after BOOT_RETRY_DELAYS is exhausted.
    function retryBoot(slot, what, text) {
      counters.bootFailures++;
      slot.worker?.terminate();
      slot.worker = null;
      slot.partner?.worker?.terminate();
      if (slot.partner) slot.partner.worker = null;
      const delay = bootRetryDelays[slot.bootFailures++];
      if (delay === undefined) {
        retire(slot, new Error(`${what} failed to start ${slot.bootFailures} times in a row; the browser may be out of memory:\n${text}`));
        return;
      }
      slot.state = "booting";
      slot.bootTimer = setTimeout(() => {
        if (finished || slot.state === "done") return;
        start(slot);
        if (slot.partner) startPartner(slot);
      }, delay);
    }

    function startPartner(slot) {
      const partner = slot.partner;
      const worker = spawn({
        onMessage: (message) => partner.worker === worker && onPartnerMessage(slot, message),
        onError: (text) => partner.worker === worker && onPartnerCrash(slot, text),
      });
      partner.worker = worker;
      partner.state = "booting";
      worker.post({ type: "init", ...init, role: "regenerator" });
    }

    function replace(slot) {
      clearTimeout(slot.timer);
      slot.worker?.terminate();
      slot.worker = null;
      counters.restarts++;
      // A partner regenerating for the lost run is as good as lost too.
      if (slot.partner?.state === "busy") replacePartner(slot);
      if (!finished) start(slot);
    }

    function replacePartner(slot) {
      slot.partner.worker?.terminate();
      slot.partner.worker = null;
      counters.restarts++;
      if (!finished) startPartner(slot);
    }

    // Starts the next run once the worker, and its partner if paired, are both idle.
    function dispatch(slot) {
      if (finished || slot.state !== "idle") return;
      if (signal?.aborted || next >= runs) {
        stopSlot(slot);
        slot.state = "done";
        if (slots.every((s) => s.state === "done")) finish();
        return;
      }
      if (slot.partner && slot.partner.state !== "idle") return;
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
      if (finished || slot.state === "done") return;
      clearTimeout(slot.timer);
      if (slot.state === "booting") {
        retryBoot(slot, "A fuzz worker", text);
        return;
      }
      if (slot.state === "reclassifying") {
        // The worker that would have asked the hooks about the timeout died. Count it as fuzz.py's plain
        // timeout and carry on, rather than losing the variant.
        const { i, yamls } = slot.pendingTimeout;
        slot.pendingTimeout = null;
        counters.reclassifyFailures = (counters.reclassifyFailures ?? 0) + 1;
        addDump("timeout", i, { ...yamls, [`${i}.log`]: `[...] Generation killed here after ${timeoutSeconds}s` });
        addError(TIMEOUT_KEY, i);
        record("timeout");
        replace(slot);
        return;
      }
      if (slot.state === "preparing" || slot.state === "generating" || slot.state === "regenerating") {
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
          slot.bootFailures = 0;
          counters.bootSeconds.push(+message.seconds.toFixed(2));
          if (slot.pendingTimeout) {
            slot.state = "reclassifying";
            slot.worker.post({ type: "timeoutOutcome" });
          } else {
            slot.state = "idle";
            dispatch(slot);
          }
          break;
        case "started":
          slot.yamls = message.yamls;
          slot.state = "generating";
          if (timeoutSeconds > 0) slot.timer = setTimeout(() => onTimeout(slot), timeoutSeconds * 1000);
          break;
        case "regenerate":
          if (!slot.partner) {
            onCrash(slot, "A hook asked for a regenerating worker, but this variant has none");
            break;
          }
          slot.state = "regenerating";
          slot.partner.state = "busy";
          slot.partner.worker.post({ type: "regenerate", request: message.request });
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
            slot.state = "idle";
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
          slot.state = "idle";
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

    // Hands a partner's response back to its worker, if that worker is still waiting for it.
    function answer(slot, response) {
      if (slot.state !== "regenerating") return;
      slot.state = "generating";
      slot.worker.post({ type: "resume", response });
    }

    function onPartnerCrash(slot, text) {
      if (finished || slot.state === "done") return;
      const partner = slot.partner;
      if (partner.state === "booting") {
        retryBoot(slot, "A regenerating worker", text);
        return;
      }
      if (partner.state === "busy") {
        counters.regeneratorFatal++;
        answer(slot, { status: "error", text: `Fatal error in the regenerating worker's Python interpreter:\n${text}` });
      }
      replacePartner(slot);
    }

    function onPartnerMessage(slot, message) {
      if (finished) return;
      const partner = slot.partner;
      switch (message.type) {
        case "ready":
          counters.bootSeconds.push(+message.seconds.toFixed(2));
          partner.state = "idle";
          dispatch(slot);
          break;
        case "regenerated":
          partner.state = "idle";
          answer(slot, message.response);
          if (heapLimitBytes > 0 && message.heapBytes > heapLimitBytes) {
            counters.heapRestarts++;
            replacePartner(slot);
          }
          break;
        case "fatal":
          onPartnerCrash(slot, message.text);
          break;
        case "setupError":
          retire(slot, new Error(`Regenerating worker setup failed:\n${message.text}`));
          break;
      }
    }

    signal?.addEventListener("abort", () => {
      for (const slot of slots) {
        if (slot.state !== "done") {
          stopSlot(slot);
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
      const slot = { worker: null, state: "idle", i: null, yamls: null, timer: null, bootTimer: null, bootFailures: 0, pendingTimeout: null, partner: paired ? { worker: null, state: "idle" } : null };
      slots.push(slot);
      start(slot);
      if (slot.partner) startPartner(slot);
    }
  });
}
