// Remote (streamable HTTP) front for Markdownify MCP, run with Bun.
//
// Upstream zcaceres/markdownify-mcp only speaks stdio. This file serves the same
// MCP server (upstream's createServer(), unchanged tools) over streamable HTTP on
// $PORT, behind a generated bearer token, and adds a small authenticated upload
// API so the file tools (pdf/docx/xlsx/pptx/image/audio) can be used remotely:
// upload a file, then pass the returned path to the tool.
//
//   GET  /healthz              200, no auth (Railway health check)
//   POST /mcp  (or POST /)     MCP streamable HTTP, stateless, Bearer token
//   PUT  /files/<name>         upload raw bytes, returns {"path": "/data/uploads/<name>"}
//   POST /files                multipart upload (field "file"), same answer
//   GET  /files                list uploads
//   DELETE /files/<name>       delete an upload
import { createServer } from "./dist/server.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.MCP_AUTH_TOKEN || "";
const DATA_DIR = process.env.MD_DATA_DIR || "/data";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MAX_UPLOAD = Number(process.env.MD_MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const MAX_DOWNLOAD = Number(process.env.MD_MAX_DOWNLOAD_BYTES || 100 * 1024 * 1024);
const MAX_CONCURRENT = Math.max(1, Number(process.env.MD_MAX_CONCURRENT || 1));
const VERSION = process.env.MARKDOWNIFY_VERSION || "unknown";

if (TOKEN.length < 24) {
  console.error("MCP_AUTH_TOKEN must be set (at least 24 characters); the template generates one.");
  process.exit(1);
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const tokenHash = createHash("sha256").update(TOKEN).digest();
function authorised(req: Request): boolean {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  return timingSafeEqual(createHash("sha256").update(m[1]).digest(), tokenHash);
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const unauthorised = () =>
  json(401, { error: "Unauthorized: send Authorization: Bearer <MCP_AUTH_TOKEN>" }, {
    "www-authenticate": 'Bearer realm="markdownify-mcp"',
  });

// ---------------------------------------------------------------------------
// Outbound fetch guard (used by webpage/youtube/bing tools). Upstream only blocks
// literal private IPs; on Railway the private network (*.railway.internal) and
// metadata addresses resolve from names, so resolve and check every address.
// Also cap the download size so one huge URL can't run the service out of memory.
function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    if (x.startsWith("::ffff:")) return privateAddress(x.slice(7));
    return /^(f[cd]|fe[89ab]|ff)/.test(x) || x.startsWith("64:ff9b:");
  }
  return true;
}

const realFetch = globalThis.fetch;
async function guardedFetch(input: any, init?: any): Promise<Response> {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(railway\.internal|localhost|internal)$/i.test(host)) {
    throw new Error(`Fetching ${url.href} is not allowed (private host).`);
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => privateAddress(a.address))) {
    throw new Error(`Fetching ${url.href} is not allowed (private address).`);
  }
  const res = await realFetch(input, init);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_DOWNLOAD) {
    throw new Error(`Download too large (${len} bytes, limit ${MAX_DOWNLOAD}).`);
  }
  if (!res.body) return res;
  let seen = 0;
  const limited = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        seen += chunk.byteLength;
        if (seen > MAX_DOWNLOAD) {
          ctrl.error(new Error(`Download too large (limit ${MAX_DOWNLOAD} bytes).`));
          return;
        }
        ctrl.enqueue(chunk);
      },
    }),
  );
  const headers = new Headers(res.headers);
  // Bun has already decoded the body; don't let the encoding be applied twice.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(limited, { status: res.status, statusText: res.statusText, headers });
}
globalThis.fetch = guardedFetch as typeof fetch;

// ---------------------------------------------------------------------------
// One conversion at a time by default: each markitdown run is a separate Python
// process of 150-300 MB, so parallel runs would not fit Railway's 0.5 GB plan.
let running = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream and no sessions to delete.
    return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, { allow: "POST" });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }
  const msgs = Array.isArray(body) ? body : [body];
  const callsTool = msgs.some((m: any) => m && m.method === "tools/call");
  const run = async () => {
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { parsedBody: body });
    } finally {
      // JSON responses are complete once handleRequest resolves.
      transport.close().catch(() => {});
      server.close().catch(() => {});
    }
  };
  return callsTool ? withSlot(run) : run();
}

// ---------------------------------------------------------------------------
function safeName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  name = path.basename(name).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!name || name.startsWith(".") || name.length > 200) return null;
  return name;
}

async function saveUpload(name: string, data: Blob | ReadableStream | null): Promise<Response> {
  if (!data) return json(400, { error: "Empty body." });
  const dest = path.join(UPLOAD_DIR, name);
  const tmp = dest + ".part";
  let size = 0;
  const out = fs.createWriteStream(tmp);
  const stream = data instanceof Blob ? data.stream() : data;
  try {
    for await (const chunk of stream as any) {
      size += chunk.byteLength;
      if (size > MAX_UPLOAD) throw new Error(`File too large (limit ${MAX_UPLOAD} bytes).`);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())));
    fs.renameSync(tmp, dest);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    return json(413, { error: (e as Error).message });
  }
  return json(201, { path: dest, size });
}

async function handleFiles(req: Request, rest: string): Promise<Response> {
  if (rest === "" || rest === "/") {
    if (req.method === "GET") {
      const files = fs
        .readdirSync(UPLOAD_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.endsWith(".part"))
        .map((d) => {
          const p = path.join(UPLOAD_DIR, d.name);
          const st = fs.statSync(p);
          return { path: p, size: st.size, modified: st.mtime.toISOString() };
        });
      return json(200, { files });
    }
    if (req.method === "POST") {
      const ct = req.headers.get("content-type") || "";
      if (!ct.includes("multipart/form-data")) {
        return json(400, { error: "Use multipart/form-data with a 'file' field, or PUT /files/<name>." });
      }
      const len = Number(req.headers.get("content-length") || 0);
      if (len > MAX_UPLOAD + 64 * 1024) return json(413, { error: `File too large (limit ${MAX_UPLOAD} bytes).` });
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) return json(400, { error: "Missing 'file' field." });
      const name = safeName((file as File).name || "upload");
      if (!name) return json(400, { error: "Bad file name." });
      return saveUpload(name, file);
    }
    return json(405, { error: "Method not allowed." }, { allow: "GET, POST" });
  }
  const name = safeName(rest.replace(/^\//, ""));
  if (!name) return json(400, { error: "Bad file name." });
  const p = path.join(UPLOAD_DIR, name);
  if (req.method === "PUT") return saveUpload(name, req.body);
  if (req.method === "DELETE") {
    if (!fs.existsSync(p)) return json(404, { error: "Not found." });
    fs.rmSync(p);
    return json(200, { deleted: p });
  }
  if (req.method === "GET") {
    if (!fs.existsSync(p)) return json(404, { error: "Not found." });
    return new Response(Bun.file(p));
  }
  return json(405, { error: "Method not allowed." }, { allow: "GET, PUT, DELETE" });
}

const LANDING = `Markdownify MCP ${VERSION} (remote MCP server, streamable HTTP)

MCP endpoint: POST /mcp with header  Authorization: Bearer <MCP_AUTH_TOKEN>
Uploads:      PUT /files/<name>  (same header), then pass the returned path to a file tool
Health:       GET /healthz
`;

Bun.serve({
  port: PORT,
  hostname: "::",
  maxRequestBodySize: MAX_UPLOAD + 1024 * 1024,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p === "/healthz") {
      return json(200, { status: "ok", version: VERSION });
    }
    if (p === "/" && req.method === "GET" && !req.headers.get("authorization")) {
      return new Response(LANDING, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (p.startsWith("/.well-known/")) {
      // No OAuth: clients must send the bearer token from the template variables.
      return json(404, { error: "Not found." });
    }
    if (!authorised(req)) return unauthorised();
    if (p === "/mcp" || p === "/") return handleMcp(req);
    if (p === "/files" || p.startsWith("/files/")) return handleFiles(req, p.slice("/files".length));
    return json(404, { error: "Not found." });
  },
  error(err) {
    console.error("request failed:", err);
    return json(500, { error: "Internal error." });
  },
});

console.log(
  `Markdownify MCP ${VERSION} listening on :${PORT} (/mcp, /files, /healthz); ` +
    `uploads in ${UPLOAD_DIR}, max ${MAX_CONCURRENT} conversion(s) at a time`,
);
