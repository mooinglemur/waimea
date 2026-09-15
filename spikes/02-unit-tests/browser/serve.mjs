// Static server: /pyodide/ -> vendor/pyodide, /tree/ -> a make_tree.py output dir, / -> this directory.
// Usage: node serve.mjs <tree dir> [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [treeDir, portArg = "8233"] = process.argv.slice(2);
const here = resolve(new URL(".", import.meta.url).pathname);
const pyodideDir = resolve(new URL("../../../vendor/pyodide", import.meta.url).pathname);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".zip": "application/zip",
  ".apworld": "application/zip",
  ".whl": "application/zip",
  ".wasm": "application/wasm",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const [root, rel] = path.startsWith("/pyodide/") ? [pyodideDir, path.slice(9)]
    : path.startsWith("/tree/") ? [resolve(treeDir), path.slice(6)]
    : [here, path.slice(1)];
  const file = join(root, normalize(rel || "index.html"));
  if (!file.startsWith(root)) {
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
}).listen(Number(portArg), "127.0.0.1", () => console.log(`serving on http://localhost:${portArg}`));
