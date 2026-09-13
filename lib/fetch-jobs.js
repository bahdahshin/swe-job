// Fetches software engineer postings from HiringCafe (https://hiringcafe.com) and normalizes them.
// HiringCafe sits behind bot protection that rejects Node's TLS fingerprint, so requests go through
// wreq-js, which impersonates a real Chrome handshake. Search results are server-rendered into the
// page's __NEXT_DATA__ JSON, so each results page is one GET.
const fs = require("fs");
const path = require("path");
const { createSession } = require("wreq-js");

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
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for page ${page}`);
    if (res.status === 429) err.retryAfterMs = (Number(res.headers.get("retry-after")) || 60) * 1000;
    throw err;
  }
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(`No __NEXT_DATA__ on page ${page} (blocked or page layout changed)`);
  const props = JSON.parse(match[1]).props?.pageProps || {};
  if (props.ssrError) throw new Error(`HiringCafe search error on page ${page}: ${JSON.stringify(props.ssrError)}`);
  return { hits: props.ssrHits || [], total: props.ssrTotalCount, isLastPage: Boolean(props.ssrIsLastPage) };
}

async function fetchAllJobs({ pages = 25, delayMs = 1500, log = console.log } = {}) {
  const session = await createSession({ browser: "chrome_149", os: "windows" });
  const byCluster = new Map();
  const errors = [];
  let total = null;
  let pagesFetched = 0;
  try {
    for (let page = 0; page < pages; page++) {
      let result;
      for (let attempt = 1; attempt <= 3 && !result; attempt++) {
        try {
          result = await fetchPage(session, page);
        } catch (err) {
          if (attempt === 3) errors.push({ page, error: err.message, rateLimited: Boolean(err.retryAfterMs) });
          else {
            const wait = err.retryAfterMs || delayMs * 2 * attempt;
            log(`  page ${page}: ${err.message}, retrying in ${Math.round(wait / 1000)}s`);
            await sleep(wait);
          }
        }
      }
      if (!result) {
        const last = errors[errors.length - 1];
        log(`  page ${page}: failed (${last.error})`);
        if (last.rateLimited) break; // still rate limited after backing off; later pages would fail too
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
    errors,
    jobs: [...byCluster.values()],
  };
}

// ---- fetch history -------------------------------------------------------------
// Every fetch is kept as data/fetches/<id>.json, where the id is its fetchedAt timestamp made filename-safe.

const FETCH_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

const fetchId = (fetchedAt) => fetchedAt.replace(/[:.]/g, "-");

const summarize = (id, data) => ({
  id,
  fetchedAt: data.fetchedAt,
  jobCount: data.jobs.length,
  pagesFetched: data.pagesFetched,
  failedPages: data.errors.length,
  totalResults: data.totalResults,
});

function saveFetch(dir, data) {
  if (!data.jobs.length) throw new Error(`No postings fetched: ${JSON.stringify(data.errors)}`);
  const id = fetchId(data.fetchedAt);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
  return summarize(id, data);
}

function loadFetch(dir, id) {
  if (!FETCH_ID.test(id)) return null; // also keeps ids from escaping the directory
  const file = path.join(dir, `${id}.json`);
  return fs.existsSync(file) ? { id, ...JSON.parse(fs.readFileSync(file, "utf8")) } : null;
}

// Summaries of all saved fetches, newest first.
function listFetches(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => name.replace(/\.json$/, ""))
    .filter((id) => FETCH_ID.test(id))
    .sort()
    .reverse()
    .map((id) => summarize(id, loadFetch(dir, id)));
}

// The fetch to show by default: the newest one where every page loaded, else the newest one.
const defaultFetch = (summaries) => summaries.find((s) => !s.failedPages) || summaries[0] || null;

module.exports = { fetchAllJobs, saveFetch, loadFetch, listFetches, defaultFetch, normalize, levelFromTitle };
