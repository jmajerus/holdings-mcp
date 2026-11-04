import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * The holdings store. Everything in it is a copy (PLAN.md, "Copies follow feeds"), except former_keys:
 * - zotero_items mirrors the Zotero libraries, kept current by library version (src/sync.ts), and
 *   zotero_deletions the keys Zotero deleted from them, so corpus-mcp and quote-mcp can sync from here as they
 *   would from Zotero (src/zotero-api.ts);
 * - feeds holds each feed's last good snapshot, its ETag, and when it last answered (src/feeds.ts);
 * - works, work_keys, holdings, and works_fts are rebuilt from those after every refresh (src/works.ts);
 * - former_keys records interim keys (calibre:…, quote:…) whose work was later filed in Zotero, so they keep
 *   resolving. It can't be rebuilt from the sources, so back it up with the rest.
 */

export type DB = Database.Database;

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS zotero_items (
  library TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, item_type TEXT NOT NULL, parent_key TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY (library, key)
);
CREATE INDEX IF NOT EXISTS zotero_items_type ON zotero_items (library, item_type);
CREATE INDEX IF NOT EXISTS zotero_items_parent ON zotero_items (library, parent_key);
CREATE INDEX IF NOT EXISTS zotero_items_version ON zotero_items (library, version);
-- Keys Zotero deleted for good (emptied from the trash), at the library version the sync learned of them.
CREATE TABLE IF NOT EXISTS zotero_deletions (
  library TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (library, key)
);
CREATE INDEX IF NOT EXISTS zotero_deletions_version ON zotero_deletions (library, version);

-- One row per feed: zotero:<library>, books, counts. body is the last snapshot that parsed.
CREATE TABLE IF NOT EXISTS feeds (
  name TEXT PRIMARY KEY, url TEXT, etag TEXT, body TEXT, entries INTEGER,
  checked_at TEXT, ok_at TEXT, changed_at TEXT, error TEXT
);

-- kind: zotero (a Zotero item), calibre (a Calibre book not filed in Zotero), quote (a quote-mcp work with no single match).
CREATE TABLE IF NOT EXISTS works (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('zotero', 'calibre', 'quote')),
  item_type TEXT, title TEXT NOT NULL, creators TEXT NOT NULL DEFAULT '[]', year TEXT, citekey TEXT, isbns TEXT NOT NULL DEFAULT '[]',
  -- What stands in the way of citing it (not_in_zotero, no_citekey, ambiguous_edition), and the candidate items of an ambiguous one.
  blockers TEXT NOT NULL DEFAULT '[]', candidates TEXT NOT NULL DEFAULT '[]'
);
-- Every key a work answers to, its own included: citekey, item key, book id, calibre:<uuid>, quote:<id>, former keys.
CREATE TABLE IF NOT EXISTS work_keys (
  key TEXT NOT NULL COLLATE NOCASE, work_key TEXT NOT NULL REFERENCES works(key) ON DELETE CASCADE, kind TEXT NOT NULL,
  PRIMARY KEY (key, work_key)
);
CREATE INDEX IF NOT EXISTS work_keys_work ON work_keys (work_key);
-- form: text (a Calibre book with text), file (a Calibre book without text, or a Zotero attachment), quotes. detail is JSON.
CREATE TABLE IF NOT EXISTS holdings (
  work_key TEXT NOT NULL REFERENCES works(key) ON DELETE CASCADE, form TEXT NOT NULL CHECK (form IN ('text', 'file', 'quotes')),
  ref TEXT NOT NULL, detail TEXT NOT NULL, PRIMARY KEY (work_key, form, ref)
);
CREATE INDEX IF NOT EXISTS holdings_form ON holdings (form);

CREATE TABLE IF NOT EXISTS former_keys (key TEXT PRIMARY KEY COLLATE NOCASE, work_key TEXT NOT NULL, at TEXT NOT NULL);

CREATE VIRTUAL TABLE IF NOT EXISTS works_fts USING fts5(key UNINDEXED, title, creators, tokenize = 'porter unicode61 remove_diacritics 2');
`;

export function openDb(path = process.env.HOLDINGS_DB ?? "data/holdings.db"): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = Number(db.pragma("user_version", { simple: true }));
  if (version > SCHEMA_VERSION) throw new Error(`${path} has schema ${version}; this build knows ${SCHEMA_VERSION}.`);
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const now = () => new Date().toISOString();
