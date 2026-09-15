import assert from "node:assert/strict";
import { test } from "node:test";
import { FATAL_KEY } from "../web/fuzz-orchestrator.mjs";
import { buildReport } from "../web/report.mjs";

const manifest = {
  archipelago: { version: "0.6.7", repository: "ionium-ap/Archipelago", commit: "f04b3a3457efbca6fde29beaf70c7f7f0016cdc8" },
  fuzzer: { repository: "ionium-ap/Archipelago-fuzzer", commit: "1".repeat(40) },
  lobby: { repository: "ionium-ap/Archipelago-lobby", commit: "2".repeat(40) },
  pyodide: { version: "0.29.4", base: "/runtime/pyodide-0.29.4/" },
  core: { url: "/bundles/core-abc.zip" },
  calibration: { reference: { label: "index-ci k8s-sandboxed runner", cpu: "Xeon" } },
};

const aptest = {
  failures: {
    "test.general.test_locations.TestBase.test_location_group [Goal]": {
      traceback: "Traceback (most recent call last):\n  ...\nAssertionError: 'Library Tidied' not found",
      description: "Test that all location groups are valid",
    },
  },
  errors: {},
  expected_failures: {},
  unexpected_successes: {},
};

function variantResult(stats, errors = {}, counters = {}) {
  return {
    report: { stats: { total: stats.success + stats.failure + stats.timeout + stats.ignored, ...stats }, errors },
    files: { "fuzz_output/report.json": JSON.stringify({ stats, errors }) },
    counters: { restarts: 0, heapRestarts: 0, timeouts: 0, fatal: 0, bootSeconds: [2], ...counters },
  };
}

const record = {
  startedAt: "2026-09-15T21:00:00.000Z",
  finishedAt: "2026-09-15T21:10:00.000Z",
  world: { module: "librarian", version: "2.0.3", game: "Librarian Tidy Up the Arcane Library" },
  plan: { unitTests: true, jobs: 2 },
  unitTests: { status: 1, files: { "librarian.aptest": JSON.stringify(aptest), "librarian.toml": "[x]\n" } },
  calibration: { factor: 0.8 },
  calibrationError: null,
  ciTimeoutSeconds: 30,
  timeoutSeconds: 24,
  aborted: false,
  fuzz: [
    { variant: "default", runs: 20, result: variantResult({ success: 20, failure: 0, timeout: 0, ignored: 0 }) },
    { variant: "no-restrictive-starts", skipped: "not selected" },
    {
      variant: "check-collect-accessibility",
      runs: 20,
      result: variantResult({ success: 17, failure: 0, timeout: 0, ignored: 3 }, {}, { timeouts: 3, restarts: 3 }),
    },
    { variant: "check-determinism", skipped: "Needs a second interpreter; not yet supported in the browser" },
    {
      variant: "check-ut",
      runs: 20,
      result: variantResult({ success: 18, failure: 2, timeout: 0, ignored: 0 }, { librarian: { None: [4, 9], [FATAL_KEY]: [11] } }, { fatal: 1 }),
    },
  ],
};

test("files follow the index CI's artifact layout", () => {
  const { files } = buildReport({ manifest, record, userAgent: "test", hardwareConcurrency: 8 });
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("unittest-report/librarian/2.0.3/librarian.aptest"));
  assert.ok(paths.includes("unittest-report/librarian/2.0.3/librarian.toml"));
  assert.ok(paths.includes("fuzz-report/librarian/2.0.3/default/fuzz_output/report.json"));
  assert.ok(paths.includes("fuzz-report/librarian/2.0.3/check-ut/fuzz_output/report.json"));
  assert.ok(paths.includes("summary.md"));
  const environment = JSON.parse(files.find((f) => f.path === "environment.json").data);
  assert.equal(environment.timeoutSeconds, 24);
  assert.equal(environment.archipelago.commit, manifest.archipelago.commit);
});

test("summary.md renders like CI's comments, with Waimea's notes", () => {
  const { summary } = buildReport({ manifest, record });
  assert.match(summary, /^# Waimea report: Librarian Tidy Up the Arcane Library \(librarian v2\.0\.3\)/);
  assert.match(summary, /## ❌ librarian v2\.0\.3\n\n\*\*Failures:\*\*\n- `test\.general\.test_locations\.TestBase\.test_location_group \[Goal\]` — Test that all location groups are valid — `AssertionError: 'Library Tidied' not found`/);
  assert.match(summary, /### default\n\n```\nSuccess: 20\nFailure: 0\nTimeout: 0\nIgnored: 0\nTotal: 20\n```\n\*\*Failure rate\*\*: 0\.0%/);
  assert.match(summary, /### ⏭️ no-restrictive-starts\n\n_Not run: not selected\._/);
  assert.match(summary, /### ⏭️ check-determinism\n\n_Not run: Needs a second interpreter/);
  assert.match(summary, /### ✅ check-collect-accessibility\n\n<details>/);
  assert.match(summary, /3 generations hit it; hooks reported 3 of them as another outcome/);
  assert.match(summary, /### ❌ check-ut/);
  assert.match(summary, /- `None` \(×2\)/);
  assert.match(summary, /_long-form \/ traceback errors_ \(×1; see report\.json artifact\)/);
  assert.match(summary, /1 fatal interpreter errors/);
});

test("a clean unit-test run and a crashed one render as CI and Waimea do", () => {
  const clean = buildReport({ manifest, record: { ...record, unitTests: { status: 0, files: { "librarian.toml": "" } } } }).summary;
  assert.match(clean, /## ✅ librarian v2\.0\.3\n\n_All unit tests passed\._/);
  const crashed = buildReport({ manifest, record: { ...record, unitTests: { status: "crash", error: "Error: boom\nRangeError: Maximum call stack size exceeded", files: {} } } }).summary;
  assert.match(crashed, /## ⚠️ librarian v2\.0\.3\n\n_The unit-test run crashed: `RangeError: Maximum call stack size exceeded`_/);
});
