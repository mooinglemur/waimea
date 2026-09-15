// Builds the downloadable report from a session record (session.mjs):
// - unittest-report/<module>/<version>/ and fuzz-report/<module>/<version>/<variant>/fuzz_output/, the index
//   CI's artifact layout, which its aggregate_unittests.py and aggregate_fuzz.py read;
// - summary.md, rendered in the shape of CI's two PR comments, with Waimea's own notes added;
// - environment.json, what produced the results.

import { FATAL_KEY } from "./fuzz-orchestrator.mjs";
import { VARIANTS } from "./fuzz-variants.mjs";

// From aggregate_unittests.py and aggregate_fuzz.py.
const MAX_ROWS = 25;
const TRACEBACK_KEY_MAX_LEN = 100;

const lastLine = (traceback) => (traceback ?? "").trim().split("\n").filter((l) => l.trim()).at(-1)?.trim() ?? "";

// aggregate_unittests.render_category
function renderCategory(title, entries, withTraceback) {
  const items = Object.entries(entries ?? {});
  if (!items.length) return "";
  const lines = [`**${title}:**`];
  for (const [testId, info = {}] of items.slice(0, MAX_ROWS)) {
    const description = (info?.description ?? "").trim();
    const tail = withTraceback ? lastLine(info?.traceback) : "";
    let suffix = "";
    if (description) suffix += ` — ${description}`;
    if (tail) suffix += ` — \`${tail.slice(0, 300)}\``;
    lines.push(`- \`${testId}\`${suffix}`);
  }
  if (items.length > MAX_ROWS) lines.push(`- _…and ${items.length - MAX_ROWS} more (see .aptest artifact)_`);
  return `${lines.join("\n")}\n`;
}

// aggregate_unittests.render_run, with Waimea's crashed and stopped runs added.
export function renderUnitTests(module, version, unitTests) {
  if (unitTests.status === "crash" || unitTests.status === "stopped") {
    const why = unitTests.status === "stopped" ? "The unit-test run was stopped." : `The unit-test run crashed: \`${lastLine(unitTests.error).slice(0, 300)}\``;
    return `## ⚠️ ${module} v${version}\n\n_${why}_\n`;
  }
  const raw = unitTests.files?.[`${module}.aptest`];
  if (!raw) return `## ✅ ${module} v${version}\n\n_All unit tests passed._\n`;
  const aptest = JSON.parse(raw);
  const { failures = {}, errors = {}, unexpected_successes: unexpected = {}, expected_failures: expected = {} } = aptest;
  const real = Object.keys(failures).length || Object.keys(errors).length || Object.keys(unexpected).length;
  const head = `## ${real ? "❌" : "✅"} ${module} v${version}\n`;
  let body = renderCategory("Failures", failures, true) + renderCategory("Errors", errors, true);
  if (Object.keys(unexpected).length) body += renderCategory("Unexpected successes (annotated as failing)", unexpected, false);
  if (Object.keys(expected).length) body += `\n_Expected failures (known/annotated): ${Object.keys(expected).length}_\n`;
  if (!real && !Object.keys(expected).length) body = "_All unit tests passed._\n";
  else if (!real) body += "_No unexpected failures._\n";
  return `${head}\n${body}`;
}

// aggregate_fuzz.render_errors
function renderErrors(errors) {
  const classCounts = new Map();
  let tracebackBucket = 0;
  for (const worldErrors of Object.values(errors ?? {})) {
    for (const [key, runs] of Object.entries(worldErrors)) {
      if (key.includes("\n") || key.length > TRACEBACK_KEY_MAX_LEN) tracebackBucket += runs.length;
      else classCounts.set(key, (classCounts.get(key) ?? 0) + runs.length);
    }
  }
  if (!classCounts.size && !tracebackBucket) return "";
  const lines = ["**Errors:**"];
  for (const [key, count] of [...classCounts].sort((a, b) => b[1] - a[1])) lines.push(`- \`${key}\` (×${count})`);
  if (tracebackBucket) lines.push(`- _long-form / traceback errors_ (×${tracebackBucket}; see report.json artifact)`);
  return `${lines.join("\n")}\n`;
}

// Waimea's additions to a variant's section: the timeout it used, and timeouts hooks may have hidden.
function renderWaimeaNotes(entry, record) {
  const { stats } = entry.result.report;
  const { counters } = entry.result;
  const notes = [`Timeout ${record.timeoutSeconds} s (CI's ${record.ciTimeoutSeconds} s, scaled by calibration)`];
  if (counters.timeouts) {
    const hidden = counters.timeouts - stats.timeout;
    notes.push(hidden > 0 ? `${counters.timeouts} generations hit it; hooks reported ${hidden} of them as another outcome` : `${counters.timeouts} generations hit it`);
  }
  if (counters.fatal) notes.push(`${counters.fatal} fatal interpreter errors, under "${FATAL_KEY}"`);
  if (counters.heapRestarts) notes.push(`${counters.heapRestarts} workers restarted for memory`);
  if (entry.result.aborted) notes.push("stopped early");
  return `_${notes.join("; ")}._\n`;
}

// aggregate_fuzz._render_one_report, without apdiff-viewer baselines.
export function renderVariant(entry, record) {
  const definition = VARIANTS.find((v) => v.name === entry.variant);
  const slug = entry.variant;
  if (entry.skipped) return `### ⏭️ ${slug}\n\n_Not run: ${entry.skipped}._\n`;
  if (entry.error) return `### ⚠️ ${slug}\n\n_The variant couldn't run: \`${lastLine(entry.error).slice(0, 300)}\`_\n`;

  const { stats, errors } = entry.result.report;
  const total = stats.total ?? stats.success + stats.failure + stats.timeout + stats.ignored;
  const rate = total ? (stats.failure / total) * 100 : 0;
  const countsBlock =
    "```\n" +
    `Success: ${stats.success}\nFailure: ${stats.failure}\nTimeout: ${stats.timeout}\nIgnored: ${stats.ignored}\nTotal: ${total}\n` +
    "```\n" +
    `**Failure rate**: ${rate.toFixed(1)}%\n`;
  const errorsBlock = renderErrors(errors);
  const notes = renderWaimeaNotes(entry, record);

  if (definition?.runs === "check") {
    let body = "<details>\n<summary>Details</summary>\n\n";
    if (definition.description) body += `${definition.description}\n\n`;
    body += countsBlock;
    if (errorsBlock) body += `\n${errorsBlock}`;
    body += `\n${notes}\n</details>\n`;
    return `### ${stats.failure === 0 ? "✅" : "❌"} ${slug}\n\n${body}`;
  }
  let out = `### ${slug}\n\n${countsBlock}\n`;
  if (errorsBlock) out += `${errorsBlock}\n`;
  return `${out}${notes}\n`;
}

export function environmentFor({ manifest, record, userAgent, hardwareConcurrency }) {
  return {
    generatedBy: "waimea",
    startedAt: record.startedAt,
    finishedAt: record.finishedAt ?? null,
    stoppedEarly: record.aborted,
    world: record.world,
    archipelago: manifest.archipelago,
    fuzzer: manifest.fuzzer,
    lobby: manifest.lobby,
    pyodide: manifest.pyodide.version,
    coreBundle: manifest.core.url,
    browser: userAgent ?? null,
    hardwareConcurrency: hardwareConcurrency ?? null,
    plan: record.plan,
    ciTimeoutSeconds: record.ciTimeoutSeconds,
    timeoutSeconds: record.timeoutSeconds,
    calibration: record.calibration,
    calibrationError: record.calibrationError,
    calibrationReference: { label: manifest.calibration.reference.label, cpu: manifest.calibration.reference.cpu },
    variants: record.fuzz.map((entry) => ({
      variant: entry.variant,
      runs: entry.runs ?? 0,
      skipped: entry.skipped ?? null,
      error: entry.error ?? null,
      counters: entry.result ? { ...entry.result.counters, bootSeconds: undefined } : null,
    })),
  };
}

/**
 * @returns {{files: {path: string, data: string}[], summary: string}}
 */
export function buildReport({ manifest, record, userAgent, hardwareConcurrency }) {
  const { module, version, game } = record.world;
  const files = [];
  if (record.unitTests) {
    for (const [name, text] of Object.entries(record.unitTests.files ?? {})) {
      files.push({ path: `unittest-report/${module}/${version}/${name}`, data: text });
    }
  }
  for (const entry of record.fuzz) {
    for (const [path, text] of Object.entries(entry.result?.files ?? {})) {
      files.push({ path: `fuzz-report/${module}/${version}/${entry.variant}/${path}`, data: text });
    }
  }

  const { archipelago } = manifest;
  let summary =
    `# Waimea report: ${game} (${module} v${version})\n\n` +
    `Run in a browser against Archipelago ${archipelago.version} (${archipelago.repository}@${archipelago.commit.slice(0, 7)}), ` +
    `on ${record.startedAt}. The index CI remains the authoritative check.\n` +
    (record.aborted ? "\n**Stopped early; results below are partial.**\n" : "") +
    "\n# Unit tests\n\n" +
    (record.unitTests ? renderUnitTests(module, version, record.unitTests) : "_Not run._\n") +
    `\n# Fuzzing\n\n## Fuzz results for ${module} v${version}\n\n`;
  if (record.calibrationError) summary += `_Timeout calibration failed, so CI's ${record.ciTimeoutSeconds} s timeout was used: ${lastLine(record.calibrationError)}_\n\n`;
  summary += record.fuzz.map((entry) => renderVariant(entry, record)).join("\n");

  files.push({ path: "summary.md", data: summary });
  files.push({ path: "environment.json", data: `${JSON.stringify(environmentFor({ manifest, record, userAgent, hardwareConcurrency }), null, 2)}\n` });
  return { files, summary };
}
