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
    if (entry.error) {
      setDot(this.marker, "fail");
      this.counts.textContent = "couldn't run";
      this.body.append(h("pre", { class: "log" }, entry.error));
      this.element.open = true;
      return;
    }
    const { report, counters, files, aborted } = entry.result;
    const { stats } = report;
    const elapsed = this.startedAt ? ` in ${formatSeconds((performance.now() - this.startedAt) / 1000)}` : "";
    setDot(this.marker, stats.failure ? "fail" : "pass");
    this.counts.textContent = `${stats.failure ? `${stats.failure} of ${stats.total} failed` : `${stats.total} passed`}${aborted ? " (stopped)" : ""}${elapsed}`;

    this.body.append(h("p", {}, statsLine(stats)));
    const notes = [];
    if (counters.timeouts) {
      const hidden = counters.timeouts - stats.timeout;
      notes.push(`${counters.timeouts} generations reached the ${timeoutSeconds} s timeout${hidden > 0 ? `; the hook reported ${hidden} of them as another outcome` : ""}.`);
    }
    if (counters.fatal) notes.push(`${counters.fatal} runs crashed the browser's Python interpreter (often a JavaScript stack overflow); these may pass natively.`);
    if (counters.heapRestarts) notes.push(`${counters.heapRestarts} workers were restarted to free memory.`);
    for (const note of notes) this.body.append(h("p", { class: "hint" }, note));

    const worldErrors = Object.values(report.errors)[0] ?? {};
    const classes = Object.entries(worldErrors).sort((a, b) => b[1].length - a[1].length);
    for (const [key, runs] of classes) {
      const list = h("div", { class: "runs" });
      const errorClass = h(
        "details",
        { class: "group has-failures" },
        h("summary", {}, dot("fail"), h("span", { class: "title error-key" }, key.split("\n")[0].slice(0, 160)), h("span", { class: "counts" }, `×${runs.length}`)),
        key.includes("\n") ? h("pre", { class: "log" }, key) : null,
        key === "None"
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
