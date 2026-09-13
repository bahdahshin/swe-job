# Software Engineer Job Market

Dashboard of software engineer job posts, salary, and years of experience required.

```bash
npm install
npm start
```

Then open http://localhost:3000. Needs Node 22.9+.

## Data

Postings come from [HiringCafe](https://hiringcafe.com)'s US search for "software engineer". HiringCafe blocks Node's built-in `fetch` by its TLS fingerprint, so `lib/hiringcafe.js` uses [wreq-js](https://github.com/sqdshguy/wreq-js), which makes the same TLS handshake as Chrome. Each results page comes back with the jobs already in its `__NEXT_DATA__` JSON. The fetcher then:

- keeps software engineering roles that aren't people-manager roles,
- merges the same job posted on more than one board,
- saves the result as a new entry in the fetch history.

Every fetch is kept, and nothing is overwritten. Start a new one with the **Fetch now** button at the top of the dashboard, or from the command line:

```bash
npm run fetch -- --pages=25
```

The picker next to the button lists every saved fetch, and you can load any of them. The page opens the newest complete fetch. Pick an older one and its id goes in the URL (`?fetch=<id>`), so a reload or shared link shows the same data.

Each page has roughly 120 results, and 25 pages give about 2,000 unique postings. `HIRINGCAFE_PAGES` sets the page count for **Fetch now**.

Salary (annual USD) and minimum years of experience come from HiringCafe's reading of each post. Posts that don't state them are left out of those charts.

## Storage

`lib/store.js` picks where fetches are saved:

- **Vercel Blob**, when `BLOB_READ_WRITE_TOKEN` (or `BLOB_STORE_ID` with Vercel OIDC) is set. Full fetches go to `fetches/<id>.json` and small summaries to `summaries/<id>.json`.
- **`data/fetches/<id>.json`** otherwise. On Vercel these files are read-only, so the fetches you commit still show up in the picker, but **Fetch now** fails with a message asking you to connect a Blob store.

## Deploying to Vercel

1. In the Vercel project, open **Storage**, create a **Blob** store (private), and connect it to the project. That adds `BLOB_READ_WRITE_TOKEN`.
2. Redeploy.
3. Optional: copy the fetches you already have locally into Blob, so the picker isn't empty:

   ```bash
   vercel env pull .env.local
   npm run upload-fetches
   ```

**Fetch now** runs the whole fetch inside its request and streams progress to the page. It stops starting new pages after 240 seconds (`HIRINGCAFE_TIME_BUDGET_MS`) and saves what it has, so it stays under Vercel's default 300-second function limit. A fetch cut short that way is marked partial and isn't used as the default. Keep the page open until it finishes.

If HiringCafe blocks Vercel's IP addresses, **Fetch now** says so ("blocked by HiringCafe's bot protection"). In that case, fetch on your own machine with `npm run fetch` while `BLOB_READ_WRITE_TOKEN` is set (e.g. `node --env-file=.env.local scripts/fetch-jobs.js`), and the result appears on the deployed site.

## API

- `GET /api/jobs`: the default fetch (404 if there are none yet)
- `GET /api/fetches`: storage type and a summary of every saved fetch, newest first
- `GET /api/fetches/<id>`: one saved fetch
- `POST /api/refresh`: run a new fetch; the response streams newline-delimited JSON (`progress` events, then `done` with the saved fetch's summary, or `error`)
