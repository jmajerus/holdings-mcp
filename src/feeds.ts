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
  /** The Calibre book an unmatched work's quotes were saved from (add_quote), so it joins that book's work. */
  calibre_uuid?: string | null;
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

/** A field's check, and how its type is named in the error. */
type Rule = [check: (v: unknown) => boolean, type: string];

const nullable = ([check, type]: Rule): Rule => [(v) => v === null || check(v), `${type} or null`];
const text: Rule = [(v) => typeof v === "string", "a string"];
const nonEmpty: Rule = [(v) => typeof v === "string" && v.length > 0, "a non-empty string"];
const count: Rule = [(v) => Number.isInteger(v) && (v as number) >= 0, "a count"];
const id: Rule = [(v) => Number.isInteger(v), "an integer"];
const flag: Rule = [(v) => typeof v === "boolean", "true or false"];
const texts: Rule = [(v) => Array.isArray(v) && v.every((s) => typeof s === "string"), "a list of strings"];
const ids: Rule = [(v) => Array.isArray(v) && v.every((n) => Number.isInteger(n)), "a list of integers"];
const year: Rule = nullable([(v) => typeof v === "string" || Number.isInteger(v), "a year"]);
const zoteroRef: Rule = nullable([(v) => isObject(v) && typeof v.library === "string" && typeof v.key === "string", "{ library, key }"]);
const match: Rule = [(v) => v === "zotero" || v === "unmatched" || v === "ambiguous", "zotero, unmatched, or ambiguous"];

/** Every field rebuildWorks reads, so a snapshot that would break it is refused and the last good one kept. */
function check(required: Record<string, Rule>, optional: Record<string, Rule>) {
  return (e: Record<string, unknown>): string | null => {
    for (const [name, [ok, type]] of Object.entries(required)) if (!ok(e[name])) return `${name} must be ${type}`;
    for (const [name, [ok, type]] of Object.entries(optional)) if (e[name] !== undefined && !ok(e[name])) return `${name} must be ${type}`;
    return null;
  };
}

const bookFields = check(
  { book_id: nonEmpty, library: text, title: text, authors: texts, formats: texts, has_text: flag },
  { calibre_uuid: nullable(nonEmpty), year, isbns: texts, citekey: nullable(nonEmpty), citekey_source: nullable(text), zotero: zoteroRef },
);
const countFields = check(
  { quotes: count, notes: count },
  { verified: count, work_id: id, former_work_ids: ids, match, zotero: zoteroRef, citekey: nullable(nonEmpty), candidates: texts,
    title: text, authors: texts, year, calibre_uuid: nullable(nonEmpty) },
);

export const FEEDS: Feed[] = [
  {
    name: "books", setting: "HOLDINGS_BOOKS_URL", path: "/api/holdings/books",
    parse: (body) => entries(body, "books", bookFields),
  },
  {
    name: "counts", setting: "HOLDINGS_COUNTS_URL", path: "/api/holdings/counts",
    parse: (body) => entries(body, "works", (e) => countFields(e) ?? (!e.zotero && e.work_id === undefined ? "neither zotero nor work_id" : null)),
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
export function recordZotero(db: DB, library: string, result: { changed: number; deleted: number; version: number } | { error: string }): void {
  const at = now();
  const name = `zotero:${library}`;
  db.prepare("INSERT INTO feeds (name, checked_at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET checked_at = excluded.checked_at").run(name, at);
  if ("error" in result) {
    db.prepare("UPDATE feeds SET error = ? WHERE name = ?").run(`Zotero ${library}: ${result.error}`, name);
    return;
  }
  const entries = (db.prepare("SELECT COUNT(*) AS n FROM zotero_items WHERE library = ? AND deleted = 0").get(library) as { n: number }).n;
  db.prepare("UPDATE feeds SET etag = ?, entries = ?, ok_at = ?, error = NULL, changed_at = CASE WHEN ? THEN ? ELSE changed_at END WHERE name = ?")
    .run(String(result.version), entries, at, result.changed || result.deleted ? 1 : 0, at, name);
}
