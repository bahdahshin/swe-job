import { fetchAllJobs } from "./hiringcafe.js";
import { continuationFor } from "./continuation.js";

// Each request saves a new immutable snapshot, so continuation works across server instances.
export function createRefreshHandler({ store, pages = 25, timeBudgetMs = Infinity, fetchJobs = fetchAllJobs }) {
  let running = false; // local instance guard, not a distributed lock
  const reject = (res, status, error) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  return async function streamRefresh(req, res) {
    if (running) return reject(res, 409, "A fetch is already running");
    if (store.saveBlocker) return reject(res, 503, store.saveBlocker);
    running = true;
    let heartbeat;
    try {
      const resumeId = new URL(req.url, "http://localhost").searchParams.get("resume");
      const resume = resumeId ? await store.load(resumeId) : null;
      if (resumeId && !resume) return reject(res, 404, "No saved fetch with that id");
      if (resume && (!continuationFor(resume) || resume.query !== "software engineer")) {
        return reject(res, 400, "This saved fetch cannot be resumed. Start a new fetch.");
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const send = (event) => {
        if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
      };
      heartbeat = setInterval(() => send({ type: "ping" }), 15000);
      send({ type: "progress", message: resume
        ? `Continuing from page ${continuationFor(resume).nextPage}…`
        : `Starting (up to ${pages} pages)…` });
      const data = await fetchJobs({
        pages, timeBudgetMs, resume,
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
      console.error("Fetch failed:", err);
      if (!res.headersSent) reject(res, 500, err.message);
      else if (!res.destroyed) res.write(JSON.stringify({ type: "error", error: err.message }) + "\n");
    } finally {
      clearInterval(heartbeat);
      running = false;
      if (!res.writableEnded) res.end();
    }
  };
}
