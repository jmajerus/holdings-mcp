import fs from "node:fs";
import path from "node:path";
import { checkSummary } from "./checks.js";
import type { DB } from "./db.js";
import { VERSION } from "./mcp.js";
import { holdingsStatus } from "./queries.js";
import { worklistCount } from "./worklist.js";

/** The same snapshot feeds both the machine endpoint and its human-readable presentation. */
export function healthStatus(db: DB, env: NodeJS.ProcessEnv = process.env) {
  let deployed: unknown = null;
  try {
    deployed = JSON.parse(fs.readFileSync(path.join(path.dirname(env.HOLDINGS_DB ?? "data/holdings.db"), "deployed.json"), "utf8"));
  } catch { /* No deployment record on a fresh installation. */ }
  const status = holdingsStatus(db);
  return {
    ok: true, version: VERSION, works: status.works.total, last_refresh: status.last_refresh,
    errors: status.feeds.filter((f) => f.error).map((f) => f.error),
    checks: checkSummary(db), worklist: worklistCount(db), deployed,
  };
}
