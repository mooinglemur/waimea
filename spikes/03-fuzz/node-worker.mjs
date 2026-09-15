// Runs web/fuzz-worker.mjs in a Node worker thread, providing the browser worker globals it uses.
import { parentPort } from "node:worker_threads";

globalThis.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (data) => globalThis.onmessage?.({ data }));
await import("../../web/fuzz-worker.mjs");
