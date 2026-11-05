import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DB, getMeta, openDb, setMeta } from "../src/db.js";
import { type Refresher, startRefresh } from "../src/refresh.js";
import { serveHttp } from "../src/server.js";
import { syncLibrary } from "../src/sync.js";
import { ZoteroClient } from "../src/zotero.js";

/**
 * Phase 4: corpus-mcp and quote-mcp sync from holdings-mcp's /zotero as they would from Zotero. The sync here
 * is quote-mcp's own (src/sync.ts is its copy), so a mirror synced through holdings-mcp has to come out the
 * same as one synced from Zotero, including for a service that synced from Zotero first and then switched.
 */

const LIB = "users/1";

/** A Zotero library on the Web API, as far as the syncs use it. */
class FakeZotero {
  version = 0;
  items = new Map<string, { key: string; version: number; data: Record<string, unknown> }>();
  deletions = new Map<string, number>();
  requests: string[] = [];
  /** Run when /deleted is asked for: a change landing between a sync's two requests. */
  beforeDeleted?: () => void;

  put(key: string, data: Record<string, unknown>) {
    this.version++;
    this.items.set(key, { key, version: this.version, data: { key, version: this.version, ...data } });
    this.deletions.delete(key);
  }

  remove(key: string) {
    this.version++;
    this.items.delete(key);
    this.deletions.set(key, this.version);
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    this.requests.push(`${url.pathname}${url.search}`);
    const since = Number(url.searchParams.get("since") ?? 0);
    const headers = { "content-type": "application/json", "last-modified-version": String(this.version) };
    if (url.pathname === `/${LIB}/deleted`) {
      this.beforeDeleted?.();
      this.beforeDeleted = undefined;
      const items = [...this.deletions].filter(([, v]) => v > since).map(([k]) => k);
      return void res.writeHead(200, headers).end(JSON.stringify({ collections: [], searches: [], items, tags: [], settings: [] }));
    }
    if (url.pathname !== `/${LIB}/items` && url.pathname !== `/${LIB}/items/top`) return void res.writeHead(404).end();
    const list = [...this.items.values()]
      .filter((i) => i.version > since && (url.searchParams.get("includeTrashed") === "1" || !i.data.deleted))
      .filter((i) => !url.pathname.endsWith("/top") || !i.data.parentItem)
      .sort((a, b) => b.version - a.version);
    const start = Number(url.searchParams.get("start") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    res.writeHead(200, { ...headers, "total-results": String(list.length) }).end(JSON.stringify(list.slice(start, start + limit)));
  }
}

const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const mirror = (db: DB) => db.prepare("SELECT library, key, version, item_type, parent_key, deleted, data FROM zotero_items ORDER BY key").all();
const client = (apiBase: string) => new ZoteroClient({ library: LIB, apiKey: "unused", apiBase });

let zotero: FakeZotero;
let zoteroBase: string;
let zoteroServer: http.Server;
let holdings: DB;
let holdingsServer: http.Server;
let base: string;
let refresher: Refresher;
let token: string;

beforeAll(async () => {
  ({ server: zoteroServer, base: zoteroBase } = await listen((req, res) => zotero.handle(req, res)));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "RS256", kid: "test" }] });
  token = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://team.cloudflareaccess.com").setSubject("owner").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  holdings = openDb(":memory:");
  refresher = startRefresh(holdings, { zotero: [{ library: LIB, apiKey: "k", apiBase: zoteroBase }], env: {} }, 0);
  holdingsServer = await serveHttp(holdings, {
    host: "127.0.0.1", port: 0, refresher, access: { teamDomain: "https://team.cloudflareaccess.com", lanHosts: [] }, accessKeys: keys,
  });
  base = `http://127.0.0.1:${(holdingsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  zoteroServer.close();
  holdingsServer.close();
});

beforeEach(() => {
  zotero = new FakeZotero();
  holdings.exec("DELETE FROM zotero_items; DELETE FROM zotero_deletions; DELETE FROM meta;");
  // More than a page of 100, so the syncs page through holdings-mcp's listing.
  for (let i = 0; i < 130; i++) zotero.put(`B${String(i).padStart(7, "0")}`, { itemType: "book", title: `Book ${i}` });
  zotero.put("NOTE0001", { itemType: "note", note: "<p>a quote</p>", parentItem: "B0000001" });
  zotero.put("GONE0001", { itemType: "book", title: "Soon deleted" });
});

describe("the Zotero mirror at /zotero", () => {
  it("gives a service syncing through it the mirror it would get from Zotero, before and after changes", async () => {
    // A service that synced from Zotero before holdings-mcp existed, and switches to it later.
    const switching = openDb(":memory:");
    await syncLibrary(switching, client(zoteroBase), LIB);
    zotero.remove("GONE0001");

    await refresher.now();
    const direct = openDb(":memory:");
    const through = openDb(":memory:");
    await syncLibrary(direct, client(zoteroBase), LIB);
    await syncLibrary(through, client(`${base}/zotero`), LIB);
    expect(mirror(through)).toEqual(mirror(direct));
    expect(mirror(through)).toHaveLength(131);

    zotero.put("B0000003", { itemType: "book", title: "Book 3, corrected" });
    zotero.put("B0000004", { itemType: "book", title: "Book 4", deleted: 1 });
    zotero.put("NOTE0002", { itemType: "note", note: "<p>another</p>", parentItem: "B0000002" });
    zotero.remove("B0000005");
    await refresher.now();
    zotero.requests = [];
    for (const db of [direct, through, switching]) await syncLibrary(db, client(db === direct ? zoteroBase : `${base}/zotero`), LIB);
    expect(mirror(through)).toEqual(mirror(direct));
    expect(mirror(switching).filter((r) => (r as { deleted: number }).deleted === 0)).toEqual(mirror(direct).filter((r) => (r as { deleted: number }).deleted === 0));
    expect(getMeta(through, `zotero_version:${LIB}`)).toBe(String(zotero.version));
    // Only the direct sync went to Zotero.
    expect(zotero.requests.every((r) => r.includes("since="))).toBe(true);
    expect(zotero.requests).toHaveLength(2);
  });

  it("answers items/top, the headers, and deletions as Zotero does", async () => {
    await refresher.now();
    zotero.remove("GONE0001");
    await refresher.now();
    const top = await fetch(`${base}/zotero/${LIB}/items/top?format=json&includeTrashed=1&since=0&limit=100&start=100`);
    expect(top.headers.get("last-modified-version")).toBe(String(zotero.version));
    expect(top.headers.get("total-results")).toBe("130");
    const page = (await top.json()) as { key: string; data: { parentItem?: string } }[];
    expect(page).toHaveLength(30);
    expect(page.some((i) => i.key === "NOTE0001" || i.key === "GONE0001")).toBe(false);
    const notes = (await (await fetch(`${base}/zotero/${LIB}/items?itemType=note`)).json()) as { key: string }[];
    expect(notes.map((i) => i.key)).toEqual(["NOTE0001"]);
    const deleted = await (await fetch(`${base}/zotero/${LIB}/deleted?since=${zotero.version - 1}`)).json();
    expect(deleted).toMatchObject({ items: ["GONE0001"], collections: [] });
    expect(await (await fetch(`${base}/zotero/${LIB}/deleted?since=${zotero.version}`)).json()).toMatchObject({ items: [] });
  });

  it("pages through a listing as it was at its first page, though a refresh lands in between", async () => {
    await refresher.now();
    const page = (start: number) => fetch(`${base}/zotero/${LIB}/items/top?format=json&includeTrashed=1&since=0&limit=100&start=${start}`);
    const first = await page(0);
    const version = first.headers.get("last-modified-version");
    expect(((await first.json()) as unknown[]).length).toBe(100);
    // Deleting an item on the first page would move every later item up one place, and B0000100 would be missed.
    zotero.remove("B0000050");
    await refresher.now();
    const second = await page(100);
    expect(second.headers.get("last-modified-version")).toBe(version);
    expect(((await second.json()) as { key: string }[]).map((i) => i.key)[0]).toBe("B0000100");
    // The next sync, from the version the listing gave, learns of the deletion.
    expect(await (await fetch(`${base}/zotero/${LIB}/deleted?since=${version}`)).json()).toMatchObject({ items: ["B0000050"] });
  });

  it("passes on a deletion Zotero made between a refresh's two requests", async () => {
    await refresher.now();
    const service = openDb(":memory:");
    await syncLibrary(service, client(`${base}/zotero`), LIB);
    zotero.put("B0000001", { itemType: "book", title: "Book 1, edited" });
    zotero.beforeDeleted = () => zotero.remove("B0000002");
    await refresher.now();
    // Recorded at the version the listing gave, which is past any version a service syncing from here has.
    const listed = Number(getMeta(holdings, `zotero_version:${LIB}`));
    expect(holdings.prepare("SELECT version FROM zotero_deletions WHERE key = 'B0000002'").pluck().get()).toBe(listed);
    await syncLibrary(service, client(`${base}/zotero`), LIB);
    expect(service.prepare("SELECT deleted FROM zotero_items WHERE key = 'B0000002'").pluck().get()).toBe(1);
    // And Zotero reports it again to the next refresh, which records it at the version it really has.
    await refresher.now();
    expect(holdings.prepare("SELECT version FROM zotero_deletions WHERE key = 'B0000002'").pluck().get()).toBe(zotero.version);
  });

  it("lists a key again once Zotero has it again after deleting it", async () => {
    zotero.remove("GONE0001");
    await refresher.now();
    zotero.put("GONE0001", { itemType: "book", title: "Synced back from another computer" });
    await refresher.now();
    const items = (await (await fetch(`${base}/zotero/${LIB}/items?itemKey=GONE0001`)).json()) as { data: { title: string } }[];
    expect(items.map((i) => i.data.title)).toEqual(["Synced back from another computer"]);
  });

  it("refuses what it doesn't answer, and isn't there through Access", async () => {
    await refresher.now();
    const q = await fetch(`${base}/zotero/${LIB}/items?q=mobbing`);
    expect(q.status).toBe(400);
    expect(await q.text()).toMatch(/doesn't take q/);
    expect((await fetch(`${base}/zotero/groups/9/items`)).status).toBe(404);
    expect((await fetch(`${base}/zotero/${LIB}/items`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/zotero/${LIB}/items`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
    expect((await fetch(`${base}/api/refresh`, { method: "POST", headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
    expect((await fetch(`${base}/api/checks`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
    expect((await fetch(`${base}/worklist`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
    expect((await fetch(`${base}/`, { headers: { "cf-ray": "1", "cf-access-jwt-assertion": token } })).status).toBe(404);
  });

  it("learns Zotero's whole deletion log the first time it syncs a library it already mirrored", async () => {
    // A store from before schema 2: synced to a version, with no deletions recorded.
    zotero.remove("GONE0001");
    setMeta(holdings, `zotero_version:${LIB}`, String(zotero.version));
    await refresher.now();
    expect(holdings.prepare("SELECT key FROM zotero_deletions").pluck().all()).toEqual(["GONE0001"]);
    zotero.requests = [];
    await refresher.now();
    expect(zotero.requests.some((r) => r.includes("deleted?since=0"))).toBe(false);
  });
});

describe("POST /api/refresh", () => {
  it("refreshes now, after any refresh already running", async () => {
    const first = await (await fetch(`${base}/api/refresh`, { method: "POST" })).json();
    expect(first).toMatchObject({ changed: true, errors: [] });
    zotero.put("NEW00001", { itemType: "book", title: "Filed a moment ago" });
    const [a, b] = await Promise.all([refresher.now(), fetch(`${base}/api/refresh`, { method: "POST" }).then((r) => r.json())]);
    expect(a.changed).toBe(true);
    expect(b).toMatchObject({ changed: false });
    expect(holdings.prepare("SELECT title FROM works WHERE key = ?").pluck().get(`zotero:${LIB}/NEW00001`)).toBe("Filed a moment ago");
    expect((await fetch(`${base}/api/refresh`)).status).toBe(405);
  });

  it("runs one refresh after the running one for any number of requests made meanwhile", async () => {
    const running = refresher.now();
    const [next, again] = [refresher.now(), refresher.now()];
    expect(next).not.toBe(running);
    expect(again).toBe(next);
    const order: string[] = [];
    await Promise.all([running.then(() => order.push("running")), next.then(() => order.push("next"))]);
    expect(order).toEqual(["running", "next"]);
  });
});
