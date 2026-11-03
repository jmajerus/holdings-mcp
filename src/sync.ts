import { type DB, getMeta, setMeta } from "./db.js";
import type { ZoteroClient } from "./zotero.js";

/**
 * Brings the zotero_items mirror of one library up to date: everything changed since the last sync (all
 * of it the first time), trashed items flagged deleted, and keys deleted since then removed from use.
 * The library version is saved only after the changes are stored, so an interrupted sync repeats.
 */
export async function syncLibrary(db: DB, client: ZoteroClient, library: string, log: (text: string) => void = () => {}): Promise<{ changed: number; deleted: number; version: number }> {
  const since = Number(getMeta(db, `zotero_version:${library}`) ?? 0);
  const { items, deleted, version } = await client.changesSince(since, (done, total) => total && log(`\r${library}: ${done} of ${total} changed items`));
  if (items.length) log("\n");
  const upsert = db.prepare(`
    INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (library, key) DO UPDATE SET version = excluded.version, item_type = excluded.item_type,
      parent_key = excluded.parent_key, deleted = excluded.deleted, data = excluded.data`);
  const remove = db.prepare("UPDATE zotero_items SET deleted = 1 WHERE library = ? AND key = ?");
  db.transaction(() => {
    for (const item of items) {
      upsert.run(library, item.key, item.version, item.data.itemType, item.data.parentItem ?? null, item.data.deleted ? 1 : 0, JSON.stringify(item.data));
    }
    for (const key of deleted) remove.run(library, key);
    setMeta(db, `zotero_version:${library}`, String(version));
  })();
  return { changed: items.length, deleted: deleted.length, version };
}
