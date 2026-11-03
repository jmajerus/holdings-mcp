import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { FEEDS, feedUrl } from "./feeds.js";
import { holdingsStatus } from "./queries.js";
import { refresh, startRefresh } from "./refresh.js";
import { serveHttp, serveStdio } from "./server.js";
import { zoteroConfigs } from "./zotero.js";

/**
 *   holdings-mcp refresh [--rebuild]   Syncs the Zotero mirror (HOLDINGS_ZOTERO_LIBRARIES), polls the feeds
 *                                      (HOLDINGS_BOOKS_URL, HOLDINGS_COUNTS_URL), and rebuilds the works if
 *                                      anything changed (always, with --rebuild).
 *   holdings-mcp serve                 MCP over HTTP at /mcp and /health (HOLDINGS_HOST, HOLDINGS_PORT), refreshing
 *                                      every HOLDINGS_REFRESH_SECONDS.
 *   holdings-mcp status                What holdings_status answers.
 *   holdings-mcp migrate               Brings the store up to this build's schema.
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
  if (errors.length) process.exitCode = 1;
}

async function serveCommand() {
  const db = openDb();
  const seconds = Number(process.env.HOLDINGS_REFRESH_SECONDS ?? 300);
  await serveHttp(db, { host: process.env.HOLDINGS_HOST ?? "0.0.0.0", port: Number(process.env.HOLDINGS_PORT ?? 8000) });
  if (seconds > 0) startRefresh(db, { zotero: zoteroConfigs(), log: say }, seconds);
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
  migrate: () => (openDb().close(), console.log("The store is up to date.")),
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
