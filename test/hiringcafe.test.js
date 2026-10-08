import test from "node:test";
import assert from "node:assert/strict";
import { fetchAllJobs, retryAfterMs } from "../lib/hiringcafe.js";

function fixture(statuses) {
  let time = 0;
  const requests = [];
  const waits = [];
  let closed = false;
  return {
    requests, waits,
    get closed() { return closed; },
    runtime: {
      now: () => time,
      sleep: async (ms) => { waits.push(ms); time += ms; },
      createSession: async () => ({
        close: async () => { closed = true; },
        fetch: async (url) => {
          requests.push(Number(new URL(url).searchParams.get("page")));
          const status = statuses.shift() ?? 200;
          return {
            ok: status === 200, status,
            headers: new Headers({ "retry-after": "0" }),
            text: async () => status === 200
              ? '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: {
                ssrHits: [{ id: "job", job_information: { title: "Software Engineer" },
                  v5_processed_job_data: { workplace_countries: ["US"] } }],
                ssrTotalCount: 100,
              } } }) + '</script>' : '',
          };
        },
      }),
    },
  };
}

test("Retry-After supports seconds, HTTP dates, zero and invalid values", () => {
  assert.equal(retryAfterMs("12"), 12000);
  assert.equal(retryAfterMs("0"), 0);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:01:00 GMT", 10000), 50000);
  assert.equal(retryAfterMs(null), 60000);
  assert.equal(retryAfterMs("invalid"), 60000);
});

test("rate limits retry the same page with backoff and slower subsequent pacing", async () => {
  const f = fixture([200, 429, 429, 200, 200]);
  const data = await fetchAllJobs({ pages: 3, log: () => {} }, f.runtime);
  assert.deepEqual(f.requests, [0, 1, 1, 1, 2]);
  assert.deepEqual(f.waits, [5000, 15000, 30000, 10000]);
  assert.equal(data.pagesFetched, 3);
  assert.equal(data.stoppedEarly, null);
  assert.deepEqual(data.errors, []);
  assert.equal(f.closed, true);
});

test("retry respects time budget and preserves collected jobs", async () => {
  const f = fixture([200, 429]);
  const data = await fetchAllJobs({ pages: 3, timeBudgetMs: 45000, log: () => {} }, f.runtime);
  assert.deepEqual(f.requests, [0, 1]);
  assert.deepEqual(f.waits, [5000]);
  assert.equal(data.jobs.length, 1);
  assert.equal(data.errors[0].rateLimited, true);
  assert.match(data.stoppedEarly, /429/);
  assert.equal(f.closed, true);
});

test("persistent rate limiting exhausts bounded retries and closes session", async () => {
  const f = fixture([429, 429, 429, 429, 429]);
  const data = await fetchAllJobs({ log: () => {} }, f.runtime);
  assert.equal(f.requests.length, 5);
  assert.deepEqual(f.waits, [15000, 30000, 60000, 120000]);
  assert.equal(data.pagesFetched, 0);
  assert.equal(f.closed, true);
});

test("blocked requests stop immediately with an actionable local-fetch instruction", async () => {
  const f = fixture([403]);
  const data = await fetchAllJobs({ log: () => {} }, f.runtime);
  assert.deepEqual(f.requests, [0]);
  assert.deepEqual(f.waits, []);
  assert.equal(data.errors[0].blocked, true);
  assert.match(data.stoppedEarly, /npm run fetch/);
  assert.equal(f.closed, true);
});
