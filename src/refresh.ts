import { type DB, now, setMeta } from "./db.js";
import { FEEDS, feedUrl, pollFeed, recordZotero } from "./feeds.js";
import { syncLibrary } from "./sync.js";
import { rebuildWorks } from "./works.js";
import { ZoteroClient, type ZoteroConfig } from "./zotero.js";

/**
 * One refresh: each Zotero library brought up to date, each feed polled, and the works rebuilt when any of
 * them changed (or when force is set). The server runs one every HOLDINGS_REFRESH_SECONDS; a failing
 * source is recorded on its feed and the others carry on.
 */

export interface RefreshOptions {
  zotero: ZoteroConfig[];
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  log?: (text: string) => void;
}

export async function refresh(db: DB, options: RefreshOptions): Promise<{ changed: boolean; works?: number; retired?: string[] }> {
  const log = options.log ?? (() => {});
  let changed = !!options.force;
  for (const config of options.zotero) {
    try {
      const r = await syncLibrary(db, new ZoteroClient(config, log), config.library);
      recordZotero(db, config.library, r);
      if (r.changed || r.deleted) {
        changed = true;
        log(`${config.library}: ${r.changed} changed, ${r.deleted} deleted, now at version ${r.version}.\n`);
      }
    } catch (error) {
      recordZotero(db, config.library, { error: (error as Error).message });
      log(`${config.library}: ${(error as Error).message}\n`);
    }
  }
  for (const feed of FEEDS) {
    const url = feedUrl(feed, options.env);
    if (!url) continue;
    if (await pollFeed(db, feed, url)) {
      changed = true;
      log(`${feed.name}: new snapshot.\n`);
    }
  }
  setMeta(db, "last_refresh", now());
  if (!changed) return { changed };
  const r = rebuildWorks(db);
  setMeta(db, "orphans", JSON.stringify(r.orphans));
  if (r.retired.length) log(`Filed since the last refresh: ${r.retired.join(", ")}.\n`);
  return { changed, works: r.works, retired: r.retired };
}

/** Refreshes every interval, never two at once; returns a function that stops it. */
export function startRefresh(db: DB, options: RefreshOptions, seconds: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refresh(db, options);
    } catch (error) {
      console.error(`Refresh failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
