// Serves ./public and a JSON API of software engineer postings scraped from HiringCafe.
// Fetches are saved through lib/store.js: Vercel Blob when a Blob store is connected, data/fetches/ otherwise.
// New fetches come from `npm run fetch` or the dashboard's "Fetch now" button (POST /api/refresh).
//
// Nothing here relies on state surviving between requests, because on Vercel each request can land on a
// different instance: history is read from the store, and a manual fetch runs inside its own request,
// streaming progress back until it finishes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllJobs } from "./lib/hiringcafe.js";
import { createStore, defaultFetch } from "./lib/store.js";

// Written as `new URL(..., import.meta.url)` so Vercel's file tracing copies these folders into the function.
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const FETCHES_DIR = fileURLToPath(new URL("./data/fetches", import.meta.url));

const PAGES = Number(process.env.HIRINGCAFE_PAGES || 25);
// Vercel functions stop after 300s by default; finish and save well before that.
const TIME_BUDGET_MS = Number(process.env.HIRINGCAFE_TIME_BUDGET_MS || (process.env.VERCEL ? 240000 : Infinity));

const store = createStore({ dir: FETCHES_DIR });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

// ---- API ---------------------------------------------------------------------

async function listFetches() {
  const fetches = await store.list();
  return { storage: store.kind, defaultId: defaultFetch(fetches)?.id || null, fetches };
}

let refreshRunning = false; // only guards this instance; another instance could still start a fetch

// Streams newline-delimited JSON: {type:"progress",message} lines, then {type:"done",fetch} or {type:"error",error}.
async function streamRefresh(req, res) {
  if (refreshRunning) return sendJson(res, 409, { error: "A fetch is already running" });
  if (store.saveBlocker) return sendJson(res, 503, { error: store.saveBlocker }); // don't spend minutes fetching what can't be saved
  refreshRunning = true;
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  const send = (event) => {
    if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
  };
  const heartbeat = setInterval(() => send({ type: "ping" }), 15000); // keeps the connection busy during rate-limit waits
  try {
    send({ type: "progress", message: `Starting (up to ${PAGES} pages)…` });
    const data = await fetchAllJobs({
      pages: PAGES,
      timeBudgetMs: TIME_BUDGET_MS,
      log: (line) => {
        console.log(line);
        send({ type: "progress", message: line.trim() });
      },
    });
    send({ type: "progress", message: `Saving ${data.jobs.length} postings…` });
    const summary = await store.save(data);
    console.log(`Saved fetch ${summary.id} with ${summary.jobCount} postings (${store.kind})`);
    send({ type: "done", fetch: summary });
  } catch (err) {
    console.error("Fetch failed:", err); // full stack, so deploy logs show where it broke
    send({ type: "error", error: err.message });
  } finally {
    clearInterval(heartbeat);
    refreshRunning = false;
    res.end();
  }
}

async function handleApi(req, res, url) {
  // The default fetch (newest complete one).
  if (url.pathname === "/api/jobs") {
    const { defaultId } = await listFetches();
    const data = defaultId && (await store.load(defaultId));
    if (!data) return sendJson(res, 404, { empty: true, error: "No saved fetches yet. Use Fetch now to get postings." });
    return sendJson(res, 200, { source: "hiringcafe", ...data });
  }

  // Fetch history: GET /api/fetches lists summaries, GET /api/fetches/<id> returns one fetch in full.
  if (url.pathname === "/api/fetches") return sendJson(res, 200, await listFetches());
  const fetchMatch = url.pathname.match(/^\/api\/fetches\/([^/]+)$/);
  if (fetchMatch) {
    const data = await store.load(decodeURIComponent(fetchMatch[1]));
    if (!data) return sendJson(res, 404, { error: "No saved fetch with that id" });
    return sendJson(res, 200, { source: "hiringcafe", ...data });
  }

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST to start a fetch" });
    return streamRefresh(req, res);
  }

  return sendJson(res, 404, { error: "Unknown API route" });
}

// ---- HTTP ------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      console.error(`${req.method} ${url.pathname} failed:`, err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
    return;
  }

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, body) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  });
});

server.listen(PORT, () => console.log(`SWE job dashboard running at http://localhost:${PORT} (fetch storage: ${store.kind})`));
