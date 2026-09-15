// HTTP interface: the web app, the Pyodide runtime, the core bundle, the manifest and health checks.
// Nothing here receives or runs apworld code; that all happens in the browser's workers.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip, constants as zlib } from "node:zlib";
import { log } from "./log.mjs";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
  ".whl": "application/zip",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
// Zips and wheels are already compressed.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".svg", ".txt"]);

// The page runs no Python itself, so it needs no WebAssembly compilation.
export const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' blob: data:",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Workers run apworld code, including apworlds users supply, so they may load scripts and fetch only
// from Waimea itself: Pyodide's runtime files, which Pyodide fetches as it starts.
export const WORKER_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
].join("; ");
const WORKER_SCRIPTS = new Set(["/fuzz-worker.mjs", "/test-worker.mjs"]);

const compressedBodies = new Map();

function compressedBody(path, info, encoding) {
  const key = `${path}|${info.mtimeMs}|${info.size}|${encoding}`;
  let body = compressedBodies.get(key);
  if (!body) {
    body = readFile(path).then((raw) =>
      encoding === "br"
        ? brotliAsync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : gzipAsync(raw, { level: 9 }),
    );
    body.catch(() => compressedBodies.delete(key));
    compressedBodies.set(key, body);
  }
  return body;
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

async function sendFile(req, res, path, { immutable = false, policy = null } = {}) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return sendText(res, 404, "not found");
  }
  if (!info.isFile()) return sendText(res, 404, "not found");

  const ext = extname(path);
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ETag: etag,
    Vary: "Accept-Encoding",
  };
  if (policy) headers["Content-Security-Policy"] = policy;
  else if (ext === ".html") headers["Content-Security-Policy"] = PAGE_POLICY;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const accepted = req.headers["accept-encoding"] ?? "";
  const encoding = !COMPRESSIBLE.has(ext) ? null : /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null;
  if (encoding) {
    const body = await compressedBody(path, info, encoding);
    res.writeHead(200, { ...headers, "Content-Encoding": encoding, "Content-Length": body.length });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  createReadStream(path).pipe(res);
}

/**
 * @param {object} options
 * @param {string} options.webDir
 * @param {string} options.pyodideDir
 * @param {string} options.pyodideVersion
 * @param {{coreHash: string, coreBundle: string, manifest: string} | null} options.runtime
 *   null until a core bundle is available, which makes /readyz and the manifest fail
 */
export function createHandler({ webDir, pyodideDir, pyodideVersion, runtime }) {
  return async function handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    let path;
    try {
      path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      return sendText(res, 400, "bad request");
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed");

    if (path === "/healthz") return sendText(res, 200, "ok");
    if (path === "/readyz") return runtime ? sendText(res, 200, "ready") : sendText(res, 503, "no core bundle");
    if (path === "/manifest.json") {
      if (!runtime) return sendText(res, 503, "no core bundle");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
      return res.end(req.method === "HEAD" ? undefined : runtime.manifest);
    }

    let match = path.match(/^\/runtime\/pyodide-([^/]+)\/([A-Za-z0-9._-]+)$/);
    if (match) {
      if (match[1] !== pyodideVersion) return sendText(res, 404, "not found");
      return sendFile(req, res, join(pyodideDir, match[2]), { immutable: true });
    }
    match = path.match(/^\/bundles\/core-([a-f0-9]{64})\.zip$/);
    if (match) {
      if (!runtime || match[1] !== runtime.coreHash) return sendText(res, 404, "not found");
      return sendFile(req, res, runtime.coreBundle, { immutable: true });
    }

    if (WORKER_SCRIPTS.has(path)) return sendFile(req, res, join(webDir, path.slice(1)), { policy: WORKER_POLICY });

    const file = normalize(join(webDir, path === "/" ? "index.html" : path));
    if (!file.startsWith(webDir + sep)) return sendText(res, 404, "not found");
    return sendFile(req, res, file);
  };
}

export function startHttp({ host, port, ...options }) {
  const handle = createHandler(options);
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log("request failed:", req.method, req.url, err.stack ?? err);
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "internal error");
    });
  });
  server.listen(port, host, () => log(`listening on [${host}]:${port}`));
  return server;
}
