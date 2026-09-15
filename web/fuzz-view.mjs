// One fuzz variant's section: progress while it runs; afterward its counts, the timeouts hooks may have
// reported as other outcomes, and each error class with its runs' logs and YAMLs.

import { dot, formatSeconds, h, setDot, tail } from "./dom.mjs";

const RUNS_SHOWN = 20;

function statsLine(stats) {
  const parts = [`${stats.success} succeeded`];
  if (stats.failure) parts.push(`${stats.failure} failed`);
  if (stats.timeout) parts.push(`${stats.timeout} timed out`);
  if (stats.ignored) parts.push(`${stats.ignored} ignored`);
  return parts.join(" · ");
}

export class FuzzVariantView {
  constructor(definition) {
    this.definition = definition;
    this.marker = dot();
    this.counts = h("span", { class: "counts" });
    this.progressBar = h("progress", { max: 1, value: 0, hidden: true });
    this.body = h("div", { class: "section-body" }, h("p", { class: "hint" }, definition.description));
    this.element = h(
      "details",
      { class: "section" },
      h("summary", {}, this.marker, h("span", { class: "title" }, definition.name), this.counts, this.progressBar),
      this.body,
    );
  }

  queue(runs) {
    this.counts.textContent = `queued · ${runs} runs`;
  }

  skip(reason) {
    this.element.classList.add("skipped");
    this.counts.textContent = `not run: ${reason}`;
  }

  start(runs) {
    this.startedAt = performance.now();
    setDot(this.marker, "running");
    this.counts.textContent = `0/${runs}`;
    this.progressBar.hidden = false;
    this.progressBar.max = runs;
  }

  progress({ completed, runs, stats }) {
    this.progressBar.value = completed;
    const problems = [stats.failure && `${stats.failure} failed`, stats.timeout && `${stats.timeout} timed out`].filter(Boolean);
    this.counts.textContent = `${completed}/${runs}${problems.length ? ` · ${problems.join(" · ")}` : ""}`;
  }

  /** @param {object} entry  a session record's fuzz entry; module is the apworld's module name */
  done(entry, module, timeoutSeconds) {
    this.progressBar.hidden = true;
    if (entry.skipped) {
      setDot(this.marker, "");
      this.skip(entry.skipped);
      return;
    }
    if (entry.error && !entry.result) {
      setDot(this.marker, "fail");
      this.counts.textContent = "couldn't run";
      this.body.append(h("pre", { class: "log" }, entry.error));
      this.element.open = true;
      return;
    }
    const { report, counters, files, aborted } = entry.result;
    const { stats } = report;
    const elapsed = this.startedAt ? ` in ${formatSeconds((performance.now() - this.startedAt) / 1000)}` : "";
    // A generation that ran out of time isn't a failure, but it isn't a clean pass either: something may be
    // wrong, and a hook may have recorded it as another outcome. Count every generation that hit the limit,
    // not just those still classified as timeouts.
    const timedOut = Math.max(counters.timeouts ?? 0, stats.timeout);
    const endedEarly = Boolean(entry.error);
    const state = stats.failure ? "fail" : timedOut || endedEarly ? "warn" : "pass";
    setDot(this.marker, state);
    const headline = stats.failure
      ? `${stats.failure} of ${stats.total} failed`
      : timedOut
        ? `${stats.total - timedOut} of ${stats.total} passed · ${timedOut} timed out`
        : `${stats.total} passed`;
    const incomplete = endedEarly ? ` (ended after ${stats.total} of ${entry.runs} runs)` : "";
    this.counts.textContent = `${headline}${aborted ? " (stopped)" : ""}${incomplete}${elapsed}`;
    if (endedEarly) {
      this.body.append(h("p", { class: "hint" }, "The variant ended before finishing its runs:"), h("pre", { class: "log" }, entry.error));
      this.element.open = true;
    }

    this.body.append(h("p", {}, statsLine(stats)));
    const notes = [];
    if (entry.paired) notes.push(`Ran on ${entry.jobs} worker ${entry.jobs === 1 ? "pair" : "pairs"}: a second interpreter regenerated each worker's seeds for comparison.`);
    if (counters.timeouts) {
      const hidden = counters.timeouts - stats.timeout;
      notes.push(`${counters.timeouts} generations reached the ${timeoutSeconds} s timeout${hidden > 0 ? `; the hook reported ${hidden} of them as another outcome` : ""}.`);
    }
    if (counters.fatal) notes.push(`${counters.fatal} runs crashed the browser's Python interpreter (often a JavaScript stack overflow); these may pass natively.`);
    if (counters.regeneratorFatal) notes.push(`${counters.regeneratorFatal} regenerations crashed the second interpreter; the hook reports these as failed subprocess generations.`);
    if (counters.heapRestarts) notes.push(`${counters.heapRestarts} workers were restarted to free memory.`);
    if (counters.bootFailures) notes.push(`${counters.bootFailures} workers wouldn't start and were retried${counters.retiredSlots ? `; ${counters.retiredSlots} gave up, leaving fewer workers` : ""}.`);
    if (counters.reclassifyFailures) notes.push(`${counters.reclassifyFailures} timeouts were counted as timeouts because the worker that would ask the hook about them died.`);
    for (const note of notes) this.body.append(h("p", { class: "hint" }, note));

    const worldErrors = Object.values(report.errors)[0] ?? {};
    // report.json keys hold the whole message, so hooks that name what differed (determinism lists items and
    // locations) give nearly every run its own key. Group by the first line, which is the error itself, and
    // show one message as an example; each run's log has its own.
    const classes = new Map();
    for (const [key, runs] of Object.entries(worldErrors)) {
      const name = key.split("\n")[0].slice(0, 160);
      const group = classes.get(name) ?? { runs: [], example: key, keys: 0 };
      group.runs.push(...runs);
      group.keys++;
      classes.set(name, group);
    }
    for (const [name, group] of [...classes].sort((a, b) => b[1].runs.length - a[1].runs.length)) {
      const runs = group.runs.sort((a, b) => a - b);
      const list = h("div", { class: "runs" });
      const errorClass = h(
        "details",
        { class: "group has-failures" },
        h("summary", {}, dot("fail"), h("span", { class: "title error-key" }, name), h("span", { class: "counts" }, `×${runs.length}`)),
        group.example.includes("\n") ? h("pre", { class: "log" }, group.example) : null,
        group.keys > 1
          ? h("p", { class: "hint" }, `${group.keys} different messages; the one above is an example, and each run's log has its own.`)
          : null,
        name === "None"
          ? h("p", { class: "hint" }, "Marked failed without an exception: the hook or the fuzzer recorded a failure with no error to name, as Universal Tracker's check does. Each run's log says why.")
          : null,
        list,
      );
      // Rendered when opened: logs can be long.
      errorClass.addEventListener("toggle", () => {
        if (!errorClass.open || list.childElementCount) return;
        for (const run of runs.slice(0, RUNS_SHOWN)) list.append(this.renderRun(run, module, files));
        if (runs.length > RUNS_SHOWN) list.append(h("p", { class: "hint" }, `…and ${runs.length - RUNS_SHOWN} more runs in the saved report.`));
      });
      this.body.append(errorClass);
    }
    if (stats.failure) this.element.open = true;
  }

  renderRun(run, module, files) {
    const entries = Object.entries(files).filter(([path]) => /^fuzz_output\/(error|timeout|ignored)\//.test(path) && path.includes(`/${module}/${run}/`));
    const log = entries.find(([path]) => path.endsWith(`/${run}.log`));
    const yamls = entries.filter(([path]) => path.endsWith(".yaml"));
    return h(
      "details",
      { class: "run" },
      h("summary", {}, `Run ${run}`),
      log ? h("pre", { class: "log" }, tail(log[1])) : h("p", { class: "hint" }, "No log was saved for this run."),
      yamls.map(([path, text]) => [h("div", { class: "file-name" }, path.split("/").at(-1)), h("pre", { class: "log" }, text)]),
    );
  }
}
