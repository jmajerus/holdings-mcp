import { type DB, getMeta, setMeta } from "./db.js";
import { zoteroWebBase, type ApiItem, type ZoteroClient } from "./zotero.js";

/**
 * Brings the zotero_items mirror of one library up to date: everything changed since the last sync (all
 * of it the first time), trashed items flagged deleted, and keys deleted since then removed from use and
 * recorded in zotero_deletions at the library version now, which is what /zotero/<library>/deleted answers
 * from. The first sync of a library also records Zotero's whole deletion log, so a service that synced from
 * Zotero before switching here still learns of every key deleted since its version.
 * A key Zotero deletes between the item listing and the deletions request is recorded at the listing's
 * version. That is past the version of any service syncing from here, so they all learn of it; and since the
 * library version saved is the listing's, Zotero reports it again next time, at its own version.
 * The library version is saved only after the changes are stored, so an interrupted sync repeats.
 */
export async function syncLibrary(db: DB, client: ZoteroClient, library: string, log: (text: string) => void = () => {}): Promise<{ changed: number; deleted: number; version: number }> {
  const since = Number(getMeta(db, `zotero_version:${library}`) ?? 0);
  const { items, deleted, version } = await client.changesSince(since, (done, total) => total && log(`\r${library}: ${done} of ${total} changed items`));
  if (items.length) log("\n");
  const logged = getMeta(db, `zotero_deletions:${library}`) !== undefined;
  const all = logged || since === 0 ? deleted : ((await client.get("deleted", { since: 0 })).body as { items?: string[] }).items ?? [];
  let webBase = items.map((item) => zoteroWebBase(item, library)).find((base) => base !== null);
  // Backfill existing mirrors with one representative item, without re-downloading the library.
  if (!webBase && !getMeta(db, `zotero_web_base:${library}`)) {
    try {
      const { body } = await client.get("items", { format: "json", limit: 1 });
      webBase = (body as ApiItem[]).map((item) => zoteroWebBase(item, library)).find((base) => base !== null);
    } catch (error) {
      log(`Could not discover the web-library address for ${library}: ${(error as Error).message}\n`);
    }
  }
  const upsert = db.prepare(`
    INSERT INTO zotero_items (library, key, version, item_type, parent_key, deleted, data) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (library, key) DO UPDATE SET version = excluded.version, item_type = excluded.item_type,
      parent_key = excluded.parent_key, deleted = excluded.deleted, data = excluded.data`);
  const restored = db.prepare("DELETE FROM zotero_deletions WHERE library = ? AND key = ?");
  const remove = db.prepare("UPDATE zotero_items SET deleted = 1 WHERE library = ? AND key = ?");
  const record = db.prepare(`INSERT INTO zotero_deletions (library, key, version) VALUES (?, ?, ?)
    ON CONFLICT (library, key) DO UPDATE SET version = excluded.version`);
  const changed = new Set(items.map((i) => i.key));
  db.transaction(() => {
    for (const item of items) {
      upsert.run(library, item.key, item.version, item.data.itemType, item.data.parentItem ?? null, item.data.deleted ? 1 : 0, JSON.stringify(item.data));
      restored.run(library, item.key);
    }
    for (const key of all) {
      if (changed.has(key)) continue;
      remove.run(library, key);
      record.run(library, key, version);
    }
    if (webBase) setMeta(db, `zotero_web_base:${library}`, webBase);
    setMeta(db, `zotero_deletions:${library}`, "1");
    setMeta(db, `zotero_version:${library}`, String(version));
  })();
  return { changed: items.length, deleted: deleted.length, version };
}
