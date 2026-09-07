import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiscogsMockServer } from "./discogs-mock-server.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.js");

// Runs the scraper CLI against a mock Discogs API in a given working directory and returns its output and exit code.
async function runApp(cwd, baseUrl) {
  const child = spawn("node", [APP], {
    cwd,
    env: {
      ...process.env,
      DISCOGS_API_BASE: baseUrl,
      DISCOGS_USERNAME: "test-user",
      DISCOGS_TOKEN: "test-token",
      MAX_REQUESTS: "1000",
    },
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, out };
}

// Creates and returns a fresh temporary directory for a test run.
function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "discos-test-"));
}

// Reads the exported collection.json output, or returns a marker object if it wasn't written.
function recording(outputPath) {
  try {
    return JSON.parse(readFileSync(path.join(outputPath, "collection.json"), "utf8"));
  } catch (err) {
    return { missing: err.code };
  }
}

// Builds a corrupt saved collection (10 repeated copies of page 1) plus the resume metadata to seed a run with.
function seedCorruptState(server) {
  const page1 = server.pageReleases(1);
  const items = [];
  for (let i = 0; i < 10; i++) items.push(...page1);
  return {
    items,
    meta: { page: 1, totalPages: 3, expected: 120, done: false },
  };
}

// Checks that a multi-page collection is fetched exactly once and stored in the three split data files.
test("fetches a multi-page collection once, without repeats", async () => {
  const server = new DiscogsMockServer();
  await server.start();
  const cwd = tempDir();
  try {
    const { code, out } = await runApp(cwd, server.url);

    assert.equal(code, 0);
    assert.deepEqual(server.collectionRequests, [1, 2, 3]);

    const json = recording(cwd);
    assert.equal(json.length, 120);
    assert.equal(new Set(json.map((x) => x.instance_id)).size, 120);
    assert.equal(json[0].order, 1);
    assert.equal(json[119].order, 120);

    const withMaster = json.filter((x) => x.master_url);
    assert.equal(withMaster.length, 90);
    assert.ok(withMaster.every((x) => x.title.startsWith("ResolvedTitle") && x.artists_sort && x.released));

    const withoutMaster = json.filter((x) => !x.master_url);
    assert.equal(withoutMaster.length, 30);
    assert.ok(withoutMaster.every((x) => x.title.startsWith("Album")));

    assert.match(out, /Wrote 120 records/);

    const storedItems = JSON.parse(readFileSync(path.join(cwd, "data/collection.json"), "utf8"));
    const storedMasters = JSON.parse(readFileSync(path.join(cwd, "data/masters.json"), "utf8"));
    const storedReleases = JSON.parse(readFileSync(path.join(cwd, "data/releases.json"), "utf8"));
    assert.equal(storedItems.length, 120);
    assert.equal(
      Object.keys(storedMasters).length,
      new Set(json.filter((x) => x.master_url).map((x) => x.master_url)).size
    );
    assert.equal(
      Object.keys(storedReleases).length,
      new Set(json.filter((x) => x.main_release_url).map((x) => x.main_release_url)).size
    );
    assert.equal(existsSync(path.join(cwd, "data/discos-dates.json")), false);
  } finally {
    await server.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Guards against an infinite fetch loop when the server starts serving stale duplicate pages.
test("stops with a warning when the server serves stale duplicate pages", async () => {
  const server = new DiscogsMockServer();
  server.stale = true;
  await server.start();
  const cwd = tempDir();
  try {
    const { code, out } = await runApp(cwd, server.url);

    assert.equal(code, 0);
    assert.ok(out.includes("no new items"), out);
    assert.ok(server.collectionRequests.length <= 2);

    const json = recording(cwd);
    assert.ok(json.length <= 50);
  } finally {
    await server.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Verifies that saved duplicates are removed and the run resumes to a complete, de-duplicated collection.
test("dedupes a corrupt saved state and resumes the full collection", async () => {
  const server = new DiscogsMockServer();
  await server.start();
  const cwd = tempDir();
  try {
    mkdirSync(path.join(cwd, "data"), { recursive: true });
    const seeded = seedCorruptState(server);
    writeFileSync(path.join(cwd, "data/collection.json"), JSON.stringify(seeded.items));
    writeFileSync(path.join(cwd, "data/state.json"), JSON.stringify({ collection: seeded.meta }));

    const { code, out } = await runApp(cwd, server.url);

    assert.equal(code, 0);
    assert.match(out, /Removed 450 duplicated/);
    assert.deepEqual(server.collectionRequests, [2, 3]);

    const json = recording(cwd);
    assert.equal(json.length, 120);
    assert.equal(new Set(json.map((x) => x.instance_id)).size, 120);
  } finally {
    await server.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});