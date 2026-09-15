// Static server for the browser fuzz spike. Usage: node serve.mjs <data dir> [port]
//   /         this directory (index.html, page.mjs)
//   /web/     the repository's web/ modules
//   /pyodide/ vendor/pyodide
//   /deploy/  deploy/ (calibration.json)
//   /data/    the data dir: core.zip and <world>.apworld files
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [dataDir, portArg = "8234"] = process.argv.slice(2);
if (!dataDir) {
  console.error("usage: node serve.mjs <data dir> [port]");
  process.exit(2);
}
const repo = resolve(new URL("../..", import.meta.url).pathname);
const roots = [
  ["/web/", join(repo, "web")],
  ["/pyodide/", join(repo, "vendor", "pyodide")],
  ["/deploy/", join(repo, "deploy")],
  ["/data/", resolve(dataDir)],
  ["/", resolve(new URL(".", import.meta.url).pathname)],
];
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
  const [prefix, root] = roots.find(([p]) => path.startsWith(p));
  const file = join(root, normalize(path.slice(prefix.length) || "index.html"));
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
