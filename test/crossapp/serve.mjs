// Cross-app run helper (not part of CI): an HTTPS front for the local server, and static hosts for the app builds.
//
//   node test/crossapp/serve.mjs --cert cert.pem --key key.pem --api 8080 --tls 8443 \
//        --site 7001=/path/rider/build/web --site 7002=/path/driver/build/web --site 7003=/path/admin/webapp/dist
//
// The rider app refuses a non-https API in a staging build, so the server (plain HTTP on --api) is reached through
// https://localhost:<tls>. Every site falls back to its index.html for unknown paths (single-page apps).
import { readFileSync, existsSync, statSync } from "node:fs";
import { createServer as createHttps } from "node:https";
import { createServer as createHttp, request } from "node:http";
import { extname, join, normalize } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(`--${name}`) + 1];
const sites = args.flatMap((a, i) => (a === "--site" ? [args[i + 1].split("=")] : []));
const apiPort = Number(opt("api"));

createHttps({ cert: readFileSync(opt("cert")), key: readFileSync(opt("key")) }, (req, res) => {
  const up = request({ host: "127.0.0.1", port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(Number(opt("tls")), "127.0.0.1");

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2", ".ico": "image/x-icon" };
for (const [port, root] of sites) {
  createHttp((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = existsSync(join(file, "index.html")) ? join(file, "index.html") : join(root, "index.html");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  }).listen(Number(port), "127.0.0.1");
}
console.log("crossapp serve ready");
