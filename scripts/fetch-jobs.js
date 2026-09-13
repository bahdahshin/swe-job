// Fetches postings from HiringCafe and saves them as a new entry in data/fetches/.
// Usage: npm run fetch [-- --pages=40]
const path = require("path");
const { fetchAllJobs, saveFetch } = require("../lib/fetch-jobs");

const FETCHES_DIR = path.join(__dirname, "..", "data", "fetches");
const pagesArg = process.argv.find((a) => a.startsWith("--pages="));
const pages = Number(pagesArg?.split("=")[1] || process.env.HIRINGCAFE_PAGES || 25);

(async () => {
  console.log(`Fetching up to ${pages} result pages from HiringCafe...`);
  const data = await fetchAllJobs({ pages });
  const saved = saveFetch(FETCHES_DIR, data);
  const withSalary = data.jobs.filter((j) => j.salaryMin).length;
  const withYears = data.jobs.filter((j) => j.yearsExperience !== null).length;
  console.log(`Saved fetch ${saved.id}: ${saved.jobCount} postings (${withSalary} with salary, ${withYears} with years of experience)`);
  if (data.errors.length) console.log(`${data.errors.length} page(s) failed:`, data.errors);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
