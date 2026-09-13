// Fetches postings from HiringCafe and saves them as a new entry in the fetch history
// (Vercel Blob if BLOB_READ_WRITE_TOKEN is set, otherwise data/fetches/).
// Usage: npm run fetch [-- --pages=40]
import { fileURLToPath } from "node:url";
import { fetchAllJobs } from "../lib/hiringcafe.js";
import { createStore } from "../lib/store.js";

const pagesArg = process.argv.find((a) => a.startsWith("--pages="));
const pages = Number(pagesArg?.split("=")[1] || process.env.HIRINGCAFE_PAGES || 25);
const store = createStore({ dir: fileURLToPath(new URL("../data/fetches", import.meta.url)) });

try {
  console.log(`Fetching up to ${pages} result pages from HiringCafe (saving to ${store.kind})...`);
  const data = await fetchAllJobs({ pages });
  const saved = await store.save(data);
  const withSalary = data.jobs.filter((j) => j.salaryMin).length;
  const withYears = data.jobs.filter((j) => j.yearsExperience !== null).length;
  console.log(`Saved fetch ${saved.id}: ${saved.jobCount} postings (${withSalary} with salary, ${withYears} with years of experience)`);
  if (data.errors.length) console.log(`${data.errors.length} page(s) failed:`, data.errors);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
