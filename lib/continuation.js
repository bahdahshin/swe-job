// Resume only a known contiguous prefix of a fetch. Saved snapshots remain immutable;
// the caller uses this cursor to create the next snapshot after the cooldown.
function continuationFor(data, now = Date.now()) {
  if (!data || typeof data !== "object") return null;
  const errors = data.errors ?? [];
  if (!Array.isArray(errors)) return null;
  if (errors.some((error) => error?.blocked) || /HTTP 403|blocked|bot protection/i.test(data.stoppedEarly || "")) return null;

  const pagesRequested = data.pagesRequested === undefined ? 25 : data.pagesRequested;
  if (!Number.isInteger(pagesRequested) || pagesRequested <= 0) return null;
  const validPage = (page) => Number.isInteger(page) && page >= 0 && page < pagesRequested;

  if (Object.hasOwn(data, "continuation")) {
    const continuation = data.continuation;
    if (!continuation || typeof continuation !== "object" || !validPage(continuation.nextPage)) return null;
    if (!Number.isFinite(continuation.delayMs) || continuation.delayMs < 0) return null;
    let retryAt = null;
    if (continuation.retryAt !== null) {
      if (typeof continuation.retryAt !== "string") return null;
      const retryTime = Date.parse(continuation.retryAt);
      if (!Number.isFinite(retryTime)) return null;
      retryAt = new Date(retryTime).toISOString();
    }
    return { nextPage: continuation.nextPage, retryAt, delayMs: continuation.delayMs };
  }

  // Old snapshots can have skipped failed pages. Infer a cursor only when the
  // first uncollected page is unambiguous, rather than silently keeping a gap.
  if (!validPage(data.pagesFetched)) return null;
  if (!errors.length && /time limit reached/i.test(data.stoppedEarly || "")) {
    return { nextPage: data.pagesFetched, retryAt: null, delayMs: 5000 };
  }
  if (errors.length === 1 && errors[0]?.page === data.pagesFetched && errors[0].rateLimited === true) {
    if (!Number.isFinite(now)) return null;
    const savedAt = Date.parse(data.fetchedAt);
    const retryTime = (Number.isFinite(savedAt) ? savedAt : now) + 60000;
    if (!Number.isFinite(retryTime) || Math.abs(retryTime) > 8640000000000000) return null;
    return { nextPage: data.pagesFetched, retryAt: new Date(retryTime).toISOString(), delayMs: 10000 };
  }
  return null;
}

export { continuationFor };
