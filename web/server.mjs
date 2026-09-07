import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "web");
const DATA_DIR = path.join(ROOT, "data");
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function safeJoin(base, rel) {
  const target = path.normalize(path.join(base, rel));
  return target.startsWith(base + path.sep) ? target : null;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";

  let base = WEB_DIR;
  let rel = pathname.replace(/^\/+/, "");
  const m = pathname.match(/^\/(web|data)\/(.+)$/);
  if (m) {
    base = m[1] === "data" ? DATA_DIR : WEB_DIR;
    rel = m[2];
  }

  const file = safeJoin(base, rel);
  if (!file || (base === DATA_DIR && path.extname(file) !== ".json")) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Discos web UI running at http://localhost:${PORT}`);
});