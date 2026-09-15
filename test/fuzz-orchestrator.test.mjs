import assert from "node:assert/strict";
import { test } from "node:test";
import { FATAL_KEY, TIMEOUT_KEY, runVariant } from "../web/fuzz-orchestrator.mjs";

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

test("aborting ends the variant with the runs completed so far", async () => {
  const controller = new AbortController();
  const { spawn } = fakeSpawn((i) => (i >= 2 ? "hang" : {}));
  const promise = runVariant({ ...base, spawn, runs: 10, jobs: 1, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.report.stats.total, 2);
});
