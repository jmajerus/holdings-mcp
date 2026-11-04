import { checkResults, zoteroReads } from "./checks.js";
import { type DB, getMeta } from "./db.js";

/**
 * What the MCP tools answer: find_work, get_work, and holdings_status. Every work comes with all its
 * keys and its holdings, and each holding names the tools to call next, so an agent never has to learn
 * from an empty result that a paper book has no text to search.
 */

/** A request the caller can fix (no such work, a key that names several): the message says what to do. */
export class ToolError extends Error {}

/** Words and "quoted phrases" as an FTS5 query: every term required, a trailing * kept as a prefix match (quote-mcp's src/common.ts). */
export function ftsQuery(text: string): string {
  const terms = text.match(/"[^"]+"|\S+/g) ?? [];
  return terms.map((t) => {
    const prefix = t.endsWith("*") && !t.startsWith('"');
    const bare = t.replace(/^"|"$/g, "").replace(/\*$/, "").replace(/"/g, "");
    return bare ? `"${bare}"${prefix ? "*" : ""}` : "";
  }).filter(Boolean).join(" ");
}

/** The tools that act on each kind of holding, on the other services in the portal. */
const TOOLS = {
  text: ["search_corpus", "read_book", "get_book_outline", "cite_passage"],
  calibreFile: ["render_page"],
  quotes: ["search_quotes", "cite_quote"],
} as const;

interface WorkRow {
  key: string; kind: string; item_type: string | null; title: string; creators: string; year: string | null;
  citekey: string | null; isbns: string; blockers: string; candidates: string;
}
interface HoldingRow { form: "text" | "file" | "quotes"; ref: string; detail: string }

const parse = <T>(text: string): T => JSON.parse(text) as T;
const year = (y: string | null) => (y && /^\d+$/.test(y) ? Number(y) : y);

/** A work as the tools return it; full adds the blockers' candidates and every Zotero attachment. */
function describe(db: DB, row: WorkRow, full = false) {
  // A former key can also still be an alias (a filed book's calibre:<uuid>), so it's listed by the table that records it.
  const former = (db.prepare("SELECT key FROM former_keys WHERE work_key = ? ORDER BY key").all(row.key) as { key: string }[]).map((r) => r.key);
  const keyRows = (db.prepare("SELECT key, kind FROM work_keys WHERE work_key = ? AND kind NOT IN ('work', 'former') ORDER BY kind, key").all(row.key) as { key: string; kind: string }[])
    .filter((k) => !former.includes(k.key));
  const keysOf = (kind: string) => keyRows.filter((k) => k.kind === kind).map((k) => k.key);
  const keys: Record<string, string | string[]> = {};
  if (row.kind === "zotero") keys.item = keysOf("item")[0];
  if (former.length) keys.former_keys = former;
  for (const [kind, name] of [["book", "book_ids"], ["calibre", "calibre"], ["quote", "quote"], ["isbn", "isbn"]] as const) {
    const some = keysOf(kind);
    if (some.length) keys[name] = some;
  }
  const extraCitekeys = keysOf("citekey").filter((c) => c !== row.citekey);
  if (extraCitekeys.length) keys.other_citekeys = extraCitekeys;

  const rows = db.prepare("SELECT form, ref, detail FROM holdings WHERE work_key = ? ORDER BY form, ref").all(row.key) as HoldingRow[];
  const holdings: Record<string, unknown> = {};
  const text = rows.filter((h) => h.form === "text").map((h) => parse<{ book_id: string; library: string; formats: string[] }>(h.detail));
  if (text.length) {
    const [first, ...others] = text;
    holdings.text = { book_id: first.book_id, library: first.library, formats: first.formats, tools: TOOLS.text, ...(others.length ? { other_copies: others.map(({ book_id, library, formats }) => ({ book_id, library, formats })) } : {}) };
  }
  const files = rows.filter((h) => h.form === "file").map((h) => parse<Record<string, unknown>>(h.detail));
  const calibreFiles = files.filter((f) => f.source === "calibre").map(({ book_id, library, formats }) => ({ book_id, library, formats, tools: TOOLS.calibreFile }));
  const zoteroFiles = files.filter((f) => f.source === "zotero").map(({ key, title, content_type, filename }) => ({ attachment: key, title, content_type, filename }));
  if (calibreFiles.length || zoteroFiles.length) {
    holdings.file = {
      ...(calibreFiles.length ? { calibre: calibreFiles } : {}),
      ...(zoteroFiles.length ? (full ? { zotero: zoteroFiles } : { zotero_attachments: zoteroFiles.length }) : {}),
    };
  }
  const quotes = rows.filter((h) => h.form === "quotes").map((h) => parse<{ quotes: number; notes: number; verified: number }>(h.detail));
  if (quotes.length) {
    const sum = (f: "quotes" | "notes" | "verified") => quotes.reduce((n, q) => n + (q[f] ?? 0), 0);
    holdings.quotes = { quotes: sum("quotes"), notes: sum("notes"), verified: sum("verified"), tools: TOOLS.quotes, work: row.key };
  }

  const blockers = parse<string[]>(row.blockers);
  const candidates = parse<string[]>(row.candidates);
  return {
    key: row.key,
    citekey: row.citekey,
    item_type: row.item_type,
    title: row.title,
    creators: parse<string[]>(row.creators),
    year: year(row.year),
    ...(Object.keys(keys).length ? { keys } : {}),
    holdings,
    ...(blockers.length ? { cannot_cite: blockers } : {}),
    ...(full && candidates.length ? { candidates } : {}),
  };
}

/** The forms of a key people pass: a Pandoc @citekey, a Zotero library/key path, a bare Calibre UUID, a hyphenated ISBN. */
function keyForms(key: string): string[] {
  const k = key.trim().replace(/^@/, "");
  const forms = [k];
  if (/^(users|groups)\/\d+\/[A-Z0-9]{8}$/i.test(k)) forms.push(`zotero:${k}`);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) forms.push(`calibre:${k}`);
  if (/^[0-9X-]{10,17}$/i.test(k)) forms.push(k.replace(/-/g, "").toUpperCase());
  return forms;
}

function resolve(db: DB, key: string): WorkRow[] {
  const forms = keyForms(key);
  return db.prepare(`SELECT DISTINCT w.* FROM works w JOIN work_keys k ON k.work_key = w.key WHERE k.key IN (${forms.map(() => "?").join(", ")}) ORDER BY w.key`).all(...forms) as WorkRow[];
}

export function getWork(db: DB, key: string) {
  const rows = resolve(db, key);
  if (!rows.length) throw new ToolError(`No work has the key "${key}". Try find_work with words from its title or an author.`);
  if (rows.length > 1) {
    return { note: `"${key}" names ${rows.length} works (an ISBN or citekey shared by editions or duplicates); pick one by its key.`, works: rows.map((r) => describe(db, r, true)) };
  }
  return describe(db, rows[0], true);
}

export type Has = "text" | "file" | "quotes" | "notes";

export interface FindArgs {
  query?: string;
  author?: string;
  key?: string;
  has?: Has[];
  item_type?: string;
  limit?: number;
  offset?: number;
}

const HAS_SQL: Record<Has, string> = {
  text: "EXISTS (SELECT 1 FROM holdings h WHERE h.work_key = w.key AND h.form = 'text')",
  file: "EXISTS (SELECT 1 FROM holdings h WHERE h.work_key = w.key AND h.form = 'file')",
  quotes: "EXISTS (SELECT 1 FROM holdings h WHERE h.work_key = w.key AND h.form = 'quotes' AND json_extract(h.detail, '$.quotes') > 0)",
  notes: "EXISTS (SELECT 1 FROM holdings h WHERE h.work_key = w.key AND h.form = 'quotes' AND json_extract(h.detail, '$.notes') > 0)",
};

export function findWork(db: DB, args: FindArgs) {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const where: string[] = [];
  const params: unknown[] = [];
  let fromFts = false;
  const match: string[] = [];
  if (args.query?.trim()) {
    const q = ftsQuery(args.query);
    if (!q) throw new ToolError("query has no words to look for.");
    match.push(`{title creators} : (${q})`);
  }
  if (args.author?.trim()) {
    const q = ftsQuery(args.author);
    if (!q) throw new ToolError("author has no words to look for.");
    match.push(`creators : (${q})`);
  }
  if (match.length) {
    fromFts = true;
    where.push("works_fts MATCH ?");
    params.push(match.join(" AND "));
  }
  if (args.key?.trim()) {
    const keys = resolve(db, args.key).map((r) => r.key);
    if (!keys.length) return { total: 0, works: [], note: `No work has the key "${args.key}".` };
    where.push(`w.key IN (${keys.map(() => "?").join(", ")})`);
    params.push(...keys);
  }
  for (const h of args.has ?? []) where.push(HAS_SQL[h]);
  if (args.item_type) {
    where.push("w.item_type = ?");
    params.push(args.item_type);
  }
  const from = fromFts ? "works_fts JOIN works w ON w.key = works_fts.key" : "works w";
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${clause}`).get(...params) as { n: number }).n;
  const order = fromFts ? "bm25(works_fts, 0, 4, 1)" : "w.title COLLATE NOCASE, w.key";
  const rows = db.prepare(`SELECT w.* FROM ${from} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as WorkRow[];
  return { total, offset, works: rows.map((r) => describe(db, r)) };
}

/** Each feed's freshness and errors, what the store holds, and what still needs a person. */
/** Each source and how fresh it is: stale after half an hour without a good answer. */
export function holdingsFeeds(db: DB, staleAfterSeconds = 1800) {
  return (db.prepare("SELECT name, url, entries, checked_at, ok_at, changed_at, error FROM feeds ORDER BY name").all() as
    { name: string; url: string | null; entries: number | null; checked_at: string | null; ok_at: string | null; changed_at: string | null; error: string | null }[])
    .map((f) => ({ ...f, stale: !f.ok_at || Date.now() - Date.parse(f.ok_at) > staleAfterSeconds * 1000 }));
}

export function holdingsStatus(db: DB, staleAfterSeconds = 1800) {
  const feeds = holdingsFeeds(db, staleAfterSeconds);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const unmatchedBooks = db.prepare(`SELECT w.key, w.title, w.creators, (SELECT group_concat(h.ref, ', ') FROM holdings h WHERE h.work_key = w.key AND h.form IN ('text', 'file')) AS book_ids
    FROM works w WHERE w.kind = 'calibre' ORDER BY w.title COLLATE NOCASE LIMIT 50`).all() as { key: string; title: string; creators: string; book_ids: string }[];
  return {
    last_refresh: getMeta(db, "last_refresh") ?? null,
    feeds,
    works: {
      total: count("SELECT COUNT(*) AS n FROM works"),
      in_zotero: count("SELECT COUNT(*) AS n FROM works WHERE kind = 'zotero'"),
      calibre_only: count("SELECT COUNT(*) AS n FROM works WHERE kind = 'calibre'"),
      quotes_unmatched: count("SELECT COUNT(*) AS n FROM works WHERE kind = 'quote' AND blockers LIKE '%not_in_zotero%'"),
      quotes_ambiguous: count("SELECT COUNT(*) AS n FROM works WHERE kind = 'quote' AND blockers LIKE '%ambiguous_edition%'"),
      no_citekey: count("SELECT COUNT(*) AS n FROM works WHERE blockers LIKE '%no_citekey%'"),
    },
    holdings: {
      text: count("SELECT COUNT(DISTINCT work_key) AS n FROM holdings WHERE form = 'text'"),
      file: count("SELECT COUNT(DISTINCT work_key) AS n FROM holdings WHERE form = 'file'"),
      quotes: count("SELECT COUNT(DISTINCT work_key) AS n FROM holdings WHERE form = 'quotes'"),
    },
    former_keys: count("SELECT COUNT(*) AS n FROM former_keys"),
    unmatched_books: unmatchedBooks.map((b) => ({ key: b.key, title: b.title, creators: JSON.parse(b.creators) as string[], book_ids: b.book_ids?.split(", ") ?? [] })),
    checks: checkResults(db),
    zotero_readers: zoteroReads(db),
  };
}
