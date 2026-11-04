import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_VERSION, openDb } from "./db.js";
import { FEEDS, feedUrl } from "./feeds.js";
import { holdingsStatus } from "./queries.js";
import { refresh, startRefresh } from "./refresh.js";
import { serveHttp, serveStdio } from "./server.js";
import { zoteroConfigs } from "./zotero.js";

/**
 *   holdings-mcp refresh [--rebuild] [--strict]
 *                                      Syncs the Zotero mirror (HOLDINGS_ZOTERO_LIBRARIES), polls the feeds
 *                                      (HOLDINGS_BOOKS_URL, HOLDINGS_COUNTS_URL), and rebuilds the works if
 *                                      anything changed (always, with --rebuild). Exits 1 when a Zotero library
 *                                      failed; a feed that failed is only reported (the server retries it), unless
 *                                      --strict.
 *   holdings-mcp serve                 MCP over HTTP at /mcp and /health (HOLDINGS_HOST, HOLDINGS_PORT), and on the
 *                                      LAN the Zotero mirror at /zotero and POST /api/refresh; refreshing every
 *                                      HOLDINGS_REFRESH_SECONDS (120; 0 for only on request).
 *   holdings-mcp status                What holdings_status answers.
 *   holdings-mcp migrate [--backup <file>]
 *                                      Brings the store up to this build's schema, first copying it to <file> when
 *                                      that changes the schema (the deploy keeps the copy for a rollback).
 *   holdings-mcp backup [--dir data/backups] [--keep 14]
 *   holdings-mcp stdio                 MCP over stdio, for local clients and tests.
 */

const argv = process.argv.slice(3);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const say = (text: string) => process.stderr.write(text);

async function refreshCommand() {
  const db = openDb();
  const r = await refresh(db, { zotero: zoteroConfigs(), force: flag("--rebuild"), log: say });
  const off = FEEDS.filter((f) => !feedUrl(f)).map((f) => f.setting);
  if (off.length) say(`Not polled (unset): ${off.join(", ")}.\n`);
  console.log(r.changed ? `Rebuilt: ${r.works} works.` : "Nothing changed.");
  const errors = holdingsStatus(db).feeds.filter((f) => f.error);
  for (const f of errors) console.log(`Error: ${f.error}`);
  if (errors.some((f) => flag("--strict") || f.name.startsWith("zotero:"))) process.exitCode = 1;
}

async function serveCommand() {
  const db = openDb();
  const seconds = Number(process.env.HOLDINGS_REFRESH_SECONDS ?? 120);
  const refresher = startRefresh(db, { zotero: zoteroConfigs(), log: say }, seconds);
  await serveHttp(db, { host: process.env.HOLDINGS_HOST ?? "0.0.0.0", port: Number(process.env.HOLDINGS_PORT ?? 8000), refresher });
}

async function migrateCommand() {
  const file = process.env.HOLDINGS_DB ?? "data/holdings.db";
  const backup = option("--backup");
  if (backup && existsSync(file)) {
    const old = new Database(file, { readonly: true, fileMustExist: true });
    const version = Number(old.pragma("user_version", { simple: true }));
    if (version < SCHEMA_VERSION) {
      rmSync(backup, { force: true });
      await old.backup(backup);
      console.log(`Copied the store at schema ${version} to ${backup}.`);
    }
    old.close();
  }
  const db = openDb(file);
  console.log(`The store is at schema ${db.pragma("user_version", { simple: true })}.`);
  db.close();
}

async function backupCommand() {
  const dir = option("--dir") ?? "data/backups";
  const keep = Number(option("--keep") ?? 14);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `holdings-${new Date().toISOString().slice(0, 10)}.db`);
  await openDb().backup(file);
  const old = readdirSync(dir).filter((f) => /^holdings-\d{4}-\d\d-\d\d\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  console.log(`Backed up to ${file}${old.length ? `; removed ${old.length} older` : ""}.`);
}

const commands: Record<string, () => unknown> = {
  refresh: refreshCommand,
  serve: serveCommand,
  status: () => console.log(JSON.stringify(holdingsStatus(openDb()), null, 2)),
  migrate: migrateCommand,
  backup: backupCommand,
  stdio: () => serveStdio(openDb()),
};

const command = process.argv[2];
if (!command || !commands[command]) {
  console.error(`Usage: holdings-mcp <${Object.keys(commands).join(" | ")}>`);
  process.exitCode = 2;
} else {
  Promise.resolve(commands[command]()).catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
