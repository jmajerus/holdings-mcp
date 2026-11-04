import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkResults, checkSummary, runChecks, zoteroReaders } from "../src/checks.js";
import { type DB, now, openDb } from "../src/db.js";
import { serveHttp } from "../src/server.js";
import { rebuildWorks } from "../src/works.js";

/** Each check gets data that breaks what it guards, and correct data it must pass (docs/cross-service-checks.md). */

const LIB = "users/1";
const HOUR = 3_600_000;
const UUID = "f2b79da7-0000-4000-8000-000000000001";
let db: DB;

function item(key: string, data: Record<string, unknown>, options: { deleted?: boolean; library?: string } = {}) {
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, ?, NULL, ?, ?)")
    .run(options.library ?? LIB, key, data.itemType ?? "book", options.deleted ? 1 : 0, JSON.stringify({ itemType: "book", title: key, ...data }));
}

function feed(name: string, body: unknown, ok_at: string | null = now(), error: string | null = null) {
  db.prepare("INSERT INTO feeds (name, body, ok_at, error) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body, ok_at = excluded.ok_at, error = excluded.error")
    .run(name, body === null ? null : JSON.stringify(body), ok_at, error);
}

const book = (id: string, extra: Record<string, unknown> = {}) => ({ calibre_uuid: null, book_id: id, library: "main", title: id, authors: [], formats: ["pdf"], has_text: true, ...extra });
const quoted = (id: number, extra: Record<string, unknown> = {}) => ({ work_id: id, quotes: 1, notes: 0, verified: 0, ...extra });

function run(books: unknown[], counts: unknown[], env: NodeJS.ProcessEnv = {}, at?: number) {
  feed("books", { version: 1, books });
  feed("counts", { version: 1, works: counts });
  feed(`zotero:${LIB}`, null);
  rebuildWorks(db);
  runChecks(db, env, at);
}

const result = (name: string) => checkResults(db).find((c) => c.name === name)!;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("correct data", () => {
  it("passes every check, editions sharing an ISBN included", () => {
    item("AAAA0001", { ISBN: "9781098151330", citationKey: "one2001" });
    item("AAAA0002", { ISBN: "9781098151330", citationKey: "two2002" });
    run([book("main:1", { zotero: { library: LIB, key: "AAAA0001" }, isbns: ["9781098151330"], citekey: "one2001" })], [quoted(1, { zotero: { library: LIB, key: "AAAA0002" } })]);
    expect(checkSummary(db)).toEqual({ ok: 6, drift: 0, fail: 0, skipped: 0, failing: [] });
  });
});

describe("items-exist", () => {
  it("says why an item a feed names isn't a work, and fails only after an hour", () => {
    item("TRASHED1", {}, { deleted: true });
    item("ANOTE001", { itemType: "note" });
    const start = Date.now();
    run([book("main:1", { zotero: { library: LIB, key: "TRASHED1" } })], [quoted(5, { zotero: { library: LIB, key: "MISSING1" } }), quoted(6, { zotero: { library: LIB, key: "ANOTE001" } })], {}, start);
    const check = result("items-exist");
    expect(check.result).toBe("drift");
    expect(check.count).toBe(3);
    const detail = check.examples.map((e) => e.detail).join("\n");
    expect(detail).toMatch(/TRASHED1, which is in Zotero's trash/);
    expect(detail).toMatch(/MISSING1, which is not in the mirror/);
    expect(detail).toMatch(/ANOTE001, which is a note, not a work/);

    runChecks(db, {}, start + 2 * HOUR);
    const later = result("items-exist");
    expect(later.result).toBe("fail");
    expect(later.first_seen).toBe(new Date(start).toISOString());
    expect(checkSummary(db).failing).toEqual(["items-exist"]);
  });

  it("drops a finding once it's fixed, and starts its age over if it comes back", () => {
    const start = Date.now();
    const broken = [book("main:1", { zotero: { library: LIB, key: "GONE0001" } })];
    run(broken, [], {}, start);
    expect(result("items-exist").count).toBe(1);
    run([], [], {}, start + HOUR);
    expect(result("items-exist")).toMatchObject({ result: "ok", count: 0 });
    run(broken, [], {}, start + 2 * HOUR);
    expect(result("items-exist").first_seen).toBe(new Date(start + 2 * HOUR).toISOString());
  });
});

describe("one-quote-work-per-item", () => {
  it("fails when two quote-mcp works name one item", () => {
    item("AAAA0001", {});
    run([], [quoted(1, { zotero: { library: LIB, key: "AAAA0001" } }), quoted(2, { zotero: { library: LIB, key: "AAAA0001" } })]);
    expect(result("one-quote-work-per-item")).toMatchObject({ result: "fail", count: 1, fix: "quote-mcp" });
  });
});

describe("one-work-per-exact-key", () => {
  it("fails on an exact key naming two works, whatever its case", () => {
    item("AAAA0001", {});
    item("AAAA0002", {});
    run([], []);
    db.prepare("INSERT INTO work_keys (key, work_key, kind) VALUES ('main:1', ?, 'book')").run(`zotero:${LIB}/AAAA0001`);
    db.prepare("INSERT INTO work_keys (key, work_key, kind) VALUES ('MAIN:1', ?, 'book')").run(`zotero:${LIB}/AAAA0002`);
    runChecks(db, {});
    expect(result("one-work-per-exact-key")).toMatchObject({ result: "fail", count: 1 });
  });

  it("reports a shared citekey as drift, which never fails", () => {
    item("AAAA0001", { citationKey: "same2001" });
    item("AAAA0002", { citationKey: "same2001" });
    const start = Date.now();
    run([], [], {}, start);
    runChecks(db, {}, start + 1000 * HOUR);
    expect(result("one-work-per-exact-key")).toMatchObject({ result: "drift", count: 1 });
    expect(result("one-work-per-exact-key").examples[0].ref).toBe("citekey:same2001");
  });
});

describe("filed-but-unmatched", () => {
  it("names the library of an item carrying an unmatched book's UUID, and only that", () => {
    item("FILED001", { extra: `Calibre UUID: ${UUID}` }, { library: LIB });
    item("FILED002", { extra: "Calibre UUID: f2b79da7-0000-4000-8000-00000000ffff" });
    const start = Date.now();
    run([book("main:1", { calibre_uuid: UUID })], [], {}, start);
    const check = result("filed-but-unmatched");
    expect(check).toMatchObject({ result: "drift", count: 1 });
    expect(check.examples[0]).toMatchObject({ ref: `calibre:${UUID}` });
    expect(check.examples[0].detail).toContain(`${LIB}/FILED001`);
    runChecks(db, {}, start + 2 * HOUR);
    expect(result("filed-but-unmatched").result).toBe("fail");
  });

  it("passes once corpus-mcp has matched it", () => {
    item("FILED001", { extra: `Calibre UUID: ${UUID}` });
    run([book("main:1", { calibre_uuid: UUID, zotero: { library: LIB, key: "FILED001" } })], []);
    expect(result("filed-but-unmatched").result).toBe("ok");
  });
});

describe("likely-missed-matches", () => {
  it("says it can't tell when the books feed sends no ISBNs, rather than passing", () => {
    run([book("main:1")], []);
    expect(result("likely-missed-matches")).toMatchObject({ result: "skipped", reason: "corpus-mcp's books feed sends no ISBNs" });
  });

  it("reports an unfiled book sharing an ISBN with an item, and never fails", () => {
    item("AAAA0001", { ISBN: "978-1-0981-5133-0" });
    const start = Date.now();
    run([book("main:1", { calibre_uuid: UUID, isbns: ["9781098151330"] }), book("main:2", { isbns: ["9780000000002"] })], [], {}, start);
    runChecks(db, {}, start + 1000 * HOUR);
    expect(result("likely-missed-matches")).toMatchObject({ result: "drift", count: 1, fix: "a person, at corpus-mcp's /admin/zotero" });
  });
});

describe("zotero-readers-in-step", () => {
  const env = { HOLDINGS_ZOTERO_READERS: "quote-mcp=192.168.1.210:1800" };
  const read = (at: string) => db.prepare("INSERT OR REPLACE INTO zotero_readers (address, library, last_read, last_since) VALUES ('192.168.1.210', ?, ?, 5)").run(LIB, at);

  it("passes with no readers configured, and within three intervals", () => {
    const start = Date.now();
    run([], [], {}, start);
    expect(result("zotero-readers-in-step").result).toBe("ok");
    read(new Date(start - HOUR).toISOString());
    runChecks(db, env, start);
    expect(result("zotero-readers-in-step").result).toBe("ok");
  });

  it("drifts past three intervals, then fails after three more", () => {
    const start = Date.now();
    read(new Date(start - 2 * HOUR).toISOString());
    run([], [], env, start);
    const check = result("zotero-readers-in-step");
    expect(check).toMatchObject({ result: "drift", count: 1 });
    expect(check.examples[0].detail).toMatch(/quote-mcp \(192\.168\.1\.210\) last read at/);
    runChecks(db, env, start + 2 * HOUR);
    expect(result("zotero-readers-in-step").result).toBe("fail");
  });

  it("flags a reader that has never read", () => {
    run([], [], env);
    expect(result("zotero-readers-in-step").examples[0].detail).toMatch(/has not read/);
  });

  it("reports a malformed setting as skipped, with why, and the others still run", () => {
    expect(() => zoteroReaders({ HOLDINGS_ZOTERO_READERS: "quote-mcp" })).toThrow(/name=address:seconds/);
    run([], [], { HOLDINGS_ZOTERO_READERS: "quote-mcp" });
    expect(result("zotero-readers-in-step")).toMatchObject({ result: "skipped", reason: expect.stringMatching(/name=address:seconds/) });
    expect(checkSummary(db)).toMatchObject({ ok: 5, skipped: 1 });
  });
});

describe("stale inputs", () => {
  it("gives no verdict on a failed or stale feed, and keeps what it had found", () => {
    item("AAAA0001", {});
    const broken = [quoted(1, { zotero: { library: LIB, key: "AAAA0001" } }), quoted(2, { zotero: { library: LIB, key: "AAAA0001" } })];
    run([], broken);
    expect(result("one-quote-work-per-item").result).toBe("fail");

    feed("counts", { version: 1, works: [] }, now(), "HTTP 500");
    runChecks(db, {});
    expect(result("one-quote-work-per-item")).toMatchObject({ result: "skipped", reason: "counts failed", count: 1 });

    feed("counts", { version: 1, works: [] }, new Date(Date.now() - 2 * HOUR).toISOString());
    runChecks(db, {});
    expect(result("one-quote-work-per-item")).toMatchObject({ result: "skipped", reason: "counts is stale" });
    expect(result("zotero-readers-in-step").result).toBe("ok");
  });

  it("skips a check whose feed has never answered", () => {
    runChecks(db, {});
    expect(result("items-exist")).toMatchObject({ result: "skipped", reason: "books has no data; counts has no data" });
  });
});

describe("examples", () => {
  it("reports the whole count and ten examples", () => {
    run(Array.from({ length: 15 }, (_, i) => book(`main:${i}`, { zotero: { library: LIB, key: `GONE${i}` } })), []);
    expect(result("items-exist").count).toBe(15);
    expect(result("items-exist").examples).toHaveLength(10);
  });
});

describe("over HTTP", () => {
  let server: http.Server;
  let base: string;
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(async () => {
    server = await serveHttp(db, { host: "127.0.0.1", port: 0, access: { lanHosts: ["127.0.0.1"] } });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it("summarises in /health and gives the rest at /api/checks, with since for what's new", async () => {
    const start = Date.now();
    const old = book("main:1", { zotero: { library: LIB, key: "OLD00001" } });
    run([old], [], {}, start);
    run([old, book("main:2", { zotero: { library: LIB, key: "NEW00001" } })], [], {}, start + HOUR);

    expect((await (await fetch(`${base}/health`)).json() as { checks: unknown }).checks).toMatchObject({ drift: 1, fail: 0 });
    const all = await (await fetch(`${base}/api/checks`)).json() as { checks: { name: string; count: number }[] };
    expect(all.checks.find((c) => c.name === "items-exist")?.count).toBe(2);
    const since = new Date(start + HOUR).toISOString();
    const fresh = await (await fetch(`${base}/api/checks?since=${since}`)).json() as { checks: { name: string; count: number; examples: { ref: string }[] }[] };
    const items = fresh.checks.find((c) => c.name === "items-exist")!;
    expect(items.count).toBe(1);
    expect(items.examples[0].ref).toBe("book:main:2");

    expect((await fetch(`${base}/api/checks?since=soon`)).status).toBe(400);
    expect((await fetch(`${base}/api/checks`, { method: "POST" })).status).toBe(405);
  });

  it("records who reads /zotero: first pages and /deleted, not errors or later pages", async () => {
    item("AAAA0001", {});
    run([], []);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '7')").run(`zotero_version:${LIB}`);
    const reads = () => db.prepare("SELECT address, library, last_since FROM zotero_readers").all();

    await fetch(`${base}/zotero/${LIB}/items?since=3&limit=1&start=1`);
    expect(reads()).toEqual([]);
    await fetch(`${base}/zotero/${LIB}/items?q=x`);
    expect(reads()).toEqual([]);
    await fetch(`${base}/zotero/${LIB}/items?since=3&limit=1`);
    expect(reads()).toEqual([{ address: "127.0.0.1", library: LIB, last_since: 3 }]);
    await fetch(`${base}/zotero/${LIB}/deleted?since=6`);
    expect(reads()).toEqual([{ address: "127.0.0.1", library: LIB, last_since: 6 }]);
  });
});
