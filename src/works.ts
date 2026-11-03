import { type DB, now } from "./db.js";
import { type BookEntry, type CountEntry, snapshot } from "./feeds.js";

/**
 * Rebuilds works, their keys, and their holdings from the Zotero mirror and the feeds' last snapshots
 * (PLAN.md, Data and Keys). Zotero items come first; a Calibre book or quote-mcp work joins the item it's
 * matched to, and becomes a work of its own (calibre:<uuid>, quote:<id>) when there's no item to join.
 * Unfiled books and quote-mcp works are never joined to each other on title guesses, only by the Calibre
 * UUID quote-mcp records when a quote is saved from a book.
 *
 * An interim key that stops being a work's key (its book or work was filed and matched) is recorded in
 * former_keys with the work it now belongs to, so it keeps resolving.
 */

/** Zotero item types that are parts of a work, never works. */
const NOT_WORKS = new Set(["note", "attachment", "annotation"]);

interface ZoteroData {
  itemType: string; title?: string; caseName?: string; subject?: string; nameOfAct?: string; date?: string;
  extra?: string; citationKey?: string; ISBN?: string; contentType?: string; filename?: string; linkMode?: string;
  creators?: { creatorType: string; lastName?: string; firstName?: string; name?: string }[];
}

interface Work {
  key: string; kind: "zotero" | "calibre" | "quote"; item_type: string | null; title: string; creators: string[];
  year: string | null; citekey: string | null; isbns: string[]; blockers: string[]; candidates: string[];
}

export const workKey = (library: string, key: string) => `zotero:${library}/${key}`;

/** Better BibTeX's citekey, from the item's field or the "Citation Key:" line it writes to Extra (as quote-mcp's src/csl.ts). */
export function citekeyOf(data: ZoteroData): string | null {
  if (typeof data.citationKey === "string" && data.citationKey) return data.citationKey;
  return /^Citation Key:\s*(\S+)/m.exec(String(data.extra ?? ""))?.[1] ?? null;
}

/** Authors as people read them; editors when there are no authors, then anyone credited. */
export function creatorsOf(data: ZoteroData): string[] {
  const all = data.creators ?? [];
  const name = (c: (typeof all)[number]) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ");
  for (const role of ["author", "editor"]) {
    const some = all.filter((c) => c.creatorType === role);
    if (some.length) return some.map(name).filter(Boolean);
  }
  return all.map(name).filter(Boolean);
}

export const yearOf = (date: unknown): string | null => /\b(\d{4})\b/.exec(String(date ?? ""))?.[1] ?? null;

/** ISBNs as digits (and a final X), however Zotero holds them: several to a field, hyphenated or not. */
export function isbnsOf(text: unknown): string[] {
  const found = String(text ?? "").toUpperCase().match(/[0-9][0-9X-]{8,16}/g) ?? [];
  return [...new Set(found.map((s) => s.replace(/-/g, "")).filter((s) => /^(\d{9}[\dX]|\d{13})$/.test(s)))];
}

export interface RebuildResult {
  works: number;
  /** Feed entries whose Zotero item isn't in the mirror and that had no interim key to fall back on. */
  orphans: string[];
  /** Interim keys newly recorded as former keys. */
  retired: string[];
}

export function rebuildWorks(db: DB): RebuildResult {
  const books = snapshot<BookEntry>(db, "books");
  const counts = snapshot<CountEntry>(db, "counts");
  const items = db.prepare(`SELECT library, key, item_type, parent_key, data FROM zotero_items WHERE deleted = 0`).all() as
    { library: string; key: string; item_type: string; parent_key: string | null; data: string }[];

  const works = new Map<string, Work>();
  const keys: { key: string; work_key: string; kind: string }[] = [];
  const holdings: { work_key: string; form: string; ref: string; detail: unknown }[] = [];
  /** Where each Calibre book went, by UUID: its Zotero item's work, or its own. */
  const bookWorks = new Map<string, string>();
  const orphans: string[] = [];
  const alias = (key: string | null | undefined, work_key: string, kind: string) => key && keys.push({ key, work_key, kind });

  for (const item of items) {
    if (item.parent_key || NOT_WORKS.has(item.item_type)) continue;
    const data = JSON.parse(item.data) as ZoteroData;
    const key = workKey(item.library, item.key);
    works.set(key, {
      key, kind: "zotero", item_type: item.item_type, title: data.title ?? data.caseName ?? data.subject ?? data.nameOfAct ?? "(untitled)",
      creators: creatorsOf(data), year: yearOf(data.date), citekey: citekeyOf(data), isbns: isbnsOf(data.ISBN), blockers: [], candidates: [],
    });
    alias(item.key, key, "item");
  }
  // Attachments are file holdings of their parent: a PDF or EPUB filed in Zotero.
  for (const item of items) {
    if (!item.parent_key || item.item_type !== "attachment") continue;
    const parent = workKey(item.library, item.parent_key);
    if (!works.has(parent)) continue;
    const data = JSON.parse(item.data) as ZoteroData;
    if (data.linkMode === "linked_url") continue;
    holdings.push({ work_key: parent, form: "file", ref: `zotero:${item.key}`, detail: { source: "zotero", key: item.key, title: data.title ?? null, content_type: data.contentType ?? null, filename: data.filename ?? null } });
  }

  for (const book of books) {
    const matched = book.zotero ? workKey(book.zotero.library, book.zotero.key) : null;
    let target = matched && works.get(matched)?.kind === "zotero" ? matched : null;
    const interim = book.calibre_uuid ? `calibre:${book.calibre_uuid}` : book.book_id;
    if (!target) {
      target = interim;
      if (!works.has(target)) {
        works.set(target, {
          key: target, kind: "calibre", item_type: "book", title: book.title, creators: book.authors ?? [], year: yearOf(book.year),
          citekey: book.citekey ?? null, isbns: book.isbns ?? [], blockers: ["not_in_zotero"], candidates: [],
        });
      }
      if (matched) orphans.push(`book ${book.book_id} is matched to ${matched}, which isn't in the mirror`);
    }
    const work = works.get(target)!;
    if (!work.citekey && book.citekey) work.citekey = book.citekey;
    for (const isbn of book.isbns ?? []) if (!work.isbns.includes(isbn)) work.isbns.push(isbn);
    if (book.calibre_uuid) {
      alias(interim, target, "calibre");
      bookWorks.set(book.calibre_uuid, target);
    }
    alias(book.book_id, target, "book");
    alias(book.citekey, target, "citekey");
    holdings.push({
      work_key: target, form: book.has_text ? "text" : "file", ref: book.book_id,
      detail: { source: "calibre", book_id: book.book_id, library: book.library, formats: book.formats ?? [], calibre_uuid: book.calibre_uuid, matched_by: target === matched ? book.zotero?.matched_by ?? null : null },
    });
  }

  for (const entry of counts) {
    const matched = entry.zotero ? workKey(entry.zotero.library, entry.zotero.key) : null;
    // A work quoted from a Calibre book joins that book's work: an exact link, not a guess from its title.
    let target = matched && works.get(matched)?.kind === "zotero" ? matched : (entry.calibre_uuid && bookWorks.get(entry.calibre_uuid)) || null;
    if (!target) {
      if (entry.work_id === undefined) {
        orphans.push(`quote-mcp's quotes from ${matched} can't be placed: the item isn't in the mirror and the feed sent no work_id`);
        continue;
      }
      target = `quote:${entry.work_id}`;
      const candidates = (entry.candidates ?? []).map((c) => `zotero:${c}`);
      works.set(target, {
        key: target, kind: "quote", item_type: null, title: entry.title ?? "(untitled)", creators: entry.authors ?? [], year: yearOf(entry.year),
        citekey: entry.citekey ?? null, isbns: [], blockers: [entry.match === "ambiguous" ? "ambiguous_edition" : "not_in_zotero"], candidates,
      });
      if (matched) orphans.push(`quote-mcp work ${entry.work_id} is matched to ${matched}, which isn't in the mirror`);
    }
    const work = works.get(target)!;
    if (!work.citekey && entry.citekey) work.citekey = entry.citekey;
    if (entry.work_id !== undefined) alias(`quote:${entry.work_id}`, target, "quote");
    for (const id of entry.former_work_ids ?? []) alias(`quote:${id}`, target, "quote");
    alias(entry.citekey, target, "citekey");
    holdings.push({
      work_key: target, form: "quotes", ref: entry.work_id !== undefined ? `quote:${entry.work_id}` : target,
      detail: { work_id: entry.work_id ?? null, quotes: entry.quotes, notes: entry.notes, verified: entry.verified ?? 0 },
    });
  }

  for (const work of works.values()) {
    if (!work.citekey) work.blockers.push("no_citekey");
    alias(work.citekey, work.key, "citekey");
    for (const isbn of work.isbns) alias(isbn, work.key, "isbn");
  }

  const retired: string[] = [];
  db.transaction(() => {
    const before = (db.prepare("SELECT key FROM works WHERE kind != 'zotero'").all() as { key: string }[]).map((r) => r.key);
    db.exec("DELETE FROM works_fts; DELETE FROM holdings; DELETE FROM work_keys; DELETE FROM works;");
    const insertWork = db.prepare(`INSERT INTO works (key, kind, item_type, title, creators, year, citekey, isbns, blockers, candidates)
      VALUES (@key, @kind, @item_type, @title, @creators, @year, @citekey, @isbns, @blockers, @candidates)`);
    const insertFts = db.prepare("INSERT INTO works_fts (key, title, creators) VALUES (?, ?, ?)");
    for (const w of works.values()) {
      insertWork.run({ ...w, creators: JSON.stringify(w.creators), isbns: JSON.stringify(w.isbns), blockers: JSON.stringify(w.blockers), candidates: JSON.stringify(w.candidates) });
      insertFts.run(w.key, w.title, w.creators.join("; "));
    }
    const insertKey = db.prepare("INSERT OR IGNORE INTO work_keys (key, work_key, kind) VALUES (?, ?, ?)");
    for (const w of works.values()) insertKey.run(w.key, w.key, "work");
    for (const k of keys) insertKey.run(k.key, k.work_key, k.kind);
    const insertHolding = db.prepare("INSERT OR IGNORE INTO holdings (work_key, form, ref, detail) VALUES (?, ?, ?, ?)");
    for (const h of holdings) insertHolding.run(h.work_key, h.form, h.ref, JSON.stringify(h.detail));

    // An interim key that's no longer a work's own key, but still names one through its book or quote-mcp work, was filed.
    const nowAt = db.prepare("SELECT work_key FROM work_keys WHERE key = ? AND work_key != ?");
    const record = db.prepare("INSERT INTO former_keys (key, work_key, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET work_key = excluded.work_key, at = excluded.at");
    const at = now();
    for (const key of before) {
      if (works.has(key)) continue;
      const moved = nowAt.get(key, key) as { work_key: string } | undefined;
      if (moved) {
        record.run(key, moved.work_key, at);
        retired.push(key);
      }
    }
    // Former keys keep resolving, for as long as the work they moved to exists.
    db.exec("INSERT OR IGNORE INTO work_keys (key, work_key, kind) SELECT f.key, f.work_key, 'former' FROM former_keys f JOIN works w ON w.key = f.work_key");
  })();
  return { works: works.size, orphans, retired };
}
