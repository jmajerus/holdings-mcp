import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/db.js";
import { feedUrl, FEEDS, recordZotero } from "../src/feeds.js";
import { ToolError, findWork, getWork, holdingsStatus } from "../src/queries.js";
import { refresh } from "../src/refresh.js";
import { serveHttp } from "../src/server.js";
import { isbn13, isbnsOf } from "../src/works.js";

const LIB = "users/827407";
const BOOK_UUID = "f2b79da7-0000-4000-8000-000000000001";
const LOOSE_UUID = "f2b79da7-0000-4000-8000-000000000002";

function addItem(db: DB, key: string, data: Record<string, unknown>, parent: string | null = null) {
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, ?, ?, 0, ?)")
    .run(LIB, key, data.itemType, parent, JSON.stringify(data));
}

/** The two feeds, as corpus-mcp and quote-mcp serve them: a body, a strong ETag, 304 on a match. */
const bodies: Record<string, unknown> = {};
const hits: Record<string, number> = {};
let feeds: http.Server;
let env: NodeJS.ProcessEnv;

function books(extra: unknown[] = []) {
  bodies["/api/holdings/books"] = {
    version: 1,
    books: [
      { calibre_uuid: BOOK_UUID, book_id: "main:223", library: "main", title: "Learning Systems Thinking", authors: ["Diana Montalion"], year: 2024,
        formats: ["pdf"], has_text: true, citekey: "montalion2024learning", citekey_source: "zotero", zotero: { library: LIB, key: "MONT2024", matched_by: "confirmed" } },
      { calibre_uuid: LOOSE_UUID, book_id: "main:42", library: "main", title: "Thinking in Systems", authors: ["Donella Meadows"], year: 2008,
        formats: ["epub"], has_text: true, citekey: null, citekey_source: null, zotero: null },
      { calibre_uuid: null, book_id: "scans:7", library: "scans", title: "A Scanned Pamphlet", authors: [], year: null, formats: ["pdf"], has_text: false, citekey: null, zotero: null },
      ...extra,
    ],
  };
}

function counts(extra: unknown[] = []) {
  bodies["/api/holdings/counts"] = {
    version: 1,
    works: [
      { work_id: 499, match: "zotero", zotero: { library: LIB, key: "ROBE1993" }, citekey: "roberts1993victory", quotes: 12, notes: 1, verified: 0 },
      { work_id: 417, match: "unmatched", title: "Work on the Shelf", authors: ["Ann Author"], year: "1987", quotes: 4, notes: 0, verified: 0 },
      { work_id: 52, match: "ambiguous", candidates: [`${LIB}/ROBE1993`, `${LIB}/ROBE2001`], title: "Victory", authors: ["Roberts"], year: "2001", quotes: 7, notes: 2, verified: 0 },
      ...extra,
    ],
  };
}

beforeAll(async () => {
  feeds = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits[path] = (hits[path] ?? 0) + 1;
    if (!(path in bodies)) return void res.writeHead(404).end();
    const text = JSON.stringify(bodies[path]);
    const etag = `"${createHash("sha256").update(text).digest("hex").slice(0, 32)}"`;
    if (req.headers["if-none-match"] === etag) return void res.writeHead(304, { etag }).end();
    res.writeHead(200, { "content-type": "application/json", etag }).end(text);
  });
  await new Promise<void>((r) => feeds.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(feeds.address() as AddressInfo).port}`;
  env = { HOLDINGS_BOOKS_URL: base, HOLDINGS_COUNTS_URL: base };
});

afterAll(() => feeds.close());

let db: DB;

beforeEach(async () => {
  db = openDb(":memory:");
  addItem(db, "MONT2024", { itemType: "book", title: "Learning Systems Thinking", date: "2024-05", extra: "Citation Key: montalion2024learning", ISBN: "978-1-0981-5133-0",
    creators: [{ creatorType: "author", firstName: "Diana", lastName: "Montalion" }] });
  addItem(db, "PDF00001", { itemType: "attachment", title: "Full Text PDF", contentType: "application/pdf", filename: "montalion.pdf", linkMode: "imported_file" }, "MONT2024");
  addItem(db, "NOTE0001", { itemType: "note", note: "<p>a note</p>" }, "MONT2024");
  addItem(db, "ROBE1993", { itemType: "book", title: "Victory Over Mobbing", date: "1993", citationKey: "roberts1993victory",
    creators: [{ creatorType: "editor", name: "Roberts Collective" }] });
  addItem(db, "ROBE2001", { itemType: "book", title: "Victory Over Mobbing", date: "2001", creators: [{ creatorType: "author", lastName: "Roberts", firstName: "J." }] });
  addItem(db, "ARTI0001", { itemType: "journalArticle", title: "Mobbing at Work", date: "1990", creators: [{ creatorType: "author", lastName: "Leymann", firstName: "Heinz" }] });
  books();
  counts();
  await refresh(db, { zotero: [], env, force: true });
});

describe("works", () => {
  it("joins a Calibre book and quote counts to the Zotero item they're matched to", () => {
    const w = getWork(db, "montalion2024learning") as Record<string, any>;
    expect(w.key).toBe(`zotero:${LIB}/MONT2024`);
    expect(w.year).toBe(2024);
    expect(w.creators).toEqual(["Diana Montalion"]);
    expect(w.holdings.text).toMatchObject({ book_id: "main:223", formats: ["pdf"], tools: expect.arrayContaining(["search_corpus", "read_book"]) });
    expect(w.holdings.file.zotero).toEqual([{ attachment: "PDF00001", title: "Full Text PDF", content_type: "application/pdf", filename: "montalion.pdf" }]);
    expect(w.keys).toMatchObject({ item: "MONT2024", book_ids: ["main:223"], calibre: [`calibre:${BOOK_UUID}`], isbn: ["9781098151330"] });
    expect(w.cannot_cite).toBeUndefined();
  });

  it("answers to every key a work has", () => {
    const key = `zotero:${LIB}/MONT2024`;
    for (const k of [key, `${LIB}/MONT2024`, "MONT2024", "@montalion2024learning", "main:223", `calibre:${BOOK_UUID}`, BOOK_UUID, "978-1-0981-5133-0"]) {
      expect((getWork(db, k) as { key: string }).key, k).toBe(key);
    }
  });

  it("gives a paper book with quotes no text holding, and says why it can't be cited", () => {
    const w = getWork(db, "quote:417") as Record<string, any>;
    expect(w.key).toBe("quote:417");
    expect(w.holdings).toEqual({ quotes: { quotes: 4, notes: 0, verified: 0, tools: ["search_quotes", "cite_quote"], work: "quote:417" } });
    expect(w.cannot_cite).toEqual(["not_in_zotero", "no_citekey"]);
  });

  it("lists an ambiguous work's candidates", () => {
    const w = getWork(db, "quote:52") as Record<string, any>;
    expect(w.cannot_cite).toContain("ambiguous_edition");
    expect(w.candidates).toEqual([`zotero:${LIB}/ROBE1993`, `zotero:${LIB}/ROBE2001`]);
  });

  it("makes unfiled Calibre books works of their own, keyed by UUID, or by book id without one", () => {
    expect((getWork(db, "main:42") as Record<string, any>).key).toBe(`calibre:${LOOSE_UUID}`);
    const scan = getWork(db, "scans:7") as Record<string, any>;
    expect(scan.key).toBe("scans:7");
    expect(scan.holdings.file.calibre).toEqual([{ book_id: "scans:7", library: "scans", formats: ["pdf"], tools: ["render_page"] }]);
    expect(scan.holdings.text).toBeUndefined();
  });

  it("joins quotes saved from an unfiled Calibre book to that book's work, and follows it into Zotero", async () => {
    counts([{ work_id: 700, match: "unmatched", calibre_uuid: LOOSE_UUID, title: "Thinking in Systems", authors: ["Donella Meadows"], year: "2008", quotes: 2, notes: 0, verified: 2 }]);
    await refresh(db, { zotero: [], env, force: true });
    const loose = getWork(db, "quote:700") as Record<string, any>;
    expect(loose.key).toBe(`calibre:${LOOSE_UUID}`);
    expect(loose.holdings.text.book_id).toBe("main:42");
    expect(loose.holdings.quotes).toMatchObject({ quotes: 2, verified: 2, work: `calibre:${LOOSE_UUID}` });

    addItem(db, "MEAD2008", { itemType: "book", title: "Thinking in Systems", date: "2008", citationKey: "meadows2008thinking" });
    (bodies["/api/holdings/books"] as { books: Record<string, unknown>[] }).books[1].zotero = { library: LIB, key: "MEAD2008", matched_by: "confirmed" };
    await refresh(db, { zotero: [], env, force: true });
    expect((getWork(db, "quote:700") as Record<string, any>).key).toBe(`zotero:${LIB}/MEAD2008`);
    books();
    counts();
  });

  it("leaves notes and attachments out of works", () => {
    expect(() => getWork(db, "NOTE0001")).toThrow(ToolError);
    expect(() => getWork(db, "PDF00001")).toThrow(ToolError);
  });

  it("keeps an interim key resolving once its work is filed", async () => {
    // Meadows is filed in Zotero and corpus-mcp matches the book; quote-mcp merges work 417 into the filed item's work 600.
    addItem(db, "MEAD2008", { itemType: "book", title: "Thinking in Systems", date: "2008", citationKey: "meadows2008thinking",
      creators: [{ creatorType: "author", firstName: "Donella", lastName: "Meadows" }] });
    addItem(db, "SHEL1987", { itemType: "book", title: "Work on the Shelf", date: "1987", citationKey: "author1987work", creators: [{ creatorType: "author", name: "Ann Author" }] });
    const b = bodies["/api/holdings/books"] as { books: Record<string, unknown>[] };
    b.books[1].zotero = { library: LIB, key: "MEAD2008", matched_by: "isbn" };
    const c = bodies["/api/holdings/counts"] as { works: Record<string, unknown>[] };
    c.works[1] = { work_id: 600, match: "zotero", former_work_ids: [417], zotero: { library: LIB, key: "SHEL1987" }, citekey: "author1987work", quotes: 4, notes: 0, verified: 0 };
    const r = await refresh(db, { zotero: [], env, force: true });
    expect(r.retired?.sort()).toEqual([`calibre:${LOOSE_UUID}`, "quote:417"]);
    expect((getWork(db, `calibre:${LOOSE_UUID}`) as Record<string, any>).key).toBe(`zotero:${LIB}/MEAD2008`);
    const shelf = getWork(db, "quote:417") as Record<string, any>;
    expect(shelf.key).toBe(`zotero:${LIB}/SHEL1987`);
    expect(shelf.keys.former_keys).toEqual(["quote:417"]);
    expect(shelf.holdings.quotes.quotes).toBe(4);
  });
});

describe("find_work", () => {
  it("finds by words, ranks title matches first, and filters by holdings", () => {
    const r = findWork(db, { query: "victory" });
    expect(r.works.map((w) => w.key)).toEqual(expect.arrayContaining([`zotero:${LIB}/ROBE1993`, `zotero:${LIB}/ROBE2001`, "quote:52"]));
    expect(findWork(db, { query: "victory", has: ["quotes"] }).works.map((w) => w.key).sort()).toEqual(["quote:52", `zotero:${LIB}/ROBE1993`]);
    expect(findWork(db, { has: ["notes"] }).total).toBe(2);
    expect(findWork(db, { has: ["text"] }).works.map((w) => w.title).sort()).toEqual(["Learning Systems Thinking", "Thinking in Systems"]);
  });

  it("finds by author and by key", () => {
    expect(findWork(db, { author: "leymann" }).works.map((w) => w.title)).toEqual(["Mobbing at Work"]);
    expect(findWork(db, { author: "montal*" }).total).toBe(1);
    expect(findWork(db, { key: "main:223" }).works[0].citekey).toBe("montalion2024learning");
    expect(findWork(db, { key: "nope" }).total).toBe(0);
  });

  it("says what a key shared by several works names", () => {
    addItem(db, "DUPE0001", { itemType: "book", title: "Victory Over Mobbing (copy)", date: "1993", citationKey: "roberts1993victory" });
    return refresh(db, { zotero: [], env, force: true }).then(() => {
      const r = getWork(db, "roberts1993victory") as { works: unknown[]; note: string };
      expect(r.works).toHaveLength(2);
      expect(r.note).toMatch(/names 2 works/);
    });
  });
});

describe("feeds", () => {
  it("asks with the ETag and keeps the snapshot on a 304", async () => {
    const before = hits["/api/holdings/books"];
    const r = await refresh(db, { zotero: [], env });
    expect(r.changed).toBe(false);
    expect(hits["/api/holdings/books"]).toBe(before + 1);
    expect(findWork(db, { has: ["text"] }).total).toBe(2);
  });

  it("keeps the last good snapshot when a feed breaks", async () => {
    bodies["/api/holdings/books"] = { version: 2, books: "?" };
    await refresh(db, { zotero: [], env });
    const status = holdingsStatus(db);
    expect(status.feeds.find((f) => f.name === "books")?.error).toMatch(/expected \{ version: 1/);
    expect(findWork(db, { has: ["text"] }).total).toBe(2);
    books();
  });

  it("refuses a snapshot with a field of the wrong type, naming it", async () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["/api/holdings/books", { authors: "Diana Montalion" }, /books\[0\]: authors must be a list of strings/],
      ["/api/holdings/books", { has_text: "yes" }, /books\[0\]: has_text must be true or false/],
      ["/api/holdings/counts", { candidates: "users/827407/ROBE1993" }, /works\[0\]: candidates must be a list of strings/],
      ["/api/holdings/counts", { former_work_ids: [417, "52"] }, /works\[0\]: former_work_ids must be a list of integers/],
      ["/api/holdings/counts", { quotes: -1 }, /works\[0\]: quotes must be a count/],
    ];
    for (const [path, change, error] of cases) {
      const body = bodies[path] as Record<string, Record<string, unknown>[]>;
      const list = body.books ?? body.works;
      list[0] = { ...list[0], ...change };
      await refresh(db, { zotero: [], env });
      const name = path.endsWith("books") ? "books" : "counts";
      expect(holdingsStatus(db).feeds.find((f) => f.name === name)?.error).toMatch(error);
      expect(findWork(db, { has: ["text"] }).total).toBe(2);
      expect(findWork(db, { has: ["quotes"] }).total).toBe(3);
      books();
      counts();
    }
  });

  it("counts a Zotero deletion as a change", () => {
    recordZotero(db, LIB, { changed: 0, deleted: 0, version: 5 });
    const before = holdingsStatus(db).feeds.find((f) => f.name === `zotero:${LIB}`)?.changed_at;
    expect(before).toBeNull();
    recordZotero(db, LIB, { changed: 0, deleted: 2, version: 6 });
    expect(holdingsStatus(db).feeds.find((f) => f.name === `zotero:${LIB}`)?.changed_at).toBeTruthy();
  });

  it("reports unmatched books and entries it can't place", async () => {
    counts([{ zotero: { library: LIB, key: "GONE0001" }, quotes: 1, notes: 0, verified: 0 }]);
    await refresh(db, { zotero: [], env });
    const status = holdingsStatus(db);
    expect(status.works).toMatchObject({ calibre_only: 2, quotes_unmatched: 1, quotes_ambiguous: 1 });
    expect(status.unmatched_books.map((b) => b.book_ids[0]).sort()).toEqual(["main:42", "scans:7"]);
    expect(status.checks.find((c) => c.name === "items-exist")?.examples[0].detail).toMatch(/GONE0001/);
    counts();
  });

  it("finds a work by either form of its ISBN", async () => {
    addItem(db, "TENF0001", { itemType: "book", title: "Ten Form", ISBN: "0-306-40615-2" });
    addItem(db, "THIR0001", { itemType: "book", title: "Thirteen Form", ISBN: "978-0-8044-2957-3" });
    await refresh(db, { zotero: [], env, force: true });
    expect(getWork(db, "9780306406157")).toMatchObject({ title: "Ten Form" });
    expect(getWork(db, "0306406152")).toMatchObject({ title: "Ten Form" });
    expect(getWork(db, "080442957X")).toMatchObject({ title: "Thirteen Form" });
  });

  it("adds a feed's path to a base URL and leaves a full URL alone", () => {
    const [booksFeed] = FEEDS;
    expect(feedUrl(booksFeed, { HOLDINGS_BOOKS_URL: "http://corpus-mcp.localdomain:8000" })).toBe("http://corpus-mcp.localdomain:8000/api/holdings/books");
    expect(feedUrl(booksFeed, { HOLDINGS_BOOKS_URL: "http://x:1/other" })).toBe("http://x:1/other");
    expect(feedUrl(booksFeed, { HOLDINGS_BOOKS_URL: "off" })).toBeNull();
  });

  it("reads ISBNs however Zotero holds them", () => {
    expect(isbnsOf("978-1-0981-5133-0 0262011530; 123")).toEqual(["9781098151330", "0262011530"]);
    expect(isbn13("0306406152")).toBe("9780306406157");
    expect(isbn13("080442957X")).toBe("9780804429573");
    expect(isbn13("9791234567896")).toBe("9791234567896");
  });
});

describe("server", () => {
  let server: http.Server;
  let base: string;
  let token: string;
  let keys: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" }] });
    token = await new SignJWT({ email: "owner@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer("https://team.cloudflareaccess.com").setSubject("owner").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    server = await serveHttp(db, { host: "127.0.0.1", port: 0, access: { teamDomain: "https://team.cloudflareaccess.com", lanHosts: [] }, accessKeys: keys });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server.close());

  it("serves the tools over MCP on the LAN", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["find_work", "get_work", "holdings_status"]);
    const r = await client.callTool({ name: "get_work", arguments: { key: "nope" } });
    expect(r.isError).toBe(true);
    await client.close();
  });

  it("allows anonymous read-only library browsing through the tunnel", async () => {
    const headers = { "cf-ray": "test", host: "holdings.example.com" };
    const response = await fetch(`${base}/?q=systems&has=text`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("Learning Systems Thinking");
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
    const icon = await fetch(`${base}/favicon.svg`, { headers });
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(await icon.text()).toContain("<title>Holdings</title>");
    const iconHead = await fetch(`${base}/favicon.svg`, { method: "HEAD", headers });
    expect(iconHead.status).toBe(200);
    expect(await iconHead.text()).toBe("");
    expect((await fetch(`${base}/favicon.svg`, { method: "POST", headers })).status).toBe(405);
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain("Server health");
    expect(html).not.toContain("192.168.");
    expect((await fetch(`${base}/?key=montalion2024learning`, { headers })).status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const denied = await fetch(`${base}/`, { method, headers });
      expect(denied.status).toBe(405);
      expect(denied.headers.get("allow")).toBe("GET");
    }
    for (const route of ["/admin", "/worklist", "/api/checks", "/health", "/zotero/users/827407/items", "/mcp"]) {
      expect((await fetch(`${base}${route}`, { headers })).status).toBe(401);
    }
    for (const route of ["/api/refresh", "/worklist/dismiss", "/worklist/restore"]) {
      expect((await fetch(`${base}${route}`, { method: "POST", headers })).status).toBe(401);
    }
    expect((await fetch(`${base}/`, { headers: { ...headers, "cf-access-jwt-assertion": "invalid" } })).status).toBe(403);
    const directStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(`${base}/`, { headers: { host: "holdings.example.com" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
    });
    expect(directStatus).toBe(401);
    const signedIn = await fetch(`${base}/`, { headers: { ...headers, "cf-access-jwt-assertion": token } });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).not.toContain('href="/admin"');
  });

  it("needs an Access token through Cloudflare", async () => {
    expect((await fetch(`${base}/health`, { headers: { "cf-ray": "1" } })).status).toBe(401);
    const ok = await fetch(`${base}/health`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true });
    for (const route of ["/admin", "/worklist", "/api/checks", "/zotero/users/827407/items"]) {
      expect((await fetch(`${base}${route}`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
    }
  });
});
