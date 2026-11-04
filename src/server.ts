import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkResults, checkSummary, zoteroReads } from "./checks.js";
import type { DB } from "./db.js";
import { AccessError, authorizeRequest, requestAccessConfig, type RequestAccessConfig } from "./http-access.js";
import { VERSION, createServer } from "./mcp.js";
import { holdingsStatus } from "./queries.js";
import type { Refresher } from "./refresh.js";
import { sendZoteroApi } from "./zotero-api.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses) and /health, on
 * quote-mcp's pattern. Requests through Cloudflare need a verified Access token; direct LAN requests don't.
 * On the LAN only (a 404 through Access): the Zotero mirror at /zotero (src/zotero-api.ts), and
 * POST /api/refresh, which refreshes now, so a service that just wrote to Zotero can see it here; and
 * GET /api/checks, the cross-service checks in full (src/checks.ts).
 */

export interface ServeOptions {
  access?: RequestAccessConfig;
  accessKeys?: JWTVerifyGetKey;
  host: string;
  port: number;
  refresher?: Refresher;
}

/** What tools/deploy.mjs last installed (branch, commit, when), written beside the store, so read per request. */
function readDeployed(): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(process.env.HOLDINGS_DB ?? "data/holdings.db"), "deployed.json"), "utf8"));
  } catch {
    return null;
  }
}

export function serveHttp(db: DB, options: ServeOptions): Promise<http.Server> {
  const access = options.access ?? requestAccessConfig(process.env, ["holdings-mcp", "holdings-mcp.localdomain"]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const { via } = await authorizeRequest(req, url.pathname, access, options.accessKeys);
      if (url.pathname === "/health") {
        const status = holdingsStatus(db);
        const errors = status.feeds.filter((f) => f.error).map((f) => f.error);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true, version: VERSION, works: status.works.total, last_refresh: status.last_refresh, errors, checks: checkSummary(db), deployed: readDeployed(),
        }));
        return;
      }
      if (url.pathname.startsWith("/zotero/") || url.pathname === "/api/refresh" || url.pathname === "/api/checks") {
        if (via !== "lan") return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found." }));
        if (url.pathname === "/api/refresh") return await refreshNow(db, options.refresher, req, res);
        if (url.pathname === "/api/checks") return sendChecks(db, req, res, url);
        return sendZoteroApi(db, req, res, url);
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (req.method !== "POST") {
        // Stateless: no server-initiated stream (GET) and no sessions to end (DELETE).
        res.writeHead(405, { allow: "POST, OPTIONS", "content-type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null,
        }));
        return;
      }
      const mcp = createServer(db);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (error instanceof AccessError) {
        if (!res.headersSent) res.writeHead(error.status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: error.message }));
        return;
      }
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => server.listen(options.port, options.host, () => {
    const a = server.address();
    console.error(`holdings-mcp ${VERSION} listening on ${typeof a === "object" && a ? `${a.address}:${a.port}` : options.port} (/mcp, /health)`);
    resolve(server);
  }));
}

async function refreshNow(db: DB, refresher: Refresher | undefined, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = { "content-type": "application/json", "cache-control": "no-store" };
  if (req.method !== "POST") return void res.writeHead(405, { ...json, allow: "POST" }).end(JSON.stringify({ error: "POST to refresh." }));
  if (!refresher) return void res.writeHead(503, json).end(JSON.stringify({ error: "This server doesn't refresh." }));
  const r = await refresher.now();
  const errors = holdingsStatus(db).feeds.filter((f) => f.error).map((f) => f.error);
  res.writeHead(200, json).end(JSON.stringify({ changed: r.changed, ...(r.works !== undefined ? { works: r.works } : {}), errors }));
}

function sendChecks(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const json = { "content-type": "application/json", "cache-control": "no-store" };
  if (req.method !== "GET") return void res.writeHead(405, { ...json, allow: "GET" }).end(JSON.stringify({ error: "GET the checks." }));
  const since = url.searchParams.get("since") ?? undefined;
  if (since !== undefined && Number.isNaN(Date.parse(since))) return void res.writeHead(400, json).end(JSON.stringify({ error: `since must be a time, not "${since}".` }));
  // Findings store ISO times, so a since in any other form compares by the instant it means.
  const iso = since === undefined ? undefined : new Date(since).toISOString();
  res.writeHead(200, json).end(JSON.stringify({ summary: checkSummary(db), checks: checkResults(db, iso), zotero_readers: zoteroReads(db) }));
}

export async function serveStdio(db: DB): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
