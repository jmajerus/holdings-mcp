import type http from "node:http";
import { recordZoteroRead } from "./checks.js";
import { type DB, getMeta } from "./db.js";

/**
 * The part of the Zotero Web API that corpus-mcp and quote-mcp sync from (PLAN.md, phase 4), answered from the
 * mirror, so they read Zotero through holdings-mcp by pointing CORPUS_ZOTERO_API or QUOTE_ZOTERO_API at
 * http://holdings-mcp.localdomain:8000/zotero. LAN only; writes still go to Zotero (through zotero-mcp).
 *
 *   GET /zotero/<library>/items       ?since, includeTrashed, itemType, itemKey, limit (≤ 100), start, format=json
 *   GET /zotero/<library>/items/top   the same, items without a parent
 *   GET /zotero/<library>/deleted     ?since: { items: [keys deleted for good since then], collections: [], … }
 *
 * Each answers Last-Modified-Version (the library version the mirror is at) and the listings Total-Results,
 * as Zotero does. Versions are Zotero's own, so a service that synced from Zotero carries on from its version.
 * A listing's first page (start=0) takes a snapshot of the whole listing, and its later pages come from that
 * snapshot, so a refresh that lands while a service pages through can't shift the pages and skip an item;
 * what changed is in the service's next sync. A parameter Zotero has and this doesn't (q, tag, sort, …) is
 * refused, never ignored.
 */

const LISTING = new Set(["format", "since", "includeTrashed", "itemType", "itemKey", "limit", "start"]);

interface Snapshot { version: string; rows: { key: string; version: number; data: string }[]; at: number }
/** Listings by library, path, and every parameter but start and limit; a sync pages through one in seconds. */
const snapshots = new WeakMap<DB, Map<string, Snapshot>>();
const SNAPSHOT_MS = 10 * 60_000;
const SNAPSHOTS = 32;

export class ZoteroApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The libraries the mirror holds. */
function libraries(db: DB): string[] {
  return (db.prepare("SELECT key FROM meta WHERE key LIKE 'zotero_version:%'").pluck().all() as string[]).map((k) => k.slice("zotero_version:".length));
}

function int(params: URLSearchParams, name: string, fallback: number): number {
  const value = params.get(name);
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new ZoteroApiError(400, `${name} must be a whole number, not "${value}".`);
  return Number(value);
}

/** itemType as Zotero takes it: one type, alternatives joined by " || ", or a type to leave out ("-note"). */
function itemTypeFilter(value: string | null): { sql: string; args: string[] } {
  if (!value) return { sql: "", args: [] };
  if (value.startsWith("-")) return { sql: " AND item_type != ?", args: [value.slice(1).trim()] };
  const types = value.split("||").map((t) => t.trim()).filter(Boolean);
  return { sql: ` AND item_type IN (${types.map(() => "?").join(", ")})`, args: types };
}

/** Answers one request under /zotero; the caller has checked it came over the LAN. */
export function zoteroApi(db: DB, method: string, url: URL): { status: number; headers: Record<string, string>; body: unknown } {
  if (method !== "GET") throw new ZoteroApiError(405, "Read only: write to Zotero itself (zotero-mcp).");
  const m = /^\/zotero\/((?:users|groups)\/\d+)\/(items|items\/top|deleted)$/.exec(url.pathname);
  if (!m) throw new ZoteroApiError(404, "Not found: holdings-mcp answers /zotero/<library>/items, /items/top, and /deleted.");
  const [, library, path] = m;
  const version = getMeta(db, `zotero_version:${library}`);
  if (version === undefined) throw new ZoteroApiError(404, `holdings-mcp doesn't mirror ${library}; it mirrors ${libraries(db).join(", ") || "none yet"}.`);
  const params = url.searchParams;
  const since = int(params, "since", 0);
  const headers = { "last-modified-version": version };

  if (path === "deleted") {
    const unknown = [...params.keys()].find((k) => k !== "since");
    if (unknown) throw new ZoteroApiError(400, `holdings-mcp doesn't take ${unknown} here.`);
    const items = db.prepare("SELECT key FROM zotero_deletions WHERE library = ? AND version > ? ORDER BY key").pluck().all(library, since);
    return { status: 200, headers, body: { collections: [], searches: [], items, tags: [], settings: [] } };
  }

  const unknown = [...params.keys()].find((k) => !LISTING.has(k));
  if (unknown) throw new ZoteroApiError(400, `holdings-mcp doesn't take ${unknown}; it answers only what corpus-mcp and quote-mcp sync with (${[...LISTING].join(", ")}).`);
  if ((params.get("format") ?? "json") !== "json") throw new ZoteroApiError(400, "holdings-mcp answers format=json only.");
  const limit = Math.min(Math.max(int(params, "limit", 25), 1), 100);
  const start = int(params, "start", 0);
  const type = itemTypeFilter(params.get("itemType"));
  const keys = (params.get("itemKey") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length > 50) throw new ZoteroApiError(400, "itemKey takes at most 50 keys.");
  const where = `library = ? AND version > ?
    AND NOT EXISTS (SELECT 1 FROM zotero_deletions d WHERE d.library = zotero_items.library AND d.key = zotero_items.key)
    ${params.get("includeTrashed") === "1" ? "" : "AND deleted = 0"}${path === "items/top" ? " AND parent_key IS NULL" : ""}${type.sql}
    ${keys.length ? `AND key IN (${keys.map(() => "?").join(", ")})` : ""}`;
  const args = [library, since, ...type.args, ...keys];
  const cache = snapshots.get(db) ?? new Map<string, Snapshot>();
  snapshots.set(db, cache);
  const id = [library, path, ...[...params].filter(([k]) => k !== "start" && k !== "limit").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`)].join("\n");
  const at = Date.now();
  for (const [k, snap] of cache) if (at - snap.at > SNAPSHOT_MS) cache.delete(k);
  let snap = start === 0 ? undefined : cache.get(id);
  if (!snap) {
    const rows = db.prepare(`SELECT key, version, data FROM zotero_items WHERE ${where} ORDER BY key`).all(...args) as Snapshot["rows"];
    snap = { version, rows, at };
    cache.delete(id);
    cache.set(id, snap);
    if (cache.size > SNAPSHOTS) cache.delete(cache.keys().next().value!);
  }
  const rows = snap.rows.slice(start, start + limit);
  const items = rows.map((r) => ({ key: r.key, version: r.version, library: { type: library.startsWith("users/") ? "user" : "group", id: Number(library.split("/")[1]) }, data: JSON.parse(r.data) }));
  return { status: 200, headers: { "last-modified-version": snap.version, "total-results": String(snap.rows.length) }, body: items };
}

export function sendZoteroApi(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  try {
    const r = zoteroApi(db, req.method ?? "GET", url);
    // The first page only: one write per sync request, not per page. It's what shows a service switched here.
    if (!Number(url.searchParams.get("start"))) {
      recordZoteroRead(db, req.socket.remoteAddress, /^\/zotero\/([^/]+\/\d+)/.exec(url.pathname)![1], Number(url.searchParams.get("since") ?? 0));
    }
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", ...r.headers }).end(JSON.stringify(r.body));
  } catch (error) {
    if (!(error instanceof ZoteroApiError)) throw error;
    res.writeHead(error.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(error.message);
  }
}
