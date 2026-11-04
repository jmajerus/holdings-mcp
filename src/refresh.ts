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

export type RefreshResult = Awaited<ReturnType<typeof refresh>>;

export interface Refresher {
  /** A refresh that starts after any running one, since that one may have begun before the change asked about. */
  now(): Promise<RefreshResult>;
  stop(): void;
}

/** Refreshes every interval (none when seconds is 0), and on request; never two at once. */
export function startRefresh(db: DB, options: RefreshOptions, seconds: number): Refresher {
  let running: Promise<RefreshResult> | null = null;
  let queued: Promise<RefreshResult> | null = null;
  const run = () => {
    const r = refresh(db, options);
    running = r.finally(() => (running = null));
    return running;
  };
  const tick = () => {
    if (!running) run().catch((error) => console.error(`Refresh failed: ${(error as Error).message}`));
  };
  const timer = seconds > 0 ? setInterval(tick, seconds * 1000) : null;
  timer?.unref();
  if (seconds > 0) tick();
  return {
    now() {
      if (!running) return run();
      queued ??= running.catch(() => undefined).then(() => {
        queued = null;
        return running ?? run();
      });
      return queued;
    },
    stop: () => timer && clearInterval(timer),
  };
}
