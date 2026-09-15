// The index CI's fuzz variants, in its order (Archipelago-index-ci scripts/run_fuzz.py and
// aggregate_fuzz.py). "full" variants run FUZZ_RUNS_FULL generations in CI, "check" variants FUZZ_RUNS_CHECK.

export const CI_RUNS = { full: 5000, check: 500 };
export const CI_JOBS = 4;
export const CI_TIMEOUT_SECONDS = 30;

export const VARIANTS = [
  { name: "default", hook: null, runs: "full", description: "Standard fuzz, no hook" },
  {
    name: "no-restrictive-starts",
    hook: "hooks.with_empty:Hook",
    runs: "full",
    description: "Fuzz with empty starts hook to help remove restrictive starts",
  },
  {
    name: "check-collect-accessibility",
    hook: "hooks.collect_accessibility_test:Hook",
    runs: "check",
    description: "Fuzz to check that collecting items into a state doesn't reduce accessibility",
  },
  {
    name: "check-determinism",
    hook: "hooks.determinism:Hook",
    runs: "check",
    description: "Fuzz to check for determinism",
    // The hook regenerates each seed in a second Python process, which Pyodide can't start.
    unsupported: "Needs a second interpreter; not yet supported in the browser",
  },
  { name: "check-gerpocalypse", hook: "hooks.gerpocalypse:Hook", runs: "check", description: "Fuzz to check for issues with GER" },
  {
    name: "check-indirect-conditions",
    hook: "hooks.indirect_conditions:Hook",
    runs: "check",
    description: "Fuzz to check for missing indirect conditions",
  },
  {
    name: "check-item-location-count",
    hook: "hooks.item_location_count:Hook",
    runs: "check",
    description: "Fuzz to check that the item count matches the location count",
  },
  {
    name: "check-lambda-capture",
    hook: "hooks.detect_rule_variable_capture_issues:Hook",
    runs: "check",
    description: "Fuzz to find out if there's some lambda variable capture issues",
  },
  {
    name: "check-placement-item-location-refs",
    hook: "hooks.check_placement_item_location_references:Hook",
    runs: "check",
    description: "Fuzz to check if items/locations agree on their placements",
  },
  {
    name: "check-static-output-placement",
    hook: "hooks.detect_output_placement_changes:Hook",
    runs: "check",
    description: "Fuzz to check that the world doesn't modify placements in output",
  },
  { name: "check-ut", hook: "worlds.tracker.fuzzer_hook:Hook", runs: "check", description: "Fuzz to check for universal tracker support" },
];
