import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rateLimiter, request } from "./lib/discogs.js";
import { Progress, formatTime } from "./lib/progress.js";

const USERNAME = process.env.DISCOGS_USERNAME;
const TOKEN = process.env.DISCOGS_TOKEN;
const STATE_DIR = "data";
const STATE_FILE = join(STATE_DIR, "state.json");
const COLLECTION_FILE = join(STATE_DIR, "collection.json");
const MASTERS_FILE = join(STATE_DIR, "masters.json");
const RELEASES_FILE = join(STATE_DIR, "releases.json");
const OUTPUT_FILE = "collection.json";
const COLLECTION_PATH = `/users/${USERNAME}/collection/folders/0/releases`;
const PER_PAGE = 100;
const RESET = process.argv.includes("--reset");

if (!USERNAME || !TOKEN) {
  console.error("Error: DISCOGS_USERNAME and DISCOGS_TOKEN must be set (edit .env)");
  process.exit(1);
}

let active = null;
rateLimiter.onWait = (seconds) => {
  if (active) active.wait(`Rate limit reached - waiting ${seconds}s`);
};

// Reads and parses a JSON file, returning null if it's missing or malformed.
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// Loads resumable state from the split data files (collection/masters/releases) plus state.json metadata.
async function loadState() {
  const masters = (await readJson(MASTERS_FILE)) ?? {};
  const mainReleases = (await readJson(RELEASES_FILE)) ?? {};

  const meta = (await readJson(STATE_FILE))?.collection ?? {};
  let items = await readJson(COLLECTION_FILE);
  if (!Array.isArray(items)) {
    if (items && Array.isArray(items.items)) {
      const legacy = items;
      meta.page = legacy.page ?? meta.page;
      meta.totalPages = legacy.totalPages ?? meta.totalPages;
      meta.expected = legacy.expected ?? meta.expected;
      meta.done = legacy.done ?? meta.done;
      items = legacy.items;
    } else {
      items = [];
    }
  }
  items = items ?? [];

  const derived = Math.max(0, Math.ceil(items.length / PER_PAGE));
  return {
    collection: {
      page: meta.page ?? derived,
      totalPages: meta.totalPages ?? Math.max(1, derived),
      expected: meta.expected ?? 0,
      done: meta.done ?? false,
      items,
    },
    masters,
    mainReleases,
  };
}

// Saves the raw collection items array plus the pagination metadata in state.json, both atomically.
async function saveCollection(state) {
  await mkdir(STATE_DIR, { recursive: true });
  const c = state.collection;
  await Promise.all([
    writeFile(COLLECTION_FILE, JSON.stringify(c.items, null, 2) + "\n", "utf8"),
    writeFile(
      STATE_FILE,
      JSON.stringify(
        { collection: { page: c.page, totalPages: c.totalPages, expected: c.expected ?? 0, done: c.done } },
        null,
        2
      ) + "\n",
      "utf8"
    ),
  ]);
}

// Saves the master_url → main_release_url map to masters.json.
async function saveMasters(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(MASTERS_FILE, JSON.stringify(state.masters, null, 2) + "\n", "utf8");
}

// Saves the main_release_url → resolved details map to releases.json.
async function saveReleases(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(RELEASES_FILE, JSON.stringify(state.mainReleases, null, 2) + "\n", "utf8");
}

// Removes repeated collection items (same instance_id) from a list, keeping first occurrences.
async function dedupeItems(items) {
  const seen = new Set();
  const unique = [];
  for (const it of items) {
    const key = it.instance_id ?? it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }
  return unique;
}

// Fetches every page of the collection, deduping saved items and resuming from where it left off.
async function phaseCollection(state) {
  const c = state.collection;

  const uniqueItems = await dedupeItems(c.items);
  if (uniqueItems.length !== c.items.length) {
    console.log(`Removed ${c.items.length - uniqueItems.length} duplicated collection items from state.`);
    c.items = uniqueItems;
  }

  if (c.done && c.expected && c.items.length < c.expected) {
    console.log(
      `Collection was marked complete with ${c.items.length}/${c.expected} items - fetching missing pages.`
    );
    c.done = false;
  }

  const seen = new Set(c.items.map((it) => it.instance_id ?? it.id));
  let expected = c.expected || 0;
  let pages = Math.max(c.totalPages || 1, c.page || 1);
  active = new Progress("Collection", pages);
  active.record(c.page, `resuming after page ${c.page}`);

  let page = c.page || 0;
  while (page < pages) {
    page += 1;
    const data = await request(`${COLLECTION_PATH}?page=${page}&per_page=${PER_PAGE}`);
    const pag = data?.pagination ?? {};
    if (pag.items) expected = c.expected = pag.items;
    if (pag.pages) pages = pag.pages;
    active.setTotal(pages);

    let added = 0;
    for (const item of data.releases ?? []) {
      const key = item.instance_id ?? item.id;
      if (seen.has(key)) continue;
      seen.add(key);
      c.items.push(item);
      added++;
    }

    c.page = page;
    c.totalPages = pages;
    c.done = page >= pages || (expected > 0 && c.items.length >= expected);

    if (added === 0 && page > 1 && !c.done) {
      console.log(
        `\nPage ${page}/${pages} returned no new items - server response looks stale. Stopping to avoid repeats.`
      );
      c.done = true;
    }

    await saveCollection(state);
    active.tick(`page ${page}/${pages} - ${c.items.length} items`);
    if (c.done) break;
  }
  active.finish();
}

// Lists master URLs from the collection that still need mapping to a main release, preserving first-seen order.
function pendingMasters(state) {
  const seen = new Set();
  const out = [];
  for (const item of state.collection.items) {
    const mu = item.basic_information?.master_url;
    if (mu && !(mu in state.masters) && !seen.has(mu)) {
      seen.add(mu);
      out.push(mu);
    }
  }
  return out;
}

// Resolves each pending master to its main_release_url, saving after every request.
async function phaseMasters(state) {
  const pending = pendingMasters(state);
  active = new Progress("Master lookups", pending.length);
  for (let i = 0; i < pending.length; i++) {
    const mu = pending[i];
    const data = await request(mu);
    state.masters[mu] = data?.main_release_url ?? null;
    await saveMasters(state);
    active.tick(`${Object.keys(state.masters).length} masters mapped`);
  }
  active.finish();
}

// Lists main release URLs that still need their artist/title/year details resolved.
function pendingMainReleases(state) {
  const seen = new Set();
  const out = [];
  for (const mru of Object.values(state.masters)) {
    if (mru && !(mru in state.mainReleases) && !seen.has(mru)) {
      seen.add(mru);
      out.push(mru);
    }
  }
  return out;
}

// Fetches artists_sort, title and released for each pending main release, saving after each request.
async function phaseMainReleases(state) {
  const pending = pendingMainReleases(state);
  active = new Progress("Release lookups", pending.length);
  for (let i = 0; i < pending.length; i++) {
    const url = pending[i];
    const data = await request(url);
    state.mainReleases[url] = data
      ? {
          artists_sort: data.artists_sort ?? null,
          title: data.title ?? null,
          released: data.released ?? null,
        }
      : null;
    await saveReleases(state);
    active.tick(`${Object.keys(state.mainReleases).length} releases resolved`);
  }
  active.finish();
}

// Blends each collection item with its resolved master/release details into the final ordered records.
function buildOutput(state) {
  return state.collection.items.map((item, i) => {
    const bio = item.basic_information ?? {};
    const masterUrl = bio.master_url ?? null;
    const mainReleaseUrl = masterUrl ? (state.masters[masterUrl] ?? null) : null;
    const resolved = mainReleaseUrl ? (state.mainReleases[mainReleaseUrl] ?? null) : null;
    return {
      order: i + 1,
      instance_id: item.instance_id ?? null,
      release_id: item.id ?? null,
      date_added: item.date_added ?? null,
      rating: item.rating ?? null,
      title: resolved?.title ?? bio.title ?? null,
      artists_sort: resolved?.artists_sort ?? bio.artists?.[0]?.name ?? null,
      released: resolved?.released ?? bio.year ?? null,
      master_url: masterUrl,
      main_release_url: mainReleaseUrl,
      year: bio.year ?? null,
      formats: bio.formats ?? [],
      cover_image: bio.cover_image ?? null,
    };
  });
}

// Runs the pipeline: reset or resume, the three fetch phases, then writes collection.json with a summary.
async function main() {
  let state;
  if (RESET) {
    await Promise.all([
      rm(STATE_FILE, { force: true }).catch(() => {}),
      rm(COLLECTION_FILE, { force: true }).catch(() => {}),
      rm(MASTERS_FILE, { force: true }).catch(() => {}),
      rm(RELEASES_FILE, { force: true }).catch(() => {}),
    ]);
    state = {
      collection: { page: 0, totalPages: 0, done: false, items: [] },
      masters: {},
      mainReleases: {},
    };
    console.log("Reset state - starting fresh.");
  } else {
    state = await loadState();
    if (state.collection.items.length) {
      console.log(`Resuming with ${state.collection.items.length} collection items already fetched.`);
    }
  }

  const t0 = Date.now();
  console.log(`User: ${USERNAME}`);
  console.log(`Collection: ${COLLECTION_PATH}`);
  console.log("");

  await phaseCollection(state);
  await phaseMasters(state);
  await phaseMainReleases(state);

  active = null;
  rateLimiter.onWait = () => {};
  const output = buildOutput(state);
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");

  const secs = Math.round((Date.now() - t0) / 1000);
  console.log("");
  console.log(`Wrote ${output.length} records to ${OUTPUT_FILE}.`);
  console.log(`Masters mapped: ${Object.keys(state.masters).length}`);
  console.log(`Releases resolved: ${Object.keys(state.mainReleases).length}`);
  console.log(`API requests this run: ${rateLimiter.totalRequests} (${rateLimiter.successes} successful)`);
  console.log(`Elapsed: ${formatTime(secs)}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  console.error("State was saved; re-run to resume where it left off.");
  process.exit(1);
});