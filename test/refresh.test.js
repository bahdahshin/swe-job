import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRefreshHandler } from "../lib/refresh.js";
import { createFileStore, defaultFetch } from "../lib/store.js";

const partial = {
  fetchedAt: "2026-10-08T00:00:00.000Z",
  query: "software engineer",
  totalResults: 3000,
  pagesFetched: 20,
  pagesRequested: 25,
  stoppedEarly: "HTTP 429 for page 20 (rate limited)",
  errors: [{ page: 20, error: "HTTP 429 for page 20 (rate limited)", rateLimited: true, blocked: false }],
  continuation: { nextPage: 20, retryAt: "2026-10-08T00:01:00.000Z", delayMs: 10000 },
  jobs: [{ id: "first", dedupClusterId: "cluster-first" }, { id: "second", dedupClusterId: "cluster-second" }],
};

async function fixture(t, fetchJobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swe-refresh-test-"));
  let store;
  let handler;
  const replaceInstance = (nextFetchJobs) => {
    store = createFileStore(dir);
    store.saveBlocker = null; // simulate a writable local store even in a CI environment
    handler = createRefreshHandler({ store, pages: 25, timeBudgetMs: 75000, fetchJobs: nextFetchJobs });
  };
  replaceInstance(fetchJobs);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const handle = async () => {
      if (url.pathname === "/api/fetches") {
        const fetches = await store.list();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fetches, defaultId: defaultFetch(fetches)?.id || null }));
        return;
      }
      await handler(req, res);
    };
    handle().catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    // mkdtemp must have produced exactly the named test directory under the temp root.
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith("swe-refresh-test-"));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get store() { return store; }, replaceInstance, request: (url, options) => fetch(`${base}${url}`, options) };
}

async function refresh(f, resumeId) {
  const response = await f.request(`/api/refresh${resumeId === undefined ? "" : `?resume=${encodeURIComponent(resumeId)}`}`, { method: "POST" });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    events: response.ok ? body.trim().split("\n").map((line) => JSON.parse(line)) : [],
    error: response.ok ? null : JSON.parse(body).error,
  };
}

test("HTTP refresh resumes an immutable partial snapshot on a new server instance and makes completion the default", async (t) => {
  let initialCalls = 0;
  const f = await fixture(t, async (options) => {
    initialCalls++;
    assert.equal(options.resume, null);
    assert.equal(options.pages, 25);
    assert.equal(options.timeBudgetMs, 75000);
    return structuredClone(partial);
  });
  const first = await refresh(f);
  assert.equal(first.status, 200);
  assert.match(first.contentType, /application\/x-ndjson/);
  const savedPartial = first.events.find((event) => event.type === "done").fetch;
  assert.equal(savedPartial.partial, true);
  assert.deepEqual(savedPartial.continuation, partial.continuation);
  assert.equal(initialCalls, 1);

  let resumedCalls = 0;
  const complete = {
    ...partial,
    fetchedAt: "2026-10-08T00:02:00.000Z",
    pagesFetched: 25,
    stoppedEarly: null,
    errors: [],
    continuation: null,
    resumedFrom: savedPartial.id,
    jobs: [...partial.jobs, { id: "third", dedupClusterId: "cluster-third" }],
  };
  f.replaceInstance(async (options) => {
    resumedCalls++;
    assert.deepEqual(options.resume, { id: savedPartial.id, ...partial });
    assert.deepEqual(options.resume.jobs, partial.jobs);
    assert.equal(options.resume.continuation.nextPage, 20);
    return structuredClone(complete);
  });
  const second = await refresh(f, savedPartial.id);
  assert.equal(second.status, 200);
  assert.match(second.events[0].message, /Continuing from page 20/);
  const savedComplete = second.events.find((event) => event.type === "done").fetch;
  assert.notEqual(savedComplete.id, savedPartial.id);
  assert.equal(savedComplete.partial, false);
  assert.equal(savedComplete.continuation, null);
  assert.equal(savedComplete.resumedFrom, savedPartial.id);
  assert.equal(savedComplete.jobCount, 3);
  assert.equal(resumedCalls, 1);
  assert.deepEqual(await f.store.load(savedPartial.id), { id: savedPartial.id, ...partial });
  assert.deepEqual(await f.store.load(savedComplete.id), { id: savedComplete.id, ...complete });

  const history = await (await f.request("/api/fetches")).json();
  assert.equal(history.defaultId, savedComplete.id);
  assert.deepEqual(history.fetches.map((entry) => entry.id), [savedComplete.id, savedPartial.id]);
});

test("HTTP resume rejects missing, invalid, terminal, blocked and mismatched-query snapshots without fetching", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error("Rejected resume must not fetch"); });
  for (const id of ["2026-10-08T00-00-00-000Z", "../../outside-the-store"]) {
    const result = await refresh(f, id);
    assert.equal(result.status, 404);
    assert.match(result.error, /No saved fetch/);
  }
  const rejected = [
    { continuation: null, errors: [], stoppedEarly: null, pagesFetched: 25 },
    { continuation: { nextPage: 25, retryAt: null, delayMs: 10000 } },
    { errors: [{ page: 20, blocked: true }], stoppedEarly: "HTTP 403 for page 20" },
    { query: "data scientist" },
  ];
  for (const [index, fields] of rejected.entries()) {
    const summary = await f.store.save({ ...partial, ...fields, fetchedAt: `2026-10-08T00:0${index + 3}:00.000Z` });
    const result = await refresh(f, summary.id);
    assert.equal(result.status, 400);
    assert.match(result.error, /cannot be resumed/);
  }
  assert.equal(calls, 0);
  assert.equal((await f.store.list()).length, rejected.length);
});
