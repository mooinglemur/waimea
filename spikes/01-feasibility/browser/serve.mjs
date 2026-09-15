// Static server: /pyodide/ -> Kalapana's vendored Pyodide, /browser/ -> probe page, / -> spike dir.
// Usage: node serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const port = Number(process.argv[2] ?? 8231);
const spikeDir = resolve(new URL("..", import.meta.url).pathname);
const pyodideDir = "/home/troy/src/kalapana/vendor/pyodide";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".py": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".whl": "application/zip",
  ".wasm": "application/wasm",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const [root, rel] = path.startsWith("/pyodide/") ? [pyodideDir, path.slice(9)] : [spikeDir, path.slice(1)];
  const file = join(root, normalize(rel || "browser/index.html"));
  if (!file.startsWith(resolve(root))) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`serving on http://localhost:${port}`));
