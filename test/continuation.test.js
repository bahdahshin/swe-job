import test from "node:test";
import assert from "node:assert/strict";
import { continuationFor } from "../lib/continuation.js";

const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const rateLimited = { pagesFetched: 20, pagesRequested: 25, errors: [{ page: 20, rateLimited: true, error: "HTTP 429 for page 20 (rate limited)" }] };

test("explicit continuation returns a validated cursor and normalized ISO cooldown", () => {
  assert.deepEqual(continuationFor({
    pagesRequested: 25,
    continuation: { nextPage: 20, retryAt: "2026-10-07T20:01:00-04:00", delayMs: 10000 },
  }, NOW), { nextPage: 20, retryAt: "2026-10-08T00:01:00.000Z", delayMs: 10000 });
  assert.deepEqual(continuationFor({ pagesRequested: 1, continuation: { nextPage: 0, retryAt: null, delayMs: 0 } }),
    { nextPage: 0, retryAt: null, delayMs: 0 });
});

test("explicit null is terminal even when legacy fields suggest continuation", () => {
  assert.equal(continuationFor({ ...rateLimited, continuation: null }, NOW), null);
});

test("invalid explicit continuations never fall back to legacy inference", () => {
  const valid = { nextPage: 20, retryAt: null, delayMs: 10000 };
  for (const continuation of [
    undefined, false, {},
    { ...valid, nextPage: -1 }, { ...valid, nextPage: 25 }, { ...valid, nextPage: 1.5 },
    { ...valid, retryAt: "invalid" }, { ...valid, retryAt: undefined }, { ...valid, retryAt: 0 },
    { ...valid, delayMs: -1 }, { ...valid, delayMs: Infinity }, { ...valid, delayMs: "10000" },
  ]) assert.equal(continuationFor({ ...rateLimited, continuation }, NOW), null);
});

test("legacy rate limit retries its uncollected page after a fresh one-minute cooldown", () => {
  assert.deepEqual(continuationFor(rateLimited, NOW), { nextPage: 20, retryAt: "2026-10-08T00:01:00.000Z", delayMs: 10000 });
  assert.deepEqual(continuationFor({ pagesFetched: 0, errors: [{ page: 0, rateLimited: true }] }, NOW),
    { nextPage: 0, retryAt: "2026-10-08T00:01:00.000Z", delayMs: 10000 });
});

test("legacy cooldown is anchored to its saved timestamp across requests", () => {
  const saved = { ...rateLimited, fetchedAt: "2026-10-08T00:00:00.000Z" };
  assert.equal(continuationFor(saved, NOW).retryAt, "2026-10-08T00:01:00.000Z");
  assert.equal(continuationFor(saved, NOW + 120000).retryAt, "2026-10-08T00:01:00.000Z");
});

test("legacy time-budget stop resumes only when no page failed", () => {
  assert.deepEqual(continuationFor({ pagesFetched: 12, stoppedEarly: "time limit reached after 12 page(s)" }, NOW),
    { nextPage: 12, retryAt: null, delayMs: 5000 });
  assert.deepEqual(continuationFor({ pagesFetched: 12, errors: [], stoppedEarly: "time limit reached after 12 page(s)" }, NOW),
    { nextPage: 12, retryAt: null, delayMs: 5000 });
  assert.equal(continuationFor({ pagesFetched: 12, errors: [{ page: 4 }], stoppedEarly: "time limit reached after 12 page(s)" }, NOW), null);
});

test("ambiguous, finished and invalid legacy fetches cannot resume", () => {
  for (const data of [
    null, {}, { pagesFetched: 20 },
    { ...rateLimited, errors: [{ page: 19, rateLimited: true }] },
    { ...rateLimited, errors: [{ page: 19 }, { page: 20, rateLimited: true }] },
    { ...rateLimited, errors: [{ page: 20, rateLimited: false }] },
    { ...rateLimited, errors: {} },
    { ...rateLimited, pagesFetched: -1 }, { ...rateLimited, pagesFetched: 20.5 },
    { ...rateLimited, pagesFetched: 25 },
    { ...rateLimited, pagesRequested: 0 }, { ...rateLimited, pagesRequested: -1 },
    { ...rateLimited, pagesRequested: "25" },
  ]) assert.equal(continuationFor(data, NOW), null);
  assert.equal(continuationFor(rateLimited, NaN), null);
});

test("bot protection remains terminal for both explicit and legacy continuations", () => {
  for (const data of [
    { ...rateLimited, errors: [{ page: 20, rateLimited: true, blocked: true }] },
    { ...rateLimited, stoppedEarly: "HTTP 403 for page 20" },
    { ...rateLimited, stoppedEarly: "HiringCafe blocked this server's request" },
    { ...rateLimited, errors: [{ blocked: true }], continuation: { nextPage: 20, retryAt: null, delayMs: 10000 } },
  ]) assert.equal(continuationFor(data, NOW), null);
});
