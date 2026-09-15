import assert from "node:assert/strict";
import { test } from "node:test";
import { BOOT_RETRY_DELAYS, FATAL_KEY, TIMEOUT_KEY, runVariant } from "../web/fuzz-orchestrator.mjs";

// A fake worker speaking fuzz-worker.mjs's protocol. behavior(i) returns a result message's fields,
// "hang" (never answers after "started"), or "fatal".
function fakeSpawn(behavior, { timeoutOutcome = "timeout", heapBytes = 10 } = {}) {
  const log = { spawned: 0, terminated: 0 };
  const spawn = ({ onMessage }) => {
    log.spawned++;
    let alive = true;
    const send = (message) => setTimeout(() => alive && onMessage(message), 1);
    return {
      post(message) {
        if (message.type === "init") send({ type: "ready", game: "Fake", seconds: 0.01 });
        else if (message.type === "timeoutOutcome") send({ type: "timeoutOutcome", outcome: timeoutOutcome });
        else if (message.type === "run") {
          send({ type: "started", i: message.i, yamls: { [`${message.i}-0.yaml`]: "game: Fake\n" } });
          const outcome = behavior(message.i);
          if (outcome === "hang") return;
          if (outcome === "fatal") return send({ type: "fatal", text: "RangeError: Maximum call stack size exceeded" });
          send({ type: "result", outcome: "success", key: null, dump: null, seconds: 0.01, heapBytes, ...outcome });
        }
      },
      terminate() {
        alive = false;
        log.terminated++;
      },
    };
  };
  return { spawn, log };
}

const base = { init: {}, apworld: "fake", jobs: 2, timeoutSeconds: 0, heapLimitBytes: 0, seed: "test" };

test("successful runs are counted and timed", async () => {
  const { spawn } = fakeSpawn(() => ({}));
  const result = await runVariant({ ...base, spawn, runs: 5 });
  assert.deepEqual(result.report.stats, { total: 5, success: 5, failure: 0, timeout: 0, ignored: 0 });
  assert.equal(result.durations.length, 5);
  assert.equal(result.files["fuzz_output/report.json"], JSON.stringify(result.report));
});

test("failures are keyed and dumped as fuzz.py does", async () => {
  const { spawn } = fakeSpawn((i) => (i === 1 ? { outcome: "failure", key: "FillError", dump: { kind: "error", files: { "1.log": "boom" } } } : {}));
  const result = await runVariant({ ...base, spawn, runs: 3 });
  assert.deepEqual(result.report.errors, { fake: { FillError: [1] } });
  assert.equal(result.files["fuzz_output/error/fake/1/1.log"], "boom");
});

test("a timed-out run's worker is replaced, and its replacement lets hooks reclassify it", async () => {
  const { spawn, log } = fakeSpawn((i) => (i === 0 ? "hang" : {}), { timeoutOutcome: "ignored" });
  const result = await runVariant({ ...base, spawn, runs: 3, jobs: 1, timeoutSeconds: 0.05 });
  assert.deepEqual(result.report.stats, { total: 3, success: 2, failure: 0, timeout: 0, ignored: 1 });
  assert.equal(result.counters.timeouts, 1);
  assert.equal(result.files["fuzz_output/ignored/fake/0/0.log"], "[...] Generation killed here after 0.05s");
  assert.equal(result.files["fuzz_output/ignored/fake/0/0-0.yaml"], "game: Fake\n");
  assert.equal(log.spawned, 2);
});

test("an unreclassified timeout is counted under CI's timeout key", async () => {
  const { spawn } = fakeSpawn((i) => (i === 0 ? "hang" : {}));
  const result = await runVariant({ ...base, spawn, runs: 2, jobs: 1, timeoutSeconds: 0.05 });
  assert.deepEqual(result.report.errors, { fake: { [TIMEOUT_KEY]: [0] } });
  assert.equal(result.report.stats.timeout, 1);
});

test("a fatal interpreter error counts a failure and replaces the worker", async () => {
  const { spawn, log } = fakeSpawn((i) => (i === 2 ? "fatal" : {}));
  const result = await runVariant({ ...base, spawn, runs: 4, jobs: 1 });
  assert.deepEqual(result.report.errors, { fake: { [FATAL_KEY]: [2] } });
  assert.equal(result.counters.fatal, 1);
  assert.match(result.files["fuzz_output/error/fake/2/2.log"], /RangeError/);
  assert.equal(log.spawned, 2);
});

test("a worker past the heap limit is replaced after its run", async () => {
  const { spawn, log } = fakeSpawn(() => ({}), { heapBytes: 2000 });
  const result = await runVariant({ ...base, spawn, runs: 3, jobs: 1, heapLimitBytes: 1000 });
  assert.equal(result.report.stats.success, 3);
  assert.equal(result.counters.heapRestarts, 3);
  assert.equal(log.spawned, 4);
});

// A fake paired variant: fuzz workers ask for every run to be regenerated, and finish it from the response as the
// determinism hook does. regenerate(i) returns the regenerator's response, "hang", or "fatal".
function fakePairSpawn(regenerate = () => ({ status: "ok", state: "same" })) {
  const log = { spawned: 0, regenerators: 0 };
  const spawn = ({ onMessage }) => {
    log.spawned++;
    let alive = true;
    let current = null;
    const send = (message) => setTimeout(() => alive && onMessage(message), 1);
    return {
      post(message) {
        if (message.type === "init") {
          if (message.role === "regenerator") log.regenerators++;
          send({ type: "ready", game: message.role === "regenerator" ? null : "Fake", seconds: 0.01 });
        } else if (message.type === "timeoutOutcome") send({ type: "timeoutOutcome", outcome: "timeout" });
        else if (message.type === "run") {
          current = message.i;
          send({ type: "started", i: current, yamls: { [`${current}-0.yaml`]: "game: Fake\n" } });
          send({ type: "regenerate", request: { i: current } });
        } else if (message.type === "regenerate") {
          const response = regenerate(message.request.i);
          if (response === "hang") return;
          if (response === "fatal") return send({ type: "fatal", text: "RangeError: Maximum call stack size exceeded" });
          send({ type: "regenerated", response, heapBytes: 10 });
        } else if (message.type === "resume") {
          const { response } = message;
          if (response.status === "ok" && response.state === "same") return send({ type: "result", outcome: "success", key: null, dump: null, seconds: 0.01, heapBytes: 10 });
          const key = response.status === "error" ? `Subprocess generation failed:\n${response.text}` : "Non-deterministic generation:\n=== ITEMPOOL ===";
          send({ type: "result", outcome: "failure", key, dump: { kind: "error", files: { [`${current}.log`]: key } }, seconds: 0.01, heapBytes: 10 });
        }
      },
      terminate() {
        alive = false;
      },
    };
  };
  return { spawn, log };
}

test("a paired variant gives each worker a regenerator and passes requests between them", async () => {
  const { spawn, log } = fakePairSpawn();
  const result = await runVariant({ ...base, spawn, runs: 6, jobs: 2, paired: true });
  assert.deepEqual(result.report.stats, { total: 6, success: 6, failure: 0, timeout: 0, ignored: 0 });
  assert.equal(result.game, "Fake");
  assert.deepEqual(log, { spawned: 4, regenerators: 2 });
});

test("a paired run whose regeneration differs is a failure under the hook's message", async () => {
  const { spawn } = fakePairSpawn((i) => ({ status: "ok", state: i === 1 ? "different" : "same" }));
  const result = await runVariant({ ...base, spawn, runs: 3, jobs: 1, paired: true });
  assert.deepEqual(result.report.errors, { fake: { "Non-deterministic generation:\n=== ITEMPOOL ===": [1] } });
});

test("a timeout while regenerating replaces both workers of the pair", async () => {
  const { spawn, log } = fakePairSpawn((i) => (i === 0 ? "hang" : { status: "ok", state: "same" }));
  const result = await runVariant({ ...base, spawn, runs: 2, jobs: 1, paired: true, timeoutSeconds: 0.05 });
  assert.deepEqual(result.report.stats, { total: 2, success: 1, failure: 0, timeout: 1, ignored: 0 });
  assert.deepEqual(log, { spawned: 4, regenerators: 2 });
});

test("a regenerator's fatal error answers its worker as the hook's subprocess error, and it is replaced", async () => {
  const { spawn, log } = fakePairSpawn((i) => (i === 0 ? "fatal" : { status: "ok", state: "same" }));
  const result = await runVariant({ ...base, spawn, runs: 2, jobs: 1, paired: true });
  assert.deepEqual(result.report.stats, { total: 2, success: 1, failure: 1, timeout: 0, ignored: 0 });
  assert.match(Object.keys(result.report.errors.fake)[0], /^Subprocess generation failed:\nFatal error in the regenerating worker's Python interpreter:\nRangeError/);
  assert.equal(result.counters.regeneratorFatal, 1);
  assert.equal(result.counters.fatal, 0);
  assert.deepEqual(log, { spawned: 3, regenerators: 2 });
});

// A fake whose workers can fail to start: failSpawns holds the 0-based spawn numbers the browser refuses, and
// fatalRun the run that kills its worker. reclassifyCrash kills the worker asked to reclassify a timeout.
function fakeBootSpawn({ failSpawns = new Set(), fatalRun = null, reclassifyCrash = false } = {}) {
  const log = { spawned: 0 };
  const spawn = ({ onMessage, onError }) => {
    const index = log.spawned++;
    let alive = true;
    const send = (message) => setTimeout(() => alive && onMessage(message), 1);
    const fail = (text) => setTimeout(() => alive && onError(text), 1);
    return {
      post(message) {
        if (message.type === "init") {
          if (failSpawns.has(index)) return fail("the browser stopped the worker without an error; it may be short of memory");
          return send({ type: "ready", game: "Fake", seconds: 0.01 });
        }
        if (message.type === "timeoutOutcome") {
          if (reclassifyCrash) return fail("worker died while reclassifying");
          return send({ type: "timeoutOutcome", outcome: "timeout" });
        }
        if (message.type === "run") {
          send({ type: "started", i: message.i, yamls: { [`${message.i}-0.yaml`]: "game: Fake\n" } });
          if (message.i === fatalRun) return send({ type: "fatal", text: "boom" });
          send({ type: "result", outcome: "success", key: null, dump: null, seconds: 0.01, heapBytes: 10 });
        }
      },
      terminate() {
        alive = false;
      },
    };
  };
  return { spawn, log };
}

const fastRetries = { bootRetryDelays: [1, 1] };

test("a worker the browser won't start is retried, and the variant carries on", async () => {
  const { spawn, log } = fakeBootSpawn({ failSpawns: new Set([0]) });
  const result = await runVariant({ ...base, ...fastRetries, spawn, runs: 2, jobs: 1 });
  assert.deepEqual(result.report.stats, { total: 2, success: 2, failure: 0, timeout: 0, ignored: 0 });
  assert.equal(result.counters.bootFailures, 1);
  assert.equal(result.counters.retiredSlots, 0);
  assert.equal(result.error, null);
  assert.equal(log.spawned, 2);
});

test("a worker that never starts retires its slot, and the other workers finish the variant", async () => {
  // Slot 2's first worker is spawn 1, and its retries are spawns 2 and 3.
  const { spawn } = fakeBootSpawn({ failSpawns: new Set([1, 2, 3]) });
  const result = await runVariant({ ...base, ...fastRetries, spawn, runs: 4, jobs: 2 });
  assert.deepEqual(result.report.stats, { total: 4, success: 4, failure: 0, timeout: 0, ignored: 0 });
  assert.equal(result.counters.bootFailures, 3);
  assert.equal(result.counters.retiredSlots, 1);
  assert.equal(result.error, null, "every run finished, so the variant isn't short");
});

test("when the last worker gives up, the finished runs are kept with the reason", async () => {
  const { spawn } = fakeBootSpawn({ failSpawns: new Set([1, 2, 3]), fatalRun: 2 });
  const result = await runVariant({ ...base, ...fastRetries, spawn, runs: 5, jobs: 1 });
  assert.deepEqual(result.report.stats, { total: 3, success: 2, failure: 1, timeout: 0, ignored: 0 });
  assert.match(result.error, /failed to start 3 times in a row; the browser may be out of memory/);
  assert.equal(result.counters.retiredSlots, 1);
  assert.equal(result.files["fuzz_output/report.json"], JSON.stringify(result.report));
});

test("a variant that produces nothing at all still rejects", async () => {
  const { spawn } = fakeBootSpawn({ failSpawns: new Set([0, 1, 2]) });
  await assert.rejects(runVariant({ ...base, ...fastRetries, spawn, runs: 3, jobs: 1 }), /failed to start/);
});

test("a worker that dies while reclassifying leaves the run counted as a timeout", async () => {
  const { spawn } = fakeBootSpawn({ reclassifyCrash: true });
  const result = await runVariant({
    ...base,
    ...fastRetries,
    spawn: ({ onMessage, onError }) => {
      const worker = spawn({ onMessage, onError });
      return {
        post(message) {
          // Run 0 hangs, so it times out; everything else behaves.
          if (message.type === "run" && message.i === 0) {
            onMessage({ type: "started", i: 0, yamls: { "0-0.yaml": "game: Fake\n" } });
            return;
          }
          worker.post(message);
        },
        terminate: worker.terminate,
      };
    },
    runs: 2,
    jobs: 1,
    timeoutSeconds: 0.05,
  });
  assert.deepEqual(result.report.stats, { total: 2, success: 1, failure: 0, timeout: 1, ignored: 0 });
  assert.deepEqual(result.report.errors, { fake: { [TIMEOUT_KEY]: [0] } });
  assert.equal(result.counters.reclassifyFailures, 1);
  assert.equal(result.files["fuzz_output/timeout/fake/0/0.log"], "[...] Generation killed here after 0.05s");
});

test("the shipped boot retry delays grow, so memory pressure has time to ease", () => {
  assert.equal(BOOT_RETRY_DELAYS.length >= 3, true);
  for (let i = 1; i < BOOT_RETRY_DELAYS.length; i++) assert.equal(BOOT_RETRY_DELAYS[i] > BOOT_RETRY_DELAYS[i - 1], true);
});

test("aborting ends the variant with the runs completed so far", async () => {
  const controller = new AbortController();
  const { spawn } = fakeSpawn((i) => (i >= 2 ? "hang" : {}));
  const promise = runVariant({ ...base, spawn, runs: 10, jobs: 1, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.report.stats.total, 2);
});
