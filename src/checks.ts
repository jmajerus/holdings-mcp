import { type DB, now } from "./db.js";
import { type BookEntry, type CountEntry, snapshot } from "./feeds.js";
import { holdingsFeeds } from "./queries.js";
import { isbn13, workKey } from "./works.js";

/**
 * What must hold between the services (docs/cross-service-checks.md). Each service tests its own logic; these
 * test the seams, from what holdings-mcp already reads, after every refresh. They only report: nothing here
 * fixes anything, and each check names the repository that owns the fix.
 *
 * A finding is `fail` (the data is wrong) or `drift` (it should heal on its own), and drift past its allowance
 * becomes `fail`; drift with no allowance never does. A check whose feeds failed or are stale reports `skipped`
 * and leaves its findings as they were, rather than judging old data. A finding keeps when it was first seen.
 */

const HOUR = 3_600_000;
const EXAMPLES = 10;

interface Finding {
  ref: string;
  detail: string;
  severity: "fail" | "drift";
  /** How long drift may last before it counts as fail, from when it was first seen; null: it never does. */
  allowanceMs?: number | null;
}

interface Check {
  name: string;
  fix: string;
  /** The feeds its verdict rests on. */
  feeds(db: DB): string[];
  run(db: DB, env: NodeJS.ProcessEnv, at: number): Finding[];
}

const zoteroFeeds = (db: DB) => (db.prepare("SELECT name FROM feeds WHERE name LIKE 'zotero:%' ORDER BY name").pluck().all() as string[]);

/** Why an item a feed names isn't a work, or null when it is one. */
function missingItem(db: DB, library: string, key: string): string | null {
  if (db.prepare("SELECT 1 FROM works WHERE key = ?").get(workKey(library, key))) return null;
  const item = db.prepare("SELECT item_type, deleted FROM zotero_items WHERE library = ? AND key = ?").get(library, key) as { item_type: string; deleted: number } | undefined;
  if (item?.deleted) return db.prepare("SELECT 1 FROM zotero_deletions WHERE library = ? AND key = ?").get(library, key) ? "deleted from Zotero" : "in Zotero's trash";
  return item ? `a ${item.item_type}, not a work` : "not in the mirror";
}

function calibreWorks(db: DB): { key: string; title: string; isbns: string }[] {
  return db.prepare("SELECT key, title, isbns FROM works WHERE kind = 'calibre'").all() as { key: string; title: string; isbns: string }[];
}

const sharedKeys = (db: DB, kinds: string) => db.prepare(`SELECT key, group_concat(work_key, ', ') AS works FROM work_keys
  WHERE kind IN (${kinds}) GROUP BY key COLLATE NOCASE HAVING COUNT(DISTINCT work_key) > 1 ORDER BY key`).all() as { key: string; works: string }[];

export const CHECKS: Check[] = [
  {
    // Drift first: quote-mcp's counts only learn of a trashed item at its next import, up to half an hour on.
    name: "items-exist",
    fix: "corpus-mcp for a book, quote-mcp for quotes",
    feeds: (db) => ["books", "counts", ...zoteroFeeds(db)],
    run: (db) => {
      const findings: Finding[] = [];
      const add = (ref: string, source: string, library: string, key: string) => {
        const why = missingItem(db, library, key);
        if (why) findings.push({ ref, detail: `${source} names ${library}/${key}, which is ${why}.`, severity: "drift", allowanceMs: HOUR });
      };
      for (const b of snapshot<BookEntry>(db, "books")) if (b.zotero) add(`book:${b.book_id}`, `Book ${b.book_id}`, b.zotero.library, b.zotero.key);
      for (const c of snapshot<CountEntry>(db, "counts")) {
        if (!c.zotero) continue;
        add(c.work_id === undefined ? `quotes:${c.zotero.library}/${c.zotero.key}` : `quote:${c.work_id}`, c.work_id === undefined ? "A quote-mcp entry with no work_id (so not placed in the holdings)" : `quote-mcp work ${c.work_id}`, c.zotero.library, c.zotero.key);
      }
      return findings;
    },
  },
  {
    name: "one-quote-work-per-item",
    fix: "quote-mcp",
    feeds: () => ["counts"],
    run: (db) => {
      const byItem = new Map<string, number[]>();
      for (const c of snapshot<CountEntry>(db, "counts")) {
        if (!c.zotero || c.work_id === undefined) continue;
        const item = `${c.zotero.library}/${c.zotero.key}`;
        byItem.set(item, [...byItem.get(item) ?? [], c.work_id]);
      }
      return [...byItem].filter(([, ids]) => ids.length > 1).map(([item, ids]) => ({
        ref: item, detail: `quote-mcp works ${ids.join(", ")} all name ${item}; filing should have merged them.`, severity: "fail" as const,
      }));
    },
  },
  {
    // Not ISBNs: editions share them, and find_work asks the caller to pick. A shared citekey is reported, never failed.
    name: "one-work-per-exact-key",
    fix: "holdings-mcp; Zotero for a citekey",
    feeds: (db) => ["books", "counts", ...zoteroFeeds(db)],
    run: (db) => [
      ...sharedKeys(db, "'work', 'item', 'calibre', 'book', 'quote', 'former'").map((r) => ({ ref: r.key, detail: `Names ${r.works}.`, severity: "fail" as const })),
      ...sharedKeys(db, "'citekey'").map((r) => ({ ref: `citekey:${r.key}`, detail: `Citekey shared by ${r.works}.`, severity: "drift" as const, allowanceMs: null })),
    ],
  },
  {
    name: "filed-but-unmatched",
    fix: "corpus-mcp",
    feeds: (db) => ["books", ...zoteroFeeds(db)],
    run: (db) => {
      const unfiled = new Set(calibreWorks(db).map((w) => w.key));
      const items = db.prepare("SELECT library, key, data FROM zotero_items WHERE deleted = 0 AND instr(data, 'Calibre UUID') > 0").all() as { library: string; key: string; data: string }[];
      return items.flatMap((item) => {
        const uuid = /Calibre UUID:\s*([0-9a-f-]+)/i.exec(String((JSON.parse(item.data) as { extra?: unknown }).extra ?? ""))?.[1]?.toLowerCase();
        const work = uuid && `calibre:${uuid}`;
        if (!work || !unfiled.has(work)) return [];
        // corpus-mcp matches against one library (CORPUS_ZOTERO_LIBRARY), so one filed in another stays here until it reads both.
        return [{ ref: work, detail: `Filed as ${item.library}/${item.key}, in ${item.library}; corpus-mcp hasn't matched it, and only matches against CORPUS_ZOTERO_LIBRARY.`, severity: "drift" as const, allowanceMs: HOUR }];
      });
    },
  },
  {
    name: "likely-missed-matches",
    fix: "a person, at corpus-mcp's /admin/zotero",
    feeds: (db) => ["books", ...zoteroFeeds(db)],
    run: (db) => {
      // With no ISBNs from corpus-mcp this can't find anything, and ok would claim it had looked.
      const books = snapshot<BookEntry>(db, "books");
      if (books.length && !books.some((b) => b.isbns?.length)) throw new Error("corpus-mcp's books feed sends no ISBNs");
      const items = new Map<string, string[]>();
      for (const w of db.prepare("SELECT key, isbns FROM works WHERE kind = 'zotero' AND isbns != '[]'").all() as { key: string; isbns: string }[]) {
        for (const isbn of new Set((JSON.parse(w.isbns) as string[]).map(isbn13))) items.set(isbn, [...items.get(isbn) ?? [], w.key]);
      }
      return calibreWorks(db).flatMap((w) => {
        const shared = [...new Set((JSON.parse(w.isbns) as string[]).flatMap((isbn) => items.get(isbn13(isbn)) ?? []))];
        return shared.length ? [{ ref: w.key, detail: `"${w.title}" shares an ISBN with ${shared.join(", ")}.`, severity: "drift" as const, allowanceMs: null }] : [];
      });
    },
  },
  {
    name: "zotero-readers-in-step",
    fix: "the reader's repository",
    feeds: () => [],
    run: (db, env, at) => zoteroReaders(env).flatMap((reader) => {
      const last = db.prepare("SELECT MAX(last_read) AS at FROM zotero_readers WHERE address = ?").get(reader.address) as { at: string | null };
      const allowed = 3 * reader.seconds * 1000;
      if (last.at && at - Date.parse(last.at) <= allowed) return [];
      const when = last.at ? `last read at ${last.at}` : "has not read since this was first checked";
      return [{ ref: reader.name, detail: `${reader.name} (${reader.address}) ${when}; it syncs every ${reader.seconds} s. It may have gone back to zotero.org, or its sync stopped.`, severity: "drift" as const, allowanceMs: allowed }];
    }),
  },
];

/** HOLDINGS_ZOTERO_READERS: who should be reading /zotero, as name=address:seconds[,…]. A bad entry is an error, not a silent gap. */
export function zoteroReaders(env: NodeJS.ProcessEnv = process.env): { name: string; address: string; seconds: number }[] {
  return (env.HOLDINGS_ZOTERO_READERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([^=]+)=(.+):(\d+)$/.exec(entry);
    if (!m || !Number(m[3])) throw new Error(`HOLDINGS_ZOTERO_READERS: "${entry}" isn't name=address:seconds.`);
    return { name: m[1].trim(), address: m[2].trim(), seconds: Number(m[3]) };
  });
}

/** Why a check can't give a verdict now: the feeds it rests on that failed, are stale, or haven't answered. */
function unusable(db: DB, names: string[]): string | null {
  const feeds = new Map(holdingsFeeds(db).map((f) => [f.name, f]));
  const bad = names.map((name) => {
    const feed = feeds.get(name);
    return !feed ? `${name} has no data` : feed.error ? `${name} failed` : feed.stale ? `${name} is stale` : null;
  }).filter(Boolean);
  return bad.length ? bad.join("; ") : null;
}

/** Runs every check and stores what it found. One check that throws is reported skipped; the rest still run. */
export function runChecks(db: DB, env: NodeJS.ProcessEnv = process.env, at = Date.now()): void {
  const stamp = new Date(at).toISOString();
  const previous = db.prepare("SELECT ref, first_seen FROM check_findings WHERE check_name = ?");
  const remove = db.prepare("DELETE FROM check_findings WHERE check_name = ?");
  const insert = db.prepare("INSERT INTO check_findings (check_name, ref, detail, severity, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)");
  const save = db.prepare(`INSERT INTO checks (name, result, fix, feeds, reason, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET result = excluded.result, fix = excluded.fix, feeds = excluded.feeds, reason = excluded.reason, at = excluded.at`);
  const dismissals = db.prepare("SELECT ref FROM check_dismissals WHERE check_name = ?").pluck();
  const undismiss = db.prepare("DELETE FROM check_dismissals WHERE check_name = ? AND ref = ?");
  for (const check of CHECKS) {
    let findings: Finding[];
    const feeds = check.feeds(db);
    const reason = unusable(db, feeds);
    try {
      if (reason) throw new Error(reason);
      findings = check.run(db, env, at);
    } catch (error) {
      save.run(check.name, "skipped", check.fix, JSON.stringify(feeds), (error as Error).message, stamp);
      continue;
    }
    db.transaction(() => {
      const seen = new Map((previous.all(check.name) as { ref: string; first_seen: string }[]).map((r) => [r.ref, r.first_seen]));
      remove.run(check.name);
      let result: "ok" | "drift" | "fail" = "ok";
      const refs = new Set<string>();
      for (const f of findings) {
        if (refs.has(f.ref)) continue;
        refs.add(f.ref);
        const first = seen.get(f.ref) ?? stamp;
        const late = f.severity === "drift" && f.allowanceMs != null && at - Date.parse(first) > f.allowanceMs;
        const severity = late ? "fail" : f.severity;
        insert.run(check.name, f.ref, f.detail, severity, first, stamp);
        if (severity === "fail") result = "fail";
        else if (result === "ok") result = "drift";
      }
      // A finding that went away takes its dismissal with it; if it returns, it's a new question.
      for (const d of dismissals.all(check.name) as string[]) if (!refs.has(d)) undismiss.run(check.name, d);
      save.run(check.name, result, check.fix, JSON.stringify(feeds), null, stamp);
    })();
  }
}

interface FindingRow { check_name: string; ref: string; detail: string; severity: string; first_seen: string; last_seen: string }

/** The stored results, with up to ten examples each; since: only findings first seen at or after that time. */
export function checkResults(db: DB, since?: string) {
  const feeds = new Map(holdingsFeeds(db).map((f) => [f.name, f.ok_at]));
  const rows = db.prepare("SELECT name, result, fix, feeds, reason, at FROM checks ORDER BY name").all() as { name: string; result: string; fix: string; feeds: string; reason: string | null; at: string }[];
  const findings = db.prepare(`SELECT check_name, ref, detail, severity, first_seen, last_seen FROM check_findings
    WHERE check_name = ? AND (? IS NULL OR first_seen >= ?) ORDER BY severity = 'fail' DESC, first_seen, ref`);
  return rows.map((row) => {
    const all = findings.all(row.name, since ?? null, since ?? null) as FindingRow[];
    return {
      name: row.name, result: row.result, count: all.length, fix: row.fix, checked_at: row.at,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(all.length ? { first_seen: all.map((f) => f.first_seen).sort()[0] } : {}),
      feeds: (JSON.parse(row.feeds) as string[]).map((name) => ({ name, ok_at: feeds.get(name) ?? null })),
      examples: all.slice(0, EXAMPLES).map(({ ref, detail, severity, first_seen, last_seen }) => ({ ref, detail, severity, first_seen, last_seen })),
    };
  });
}

/** Who has read /zotero, for anyone asking whether a service switched. */
export function zoteroReads(db: DB) {
  return db.prepare("SELECT address, library, last_read, last_since FROM zotero_readers ORDER BY address, library").all();
}

/** How many checks stand at each result, and which fail, for /health. */
export function checkSummary(db: DB) {
  const rows = db.prepare("SELECT name, result FROM checks ORDER BY name").all() as { name: string; result: string }[];
  const count = (result: string) => rows.filter((r) => r.result === result).length;
  return { ok: count("ok"), drift: count("drift"), fail: count("fail"), skipped: count("skipped"), failing: rows.filter((r) => r.result === "fail").map((r) => r.name) };
}

/** Records a read of /zotero: the first page of a listing, or /deleted, so one write per sync request rather than per page. */
export function recordZoteroRead(db: DB, address: string | undefined, library: string, since: number): void {
  db.prepare(`INSERT INTO zotero_readers (address, library, last_read, last_since) VALUES (?, ?, ?, ?)
    ON CONFLICT (address, library) DO UPDATE SET last_read = excluded.last_read, last_since = excluded.last_since`)
    .run((address ?? "unknown").replace(/^::ffff:/, ""), library, now(), since);
}
