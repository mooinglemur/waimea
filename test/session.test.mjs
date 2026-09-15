import assert from "node:assert/strict";
import { test } from "node:test";
import { CI_RUNS, VARIANTS } from "../web/fuzz-variants.mjs";
import { DEFAULT_PRESET, PRESETS, applyPreset, defaultJobs, defaultPlan, pairedJobs } from "../web/session.mjs";

const runsOf = (plan, name) => plan.variants.find((v) => v.name === name).runs;

test("the default plan uses the index CI's run counts", () => {
  const plan = defaultPlan(8);
  assert.equal(DEFAULT_PRESET, "ci");
  assert.equal(plan.preset, "ci");
  assert.equal(runsOf(plan, "default"), 5000);
  assert.equal(runsOf(plan, "no-restrictive-starts"), 5000);
  assert.equal(runsOf(plan, "check-ut"), 500);
  assert.deepEqual(CI_RUNS, { full: 5000, check: 500 });
});

test("every variant is enabled by default except unsupported ones", () => {
  const plan = defaultPlan(8);
  for (const variant of VARIANTS) {
    assert.equal(plan.variants.find((v) => v.name === variant.name).enabled, !variant.unsupported, variant.name);
  }
  assert.equal(plan.variants.find((v) => v.name === "check-determinism").enabled, true);
});

test("paired variants use every worker as a pair unless halved, rounding down, from two workers up", () => {
  assert.equal(VARIANTS.find((v) => v.name === "check-determinism").paired, true);
  const plan = defaultPlan(8);
  assert.equal(plan.halvePairedJobs, false);
  assert.equal(pairedJobs({ jobs: 4, halvePairedJobs: false }), 4);
  assert.equal(pairedJobs({ jobs: 4, halvePairedJobs: true }), 2);
  assert.equal(pairedJobs({ jobs: 3, halvePairedJobs: true }), 1);
  assert.equal(pairedJobs({ jobs: 2, halvePairedJobs: true }), 1);
  assert.equal(pairedJobs({ jobs: 1, halvePairedJobs: true }), 1);
});

test("the Quick preset sets a tenth of CI's counts, and CI restores them, without touching selections", () => {
  const plan = defaultPlan(8);
  plan.variants.find((v) => v.name === "check-ut").enabled = false;
  applyPreset(plan, "quick");
  assert.equal(plan.preset, "quick");
  assert.equal(runsOf(plan, "default"), 500);
  assert.equal(runsOf(plan, "check-lambda-capture"), 50);
  assert.equal(plan.variants.find((v) => v.name === "check-ut").enabled, false);
  applyPreset(plan, "ci");
  assert.equal(runsOf(plan, "default"), 5000);
  assert.deepEqual(PRESETS.map((p) => p.id), ["ci", "quick"]);
  assert.throws(() => applyPreset(plan, "huge"), /unknown preset/);
});

test("the default worker count leaves a core free, between 1 and 4", () => {
  assert.equal(defaultJobs(1), 1);
  assert.equal(defaultJobs(2), 1);
  assert.equal(defaultJobs(4), 3);
  assert.equal(defaultJobs(24), 4);
  assert.equal(defaultJobs(undefined), 1);
});
