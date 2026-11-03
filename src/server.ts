import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { JWTVerifyGetKey } from "jose";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { DB } from "./db.js";
import { AccessError, authorizeRequest, requestAccessConfig, type RequestAccessConfig } from "./http-access.js";
import { VERSION, createServer } from "./mcp.js";
import { holdingsStatus } from "./queries.js";

/**
 * Streamable HTTP at /mcp (stateless: a fresh server per request, JSON responses) and /health, on
 * quote-mcp's pattern. Requests through Cloudflare need a verified Access token; direct LAN requests don't.
 */

export interface ServeOptions {
  access?: RequestAccessConfig;
  accessKeys?: JWTVerifyGetKey;
  host: string;
  port: number;
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
      await authorizeRequest(req, url.pathname, access, options.accessKeys);
      if (url.pathname === "/health") {
        const status = holdingsStatus(db);
        const errors = status.feeds.filter((f) => f.error).map((f) => f.error);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          ok: true, version: VERSION, works: status.works.total, last_refresh: status.last_refresh, errors, deployed: readDeployed(),
        }));
        return;
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

export async function serveStdio(db: DB): Promise<void> {
  await createServer(db).connect(new StdioServerTransport());
}
