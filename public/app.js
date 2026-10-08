const SVG_NS = "http://www.w3.org/2000/svg";
const LEVEL_ORDER = ["Intern", "Junior", "Mid", "Senior", "Staff", "Principal"];
const PAGE_SIZE = 25;
const MAX_LOCATIONS = 20;

const state = {
  jobs: [],
  filters: { level: "", location: "", specialty: "", days: 0 },
  search: "",
  sort: { key: "postedDate", asc: false },
  visibleRows: PAGE_SIZE,
};

const $ = (id) => document.getElementById(id);
const fmtMoney = (n) => "$" + Math.round(n / 1000) + "k";
const fmtInt = (n) => n.toLocaleString("en-US");
// Viewer's local time, e.g. "Sep 12, 2026, 11:21 PM EDT"
const fmtDateTime = (iso) =>
  new Date(iso).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

// ---- stats -----------------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortedNums = (arr) => arr.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

// ---- data ------------------------------------------------------------------

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ---- fetch history -----------------------------------------------------------

let fetchIndex = { defaultId: null, fetches: [] };
let pendingRefresh = null;
let refreshRunning = false;

function updateRefreshButton() {
  if (refreshRunning) return;
  $("refresh").disabled = false;
  $("refresh").textContent = pendingRefresh ? "Resume fetch" : "Fetch now";
}

// `justSaved` is a summary returned by a fetch that just finished: Blob listings can lag a moment behind
// a write, so it is merged in if the server's list doesn't include it yet.
async function loadFetchList(justSaved) {
  fetchIndex = await getJson("/api/fetches");
  if (justSaved && !fetchIndex.fetches.some((f) => f.id === justSaved.id)) {
    fetchIndex.fetches = [justSaved, ...fetchIndex.fetches].sort((a, b) => (a.id < b.id ? 1 : -1));
    if (!justSaved.partial && (!fetchIndex.defaultId || justSaved.id > fetchIndex.defaultId)) fetchIndex.defaultId = justSaved.id;
  }
  const sel = $("fetch-select");
  sel.length = 0;
  if (!fetchIndex.fetches.length) sel.add(new Option("No saved fetches yet", ""));
  for (const f of fetchIndex.fetches) {
    let label = `${fmtDateTime(f.fetchedAt)} · ${fmtInt(f.jobCount)} posts`;
    if (f.failedPages) label += ` · ${f.failedPages} page${f.failedPages === 1 ? "" : "s"} failed`;
    else if (f.stoppedEarly) label += ` · partial (${f.pagesFetched} pages)`;
    if (f.id === fetchIndex.defaultId) label += " (default)";
    sel.add(new Option(label, f.id));
  }
  sel.disabled = !fetchIndex.fetches.length;
  const newestComplete = fetchIndex.fetches.filter((f) => !f.partial).sort((a, b) => b.id.localeCompare(a.id))[0];
  pendingRefresh = fetchIndex.fetches
    .filter((f) => f.partial && f.continuation && (!newestComplete || f.id > newestComplete.id))
    .sort((a, b) => b.id.localeCompare(a.id))[0] || null;
  updateRefreshButton();
}

// Shows a saved fetch and records the choice in the URL (?fetch=<id>) so a reload keeps it.
async function showFetch(id) {
  const data = await getJson(`/api/fetches/${encodeURIComponent(id)}`);
  setData(data);
  const url = new URL(location.href);
  if (data.id === fetchIndex.defaultId) url.searchParams.delete("fetch");
  else url.searchParams.set("fetch", data.id);
  history.replaceState(null, "", url);
}

function setData(data) {
  state.jobs = data.jobs.map((j) => ({
    ...j,
    salaryMid: j.salaryMin && j.salaryMax ? (j.salaryMin + j.salaryMax) / 2 : j.salaryMin || j.salaryMax || null,
  }));
  $("fetch-select").value = data.id;
  renderSources(data);

  const uniq = (key) => [...new Set(state.jobs.map((j) => j[key]))];
  fillSelect("f-level", uniq("level").sort((a, b) => rank(a) - rank(b)));
  fillDatalist("f-location-options", uniq("location").sort());
  fillSelect("f-specialty", uniq("specialty").sort());
  // Drop filters whose value no longer exists in the new data.
  for (const [id, key] of [["f-level", "level"], ["f-specialty", "specialty"]]) {
    state.filters[key] = $(id).value;
  }
  state.filters.location = $("f-location").value;
  state.visibleRows = PAGE_SIZE;
  render();
}

// ---- manual fetch ------------------------------------------------------------

function showRefreshStatus(text, isError = false) {
  $("refresh-status").textContent = text;
  $("refresh-status").classList.toggle("error", isError);
}

// Reads the NDJSON progress stream from POST /api/refresh; resolves with the final "done" or "error" event.
async function readRefreshStream(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final = null;
  const readLine = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") showRefreshStatus(event.message);
    if (event.type === "done" || event.type === "error") final = event;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) readLine(line);
  }
  readLine(buffer);
  return final;
}

function fetchedPages(summary) {
  return summary?.pagesFetched ?? summary?.continuation?.nextPage ?? 0;
}

function partialProgress(summary) {
  const pages = summary.pagesRequested
    ? `${fetchedPages(summary)} of ${summary.pagesRequested} pages`
    : `${fetchedPages(summary)} pages`;
  return `Saved ${fmtInt(summary.jobCount)} postings (${pages}).`;
}

async function waitForContinuation(summary) {
  const retryAt = Date.parse(summary.continuation.retryAt);
  const deadline = Number.isFinite(retryAt)
    ? retryAt
    : Date.now() + Math.max(0, summary.continuation.delayMs || 0);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    $("refresh").textContent = "Waiting…";
    showRefreshStatus(`${partialProgress(summary)} Rate limited; continuing in ${Math.ceil(remaining / 1000)}s…`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
}

async function startRefresh() {
  if (refreshRunning) return;
  refreshRunning = true;
  $("refresh").disabled = true;
  $("refresh").textContent = "Fetching…";
  let resume = pendingRefresh;
  let previousPages = fetchedPages(resume);
  let stalledAttempts = 0;
  showRefreshStatus(resume ? "Resuming saved fetch…" : "Starting…");
  try {
    for (let request = 0; request < 8; request++) {
      if (resume) await waitForContinuation(resume);
      $("refresh").textContent = "Fetching…";
      const url = resume ? `/api/refresh?resume=${encodeURIComponent(resume.id)}` : "/api/refresh";
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // The fetch runs inside this request, so leaving the page mid-fetch may cut it short.
      const result = await readRefreshStream(res);
      if (!result) throw new Error("the connection closed before the fetch finished (it may have hit the server's time limit)");
      if (result.type === "error") throw new Error(result.error);

      const previousFetchId = $("fetch-select").value;
      // Keep the newest checkpoint available even if reloading history fails after a successful save.
      pendingRefresh = result.fetch.partial && result.fetch.continuation ? result.fetch : null;
      await loadFetchList(result.fetch);
      if (!result.fetch.partial) {
        await showFetch(result.fetch.id);
        showRefreshStatus(`Saved and showing new fetch with ${fmtInt(result.fetch.jobCount)} postings`);
        return;
      }
      // History includes the new snapshot, but displayed results stay on the selected fetch.
      if (previousFetchId) {
        $("fetch-select").value = previousFetchId;
      } else {
        $("fetch-select").value = "";
      }
      if (!result.fetch.continuation) {
        const reason = result.fetch.stoppedEarly || `${result.fetch.failedPages} page(s) failed`;
        showRefreshStatus(`Saved partial fetch with ${fmtInt(result.fetch.jobCount)} postings: ${reason}. Kept current results. Select the partial fetch in history to view it.`, true);
        return;
      }

      resume = result.fetch;
      pendingRefresh = resume;
      const pages = fetchedPages(resume);
      stalledAttempts = pages > previousPages ? 0 : stalledAttempts + 1;
      previousPages = pages;
      if (stalledAttempts >= 3 || request === 7) {
        showRefreshStatus(`${partialProgress(resume)} ${stalledAttempts >= 3 ? "HiringCafe is still rate limiting this fetch." : "Automatic continuation paused."} Kept current results. Click Resume fetch to continue.`, true);
        return;
      }
    }
  } catch (err) {
    showRefreshStatus(`Fetch failed: ${err.message}`, true);
  } finally {
    refreshRunning = false;
    updateRefreshButton();
  }
}

function showEmpty() {
  state.jobs = [];
  render();
  $("sources").textContent = "No saved fetches yet. Use Fetch now to get postings from HiringCafe.";
  showRefreshStatus(pendingRefresh ? "A partial fetch is saved. Click Resume fetch to continue." : "No saved fetches yet. Click Fetch now to get postings.");
}

async function init() {
  $("refresh").addEventListener("click", startRefresh);

  await loadFetchList();
  const requested = new URLSearchParams(location.search).get("fetch");
  if (!fetchIndex.fetches.length) {
    showEmpty();
  } else if (requested && requested !== fetchIndex.defaultId) {
    try {
      await showFetch(requested);
    } catch (err) {
      showRefreshStatus(`Couldn't load fetch ${requested} (${err.message}); showing the default`, true);
      await showFetch(fetchIndex.defaultId);
    }
  } else {
    await showFetch(fetchIndex.defaultId);
  }

  $("fetch-select").addEventListener("change", async (e) => {
    const sel = e.target;
    sel.disabled = true;
    try {
      await showFetch(sel.value);
      showRefreshStatus("");
    } catch (err) {
      showRefreshStatus(`Couldn't load that fetch: ${err.message}`, true);
      sel.value = new URLSearchParams(location.search).get("fetch") || fetchIndex.defaultId;
    } finally {
      sel.disabled = false;
    }
  });

  const bind = (id, key, parse = (v) => v) =>
    $(id).addEventListener("change", (e) => {
      state.filters[key] = parse(e.target.value);
      state.visibleRows = PAGE_SIZE;
      render();
    });
  bind("f-level", "level");
  bind("f-specialty", "specialty");
  bind("f-days", "days", Number);
  $("f-location").addEventListener("input", (e) => {
    state.filters.location = e.target.value;
    state.visibleRows = PAGE_SIZE;
    render();
  });

  $("f-reset").addEventListener("click", () => {
    state.filters = { level: "", location: "", specialty: "", days: 0 };
    ["f-level", "f-location", "f-specialty"].forEach((id) => ($(id).value = ""));
    $("f-days").value = "0";
    render();
  });
  $("search").addEventListener("input", (e) => {
    state.search = e.target.value.toLowerCase();
    state.visibleRows = PAGE_SIZE;
    renderTable(filtered());
  });
  $("more").addEventListener("click", () => {
    state.visibleRows += PAGE_SIZE;
    renderTable(filtered());
  });
  $("sort").addEventListener("change", (e) => {
    const [key, dir] = e.target.value.split(":");
    state.sort = { key, asc: dir === "asc" };
    renderTable(filtered());
  });
  document.querySelectorAll("th[data-sort]").forEach((th) =>
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      state.sort = { key, asc: state.sort.key === key ? !state.sort.asc : key === "title" || key === "company" || key === "location" };
      renderTable(filtered());
    })
  );

  // Touch has no hover to end: every tap clears the tooltip first (capture phase, so a tap on a chart can
  // show a fresh one), and a scroll clears it rather than leaving it pinned in place.
  document.addEventListener("pointerdown", (evt) => evt.pointerType !== "mouse" && hideTooltip(), true);
  window.addEventListener("scroll", hideTooltip, { passive: true });

  // Width only: mobile browsers fire resize as the address bar slides in and out while scrolling.
  let resizeTimer;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 120);
  });
}

const rank = (level) => {
  const i = LEVEL_ORDER.indexOf(level);
  return i === -1 ? 99 : i;
};

function fillSelect(id, values) {
  // Rebuilt on every data load: keep the "All …" option and the current choice if it still exists.
  const sel = $(id);
  const current = sel.value;
  sel.length = 1;
  for (const v of values) sel.add(new Option(v, v));
  sel.value = values.includes(current) ? current : "";
}

// Rebuilt on every data load; suggestions only, so the current text (a substring search) is untouched.
function fillDatalist(id, values) {
  const list = $(id);
  list.innerHTML = "";
  for (const v of values) list.appendChild(new Option(v, v));
}

function filtered() {
  const { level, location, specialty, days } = state.filters;
  const locationQuery = location.trim().toLowerCase();
  const latest = state.jobs.reduce((m, j) => (j.postedDate > m ? j.postedDate : m), "");
  const cutoff = days && latest ? new Date(new Date(latest).getTime() - days * 86400000).toISOString().slice(0, 10) : "";
  return state.jobs.filter(
    (j) =>
      (!level || j.level === level) &&
      (!locationQuery || j.location.toLowerCase().includes(locationQuery)) &&
      (!specialty || j.specialty === specialty) &&
      (!cutoff || j.postedDate >= cutoff)
  );
}

// ---- render ----------------------------------------------------------------

function render() {
  const jobs = filtered();
  renderTiles(jobs);
  renderYearsChart(jobs);
  renderSalaryChart(jobs);
  renderLocations(jobs);
  renderTable(jobs);
}

function renderTiles(jobs) {
  const salaries = sortedNums(jobs.map((j) => j.salaryMid));
  const years = sortedNums(jobs.map((j) => j.yearsExperience));
  $("k-count").textContent = fmtInt(jobs.length);
  $("k-salary").textContent = salaries.length ? fmtMoney(quantile(salaries, 0.5)) : "–";
  $("k-salary-range").textContent = salaries.length
    ? `Middle 50%: ${fmtMoney(quantile(salaries, 0.25))} – ${fmtMoney(quantile(salaries, 0.75))}`
    : "";
  $("k-years").textContent = years.length ? `${+quantile(years, 0.5).toFixed(1)} yrs` : "–";
  const unstated = jobs.length - years.length;
  $("k-years-range").textContent = years.length
    ? `Middle 50%: ${+quantile(years, 0.25).toFixed(1)} – ${+quantile(years, 0.75).toFixed(1)} yrs` +
      (unstated ? ` · ${fmtInt(unstated)} posts don't say` : "")
    : "";
}

// Postings that don't state years of experience are left out of the per-year charts.
function groupByYears(jobs) {
  const withYears = jobs.filter((j) => Number.isFinite(j.yearsExperience));
  const maxYears = Math.max(0, ...withYears.map((j) => j.yearsExperience));
  const groups = Array.from({ length: maxYears + 1 }, (_, y) => ({ years: y, jobs: [] }));
  for (const j of withYears) groups[j.yearsExperience].jobs.push(j);
  return groups;
}

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function niceMax(v, steps = 4) {
  if (v <= 0) return steps;
  const raw = v / steps;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return step * steps;
}

function chartFrame(container, yMax, yFormat, xTitle) {
  container.innerHTML = "";
  const width = container.clientWidth;
  const height = container.clientHeight;
  const m = { top: 8, right: 8, bottom: 38, left: 48 };
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}` }, container);
  const iw = Math.max(1, width - m.left - m.right);
  const ih = Math.max(1, height - m.top - m.bottom);
  const g = el("g", { transform: `translate(${m.left},${m.top})` }, svg);
  const y = (v) => ih - (v / yMax) * ih;

  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    el("line", { x1: 0, x2: iw, y1: y(v), y2: y(v), stroke: i === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }, g);
    const t = el("text", { x: -8, y: y(v), dy: "0.32em", "text-anchor": "end", class: "axis-label" }, g);
    t.textContent = yFormat(v);
  }
  const title = el("text", { x: iw / 2, y: ih + 34, "text-anchor": "middle", class: "axis-title" }, g);
  title.textContent = xTitle;
  return { svg, g, iw, ih, y };
}

function renderYearsChart(jobs) {
  const container = $("chart-years");
  const groups = groupByYears(jobs);
  if (!groups.some((d) => d.jobs.length)) return (container.innerHTML = '<div class="empty">No postings match these filters</div>');

  const yMax = niceMax(Math.max(...groups.map((d) => d.jobs.length)));
  const { g, iw, ih, y } = chartFrame(container, yMax, (v) => fmtInt(v), "Years of experience required");
  const band = iw / groups.length;
  const gap = Math.max(2, band * 0.2);
  const barW = band - gap;
  const labelEvery = Math.ceil(groups.length / Math.max(1, Math.floor(iw / 28)));

  groups.forEach((d, i) => {
    const x = i * band + gap / 2;
    const h = ih - y(d.jobs.length);
    if (h > 0) el("path", { d: roundedTopBar(x, y(d.jobs.length), barW, h, Math.min(4, barW / 2)), fill: "var(--series)" }, g);
    if (i % labelEvery === 0) {
      const t = el("text", { x: x + barW / 2, y: ih + 16, "text-anchor": "middle", class: "axis-label" }, g);
      t.textContent = d.years;
    }
    const hit = el("rect", { x: i * band, y: 0, width: band, height: ih, fill: "transparent" }, g);
    hoverable(hit, () => {
      const sal = sortedNums(d.jobs.map((j) => j.salaryMid));
      return tip(`${d.years} ${d.years === 1 ? "year" : "years"} experience`, [
        ["Job posts", fmtInt(d.jobs.length)],
        ["Share", jobs.length ? ((d.jobs.length / jobs.length) * 100).toFixed(1) + "%" : "–"],
        ["Median salary", sal.length ? fmtMoney(quantile(sal, 0.5)) : "–"],
      ]);
    });
  });
}

function roundedTopBar(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderSalaryChart(jobs) {
  const container = $("chart-salary");
  // Only plot years with enough postings for a meaningful median/percentiles.
  const points = groupByYears(jobs)
    .map((d) => ({ years: d.years, n: d.jobs.length, sal: sortedNums(d.jobs.map((j) => j.salaryMid)) }))
    .filter((d) => d.sal.length >= 3)
    .map((d) => ({ ...d, p25: quantile(d.sal, 0.25), p50: quantile(d.sal, 0.5), p75: quantile(d.sal, 0.75) }));
  if (points.length < 2) return (container.innerHTML = '<div class="empty">Not enough salary data for these filters</div>');

  const maxYears = points[points.length - 1].years;
  const minYears = points[0].years;
  const yMax = niceMax(Math.max(...points.map((p) => p.p75)));
  const { g, iw, ih, y } = chartFrame(container, yMax, (v) => (v ? fmtMoney(v) : "$0"), "Years of experience required");
  const x = (v) => ((v - minYears) / Math.max(1, maxYears - minYears)) * iw;

  const labelEvery = Math.ceil((maxYears - minYears + 1) / Math.max(1, Math.floor(iw / 28)));
  for (let v = minYears; v <= maxYears; v += labelEvery) {
    const t = el("text", { x: x(v), y: ih + 16, "text-anchor": "middle", class: "axis-label" }, g);
    t.textContent = v;
  }

  const bandPath =
    points.map((p, i) => `${i ? "L" : "M"}${x(p.years)},${y(p.p75)}`).join("") +
    [...points].reverse().map((p) => `L${x(p.years)},${y(p.p25)}`).join("") + "Z";
  el("path", { d: bandPath, fill: "var(--band)", opacity: 0.6 }, g);
  el("path", {
    d: points.map((p, i) => `${i ? "L" : "M"}${x(p.years)},${y(p.p50)}`).join(""),
    fill: "none", stroke: "var(--series)", "stroke-width": 2, "stroke-linejoin": "round",
  }, g);

  const crosshair = el("line", { y1: 0, y2: ih, stroke: "var(--axis)", "stroke-width": 1, visibility: "hidden" }, g);
  const dot = el("circle", { r: 4.5, fill: "var(--series)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, g);
  const overlay = el("rect", { x: 0, y: 0, width: iw, height: ih, fill: "transparent" }, g);

  const nearest = (evt) => {
    const rect = overlay.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    return points.reduce((best, p) => (Math.abs(x(p.years) - px) < Math.abs(x(best.years) - px) ? p : best));
  };
  hoverable(
    overlay,
    (evt) => {
      const p = nearest(evt);
      crosshair.setAttribute("x1", x(p.years));
      crosshair.setAttribute("x2", x(p.years));
      dot.setAttribute("cx", x(p.years));
      dot.setAttribute("cy", y(p.p50));
      crosshair.setAttribute("visibility", "visible");
      dot.setAttribute("visibility", "visible");
      return tip(`${p.years} ${p.years === 1 ? "year" : "years"} experience`, [
        ["Median", fmtMoney(p.p50)],
        ["75th pct", fmtMoney(p.p75)],
        ["25th pct", fmtMoney(p.p25)],
        ["Job posts", fmtInt(p.n)],
      ]);
    },
    () => {
      crosshair.setAttribute("visibility", "hidden");
      dot.setAttribute("visibility", "hidden");
    }
  );
}

function renderLocations(jobs) {
  const container = $("chart-location");
  const byLoc = new Map();
  for (const j of jobs) {
    if (!byLoc.has(j.location)) byLoc.set(j.location, []);
    byLoc.get(j.location).push(j);
  }
  const rows = [...byLoc.entries()]
    .map(([name, list]) => ({
      name,
      count: list.length,
      salary: quantile(sortedNums(list.map((j) => j.salaryMid)), 0.5),
      years: quantile(sortedNums(list.map((j) => j.yearsExperience)), 0.5),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_LOCATIONS);
  if (!rows.length) return (container.innerHTML = '<div class="empty">No postings match these filters</div>');

  const max = rows[0].count;
  container.innerHTML =
    '<div class="hdr">Location</div><div class="hdr">Job posts</div><div class="hdr val">Med. yrs</div><div class="hdr val">Med. salary</div>' +
    rows
      .map(
        (r) => `<div class="loc-row">
          <div class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
          <div class="bar-track"><div class="bar" style="width:calc(${(r.count / max) * 100}% - 48px)"></div><span class="val" style="margin-left:8px">${fmtInt(r.count)}</span></div>
          <div class="val">${Number.isFinite(r.years) ? +r.years.toFixed(1) : "–"}</div>
          <div class="val">${Number.isFinite(r.salary) ? fmtMoney(r.salary) : "–"}</div>
        </div>`
      )
      .join("");
}

function renderTable(jobs) {
  const q = state.search;
  const { key, asc } = state.sort;
  const rows = jobs
    .filter((j) => !q || j.title.toLowerCase().includes(q) || j.company.toLowerCase().includes(q) || j.location.toLowerCase().includes(q))
    .sort((a, b) => {
      const av = a[key] ?? "";
      const bv = b[key] ?? "";
      if (av === "" || bv === "") return (av === "") - (bv === ""); // missing values always last
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (cmp) return asc ? cmp : -cmp;
      return (b.postedDate || "").localeCompare(a.postedDate || ""); // ties: newest first
    });

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    const sorted = th.dataset.sort === key;
    th.classList.toggle("sorted", sorted);
    th.classList.toggle("asc", sorted && asc);
    if (sorted) th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  });
  // Keep the "Sort by" menu in step with header clicks; text columns show as a one-off "Title: A–Z" style entry.
  const sortSel = $("sort");
  const sortValue = `${key}:${asc ? "asc" : "desc"}`;
  if ([...sortSel.options].some((o) => o.value === sortValue)) {
    sortSel.value = sortValue;
  } else {
    const custom = sortSel.querySelector('option[value="custom"]');
    custom.textContent = `${document.querySelector(`th[data-sort="${key}"]`).textContent}: ${asc ? "A–Z" : "Z–A"}`;
    sortSel.value = "custom";
  }

  const shown = rows.slice(0, state.visibleRows);
  $("rows").innerHTML = shown
    .map(
      (j) => `<tr>
        <td>${escapeHtml(j.title)}</td>
        <td>${escapeHtml(j.company)}</td>
        <td>${escapeHtml(j.location)}</td>
        <td class="num${Number.isFinite(j.yearsExperience) ? "" : " none"}" data-label="Exp">${Number.isFinite(j.yearsExperience) ? `${j.yearsExperience}+` : "–"}</td>
        <td class="num${j.salaryMin ? "" : " none"}">${j.salaryMin ? `${fmtMoney(j.salaryMin)} – ${fmtMoney(j.salaryMax)}` : "–"}</td>
        <td class="num" data-label="Posted">${escapeHtml(j.postedDate)}</td>
        <td>${j.url ? `<a href="${escapeHtml(j.url)}" target="_blank" rel="noopener noreferrer">View post ↗</a>` : '<span class="muted">No link</span>'}</td>
      </tr>`
    )
    .join("");
  $("row-info").textContent = `Showing ${fmtInt(shown.length)} of ${fmtInt(rows.length)}`;
  $("more").hidden = shown.length >= rows.length;
}

function renderSources(data) {
  const counts = new Map();
  for (const j of state.jobs) {
    const key = j.source || "Unknown";
    const entry = counts.get(key) || { url: j.sourceUrl, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  const items = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([name, { url, n }]) => {
      const label = escapeHtml(name);
      const link = url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
      return `${link} <span class="muted">(${fmtInt(n)} ${n === 1 ? "post" : "posts"})</span>`;
    });
  const note =
    ` US results for “${escapeHtml(data.query)}” fetched ${escapeHtml(fmtDateTime(data.fetchedAt))}` +
    (data.totalResults ? ` (first ${fmtInt(state.jobs.length)} unique postings of ${fmtInt(data.totalResults)} matches)` : "") +
    ". Salary and years of experience are HiringCafe's reading of each post; posts that don't state them are left out of those stats.";
  $("sources").innerHTML = `<strong>Source${items.length > 1 ? "s" : ""}:</strong> ${items.join(" · ")}.${note}`;
}

// ---- tooltip ---------------------------------------------------------------

function tip(title, rows) {
  return `<div class="tt-title">${escapeHtml(title)}</div>` +
    rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join("");
}

let activeLeave = null; // onLeave of the element whose tooltip is showing

function hideTooltip() {
  $("tooltip").hidden = true;
  if (activeLeave) activeLeave();
  activeLeave = null;
}

// Mouse: the tooltip follows the pointer. Touch: a tap shows it above the finger and a sideways drag scrubs;
// the next tap elsewhere or a scroll hides it (see init).
function hoverable(node, content, onLeave = () => {}) {
  const tooltip = $("tooltip");
  const show = (evt) => {
    if (activeLeave !== onLeave) {
      if (activeLeave) activeLeave();
      activeLeave = onLeave;
    }
    tooltip.innerHTML = content(evt);
    tooltip.hidden = false;
    const { width, height } = tooltip.getBoundingClientRect();
    let left, top;
    if (evt.pointerType === "mouse") {
      left = evt.clientX + 14;
      top = evt.clientY + 14;
      if (left + width > window.innerWidth - 8) left = evt.clientX - width - 14;
      if (top + height > window.innerHeight - 8) top = evt.clientY - height - 14;
    } else {
      left = Math.min(Math.max(8, evt.clientX - width / 2), window.innerWidth - width - 8);
      top = evt.clientY - height - 24;
      if (top < 8) top = evt.clientY + 24;
    }
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  };
  node.addEventListener("pointermove", show);
  node.addEventListener("pointerdown", (evt) => {
    // A touch is captured by the element it starts on; release it so a drag moves across the bars.
    if (node.hasPointerCapture(evt.pointerId)) node.releasePointerCapture(evt.pointerId);
    show(evt);
  });
  node.addEventListener("pointerleave", (evt) => {
    if (evt.pointerType === "mouse") hideTooltip();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

init().catch((err) => {
  document.querySelector(".page").insertAdjacentHTML("afterbegin", `<p class="empty">Failed to load data: ${escapeHtml(err.message)}</p>`);
});
