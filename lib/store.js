// Fetch history storage. Each fetch is saved once and never modified, keyed by an id made from its timestamp.
//
// - Vercel Blob when a Blob store is connected (BLOB_READ_WRITE_TOKEN, or BLOB_STORE_ID with Vercel OIDC):
//     fetches/<id>.json    the full fetch
//     summaries/<id>.json  a small summary, so listing the history doesn't download every fetch
// - Otherwise files in data/fetches/<id>.json. On Vercel those files are read-only (they ship with the
//   deployment), so saving there fails with an error that says to connect a Blob store.
import fs from "node:fs";
import path from "node:path";
import { put, list, get } from "@vercel/blob";

const FETCH_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const fetchId = (fetchedAt) => fetchedAt.replace(/[:.]/g, "-");

function summarize(id, data) {
  const failedPages = data.errors.length;
  return {
    id,
    fetchedAt: data.fetchedAt,
    jobCount: data.jobs.length,
    pagesFetched: data.pagesFetched,
    failedPages,
    stoppedEarly: data.stoppedEarly || null,
    partial: Boolean(failedPages || data.stoppedEarly),
    totalResults: data.totalResults,
  };
}

// The fetch to show by default: the newest complete one, else the newest one.
const defaultFetch = (summaries) => summaries.find((s) => !s.partial) || summaries[0] || null;

const newestFirst = (a, b) => (a.id < b.id ? 1 : -1);

function checkSavable(data) {
  if (!data.jobs.length) {
    const why = data.stoppedEarly || data.errors[0]?.error || "no matching postings";
    throw new Error(`No postings fetched, nothing saved (${why})`);
  }
}

// ---- local files -------------------------------------------------------------

const NO_BLOB_ON_VERCEL = "Can't save fetches on Vercel without a Blob store. Connect one to this project (Storage → Blob) and redeploy.";

function createFileStore(dir) {
  const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  return {
    kind: "files",
    // Why saving can't work here, if it can't; checked before a fetch so it fails fast.
    saveBlocker: process.env.VERCEL ? NO_BLOB_ON_VERCEL : null,
    async save(data) {
      checkSavable(data);
      if (this.saveBlocker) throw new Error(this.saveBlocker);
      const id = fetchId(data.fetchedAt);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
      return summarize(id, data);
    },
    async load(id) {
      if (!FETCH_ID.test(id) || !fs.existsSync(path.join(dir, `${id}.json`))) return null; // id check also blocks path traversal
      return { id, ...read(id) };
    },
    async list() {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .map((name) => name.replace(/\.json$/, ""))
        .filter((id) => FETCH_ID.test(id))
        .map((id) => summarize(id, read(id)))
        .sort(newestFirst);
    },
  };
}

// ---- Vercel Blob ---------------------------------------------------------------

// `sdk` is injectable so the store logic can be tested without a real Blob store.
function createBlobStore({ access = "private", sdk = { put, list, get } } = {}) {
  // Saved fetches never change, so anything read once can be cached for the life of the instance.
  const summaries = new Map();
  const fullCache = new Map(); // small LRU of full fetches
  const FULL_CACHE_SIZE = 3;

  const readJson = async (pathname) => {
    const result = await sdk.get(pathname, { access });
    if (!result || result.statusCode !== 200) return null;
    return new Response(result.stream).json();
  };
  const writeJson = (pathname, value) =>
    sdk.put(pathname, JSON.stringify(value), { access, contentType: "application/json", addRandomSuffix: false });

  const remember = (id, data) => {
    fullCache.delete(id);
    fullCache.set(id, data);
    if (fullCache.size > FULL_CACHE_SIZE) fullCache.delete(fullCache.keys().next().value);
  };

  return {
    kind: "blob",
    saveBlocker: null,
    async save(data) {
      checkSavable(data);
      const id = fetchId(data.fetchedAt);
      const summary = summarize(id, data);
      await writeJson(`fetches/${id}.json`, data); // full data first, so a listed summary always has its fetch
      await writeJson(`summaries/${id}.json`, summary);
      summaries.set(id, summary); // listing can lag briefly behind a write; this instance sees it right away
      remember(id, { id, ...data });
      return summary;
    },
    async load(id) {
      if (!FETCH_ID.test(id)) return null;
      if (fullCache.has(id)) {
        const data = fullCache.get(id);
        remember(id, data);
        return data;
      }
      const data = await readJson(`fetches/${id}.json`);
      if (!data) return null;
      remember(id, { id, ...data });
      return { id, ...data };
    },
    async list() {
      const ids = [];
      let cursor;
      do {
        const page = await sdk.list({ prefix: "summaries/", cursor });
        for (const blob of page.blobs) {
          const id = blob.pathname.slice("summaries/".length).replace(/\.json$/, "");
          if (FETCH_ID.test(id)) ids.push(id);
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      for (const id of summaries.keys()) if (!ids.includes(id)) ids.push(id);

      const missing = ids.filter((id) => !summaries.has(id));
      const loaded = await Promise.all(missing.map((id) => readJson(`summaries/${id}.json`)));
      missing.forEach((id, i) => loaded[i] && summaries.set(id, loaded[i]));
      return ids.filter((id) => summaries.has(id)).map((id) => summaries.get(id)).sort(newestFirst);
    },
  };
}

const blobConfigured = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

function createStore({ dir }) {
  if (blobConfigured()) return createBlobStore({ access: process.env.BLOB_ACCESS === "public" ? "public" : "private" });
  return createFileStore(dir);
}

export { createStore, createFileStore, createBlobStore, defaultFetch, summarize, FETCH_ID };
