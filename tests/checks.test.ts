import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkResults, checkSummary, runChecks, zoteroReaders } from "../src/checks.js";
import { type DB, now, openDb } from "../src/db.js";
import { homePage, probe, readLinks } from "../src/home.js";
import { serveHttp } from "../src/server.js";
import { dismiss, worklist } from "../src/worklist.js";
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
  it("matches an ISBN-10 to the same book's ISBN-13", () => {
    item("AAAA0001", { ISBN: "978-0-306-40615-7" });
    run([book("main:1", { calibre_uuid: UUID, isbns: ["0306406152"] })], []);
    expect(result("likely-missed-matches").count).toBe(1);
  });

  it("matches a book's ISBN however the feed writes it", () => {
    item("AAAA0001", { ISBN: "9780306406157" });
    run([book("main:1", { calibre_uuid: UUID, isbns: ["978-0-306-40615-7"] })], []);
    expect(result("likely-missed-matches").count).toBe(1);
    expect(db.prepare("SELECT work_key FROM work_keys WHERE key = '9780306406157' AND work_key = ?").get(`calibre:${UUID}`)).toBeTruthy();
  });

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
    await fetch(`${base}/zotero/${LIB}/items?since=2&limit=1&start=00`);
    expect(reads()).toEqual([{ address: "127.0.0.1", library: LIB, last_since: 2 }]);
    await fetch(`${base}/zotero/${LIB}/items?since=3&limit=1`);
    expect(reads()).toEqual([{ address: "127.0.0.1", library: LIB, last_since: 3 }]);
    await fetch(`${base}/zotero/${LIB}/deleted?since=6`);
    expect(reads()).toEqual([{ address: "127.0.0.1", library: LIB, last_since: 6 }]);
  });
});

describe("worklist", () => {
  let server: http.Server;
  let base: string;
  afterEach(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(async () => {
    server = await serveHttp(db, { host: "127.0.0.1", port: 0, access: { lanHosts: ["127.0.0.1"] } });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
  const missed = () => [book("main:1", { calibre_uuid: UUID, isbns: ["9781098151330"] })];

  it("lists what needs a person and leaves out the rest", () => {
    item("AAAA0001", { ISBN: "9781098151330", citationKey: "both2001" });
    item("BBBB0001", { citationKey: "both2001" }, { library: "groups/2" });
    item("CCCC0001", { citationKey: "same2001" });
    item("CCCC0002", { citationKey: "same2001" });
    const start = Date.now();
    run([...missed(), book("main:2", { zotero: { library: LIB, key: "GONE0001" } })], [], {}, start);
    const refs = () => worklist(db).open.map((i) => i.ref).sort();
    // A gone item is within its allowance, a citekey in both libraries is expected.
    expect(refs()).toEqual([`calibre:${UUID}`, "citekey:same2001"]);
    runChecks(db, {}, start + 2 * HOUR);
    expect(refs()).toEqual(["book:main:2", `calibre:${UUID}`, "citekey:same2001"]);
  });

  it("keeps a citekey on the list when two of its works are in one library, even if another library has it too", () => {
    item("CCCC0001", { citationKey: "same2001" });
    item("CCCC0002", { citationKey: "same2001" });
    item("CCCC0003", { citationKey: "same2001" }, { library: "groups/2" });
    run([], []);
    expect(worklist(db).open.map((i) => i.ref)).toEqual(["citekey:same2001"]);
  });

  it("refuses to dismiss a finding that isn't on the list", async () => {
    item("BBBB0001", { citationKey: "both2001" });
    item("BBBB0002", { citationKey: "both2001" }, { library: "groups/2" });
    run([], [], { HOLDINGS_ZOTERO_READERS: "quote-mcp=192.168.1.210:1800" });
    expect(dismiss(db, "one-work-per-exact-key", "citekey:both2001", "Fine")).toBe(false);
    expect((await post("/worklist/dismiss", { check: "zotero-readers-in-step", ref: "quote-mcp", reason: "Fine" })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_dismissals").get()).toEqual({ n: 0 });
  });

  it("links a quote-mcp entry with no work id back to quote-mcp", async () => {
    const start = Date.now();
    feed("counts", { version: 1, works: [] });
    db.prepare("UPDATE feeds SET url = 'http://quote-mcp.example:8000/api/holdings/counts' WHERE name = 'counts'").run();
    run([], [{ zotero: { library: LIB, key: "GONE0001" }, quotes: 1, notes: 0, verified: 0 }], {}, start);
    db.prepare("UPDATE feeds SET url = 'http://quote-mcp.example:8000/api/holdings/counts' WHERE name = 'counts'").run();
    runChecks(db, {}, start + 2 * HOUR);
    expect(worklist(db).open[0].ref).toBe(`quotes:${LIB}/GONE0001`);
    expect(await (await fetch(`${base}/worklist`)).text()).toContain("http://quote-mcp.example:8000/admin");
  });

  it("shows banners for a reader that stopped and a source that's down", () => {
    const start = Date.now();
    run([], [], { HOLDINGS_ZOTERO_READERS: "quote-mcp=192.168.1.210:1800" }, start);
    expect(worklist(db).banners).toEqual([]);
    runChecks(db, { HOLDINGS_ZOTERO_READERS: "quote-mcp=192.168.1.210:1800" }, start + 2 * HOUR);
    expect(worklist(db).banners[0]).toMatch(/quote-mcp .* has not read/);
    expect(worklist(db).open).toEqual([]);
    feed("counts", null, now(), "HTTP 500");
    runChecks(db, {}, start);
    expect(worklist(db).banners.join(" ")).toMatch(/not checked, because counts failed/);
  });

  it("dismisses with a reason, and brings the finding back on request", async () => {
    item("AAAA0001", { ISBN: "9781098151330" });
    run(missed(), []);
    const page = await (await fetch(`${base}/worklist`)).text();
    expect(page).toContain("zotero://select/library/items/AAAA0001");
    expect((await post("/worklist/dismiss", { check: "likely-missed-matches", ref: `calibre:${UUID}`, reason: "" })).status).toBe(400);
    const done = await post("/worklist/dismiss", { check: "likely-missed-matches", ref: `calibre:${UUID}`, reason: "Different edition" });
    expect(done.status).toBe(303);
    expect(worklist(db)).toMatchObject({ open: [], dismissed: [{ dismissed: { reason: "Different edition" } }] });
    expect((await (await fetch(`${base}/health`)).json() as { worklist: number }).worklist).toBe(0);
    runChecks(db, {});
    expect(worklist(db).open).toEqual([]);
    await post("/worklist/restore", { check: "likely-missed-matches", ref: `calibre:${UUID}` });
    expect(worklist(db).open).toHaveLength(1);
  });

  it("brings a dismissed finding back when it changes or returns", () => {
    item("AAAA0001", { ISBN: "9781098151330" });
    run(missed(), []);
    dismiss(db, "likely-missed-matches", `calibre:${UUID}`, "Fine");
    db.prepare("UPDATE check_findings SET detail = 'changed'").run();
    expect(worklist(db).open).toHaveLength(1);
    run(missed(), []);
    expect(worklist(db).open).toHaveLength(0);
    run([], []);
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_dismissals").get()).toEqual({ n: 0 });
    run(missed(), []);
    expect(worklist(db).open).toHaveLength(1);
  });

  it("keeps a dismissal while its check can't run", () => {
    item("AAAA0001", { ISBN: "9781098151330" });
    run(missed(), []);
    dismiss(db, "likely-missed-matches", `calibre:${UUID}`, "Fine");
    feed("books", { version: 1, books: [] }, now(), "HTTP 500");
    runChecks(db, {});
    expect(db.prepare("SELECT COUNT(*) AS n FROM check_dismissals").get()).toEqual({ n: 1 });
  });

  it("refuses a post from another site or without a form, and escapes what it shows", async () => {
    item("AAAA0001", { ISBN: "9781098151330", title: "x" });
    run([book("main:1", { calibre_uuid: UUID, isbns: ["9781098151330"], title: "<script>alert(1)</script>" })], []);
    expect(await (await fetch(`${base}/worklist`)).text()).not.toContain("<script>alert");
    expect((await post("/worklist/dismiss", { check: "likely-missed-matches", ref: `calibre:${UUID}`, reason: "x" }, { origin: "http://evil.example" })).status).toBe(403);
    const json = await fetch(`${base}/worklist/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
    expect((await fetch(`${base}/worklist`, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(`${base}/worklist/nope`)).status).toBe(404);
  });
});

describe("home page", () => {
  const entry = (base: string, path: string) => ({ name: "x", about: "x", base, probe: path, links: [] });
  let fake: http.Server;
  let fakeBase: string;
  beforeEach(async () => {
    fake = http.createServer((req, res) => {
      if (req.url === "/health") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, deployed: { commit: "abcdef1234", at: "2026-11-05T01:00:00Z" } }));
      if (req.url === "/boom") return void res.writeHead(500).end();
      res.writeHead(400).end();
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => fake.close(() => r())));

  it("says whether a server is up, answering, in trouble, or not there", async () => {
    expect(await probe(entry(fakeBase, "/health"))).toEqual({ state: "up", commit: "abcdef1", deployedAt: "2026-11-05T01:00:00Z" });
    expect(await probe(entry(fakeBase, "/mcp"))).toEqual({ state: "answering" });
    expect(await probe(entry(fakeBase, "/boom"))).toEqual({ state: "problem" });
    expect(await probe(entry("http://127.0.0.1:1", "/health"))).toEqual({ state: "down" });
  });

  it("reports a /health saying not ok, or not JSON, as a problem", async () => {
    const server = http.createServer((_, res) => res.writeHead(200).end("not json"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    expect((await probe(entry(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "/health"))).state).toBe("problem");
    await new Promise<void>((r) => server.close(() => r()));
    const unwell = http.createServer((_, res) => res.writeHead(200).end(JSON.stringify({ ok: false })));
    await new Promise<void>((r) => unwell.listen(0, "127.0.0.1", r));
    expect((await probe(entry(`http://127.0.0.1:${(unwell.address() as AddressInfo).port}`, "/health"))).state).toBe("problem");
    await new Promise<void>((r) => unwell.close(() => r()));
  });

  it("reads overrides, and keeps a bad one out", () => {
    expect(readLinks("quote-mcp=http://q.example:9000/x, nope, f=ftp://x, =http://y")).toEqual({
      links: new Map([["quote-mcp", "http://q.example:9000"]]), bad: ["nope", "f=ftp://x", "=http://y"],
    });
    expect(readLinks(undefined)).toEqual({ links: new Map(), bad: [] });
  });

  it("lists the core services and the clients apart, using overrides and feed addresses", async () => {
    run([], []);
    db.prepare("UPDATE feeds SET url = 'http://books.example:8000/api/holdings/books' WHERE name = 'books'").run();
    const everything = "corpus-mcp=@,quote-mcp=@,terminology-mcp=@,zotero-mcp=@,concept-clusters=@".replaceAll("@", fakeBase);
    const page = await homePage(db, { HOLDINGS_LINKS: everything });
    const core = page.indexOf("<h2>Core services"), clients = page.indexOf("<h2>Clients");
    expect(core).toBeGreaterThan(-1);
    expect(clients).toBeGreaterThan(core);
    for (const name of ["corpus-mcp", "quote-mcp", "terminology-mcp", "zotero-mcp"]) expect(page.indexOf(`<strong>${name}`)).toBeLessThan(clients);
    expect(page.indexOf("<strong>concept-clusters")).toBeGreaterThan(clients);
    expect(page).toContain(`href="${fakeBase}/admin/zotero"`);
    expect(page).toContain('href="/worklist"');
    const fromFeed = await homePage(db, { HOLDINGS_LINKS: "quote-mcp=@,terminology-mcp=@,zotero-mcp=@,concept-clusters=@,typo=@".replaceAll("@", fakeBase) });
    expect(fromFeed).toContain('href="http://books.example:8000/admin"');
    expect(fromFeed).toContain("entries it can't use: typo");
  }, 15_000);

  it("is on the LAN only", async () => {
    run([], []);
    const saved = process.env.HOLDINGS_LINKS;
    process.env.HOLDINGS_LINKS = "corpus-mcp=@,quote-mcp=@,terminology-mcp=@,zotero-mcp=@,concept-clusters=@".replaceAll("@", fakeBase);
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, access: { lanHosts: ["127.0.0.1"] } });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
    await new Promise<void>((r) => server.close(() => r()));
    if (saved === undefined) delete process.env.HOLDINGS_LINKS; else process.env.HOLDINGS_LINKS = saved;
  }, 15_000);
});
