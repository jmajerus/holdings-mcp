import { type DB, getMeta, now, setMeta } from "./db.js";
import type { ZoteroClient } from "./zotero.js";

/**
 * Each mirrored Zotero library in numbers, for GET /api/zotero/stats (LAN only): what authoring-ops-mcp shows on
 * zotero-mcp's page, so the suite's public pages can say what the library holds without a second Zotero client.
 * Counts only, never titles. Items come from the mirror; collections and saved searches, which the mirror doesn't
 * keep, from Zotero's own Total-Results on a one-row listing, asked at a refresh that finds the library changed.
 */

interface Counts { collections: number; searches: number; version: number; at: string }

/**
 * Asks Zotero how many collections and saved searches the library has, when its version has moved since the last
 * ask (any change to either moves it). Not part of syncLibrary: corpus-mcp and quote-mcp run that same sync
 * against holdings-mcp's /zotero, which serves items only. A failure leaves the last counts and is only logged.
 */
export async function syncCounts(db: DB, client: ZoteroClient, library: string, version: number, log: (text: string) => void = () => {}): Promise<void> {
  const last = readCounts(db, library);
  if (last && last.version === version) return;
  try {
    const total = async (path: string) => {
      const { headers } = await client.get(path, { format: "json", limit: 1 });
      const n = Number(headers.get("total-results"));
      if (!Number.isInteger(n) || n < 0) throw new Error(`Zotero gave no Total-Results for ${path}`);
      return n;
    };
    const [collections, searches] = await Promise.all([total("collections"), total("searches")]);
    setMeta(db, `zotero_counts:${library}`, JSON.stringify({ collections, searches, version, at: now() } satisfies Counts));
  } catch (error) {
    log(`${library}: couldn't count collections and searches: ${(error as Error).message}\n`);
  }
}

function readCounts(db: DB, library: string): Counts | undefined {
  try { return JSON.parse(getMeta(db, `zotero_counts:${library}`) ?? "") as Counts; } catch { return undefined; }
}

/** Item types that aren't items a person files: they hang off one. */
const CHILD_TYPES = new Set(["note", "attachment", "annotation"]);

export function zoteroStats(db: DB) {
  const libraries = (db.prepare("SELECT key FROM meta WHERE key LIKE 'zotero_version:%' ORDER BY key").pluck().all() as string[])
    .map((k) => k.slice("zotero_version:".length));
  return {
    libraries: libraries.map((library) => {
      // deleted = 1 is an item in the trash, or one deleted for good (it is then in zotero_deletions too).
      const byType = db.prepare(`SELECT item_type AS type, COUNT(*) AS n FROM zotero_items WHERE library = ? AND deleted = 0
        GROUP BY item_type ORDER BY n DESC, item_type`).all(library) as { type: string; n: number }[];
      const one = (sql: string) => (db.prepare(sql).get(library) as { n: number }).n;
      const of = (type: string) => byType.find((t) => t.type === type)?.n ?? 0;
      const feed = db.prepare("SELECT ok_at, changed_at FROM feeds WHERE name = ?").get(`zotero:${library}`) as { ok_at: string | null; changed_at: string | null } | undefined;
      const counts = readCounts(db, library);
      return {
        library,
        version: Number(getMeta(db, `zotero_version:${library}`)),
        synced_at: feed?.ok_at ?? null,
        changed_at: feed?.changed_at ?? null,
        items: byType.filter((t) => !CHILD_TYPES.has(t.type)).reduce((n, t) => n + t.n, 0),
        notes: of("note"),
        attachments: of("attachment"),
        annotations: of("annotation"),
        trashed: one(`SELECT COUNT(*) AS n FROM zotero_items i WHERE i.library = ? AND i.deleted = 1
          AND NOT EXISTS (SELECT 1 FROM zotero_deletions d WHERE d.library = i.library AND d.key = i.key)`),
        by_type: Object.fromEntries(byType.filter((t) => !CHILD_TYPES.has(t.type)).map((t) => [t.type, t.n])),
        collections: counts?.collections ?? null,
        searches: counts?.searches ?? null,
        counted_at: counts?.at ?? null,
      };
    }),
  };
}
