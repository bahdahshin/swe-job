import test from "node:test";
import assert from "node:assert/strict";
import { createBlobStore } from "../lib/store.js";

test("legacy Blob summaries expose a resume cursor from their saved full snapshot", async () => {
  const id = "2026-10-08T00-00-00-000Z";
  const data = {
    fetchedAt: "2026-10-08T00:00:00.000Z", query: "software engineer",
    pagesFetched: 20, pagesRequested: 25, jobs: [{ id: "job" }],
    errors: [{ page: 20, rateLimited: true }], stoppedEarly: "HTTP 429",
  };
  const reads = [];
  const store = createBlobStore({ sdk: {
    list: async () => ({ blobs: [{ pathname: `summaries/${id}.json` }], hasMore: false }),
    get: async (pathname) => {
      reads.push(pathname);
      return { statusCode: 200, stream: new Response(JSON.stringify(pathname.startsWith("summaries/")
        ? { id, partial: true, pagesFetched: 20, jobCount: 1 }
        : data)).body };
    },
    put: async () => assert.fail("listing must not rewrite an existing snapshot"),
  } });
  const [summary] = await store.list();
  assert.equal(summary.continuation.nextPage, 20);
  assert.equal(summary.continuation.retryAt, "2026-10-08T00:01:00.000Z");
  assert.equal(summary.pagesRequested, 25);
  await store.list();
  assert.deepEqual(reads, [`summaries/${id}.json`, `fetches/${id}.json`]);
});
