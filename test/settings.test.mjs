import assert from "node:assert/strict";
import { test } from "node:test";
import { portSetting } from "../server/settings.mjs";

function port(value) {
  const warnings = [];
  const result = portSetting({ WAIMEA_PORT: value }, "WAIMEA_PORT", 8080, (message) => warnings.push(message));
  return { result, warnings };
}

test("a Kubernetes service link in WAIMEA_PORT falls back to the default with a warning", () => {
  const { result, warnings } = port("tcp://10.0.0.1:8080");
  assert.equal(result, 8080);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WAIMEA_PORT=tcp:\/\/10\.0\.0\.1:8080/);
});

test("a plain port number is used, and an unset one falls back", () => {
  assert.deepEqual(port("9000"), { result: 9000, warnings: [] });
  assert.deepEqual(port(undefined), { result: 8080, warnings: [] });
});

test("an out-of-range port falls back to the default", () => {
  assert.equal(port("70000").result, 8080);
});
