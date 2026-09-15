// Runtime configuration, read once from the environment.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.mjs";
import { portSetting } from "./settings.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const vendorDir = resolve(env.WAIMEA_VENDOR_DIR ?? join(appDir, "vendor"));

export const config = {
  appDir,
  vendorDir,
  webDir: join(appDir, "web"),
  pyodideDir: join(vendorDir, "pyodide"),
  // Built by build/build-core.mjs; core.json beside it describes the build.
  coreBundle: resolve(env.WAIMEA_CORE_BUNDLE ?? join(appDir, "build", "out", "core.zip")),
  calibrationFile: resolve(env.WAIMEA_CALIBRATION ?? join(appDir, "deploy", "calibration.json")),
  // Shown at the top left of the page and in the browser tab.
  siteName: env.WAIMEA_SITE_NAME?.trim() || "Waimea",
  host: env.WAIMEA_HOST ?? "::",
  port: portSetting(env, "WAIMEA_PORT", 8080, log),
  inputs: JSON.parse(readFileSync(join(vendorDir, "inputs.json"), "utf8")),
};
