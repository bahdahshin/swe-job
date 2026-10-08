import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/init\(\)\.catch\([\s\S]*$/, "");

const complete = (id = "2026-10-07T01-00-00-000Z") => ({
  id, fetchedAt: "2026-10-07T01:00:00.000Z", jobCount: 2, pagesFetched: 25,
  pagesRequested: 25, partial: false, jobs: [{ title: "Original result" }],
});
const partial = (id, pagesFetched, retryAt = null) => ({
  id, fetchedAt: "2026-10-07T02:00:00.000Z", jobCount: pagesFetched * 100,
  pagesFetched, pagesRequested: 25, partial: true, stoppedEarly: "HTTP 429",
  continuation: { nextPage: pagesFetched, retryAt, delayMs: 0 },
});

function stream(chunks) {
  return {
    ok: true,
    body: { pipeThrough: () => ({ getReader: () => ({
      read: async () => chunks.length ? { value: chunks.shift(), done: false } : { done: true },
    }) }) },
  };
}

function harness(fetches = [], onPost = () => { throw new Error("Unexpected refresh request"); }) {
  const elements = new Map();
  const statuses = [];
  const waits = [];
  const posts = [];
  let clock = Date.parse("2026-10-07T03:00:00.000Z");
  const getElement = (id) => {
    if (!elements.has(id)) {
      let text = "";
      elements.set(id, {
        value: "", disabled: false, options: [],
        add(option) { this.options.push(option); },
        set length(value) { this.options.length = value; },
        get textContent() { return text; },
        set textContent(value) { text = value; if (id === "refresh-status") statuses.push(value); },
        classList: { toggle() {} },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: getElement },
    Option: function(text, value) { this.text = text; this.value = value; },
    location: { href: "https://dashboard.test/", search: "" },
    history: { replaceState() {} }, URL, URLSearchParams, TextDecoderStream,
    Date: class extends Date { static now() { return clock; } },
    setTimeout(callback, ms) {
      waits.push({ ms, disabled: getElement("refresh").disabled, status: getElement("refresh-status").textContent });
      clock += ms;
      callback();
    },
    fetch: async (url, options) => {
      if (options?.method === "POST") {
        posts.push(url);
        const summary = await onPost(url, posts.length, api, getElement);
        if (summary?.ok === false) return summary;
        fetches = [summary, ...fetches];
        return stream([JSON.stringify({ type: "done", fetch: summary })]);
      }
      if (url === "/api/fetches") {
        return { ok: true, json: async () => ({
          defaultId: fetches.filter((f) => !f.partial).sort((a, b) => b.id.localeCompare(a.id))[0]?.id || null,
          fetches: fetches.map(({ jobs, ...summary }) => summary),
        }) };
      }
      const id = decodeURIComponent(url.slice("/api/fetches/".length));
      const data = fetches.find((f) => f.id === id);
      return { ok: !!data, status: 404, json: async () => data || { error: "Missing fetch" } };
    },
  });
  vm.runInContext(source + `
    setData = function(data) { state.jobs = data.jobs; $("fetch-select").value = data.id; };
    globalThis.api = { startRefresh, loadFetchList, readRefreshStream, showFetch, state,
      get pending() { return pendingRefresh; } };
  `, context);
  const api = context.api;
  return { api, posts, statuses, waits, getElement };
}

test("refresh stream processes a final event without a newline", async () => {
  const { api, statuses } = harness();
  const result = await api.readRefreshStream(stream([
    '{"type":"pro', 'gress","message":"Page 20"}\n', '{"type":"done","fetch":{"id":"saved"}}',
  ]));
  assert.equal(result.fetch.id, "saved");
  assert.deepEqual(statuses, ["Page 20"]);
});

test("history offers only a resumable partial newer than the latest complete and never starts it", async () => {
  const newer = partial("2026-10-07T04-00-00-000Z", 20);
  const old = partial("2026-10-07T00-00-00-000Z", 10);
  const h = harness([old, complete(), newer]);
  await h.api.loadFetchList();
  assert.equal(h.api.pending.id, newer.id);
  assert.equal(h.getElement("refresh").textContent, "Resume fetch");
  assert.equal(h.posts.length, 0);

  const stale = harness([old, complete()]);
  await stale.api.loadFetchList();
  assert.equal(stale.api.pending, null);
  assert.equal(stale.getElement("refresh").textContent, "Fetch now");
});

test("a rate limited fetch waits and resumes its saved ID while preserving displayed results", async () => {
  const original = complete();
  const checkpoint = partial("2026-10-07T04-00-00-000Z", 20, "2026-10-07T03:00:02.000Z");
  const finished = { ...complete("2026-10-07T05-00-00-000Z"), jobs: [{ title: "New result" }] };
  const h = harness([original], (url, count, api, getElement) => {
    assert.equal(getElement("refresh").disabled, true);
    if (count === 1) {
      assert.equal(url, "/api/refresh");
      return checkpoint;
    }
    assert.equal(url, `/api/refresh?resume=${encodeURIComponent(checkpoint.id)}`);
    assert.equal(api.state.jobs[0].title, "Original result");
    assert.equal(getElement("fetch-select").value, original.id);
    return finished;
  });
  await h.api.loadFetchList();
  await h.api.showFetch(original.id);
  await h.api.startRefresh();
  assert.equal(h.posts.length, 2);
  assert.equal(h.waits.reduce((sum, wait) => sum + wait.ms, 0), 2000);
  assert.ok(h.waits.every((wait) => wait.disabled && /continuing in/.test(wait.status)));
  assert.equal(h.api.state.jobs[0].title, "New result");
  assert.equal(h.api.pending, null);
  assert.equal(h.getElement("refresh").disabled, false);
  assert.equal(h.getElement("refresh").textContent, "Fetch now");
});

test("manual resume stops after three consecutive attempts without page progress", async () => {
  const original = complete();
  const checkpoint = partial("2026-10-07T04-00-00-000Z", 20);
  const h = harness([checkpoint, original], (url, count) => partial(`2026-10-07T04-00-0${count}-000Z`, 20));
  await h.api.loadFetchList();
  await h.api.showFetch(original.id);
  await h.api.startRefresh();
  assert.equal(h.posts.length, 3);
  assert.ok(h.posts[0].endsWith(`resume=${checkpoint.id}`));
  assert.equal(h.api.state.jobs[0].title, "Original result");
  assert.equal(h.getElement("refresh").textContent, "Resume fetch");
  assert.match(h.statuses.at(-1), /still rate limiting/);
});

test("automatic continuation is bounded to eight requests even when pages advance", async () => {
  const h = harness([complete()], (url, count) => partial(`2026-10-07T04-00-0${count}-000Z`, count));
  await h.api.loadFetchList();
  await h.api.showFetch(complete().id);
  await h.api.startRefresh();
  assert.equal(h.posts.length, 8);
  assert.equal(h.api.pending.pagesFetched, 8);
  assert.equal(h.getElement("refresh").textContent, "Resume fetch");
  assert.match(h.statuses.at(-1), /Automatic continuation paused/);
});

test("a partial without a continuation preserves results and stops", async () => {
  const failure = { ...partial("2026-10-07T04-00-00-000Z", 20), continuation: null };
  const h = harness([complete()], () => failure);
  await h.api.loadFetchList();
  await h.api.showFetch(complete().id);
  await h.api.startRefresh();
  assert.equal(h.posts.length, 1);
  assert.equal(h.api.state.jobs[0].title, "Original result");
  assert.equal(h.getElement("fetch-select").value, complete().id);
  assert.equal(h.getElement("refresh").textContent, "Fetch now");
  assert.match(h.statuses.at(-1), /Kept current results/);
});

test("a failed continuation leaves its saved checkpoint available for manual resume", async () => {
  const checkpoint = partial("2026-10-07T04-00-00-000Z", 20);
  const h = harness([complete()], (url, count) => count === 1 ? checkpoint : {
    ok: false, status: 503, json: async () => ({ error: "Temporarily unavailable" }),
  });
  await h.api.loadFetchList();
  await h.api.showFetch(complete().id);
  await h.api.startRefresh();
  assert.equal(h.api.pending.id, checkpoint.id);
  assert.equal(h.getElement("refresh").textContent, "Resume fetch");
  assert.match(h.statuses.at(-1), /Fetch failed: Temporarily unavailable/);
});
