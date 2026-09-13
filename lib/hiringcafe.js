// Fetches software engineer postings from HiringCafe (https://hiringcafe.com) and normalizes them.
// HiringCafe sits behind bot protection that rejects Node's TLS fingerprint, so requests go through
// wreq-js, which impersonates a real Chrome handshake. Search results are server-rendered into the
// page's __NEXT_DATA__ JSON, so each results page is one GET.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// wreq-js loads a native binary (@wreq-js/binding-<platform>) as soon as it is imported. Two consequences:
// - It is imported lazily, when a fetch starts, so a missing binary breaks "Fetch now" with a clear error
//   instead of crashing the whole server on startup.
// - wreq-js picks the binding by platform name at runtime, which Vercel's file tracing can't follow, so the
//   deployed function shipped without it. Naming the packages here lets tracing find and copy whichever one
//   is installed. These functions are never called.
export const NATIVE_BINDING_TRACE_HINTS = [
  () => require("@wreq-js/binding-linux-x64-gnu"),
  () => require("@wreq-js/binding-linux-arm64-gnu"),
  () => require("@wreq-js/binding-darwin-arm64"),
  () => require("@wreq-js/binding-darwin-x64"),
  () => require("@wreq-js/binding-win32-x64-msvc"),
];

let wreq;
async function loadWreq() {
  try {
    wreq ??= await import("wreq-js");
    return wreq;
  } catch (err) {
    throw new Error(`Couldn't load wreq-js on ${process.platform}-${process.arch}: ${err.message}`, { cause: err });
  }
}

const BASE_URL = "https://hiringcafe.com";
const SEARCH_STATE = { searchQuery: "software engineer" }; // HiringCafe defaults the location to the US

const TITLE_MATCH = /\b(software|swe\b|backend|back-end|frontend|front-end|full[- ]?stack|mobile|ios|android|machine learning|ml|infrastructure|platform|data|security|site reliability|embedded|firmware)\b.*\b(engineer|developer)\b|\bsoftware developer\b|\bswe\b/i;
const TITLE_EXCLUDE = /\b(manager|director|head of|vp\b|vice president|recruit|sales|solutions?|support|customer|account|field|technical program|product designer|analyst|scientist)\b/i;

// ---- field mapping ---------------------------------------------------------

function levelFromTitle(title) {
  const base = title.split(",")[0].trim();
  if (/\b(intern|internship|co-op)\b/i.test(title)) return "Intern";
  if (/\b(principal|distinguished|fellow)\b/i.test(title)) return "Principal";
  if (/\bstaff\b/i.test(title)) return "Staff";
  if (/\b(senior|sr|lead)\b/i.test(title) || /\b(III|IV|3|4)$/.test(base)) return "Senior";
  if (/\b(new grad|graduate|junior|jr|entry[- ]level|early career|associate)\b/i.test(title) || /\b(I|1)$/.test(base)) return "Junior";
  if (/\b(II|2)$/.test(base)) return "Mid";
  return null;
}

const SENIORITY = {
  "No Prior Experience Required": "Junior",
  "Entry Level": "Junior",
  "Mid Level": "Mid",
  "Senior Level": "Senior",
};

function specialtyFromTitle(title) {
  const rules = [
    ["ML / AI", /\b(machine learning|ml|ai|llm|inference|model)\b/i],
    ["Security", /\bsecurity\b/i],
    ["Mobile", /\b(mobile|ios|android)\b/i],
    ["Embedded", /\b(embedded|firmware|fpga|rtos)\b/i],
    ["Frontend", /\b(front[- ]?end|web|ui)\b/i],
    ["Full Stack", /\bfull[- ]?stack\b/i],
    ["Data", /\bdata\b/i],
    ["Infrastructure", /\b(infrastructure|platform|reliability|sre|devops|cloud|systems|distributed)\b/i],
    ["Backend", /\b(back[- ]?end|api|payments)\b/i],
  ];
  return (rules.find(([, re]) => re.test(title)) || ["General"])[0];
}

// Collapse neighbouring cities into one metro so the location breakdown stays readable.
const METROS = [
  ["SF Bay Area", /san francisco|bay area|mountain view|palo alto|menlo park|san mateo|sunnyvale|san jose|oakland|redwood city|foster city|cupertino|santa clara|fremont|milpitas/i],
  ["New York", /new york|brooklyn|jersey city/i],
  ["Seattle Area", /seattle|bellevue|redmond|kirkland/i],
  ["Los Angeles", /los angeles|santa monica|irvine|el segundo|pasadena/i],
  ["Boston", /boston|cambridge, massachusetts|waltham/i],
  ["Washington, DC", /washington, district|arlington, virginia|mclean|reston|herndon|chantilly/i],
  ["Austin", /austin/i], ["Denver", /denver|boulder/i], ["Chicago", /chicago/i], ["Atlanta", /atlanta/i],
];

function normalizeLocation(job) {
  if (job.workplace_type === "Remote") return "Remote (US)";
  const cities = job.workplace_cities || [];
  const city = cities.find((c) => c.endsWith(", US")) || cities[0]; // multi-country posts: prefer the US city
  if (!city || !city.endsWith(", US")) return "United States (unspecified)";
  const metro = METROS.find(([, re]) => re.test(city));
  if (metro) return metro[0];
  return city.replace(/, US$/, ""); // "Huntsville, Alabama, US" -> "Huntsville, Alabama"
}

function annualSalary(job) {
  const min = job.yearly_min_compensation;
  const max = job.yearly_max_compensation || min;
  if (job.listed_compensation_currency !== "USD" || !min) return null;
  if (min < 30000 || max > 1500000 || max < min) return null;
  return { min: Math.round(min), max: Math.round(max) };
}

function normalize(hit) {
  const job = hit.v5_processed_job_data || {};
  const title = (hit.job_information?.title || job.core_job_title || "").trim();
  const salary = annualSalary(job);
  const years = job.min_industry_and_role_yoe;
  return {
    id: hit.id,
    title,
    company: job.company_name || hit.enriched_company_data?.name || "",
    location: normalizeLocation(job),
    locationRaw: job.formatted_workplace_location || "",
    remote: job.workplace_type === "Remote",
    workplaceType: job.workplace_type || null,
    level: levelFromTitle(title) || SENIORITY[job.seniority_level] || "Unspecified",
    specialty: specialtyFromTitle(title),
    yearsExperience: Number.isFinite(years) ? Math.floor(years) : null, // charts bucket by whole years
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    postedDate: job.estimated_publish_date ? job.estimated_publish_date.slice(0, 10) : "",
    url: /^https?:\/\//i.test(hit.apply_url || "") ? hit.apply_url : null,
    source: "HiringCafe",
    sourceUrl: BASE_URL,
  };
}

const isSoftwareRole = (hit) => {
  const job = hit.v5_processed_job_data || {};
  const title = hit.job_information?.title || "";
  return (
    !hit.is_expired &&
    job.role_type !== "People Manager" &&
    (job.workplace_countries || []).includes("US") &&
    TITLE_MATCH.test(title) &&
    !TITLE_EXCLUDE.test(title)
  );
};

// ---- fetching --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(session, page) {
  const url = `${BASE_URL}/?searchState=${encodeURIComponent(JSON.stringify(SEARCH_STATE))}&page=${page}`;
  const res = await session.fetch(url, { headers: { Accept: "text/html" }, timeout: 30000 });
  const html = await res.text();
  const match = res.ok && html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    if (res.status === 429) {
      const err = new Error(`HTTP 429 for page ${page} (rate limited)`);
      err.retryAfterMs = (Number(res.headers.get("retry-after")) || 60) * 1000;
      throw err;
    }
    // Bot walls answer with a challenge page instead of results. From a cloud host (e.g. Vercel) that
    // usually means the server's IP range is blocked, not a code problem, so say so. Normal result pages
    // also load Cloudflare scripts, which is why this is only checked when the job data is missing.
    const challenged = res.status === 403 || res.headers.get("cf-mitigated") === "challenge" || /just a moment|cf-chl|attention required/i.test(html);
    const err = new Error(
      challenged
        ? `HTTP ${res.status} for page ${page}: blocked by HiringCafe's bot protection (likely this server's IP)`
        : `HTTP ${res.status} for page ${page}: no job data in the page (blocked or page layout changed)`
    );
    err.blocked = challenged;
    throw err;
  }
  const props = JSON.parse(match[1]).props?.pageProps || {};
  if (props.ssrError) throw new Error(`HiringCafe search error on page ${page}: ${JSON.stringify(props.ssrError)}`);
  return { hits: props.ssrHits || [], total: props.ssrTotalCount, isLastPage: Boolean(props.ssrIsLastPage) };
}

// timeBudgetMs keeps a fetch inside a serverless time limit: no page or retry starts once it would run past
// the budget, and whatever was collected so far is returned with stoppedEarly set.
async function fetchAllJobs({ pages = 25, delayMs = 1500, timeBudgetMs = Infinity, log = console.log } = {}) {
  const started = Date.now();
  const hasTime = (ms) => Date.now() - started + ms < timeBudgetMs;
  const PAGE_ESTIMATE_MS = 5000;
  const { createSession } = await loadWreq();
  const session = await createSession({ browser: "chrome_149", os: "windows" });
  const byCluster = new Map();
  const errors = [];
  let total = null;
  let pagesFetched = 0;
  let stoppedEarly = null;
  try {
    for (let page = 0; page < pages; page++) {
      if (!hasTime(PAGE_ESTIMATE_MS)) {
        stoppedEarly = `time limit reached after ${page} page(s)`;
        break;
      }
      let result;
      let lastErr;
      for (let attempt = 1; attempt <= 3 && !result; attempt++) {
        try {
          result = await fetchPage(session, page);
        } catch (err) {
          lastErr = err;
          const wait = err.retryAfterMs || delayMs * 2 * attempt;
          if (attempt === 3 || err.blocked || !hasTime(wait + PAGE_ESTIMATE_MS)) break;
          log(`  page ${page}: ${err.message}, retrying in ${Math.round(wait / 1000)}s`);
          await sleep(wait);
        }
      }
      if (!result) {
        errors.push({ page, error: lastErr.message, rateLimited: Boolean(lastErr.retryAfterMs), blocked: Boolean(lastErr.blocked) });
        log(`  page ${page}: failed (${lastErr.message})`);
        // Blocked, still rate limited, or nothing works from the start: later pages would fail the same way.
        if (lastErr.blocked || lastErr.retryAfterMs || pagesFetched === 0) {
          stoppedEarly = lastErr.message;
          break;
        }
        continue;
      }
      pagesFetched++;
      total = result.total ?? total;
      let kept = 0;
      for (const hit of result.hits) {
        // The same opening is often posted on several boards; keep one per dedup cluster.
        const key = hit.strict_dedup_cluster_id || hit.id;
        if (byCluster.has(key) || !isSoftwareRole(hit)) continue;
        byCluster.set(key, normalize(hit));
        kept++;
      }
      log(`  page ${page}: ${result.hits.length} results, ${kept} new software engineer postings`);
      if (result.isLastPage || !result.hits.length) break;
      await sleep(delayMs);
    }
  } finally {
    await session.close();
  }
  return {
    fetchedAt: new Date().toISOString(),
    query: SEARCH_STATE.searchQuery,
    totalResults: total,
    pagesFetched,
    pagesRequested: pages,
    stoppedEarly,
    errors,
    jobs: [...byCluster.values()],
  };
}

export { fetchAllJobs, normalize, levelFromTitle };
