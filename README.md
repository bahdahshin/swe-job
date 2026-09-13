# Software Engineer Job Market

Dashboard of software engineer job posts, salary, and years of experience required.

```bash
npm install
npm start
```

Then open http://localhost:3000. Needs Node 20+.

## Data

Postings come from [HiringCafe](https://hiringcafe.com)'s US search for "software engineer". HiringCafe blocks Node's built-in `fetch` by its TLS fingerprint, so `lib/fetch-jobs.js` uses [wreq-js](https://github.com/sqdshguy/wreq-js), which makes the same TLS handshake as Chrome. Each results page comes back with the jobs already in its `__NEXT_DATA__` JSON. The script then:

- keeps software engineering roles that aren't people-manager roles,
- merges the same job posted on more than one board,
- saves the rest as a new file in `data/fetches/`.

Every fetch is kept, and nothing is overwritten. Start a new one with the **Fetch now** button at the top of the dashboard, or from the command line:

```bash
npm run fetch -- --pages=25
```

The picker next to the button lists every saved fetch, and you can load any of them. The page opens the newest fetch where every page loaded; pick an older one and its id goes in the URL (`?fetch=<id>`), so a reload or shared link shows the same data. If there are no saved fetches, the server fetches one on startup.

Each page has roughly 120 results, and 25 pages give about 2,000 unique postings. `HIRINGCAFE_PAGES` sets the page count when the server does the fetch itself.

Salary (annual USD) and minimum years of experience come from HiringCafe's reading of each post. Posts that don't state them are left out of those charts.

API:

- `GET /api/jobs`: the default fetch
- `GET /api/fetches`: summary of every saved fetch, newest first
- `GET /api/fetches/<id>`: one saved fetch
- `POST /api/refresh`: start a new fetch; `GET /api/refresh` shows its progress
