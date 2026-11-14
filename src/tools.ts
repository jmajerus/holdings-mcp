import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type DB, now } from "./db.js";

/**
 * The tools each service lists, kept as one feed row per service (tools:<name>), so the tools-skills-use check
 * (src/checks.ts) can say when a tool the authoring skills call has been renamed or dropped. The Glass Office run
 * lost three tool names mid-session, and nothing reported it but the agent that tripped over them.
 */

/**
 * The tools the authoring skills call, by each service's own names (the portal adds a prefix). Keep in step with
 * the skills: a tool added to a skill belongs here, and a rename that was meant is made here too.
 */
export const TOOLS_SKILLS_USE: Record<string, string[]> = {
  "holdings-mcp": ["find_work", "get_work", "status"],
  "corpus-mcp": ["search_corpus", "read_book", "cite_passage", "pin_citekey", "list_shelves", "list_books", "get_book_outline"],
  "quote-mcp": ["search_quotes", "get_quote", "get_concept", "list_concepts", "add_quote", "cite_quote"],
  "terminology-mcp": ["search_terms", "get_term"],
  "zotero-mcp": ["zotero_search_items", "zotero_add_item", "zotero_get_item_metadata"],
  "iasp-mcp": ["get_authoring_guide", "validate_markdown", "render_document"],
};

/** How long a listing is good for: tools change at a deploy, not between refreshes. Under the 30 minutes after which a feed is stale. */
const LISTING_SECONDS = 600;

/** HOLDINGS_TOOL_SERVERS: whose tools to list, as name=url[,…] (the url is the service's MCP endpoint). A bad entry is an error. */
export function toolServers(env: NodeJS.ProcessEnv = process.env): { name: string; url: string }[] {
  return (env.HOLDINGS_TOOL_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at).trim();
    let url: URL | undefined;
    try { url = new URL(entry.slice(at + 1).trim()); } catch { /* reported below */ }
    if (at < 1 || !url || !/^https?:$/.test(url.protocol)) throw new Error(`HOLDINGS_TOOL_SERVERS: "${entry}" isn't name=url.`);
    return { name, url: url.toString() };
  });
}

export type ListTools = (url: string) => Promise<string[]>;

/** A service's tool names, asked over MCP as any client would. */
export const listTools: ListTools = async (url) => {
  const client = new Client({ name: "holdings-mcp-checks", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { signal: AbortSignal.timeout(15_000) } });
  try {
    await client.connect(transport);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names.sort();
  } finally {
    await client.close().catch(() => {});
  }
};

/** Lists each configured service's tools unless its last listing is recent. Errors are recorded on the feed, not thrown. */
export async function pollTools(db: DB, env: NodeJS.ProcessEnv = process.env, list: ListTools = listTools): Promise<void> {
  const servers = toolServers(env);
  const names = servers.map((s) => `tools:${s.name}`);
  // A service taken off the list stops being checked.
  for (const row of db.prepare("SELECT name FROM feeds WHERE name LIKE 'tools:%'").pluck().all() as string[]) {
    if (!names.includes(row)) db.prepare("DELETE FROM feeds WHERE name = ?").run(row);
  }
  for (const server of servers) {
    const name = `tools:${server.name}`;
    const at = now();
    const last = db.prepare("SELECT url, ok_at, error FROM feeds WHERE name = ?").get(name) as { url: string | null; ok_at: string | null; error: string | null } | undefined;
    if (last?.url === server.url && !last.error && last.ok_at && Date.parse(at) - Date.parse(last.ok_at) < LISTING_SECONDS * 1000) continue;
    db.prepare("INSERT INTO feeds (name, url, checked_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET url = excluded.url, checked_at = excluded.checked_at").run(name, server.url, at);
    try {
      const tools = await list(server.url);
      const body = JSON.stringify(tools);
      db.prepare("UPDATE feeds SET body = ?, entries = ?, ok_at = ?, error = NULL, changed_at = CASE WHEN body IS ? THEN changed_at ELSE ? END WHERE name = ?")
        .run(body, tools.length, at, body, at, name);
    } catch (error) {
      db.prepare("UPDATE feeds SET error = ? WHERE name = ?").run(`${server.name}'s tools (${server.url}): ${(error as Error).message}`, name);
    }
  }
}

/** Each listed service's tool names, from its last good listing. */
export function listedTools(db: DB): Map<string, string[]> {
  const rows = db.prepare("SELECT name, body FROM feeds WHERE name LIKE 'tools:%' AND body IS NOT NULL ORDER BY name").all() as { name: string; body: string }[];
  return new Map(rows.map((r) => [r.name.slice("tools:".length), JSON.parse(r.body) as string[]]));
}
