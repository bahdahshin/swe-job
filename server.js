// Serves ./public and a JSON API of software engineer postings scraped from HiringCafe.
// Every fetch is saved to data/fetches/<id>.json; if none exist, one is fetched on startup.
// New fetches come from `npm run fetch` or the dashboard's "Fetch now" button (POST /api/refresh).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { fetchAllJobs, saveFetch, loadFetch, listFetches, defaultFetch } = require("./lib/fetch-jobs");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const FETCHES_DIR = path.join(__dirname, "data", "fetches");
const LEGACY_PATH = path.join(__dirname, "data", "jobs.json"); // single-file format used before fetch history

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---- data ------------------------------------------------------------------

let fetches = []; // summaries of saved fetches, newest first
let defaultData = null; // full data of defaultFetch(fetches), kept in memory for /api/jobs
let loadError = null;
// State of the current or last HiringCafe fetch, reported by GET /api/refresh.
const refreshState = { running: false, startedAt: null, finishedAt: null, progress: "", error: null, fetchId: null };

function reloadIndex() {
  fetches = listFetches(FETCHES_DIR);
  const def = defaultFetch(fetches);
  if (def && def.id !== defaultData?.id) defaultData = loadFetch(FETCHES_DIR, def.id);
}

async function refresh() {
  Object.assign(refreshState, { running: true, startedAt: new Date().toISOString(), finishedAt: null, progress: "Starting…", error: null, fetchId: null });
  try {
    const fresh = await fetchAllJobs({
      pages: Number(process.env.HIRINGCAFE_PAGES || 25),
      log: (line) => {
        console.log(line);
        refreshState.progress = line.trim();
      },
    });
    const saved = saveFetch(FETCHES_DIR, fresh);
    refreshState.fetchId = saved.id;
    reloadIndex();
    loadError = null;
    console.log(`Saved fetch ${saved.id} with ${saved.jobCount} postings`);
  } catch (err) {
    refreshState.error = err.message;
    console.error("Fetch failed:", err.message);
    throw err;
  } finally {
    Object.assign(refreshState, { running: false, finishedAt: new Date().toISOString() });
  }
}

async function loadData() {
  if (fs.existsSync(LEGACY_PATH)) {
    const saved = saveFetch(FETCHES_DIR, JSON.parse(fs.readFileSync(LEGACY_PATH, "utf8")));
    fs.unlinkSync(LEGACY_PATH);
    console.log(`Moved data/jobs.json into fetch history as ${saved.id}`);
  }
  reloadIndex();
  if (defaultData) {
    console.log(`${fetches.length} saved fetch(es); showing ${defaultData.id} (${defaultData.jobs.length} postings) by default`);
    return;
  }
  console.log("No saved fetches, fetching postings from HiringCafe...");
  await refresh();
}

// ---- HTTP ------------------------------------------------------------------

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": MIME[".json"] });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // The default fetch (newest complete one).
  if (url.pathname === "/api/jobs") {
    if (loadError) return sendJson(res, 500, { error: loadError.message });
    if (!defaultData) return sendJson(res, 503, { loading: true, error: "Still fetching postings from HiringCafe" });
    return sendJson(res, 200, { source: "hiringcafe", ...defaultData });
  }

  // Fetch history: GET /api/fetches lists summaries, GET /api/fetches/<id> returns one fetch in full.
  if (url.pathname === "/api/fetches") {
    return sendJson(res, 200, { defaultId: defaultData?.id || null, fetches });
  }
  const fetchMatch = url.pathname.match(/^\/api\/fetches\/([^/]+)$/);
  if (fetchMatch) {
    const data = loadFetch(FETCHES_DIR, decodeURIComponent(fetchMatch[1]));
    if (!data) return sendJson(res, 404, { error: "No saved fetch with that id" });
    return sendJson(res, 200, { source: "hiringcafe", ...data });
  }

  if (url.pathname === "/api/refresh") {
    if (req.method === "POST") {
      if (refreshState.running) return sendJson(res, 409, { ...refreshState, error: "A fetch is already running" });
      refresh().catch(() => {}); // outcome is reported through refreshState
      return sendJson(res, 202, refreshState);
    }
    return sendJson(res, 200, refreshState);
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

server.listen(PORT, () => console.log(`SWE job dashboard running at http://localhost:${PORT}`));
loadData().catch((err) => {
  loadError = err;
  console.error("Failed to load postings:", err);
});
