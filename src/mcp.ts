import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DB } from "./db.js";
import { ToolError, findWork, getWork, holdingsStatus } from "./queries.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = `What do I have, and in what form? One row per work, whatever the medium: a Zotero item, a Calibre book with or without text, a paper book with quotes in the quote store.
Find a work once with find_work (words in its title or creators, an author, any key, or what it has), then pass what its holdings name to the tools they list: holdings.text.book_id to search_corpus, read_book, get_book_outline, or cite_passage; the work's key to search_quotes (as work) for its quotes and notes.
A work's key is zotero:<library>/<item key> for a Zotero item; a Calibre book not yet filed has calibre:<uuid>, and a quoted work quote-mcp can't match to one item has quote:<id>. Every tool here takes any key a work has: its key, citekey (with or without @), Zotero item key, Calibre book id (main:42), or ISBN. Keys a work had before it was filed keep resolving.
A work with no text holding has no text to search: don't call search_corpus for it. cannot_cite says what stands in the way of citing a work (not_in_zotero, no_citekey, ambiguous_edition); get_work lists an ambiguous work's candidate items.
This server is read-only. Filing a work in Zotero is done with the Zotero tools; quotes are saved and cited with quote-mcp's tools.`;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Runs a tool body, turning ToolError into an isError result the agent can act on. */
function run(body: () => unknown): CallToolResult {
  try {
    return json(body());
  } catch (error) {
    if (error instanceof ToolError) return { isError: true, content: [{ type: "text", text: error.message }] };
    throw error;
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function createServer(db: DB): McpServer {
  const server = new McpServer({ name: "holdings-mcp", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool("find_work", {
    title: "Find a work",
    description: "Works by words in the title or creators, by author, by any key, or by what they have. Combine any of them; with none, every work. Each result gives the work's key and citekey, its other keys, its bibliographic fields, and its holdings (text, file, quotes), each with the tools to call next.",
    inputSchema: {
      query: z.string().optional().describe("Words or \"quoted phrases\" in the title or creators; a trailing * matches a prefix"),
      author: z.string().optional().describe("Words in a creator's name"),
      key: z.string().optional().describe("Any key: zotero:<library>/<item key>, a citekey, a Zotero item key, a Calibre book id (main:42), calibre:<uuid>, quote:<id>, or an ISBN"),
      has: z.array(z.enum(["text", "file", "quotes", "notes"])).optional().describe("Only works that have all of these: text (a Calibre book with text), file, quotes, notes"),
      item_type: z.string().optional().describe('A Zotero item type, e.g. "book" or "journalArticle"'),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      offset: z.number().int().min(0).optional(),
    },
    annotations: readOnly,
  }, (args) => run(() => findWork(db, args)));

  server.registerTool("get_work", {
    title: "Get a work",
    description: "One work by any key: every key it has (former keys included), every holding (each Zotero attachment and Calibre copy), and what stands in the way of citing it (not_in_zotero, no_citekey, ambiguous_edition, with the candidate items).",
    inputSchema: { key: z.string().describe("Any key a work has; see find_work") },
    annotations: readOnly,
  }, ({ key }) => run(() => getWork(db, key)));

  server.registerTool("holdings_status", {
    title: "Holdings status",
    description: "Each source's freshness and errors (the Zotero libraries, corpus-mcp's books, quote-mcp's quote counts), how many works and holdings there are, Calibre books not yet filed in Zotero, and feed entries that couldn't be placed.",
    inputSchema: {},
    annotations: readOnly,
  }, () => run(() => holdingsStatus(db)));

  return server;
}
