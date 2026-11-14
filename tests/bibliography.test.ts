import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import { bibliography, cslDate, toCsl } from "../src/bibliography.js";
import { type DB, now, openDb } from "../src/db.js";
import { getWork } from "../src/queries.js";
import { serveHttp } from "../src/server.js";
import { rebuildWorks } from "../src/works.js";

const LIB = "users/1";
const UUID = "f2b79da7-0000-4000-8000-000000000001";
let db: DB;

function item(key: string, data: Record<string, unknown>) {
  db.prepare("INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, 1, ?, NULL, 0, ?)")
    .run(LIB, key, data.itemType ?? "book", JSON.stringify({ itemType: "book", ...data }));
}

function feed(name: string, body: unknown) {
  db.prepare("INSERT INTO feeds (name, body, ok_at) VALUES (?, ?, ?)").run(name, JSON.stringify(body), now());
}

beforeEach(() => {
  db = openDb(":memory:");
  item("RUSS2019", {
    title: "Human Compatible", citationKey: "russell2019human", date: "2019-10-08", publisher: "Viking", place: "New York", ISBN: "9780525558620",
    creators: [{ creatorType: "author", firstName: "Stuart", lastName: "Russell" }],
  });
  item("ESSY0001", {
    itemType: "bookSection", title: "On Violence", bookTitle: "Crises of the Republic", pages: "103-198", date: "1972",
    extra: "Citation Key: arendt1972violence\noriginal-date: 1970", publisher: "Harcourt",
    creators: [{ creatorType: "author", firstName: "Hannah", lastName: "Arendt" }, { creatorType: "translator", name: "Nobody In Particular" }, { creatorType: "castMember", lastName: "Ignored" }],
  });
  item("DUPE0001", { title: "One Edition", citationKey: "shared2000" });
  item("DUPE0002", { title: "Another Edition", citationKey: "shared2000" });
  feed("books", { version: 1, books: [
    { calibre_uuid: UUID, book_id: "main:184", library: "main", title: "Facilitating Software Architecture", authors: ["Andrew Harmel-Law"], formats: ["pdf"], has_text: true, citekey: null, proposed_citekey: "harmel-law2024facilitating", zotero: null },
    { calibre_uuid: null, book_id: "main:49", library: "main", title: "Reality Lost", authors: [], formats: ["epub"], has_text: true, citekey: "hendricks2018reality", proposed_citekey: "russell2019human", zotero: null },
    { calibre_uuid: null, book_id: "main:643", library: "main", title: "Human Compatible", authors: ["Stuart Russell"], formats: ["epub"], has_text: true, citekey: "russell2019human", zotero: { library: LIB, key: "RUSS2019" } },
  ] });
  feed("counts", { version: 1, works: [{ work_id: 9, match: "unmatched", citekey: "paper1950only", title: "A Paper Book", quotes: 2, notes: 0 }] });
  rebuildWorks(db);
});

describe("toCsl", () => {
  it("maps a book's fields, creators, and date", () => {
    expect(bibliography(db, ["russell2019human"]).items).toEqual([{
      id: "russell2019human", type: "book", title: "Human Compatible", publisher: "Viking", "publisher-place": "New York", ISBN: "9780525558620",
      author: [{ family: "Russell", given: "Stuart" }], issued: { "date-parts": [[2019, 10, 8]] },
    }]);
  });

  it("reads the citekey and CSL variables from Extra, and skips a creator type CSL has no role for", () => {
    const [csl] = bibliography(db, ["@arendt1972violence"]).items;
    expect(csl).toMatchObject({
      id: "arendt1972violence", type: "chapter", "container-title": "Crises of the Republic", page: "103-198",
      "original-date": { "date-parts": [[1970]] }, author: [{ family: "Arendt", given: "Hannah" }], translator: [{ literal: "Nobody In Particular" }],
    });
    expect(JSON.stringify(csl)).not.toContain("Ignored");
  });

  it("takes the first title field with a value, and an unknown type as a document", () => {
    expect(toCsl({ itemType: "somethingNew", title: "T", shortTitle: "S" }, "k")).toEqual({ id: "k", type: "document", title: "T", "title-short": "S" });
  });

  it("reads dates as parts where it can", () => {
    expect(cslDate("2019")).toEqual({ "date-parts": [[2019]] });
    expect(cslDate("2019-00-00")).toEqual({ "date-parts": [[2019]] });
    expect(cslDate("October 8, 2019")).toEqual({ "date-parts": [[2019]] });
    expect(cslDate("n.d.")).toEqual({ literal: "n.d." });
    expect(cslDate("")).toBeUndefined();
  });
});

describe("bibliography", () => {
  it("names an unfiled Calibre book for corpus-mcp, a shared citekey's candidates, and what it can't describe", () => {
    const b = bibliography(db, ["harmel-law2024facilitating", "shared2000", "nobody1900nothing", "paper1950only", "russell2019human", "Russell2019Human"]);
    // main:184 has only a proposed key. main:49's stale proposal doesn't compete with the work whose citekey that is.
    expect(b.unfiled).toEqual([{ citekey: "harmel-law2024facilitating", work: `calibre:${UUID}`, book_id: "main:184", calibre_uuid: UUID }]);
    expect(bibliography(db, ["hendricks2018reality"]).unfiled).toEqual([{ citekey: "hendricks2018reality", work: "main:49", book_id: "main:49", calibre_uuid: null }]);
    expect(b.ambiguous).toEqual([{ citekey: "shared2000", candidates: [`zotero:${LIB}/DUPE0001`, `zotero:${LIB}/DUPE0002`] }]);
    expect(b.missing).toEqual(["nobody1900nothing", "paper1950only"]);
    // A citekey asked for twice, in any case, is answered once, under Zotero's spelling.
    expect(b.items.map((i) => i.id)).toEqual(["russell2019human"]);
  });

  it("keeps a proposed key out of the work's own keys", () => {
    expect(() => getWork(db, "harmel-law2024facilitating")).toThrow(/No work has the key/);
    expect(JSON.stringify(getWork(db, "main:184"))).not.toContain("harmel-law2024facilitating");
  });

  it("doesn't take an ISBN or an item key for a citekey", () => {
    expect(bibliography(db, ["9780525558620", "RUSS2019"])).toMatchObject({ items: [], missing: ["9780525558620", "RUSS2019"] });
  });
});

describe("GET /api/bibliography", () => {
  it("answers on the LAN, and says what it needs", async () => {
    const server = await serveHttp(db, { host: "127.0.0.1", port: 0, access: { lanHosts: ["127.0.0.1"] } });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await fetch(`${base}/api/bibliography?citekeys=russell2019human,nobody1900nothing&citekeys=shared2000`);
      expect(ok.status).toBe(200);
      const body = await ok.json() as { items: { id: string }[]; missing: string[]; ambiguous: unknown[] };
      expect(body.items.map((i) => i.id)).toEqual(["russell2019human"]);
      expect(body.missing).toEqual(["nobody1900nothing"]);
      expect(body.ambiguous).toHaveLength(1);
      expect((await fetch(`${base}/api/bibliography`)).status).toBe(400);
      expect((await fetch(`${base}/api/bibliography?citekeys=a`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});
