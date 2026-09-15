// Scales the index CI's fuzz timeout to this browser and machine.
//
// CI's timeout is wall-clock time on its runner, and generation here is slower: Pyodide's own overhead,
// plus whatever this machine and the chosen worker count add. Before fuzzing, the same fixed workload CI's
// reference was measured on (deploy/calibration.json) runs here on the same workers the fuzz will use.
// Each run pins its YAML seed and generation seed, so both sides generate identically. The factor is the
// median, over matched runs, of this run's generation time divided by the reference's.
//
// The factor can be below 1: a fast machine gets a shorter timeout, since 30 seconds on it buys more work
// than 30 seconds on CI's runner. It's clamped to [MIN_FACTOR, MAX_FACTOR], so a bad measurement can't
// collapse the timeout and an overloaded machine can't stretch it without bound.

import { runVariant } from "./fuzz-orchestrator.mjs";

export const MIN_FACTOR = 0.5;
export const MAX_FACTOR = 4;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const scaledTimeout = (ciTimeoutSeconds, factor) => Math.ceil(ciTimeoutSeconds * factor);

/**
 * @param {object} options
 * @param {Function} options.spawn     as for runVariant
 * @param {object} options.init        worker init fields shared with the fuzz (pyodideUrl, indexURL, core)
 * @param {number} options.jobs        the worker count the fuzz will use
 * @param {object} options.calibration deploy/calibration.json
 * @param {number} [options.runs]      runs to measure here; defaults to the larger of 12 and 3 per worker
 * @param {AbortSignal} [options.signal]
 * @param {(progress: object) => void} [options.onProgress]
 */
export async function calibrate({ spawn, init, jobs, calibration, runs, signal, onProgress }) {
  const { workload, reference } = calibration;
  const count = Math.min(runs ?? Math.max(12, 3 * jobs), reference.seconds.length);
  const result = await runVariant({
    spawn,
    init: {
      ...init,
      apworld: { module: workload.world, supported: workload.supportedApworld },
      config: { apworld: workload.world, runs: count, timeout: 0, hooks: [] },
    },
    apworld: workload.world,
    runs: count,
    jobs,
    // Only a guard against a hang; calibration runs normally take seconds.
    timeoutSeconds: 300,
    heapLimitBytes: 0,
    seed: workload.yamlSeed,
    generationSeed: (i) => workload.generationSeedBase + i,
    signal,
    onProgress,
  });

  const ratios = result.durations
    .filter((d) => d.outcome === reference.outcomes[d.i] && reference.seconds[d.i] > 0)
    .map((d) => d.seconds / reference.seconds[d.i]);
  if (ratios.length < count / 2) {
    throw new Error(`Calibration failed: only ${ratios.length} of ${count} runs matched the reference's outcomes`);
  }
  const rawFactor = median(ratios);
  const factor = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, rawFactor));
  return {
    runs: count,
    matched: ratios.length,
    localMedianSeconds: median(result.durations.map((d) => d.seconds)),
    rawFactor,
    factor,
    clamped: factor !== rawFactor,
    bootSeconds: result.counters.bootSeconds,
  };
}
