import { type DB, now } from "./db.js";

/**
 * The snapshot feeds holdings-mcp joins (PLAN.md, Feeds): corpus-mcp's books and quote-mcp's quote counts.
 * Each is polled with its last ETag; a 304 costs nothing. A snapshot that doesn't parse is an error and
 * the last good one is kept, so a bad deploy upstream never empties the works.
 */

/** corpus-mcp's GET /api/holdings/books (its docs/dev-briefs/holdings-and-quotes.md, §1). */
export interface BookEntry {
  /** Null for a Calibre book without a UUID; its book id is then its interim key. */
  calibre_uuid: string | null;
  book_id: string;
  library: string;
  title: string;
  authors: string[];
  year?: number | string | null;
  formats: string[];
  has_text: boolean;
  isbns?: string[];
  citekey?: string | null;
  citekey_source?: string | null;
  /** The matched item; matched_by is "confirmed", "calibre_uuid", or "isbn", all of them matches. */
  zotero?: { library: string; key: string; matched_by?: string } | null;
}

/** quote-mcp's GET /api/holdings/counts (its docs/dev-briefs/holdings-and-quotes.md, §1). */
export interface CountEntry {
  work_id?: number;
  /** Ids of quote-mcp works merged into this one when it was filed: their quote:<id> keys now name it. */
  former_work_ids?: number[];
  match?: "zotero" | "unmatched" | "ambiguous";
  zotero?: { library: string; key: string } | null;
  citekey?: string | null;
  /** "<library>/<item key>", for an ambiguous work. */
  candidates?: string[];
  title?: string;
  authors?: string[];
  year?: number | string | null;
  quotes: number;
  notes: number;
  verified: number;
}

export interface Feed {
  name: "books" | "counts";
  /** The setting that holds its URL. */
  setting: string;
  path: string;
  /** The entries from a snapshot, or an error saying what's wrong with it. */
  parse(body: unknown): unknown[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function entries(body: unknown, field: string, check: (e: Record<string, unknown>) => string | null): unknown[] {
  if (!isObject(body) || body.version !== 1 || !Array.isArray(body[field])) throw new Error(`expected { version: 1, ${field}: [...] }`);
  for (const [i, e] of (body[field] as unknown[]).entries()) {
    const problem = isObject(e) ? check(e) : "not an object";
    if (problem) throw new Error(`${field}[${i}]: ${problem}`);
  }
  return body[field] as unknown[];
}

const zoteroRef = (z: unknown) => z === undefined || z === null || (isObject(z) && typeof z.library === "string" && typeof z.key === "string");

export const FEEDS: Feed[] = [
  {
    name: "books", setting: "HOLDINGS_BOOKS_URL", path: "/api/holdings/books",
    parse: (body) => entries(body, "books", (e) =>
      typeof e.book_id !== "string" || !e.book_id ? "no book_id"
        : e.calibre_uuid !== null && typeof e.calibre_uuid !== "string" ? "calibre_uuid must be a string or null"
          : typeof e.title !== "string" ? "no title"
            : !zoteroRef(e.zotero) ? "zotero must be { library, key } or null" : null),
  },
  {
    name: "counts", setting: "HOLDINGS_COUNTS_URL", path: "/api/holdings/counts",
    parse: (body) => entries(body, "works", (e) =>
      !zoteroRef(e.zotero) ? "zotero must be { library, key } or null"
        : !e.zotero && typeof e.work_id !== "number" ? "neither zotero nor work_id"
          : typeof e.quotes !== "number" || typeof e.notes !== "number" ? "no counts" : null),
  },
];

/** A feed's URL from its setting: a base URL gets the feed's path, a URL with a path is used as it is; off or unset turns it off. */
export function feedUrl(feed: Feed, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[feed.setting]?.trim();
  if (!value || value.toLowerCase() === "off") return null;
  const url = new URL(value);
  if (url.pathname === "/" || url.pathname === "") url.pathname = feed.path;
  return url.toString();
}

/** The entries of a feed's last good snapshot, or [] when it has none. */
export function snapshot<T>(db: DB, name: Feed["name"]): T[] {
  const row = db.prepare("SELECT body FROM feeds WHERE name = ?").get(name) as { body: string | null } | undefined;
  if (!row?.body) return [];
  const feed = FEEDS.find((f) => f.name === name)!;
  return feed.parse(JSON.parse(row.body)) as T[];
}

/** Polls one feed; true when its snapshot changed. Errors are recorded on the feed, not thrown. */
export async function pollFeed(db: DB, feed: Feed, url: string, timeoutMs = 30_000): Promise<boolean> {
  const at = now();
  const previous = db.prepare("SELECT url, etag FROM feeds WHERE name = ?").get(feed.name) as { url: string | null; etag: string | null } | undefined;
  db.prepare("INSERT INTO feeds (name, url, checked_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET url = excluded.url, checked_at = excluded.checked_at").run(feed.name, url, at);
  // A new URL is a new source: ask for the whole snapshot.
  const etag = previous?.url === url ? previous.etag : null;
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 304) {
      await res.body?.cancel();
      db.prepare("UPDATE feeds SET ok_at = ?, error = NULL WHERE name = ?").run(at, feed.name);
      return false;
    }
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const text = await res.text();
    const parsed = feed.parse(JSON.parse(text));
    const unchanged = (db.prepare("SELECT body FROM feeds WHERE name = ?").get(feed.name) as { body: string | null }).body === text;
    db.prepare("UPDATE feeds SET etag = ?, body = ?, entries = ?, ok_at = ?, error = NULL, changed_at = CASE WHEN ? THEN changed_at ELSE ? END WHERE name = ?")
      .run(res.headers.get("etag"), text, parsed.length, at, unchanged ? 1 : 0, at, feed.name);
    return !unchanged;
  } catch (error) {
    db.prepare("UPDATE feeds SET error = ? WHERE name = ?").run(`${feed.name} feed (${url}): ${(error as Error).message}`, feed.name);
    return false;
  }
}

/** Records a Zotero library's sync on its feed row, so holdings_status shows it beside the others. */
export function recordZotero(db: DB, library: string, result: { changed: number; version: number } | { error: string }): void {
  const at = now();
  const name = `zotero:${library}`;
  db.prepare("INSERT INTO feeds (name, checked_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at").run(name, at);
  if ("error" in result) {
    db.prepare("UPDATE feeds SET error = ? WHERE name = ?").run(`Zotero ${library}: ${result.error}`, name);
    return;
  }
  const entries = (db.prepare("SELECT COUNT(*) AS n FROM zotero_items WHERE library = ? AND deleted = 0").get(library) as { n: number }).n;
  db.prepare("UPDATE feeds SET etag = ?, entries = ?, ok_at = ?, error = NULL, changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE name = ?")
    .run(String(result.version), entries, at, result.changed ? 1 : 0, at, name);
}
