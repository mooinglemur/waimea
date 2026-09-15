import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { createHandler, PAGE_POLICY, WORKER_POLICY } from "../server/http.mjs";
import { loadRuntime } from "../server/runtime.mjs";

const inputs = {
  archipelago: { version: "0.6.7", repository: "ionium-ap/Archipelago", commit: "f".repeat(40) },
  fuzzer: { repository: "ionium-ap/Archipelago-fuzzer", commit: "a".repeat(40) },
  lobby: { repository: "ionium-ap/Archipelago-lobby", commit: "b".repeat(40) },
  pyodide: { version: "0.29.4" },
};

let root;
let servers = [];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "waimea-http-"));
  await mkdir(join(root, "web"));
  await mkdir(join(root, "pyodide"));
  await mkdir(join(root, "build"));
  await writeFile(join(root, "web", "index.html"), "<!doctype html><title>test</title>");
  await writeFile(join(root, "web", "app.mjs"), `export const text = "${"x".repeat(2000)}";`);
  await writeFile(join(root, "web", "fuzz-worker.mjs"), "globalThis.onmessage = () => {};");
  await writeFile(join(root, "pyodide", "pyodide.mjs"), "export {};");
  await writeFile(join(root, "build", "core.zip"), "not really a zip");
  await writeFile(join(root, "calibration.json"), JSON.stringify({ workload: { world: "tunic" }, reference: { seconds: [] } }));
  await writeFile(join(root, "secret.txt"), "outside the web directory");
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(root, { recursive: true, force: true });
});

async function serve({ withRuntime = true } = {}) {
  const runtime = withRuntime
    ? await loadRuntime({ coreBundle: join(root, "build", "core.zip"), calibrationFile: join(root, "calibration.json"), inputs })
    : null;
  const handle = createHandler({ webDir: join(root, "web"), pyodideDir: join(root, "pyodide"), pyodideVersion: "0.29.4", runtime });
  const server = createServer((req, res) => handle(req, res));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, runtime };
}

// Raw requests, so paths aren't normalized and encodings aren't decoded on the way.
function get(port, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the page gets the page policy and security headers", async () => {
  const { port } = await serve();
  const res = await get(port, "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-security-policy"], PAGE_POLICY);
  assert.doesNotMatch(PAGE_POLICY, /wasm-unsafe-eval/);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(res.headers["cache-control"], "no-cache");
});

test("worker scripts get the worker policy, which allows only this origin", async () => {
  const { port } = await serve();
  const res = await get(port, "/fuzz-worker.mjs");
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-security-policy"], WORKER_POLICY);
  assert.match(WORKER_POLICY, /default-src 'none'/);
  assert.match(WORKER_POLICY, /connect-src 'self'(;|$)/);
});

test("the manifest points at the content-hashed core bundle, which is immutable", async () => {
  const { port, runtime } = await serve();
  const res = await get(port, "/manifest.json");
  assert.equal(res.status, 200);
  const manifest = JSON.parse(res.body);
  assert.equal(manifest.core.url, `/bundles/core-${runtime.coreHash}.zip`);
  assert.equal(manifest.pyodide.base, "/runtime/pyodide-0.29.4/");
  assert.equal(manifest.archipelago.commit, inputs.archipelago.commit);
  assert.equal(manifest.calibration.workload.world, "tunic");

  const core = await get(port, manifest.core.url);
  assert.equal(core.status, 200);
  assert.equal(core.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(core.body.toString(), "not really a zip");
  assert.equal((await get(port, `/bundles/core-${"0".repeat(64)}.zip`)).status, 404);
});

test("the Pyodide runtime is served only under its pinned version", async () => {
  const { port } = await serve();
  const res = await get(port, "/runtime/pyodide-0.29.4/pyodide.mjs");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await get(port, "/runtime/pyodide-0.29.3/pyodide.mjs")).status, 404);
});

test("paths can't escape the web directory", async () => {
  const { port } = await serve();
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/runtime/pyodide-0.29.4/..%2f..%2fsecret.txt"]) {
    const res = await get(port, path);
    assert.equal(res.status === 404 || res.status === 400, true, `${path} -> ${res.status}`);
    assert.doesNotMatch(res.body.toString(), /outside the web directory/);
  }
});

test("text assets are compressed, and only GET and HEAD are allowed", async () => {
  const { port } = await serve();
  const res = await get(port, "/app.mjs", { headers: { "accept-encoding": "br, gzip" } });
  assert.equal(res.headers["content-encoding"], "br");
  assert.match(brotliDecompressSync(res.body).toString(), /^export const text/);
  assert.equal((await get(port, "/", { method: "POST" })).status, 405);
});

test("without a core bundle, readiness and the manifest fail but health passes", async () => {
  const { port } = await serve({ withRuntime: false });
  assert.equal((await get(port, "/healthz")).status, 200);
  assert.equal((await get(port, "/readyz")).status, 503);
  assert.equal((await get(port, "/manifest.json")).status, 503);
});
