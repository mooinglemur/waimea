// The unit tests section: live counts, grouped into the WorldTestBase battery and each test/general module,
// with tracebacks for failures and failing subtests. Driven by runtime/unit_tests.py's events.

import { dot, formatSeconds, h, setDot } from "./dom.mjs";

const FAILED = new Set(["failure", "error", "unexpected_success"]);
const LABELS = {
  failure: "failed",
  error: "error",
  unexpected_success: "unexpectedly passed",
  expected_failure: "expected failure",
  skipped: "skipped",
};

// Test ids: "__main__.WorldTest.test_x", "test.general.test_fill.TestFill.test_y", plus " (params)" for subtests.
function placeTest(id) {
  const parts = id.split(" ")[0].split(".");
  if (parts[0] === "__main__") return { key: "battery", title: "WorldTestBase battery", name: parts.slice(1).join(".") };
  if (parts[0] === "test" && parts[1] === "general") {
    return { key: parts[2], title: `test/general/${parts[2]}.py`, name: parts.slice(3).join(".") };
  }
  return { key: parts.slice(0, -2).join("."), title: parts.slice(0, -2).join("."), name: parts.slice(-2).join(".") };
}

// A test with failing subtests counts once; CI's summary lists each subtest, so they're shown too.
function describeCounts({ total, done, failed, subtests = 0 }, finished) {
  if (!total) return "";
  if (failed) return `${failed} of ${total} failed${subtests ? ` (${subtests} subtest${subtests === 1 ? "" : "s"})` : ""}`;
  return finished || done === total ? `${total} passed` : `${done}/${total}`;
}

export class UnitTestsView {
  constructor() {
    this.tests = new Map();
    this.groups = new Map();
    this.marker = dot();
    this.counts = h("span", { class: "counts" }, "waiting");
    this.note = h("p", { class: "hint", hidden: true });
    this.groupList = h("div", { class: "groups" });
    this.element = h(
      "details",
      { class: "section" },
      h("summary", {}, this.marker, h("span", { class: "title" }, "Unit tests"), this.counts),
      h("div", { class: "section-body" }, this.note, this.groupList),
    );
  }

  start() {
    this.startedAt = performance.now();
    setDot(this.marker, "running");
    this.counts.textContent = "starting a worker…";
  }

  handle(events) {
    for (const event of events) {
      if (event.type === "plan") this.plan(event.tests);
      else if (event.type === "start") this.update(event.id, (test) => (test.status = "running"));
      else if (event.type === "result") this.result(event);
      else if (event.type === "stop") this.stop(event.id);
      else if (event.type === "done") this.doneEvent = event;
    }
    this.refresh();
  }

  plan(ids) {
    for (const id of ids) {
      const place = placeTest(id);
      let group = this.groups.get(place.key);
      if (!group) {
        const marker = dot();
        const counts = h("span", { class: "counts" });
        const list = h("ul", { class: "tests" });
        group = { key: place.key, tests: [], marker, counts, list };
        group.element = h("details", { class: "group" }, h("summary", {}, marker, h("span", { class: "title" }, place.title), counts), list);
        this.groups.set(place.key, group);
        this.groupList.append(group.element);
      }
      const marker = dot();
      const outcome = h("span", { class: "outcome" });
      const detail = h("div", { class: "test-detail" });
      const test = { id, group, status: "pending", outcome: null, subtestFailures: 0, marker, outcomeLabel: outcome, detail };
      test.element = h("li", {}, h("div", { class: "test-line" }, marker, h("span", { class: "test-name" }, place.name), outcome), detail);
      group.tests.push(test);
      group.list.append(test.element);
      this.tests.set(id, test);
    }
    this.counts.textContent = `0/${ids.length}`;
  }

  update(id, change) {
    const test = this.tests.get(id);
    if (test) change(test);
  }

  result(event) {
    const test = this.tests.get(event.parent ?? event.id);
    if (!test) return;
    if (!event.parent) {
      test.outcome = event.outcome;
    } else if (FAILED.has(event.outcome)) {
      test.subtestFailures++;
    } else {
      return;
    }
    if (FAILED.has(event.outcome) || event.outcome === "skipped" || event.outcome === "expected_failure") {
      const heading = event.parent ? event.id.slice(event.id.indexOf(" ") + 1) || event.id : LABELS[event.outcome];
      const block = h("div", { class: "failure" }, h("div", { class: "failure-title" }, heading), event.description ? h("div", { class: "hint" }, event.description) : null);
      if (event.traceback) block.append(h("pre", { class: "log" }, event.traceback));
      test.detail.append(block);
    }
  }

  stop(id) {
    this.update(id, (test) => {
      if (test.outcome === null) test.outcome = test.subtestFailures ? "failure" : "success";
      test.status = "done";
    });
  }

  refresh() {
    const totals = { total: 0, done: 0, failed: 0, subtests: 0 };
    for (const group of this.groups.values()) {
      const counts = { total: group.tests.length, done: 0, failed: 0, subtests: 0, running: false };
      for (const test of group.tests) {
        const failed = FAILED.has(test.outcome) || test.subtestFailures > 0;
        if (test.status === "done") counts.done++;
        if (failed) counts.failed++;
        counts.subtests += test.subtestFailures;
        if (test.status === "running") counts.running = true;
        setDot(test.marker, test.status === "running" ? "running" : test.status !== "done" ? "" : failed ? "fail" : "pass");
        test.outcomeLabel.textContent = failed ? (LABELS[test.outcome] ?? "failed") : LABELS[test.outcome] ?? "";
      }
      setDot(group.marker, counts.failed ? "fail" : counts.running || (counts.done && counts.done < counts.total) ? "running" : counts.done === counts.total ? "pass" : "");
      group.counts.textContent = describeCounts(counts, false);
      if (counts.failed) group.element.classList.add("has-failures");
      totals.total += counts.total;
      totals.done += counts.done;
      totals.failed += counts.failed;
      totals.subtests += counts.subtests;
    }
    this.totals = totals;
    this.counts.textContent = describeCounts(totals, false);
    if (totals.failed) setDot(this.marker, "fail");
  }

  /** @param {{status: number | string, error?: string}} unitTests */
  finish(unitTests) {
    const elapsed = this.startedAt ? ` in ${formatSeconds((performance.now() - this.startedAt) / 1000)}` : "";
    const totals = this.totals ?? { total: 0, done: 0, failed: 0 };
    if (unitTests.status === "stopped" || unitTests.status === "crash") {
      setDot(this.marker, "fail");
      this.counts.textContent = unitTests.status === "stopped" ? "stopped" : "crashed";
      this.note.hidden = false;
      this.note.textContent = unitTests.status === "stopped" ? "Stopped before the unit tests finished." : "The unit-test worker crashed.";
      if (unitTests.error && unitTests.status === "crash") this.note.after(h("pre", { class: "log" }, unitTests.error));
      return;
    }
    const passed = unitTests.status === 0;
    setDot(this.marker, passed ? "pass" : "fail");
    this.counts.textContent = `${describeCounts(totals, true)}${elapsed}`;
    if (this.doneEvent?.stopped_early) {
      this.note.hidden = false;
      this.note.textContent = "The run stopped at the first unexpected error, as the index CI's harness does, so later tests didn't run.";
    }
    if (!passed) this.element.open = true;
  }
}
