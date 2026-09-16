// The Python runtime the page hands to its workers: the core bundle, named by content hash so it can be
// cached forever, and the manifest the page reads to find it and the Pyodide runtime.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { VERSION } from "./version.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadRuntime({ coreBundle, calibrationFile, inputs, siteName = "Waimea", version = VERSION }) {
  const core = await readFile(coreBundle);
  const coreHash = createHash("sha256").update(core).digest("hex");
  let build = null;
  try {
    build = await readJson(join(dirname(coreBundle), "core.json"));
  } catch {
    // Optional: only descriptive.
  }
  const manifest = {
    schema: 1,
    site: { name: siteName },
    version,
    archipelago: {
      version: inputs.archipelago.version,
      repository: inputs.archipelago.repository,
      commit: inputs.archipelago.commit,
    },
    fuzzer: { repository: inputs.fuzzer.repository, commit: inputs.fuzzer.commit },
    lobby: { repository: inputs.lobby.repository, commit: inputs.lobby.commit },
    pyodide: { version: inputs.pyodide.version, base: `/runtime/pyodide-${inputs.pyodide.version}/` },
    core: { url: `/bundles/core-${coreHash}.zip`, bytes: core.length, python: build?.python ?? null },
    calibration: await readJson(calibrationFile),
  };
  return { coreHash, coreBundle, manifest: JSON.stringify(manifest) };
}
