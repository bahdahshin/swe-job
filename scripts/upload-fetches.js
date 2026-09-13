// Copies fetches saved locally in data/fetches/ into the connected Vercel Blob store, skipping ones already there.
// Needs BLOB_READ_WRITE_TOKEN, e.g. `vercel env pull .env.local` then: node --env-file=.env.local scripts/upload-fetches.js
import { fileURLToPath } from "node:url";
import { createFileStore, createBlobStore } from "../lib/store.js";

if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) {
  console.error("BLOB_READ_WRITE_TOKEN is not set. Run `vercel env pull .env.local`, then `npm run upload-fetches`.");
  process.exit(1);
}

const local = createFileStore(fileURLToPath(new URL("../data/fetches", import.meta.url)));
const blob = createBlobStore({ access: process.env.BLOB_ACCESS === "public" ? "public" : "private" });

try {
  const existing = new Set((await blob.list()).map((s) => s.id));
  const pending = (await local.list()).filter((s) => !existing.has(s.id));
  console.log(`${pending.length} local fetch(es) to upload, ${existing.size} already in Blob`);
  for (const { id } of pending) {
    const { id: _, ...data } = await local.load(id);
    const saved = await blob.save(data);
    console.log(`  uploaded ${saved.id} (${saved.jobCount} postings)`);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
