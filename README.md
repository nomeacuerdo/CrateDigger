# CrateDigger

CLI scraper + web viewer for a Discogs collection (formerly codenamed *discos-dates*). It downloads a user's collection folder,
resolves each item's master and main release to get clean artist / title / release-year data,
and displays the result in a sortable, filterable table with a dark-mode web UI.

ShiteCoded with OpenCode 1.18 as a study and proof of concept. Fuck AI companies and their bankrupt morals.

## Tech stack

- **Node.js >= 18** (ES modules, native `fetch`, zero runtime dependencies)
- **Single dependency:** `dotenv` (loads `.env`)
- **CLI:** `index.js` + three small library modules under `lib/`
- **Web UI:** static HTML/CSS/JS, served by a zero-dependency `node:http` server
- **Tests:** Node's built-in `node:test` runner with an in-memory mock Discogs API

## Project structure

```
discos-dates/
  index.js                    CLI entry point: paginated fetch + master/release resolution pipeline
  lib/
    discogs.js                request() — rate-limited API calls with retry/backoff
    rate-limiter.js           RateLimiter — sliding-window rate limiter + countdown
    progress.js               Progress — live single-line CLI progress bar with ETA
  web/
    index.html                page markup
    style.css                 styles (dark by default, light via toggle)
    app.js                    data loading, joining, sorting, filtering, modal, theme
    server.mjs                tiny static file server for the UI and data
  data/                       persistent scraper output, used by the web UI
  test/
    pagination.test.mjs       integration tests for the scraper
    discogs-mock-server.mjs   in-memory fake Discogs API for tests
  collection.json             final enriched output (one ordered record per item)
```

## How the scraper works

`index.js` runs three phases:

1. **Collection** — fetch `/users/{user}/collection/folders/0/releases` page by page
   (`per_page=100`) until every item is downloaded. Duplicates in a saved state are removed,
   and a "stale page" guard stops the loop if the server keeps returning the same items.
2. **Masters** — take the unique `master_url` values from the collection and resolve each to
   its `main_release_url` (many collection items share a master, so each is fetched only once).
3. **Releases** — dedupe all `main_release_url`s and fetch `artists_sort`, `title` and
   `released` for each.

Every request respects a local sliding window (default 24 req/min) and retries with the API's
`Retry-After` header on 429. Progress shows per-phase percentage, elapsed time, and an ETA from
a rolling average request time.

### Persistence

Data is saved to three separate files plus one metadata file in `data/`, written after every
single request so a Ctrl-C or crash can be resumed without re-fetching:

| File            | Contents                                                        |
| --------------- | --------------------------------------------------------------- |
| `collection.json` | raw array of collection items                                   |
| `masters.json`    | map `master_url → main_release_url`                             |
| `releases.json`   | map `main_release_url → { artists_sort, title, released }`      |
| `state.json`      | resume metadata only: `{ collection: { page, totalPages, expected, done } }` |

The final `collection.json` in the project root is the enriched output: every collection item,
plus resolved artist/title/released (falling back to the collection's own fields when there is
no master), discogs URLs, cover image, formats, labels and rating.

## Installation

```bash
npm install
```

## Setup

Copy the example environment file and fill in your real values:

```bash
cp .env.example .env
```

`.env` variables:

| Variable           | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `DISCOGS_TOKEN`    | your Discogs personal access token (required)            |
| `DISCOGS_USERNAME` | your Discogs username (required)                         |
| `MAX_REQUESTS`     | requests allowed per 60s window (default `24`)           |
| `DISCOGS_API_BASE` | API base URL override, handy for local mocks (optional)  |

## Usage

Run the scraper (resumes from saved state if any):

```bash
npm start
```

Start completely over (deletes the `data/` files and `collection.json` output):

```bash
npm run reset
```

Example output at the end of a run:

```
Wrote 506 records to collection.json.
Masters mapped: 487
Releases resolved: 487
API requests this run: 1000 (1000 successful)
Elapsed: 6m 10s
```

### Web viewer

Serve the UI (default port `8080`, override with `PORT`):

```bash
npm run web
```

Open http://localhost:8080. The page reads `data/collection.json`, `data/masters.json` and
`data/releases.json` directly, so either run the scraper first or place your own copies there.

#### Web UI features

- Sortable table by artist, title or released date; the **#** header resets to collection order
- Filter chips: **All** / **Shared masters** / **No master**, plus a running group chip
- Per-row badges flag items that share a master release or have no master at all
- Clicking a row opens a detail modal with cover art, formats, labels, genres/styles, notes,
  rating, and links to the Discogs release/master pages
- Shared-master groups list the other collection items in the same master
- Dark theme by default, toggled in the header and persisted in `localStorage`

## Testing

```bash
npm test
```

The tests spawn `index.js` against an in-memory mock Discogs server and cover pagination without
repeats, the stale-page guard, and recovery from a corrupt saved state.


## Todo
* Add authentication to increase the Max Request limit.
* Extract from specific folders instead of the generic "All" folder
* Maybe Create a wizard to get the username and the login validation instead of .env?