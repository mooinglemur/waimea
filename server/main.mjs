import { config } from "./config.mjs";
import { startHttp } from "./http.mjs";
import { log } from "./log.mjs";
import { loadRuntime } from "./runtime.mjs";

const { archipelago, fuzzer, pyodide } = config.inputs;
log(
  `waimea starting: Archipelago ${archipelago.version} (${archipelago.repository}@${archipelago.commit.slice(0, 7)}),`,
  `fuzzer ${fuzzer.repository}@${fuzzer.commit.slice(0, 7)}, Pyodide ${pyodide.version}`,
);

let runtime = null;
try {
  runtime = await loadRuntime(config);
  log(`core bundle ${runtime.coreHash.slice(0, 12)} from ${config.coreBundle}`);
} catch (err) {
  // Kept serving so health checks and the page can explain; /readyz reports it.
  log(`no usable core bundle at ${config.coreBundle}: ${err.message}`);
}

const server = startHttp({
  host: config.host,
  port: config.port,
  webDir: config.webDir,
  pyodideDir: config.pyodideDir,
  pyodideVersion: pyodide.version,
  runtime,
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
