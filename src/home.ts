import { checkSummary } from "./checks.js";
import type { DB } from "./db.js";
import { holdingsFeeds } from "./queries.js";
import { worklistCount } from "./worklist.js";

/**
 * The page at / on the LAN: this server's own pages, the other core services in the Authoring MCP portal, and the
 * clients that use them, each with whether it's answering right now. Addresses have defaults, corpus-mcp's and
 * quote-mcp's come from the feeds holdings-mcp reads, and HOLDINGS_LINKS (name=url,…) overrides any of them.
 */

export interface Entry {
  name: string;
  about: string;
  base: string;
  /** Where to ask whether it's up. A /health route gives more; anything else only shows that it answers. */
  probe: string;
  links: [label: string, path: string][];
  feed?: string;
}

const SERVICES: Entry[] = [
  { name: "corpus-mcp", about: "Calibre book text, reading, and verifying passages", base: "http://corpus-mcp.localdomain:8000", probe: "/health", feed: "books",
    links: [["Admin", "/admin"], ["Zotero matching", "/admin/zotero"]] },
  { name: "quote-mcp", about: "Quotes and margin notes", base: "http://quote-mcp.localdomain:8000", probe: "/health", feed: "counts", links: [["Admin", "/admin"]] },
  { name: "terminology-mcp", about: "Schemes, terms, and concept sets", base: "http://terminology-mcp.localdomain:8000", probe: "/health", links: [["Editor", "/"], ["Concept sets", "/sets"]] },
  { name: "zotero-mcp", about: "Managing the Zotero library, and the one path that writes to it. It has no web pages", base: "http://zotero-mcp.localdomain:8000", probe: "/mcp", links: [] },
];

const CLIENTS: Entry[] = [
  { name: "concept-clusters", about: "Concept Clusters authoring", base: "http://cc-authoring.localdomain:8787", probe: "/", links: [["Admin", "/admin"]] },
];

export interface Status { state: "up" | "answering" | "problem" | "down"; commit?: string; deployedAt?: string }

/** Names and addresses from HOLDINGS_LINKS. A bad entry is skipped, and named on the page rather than failing it. */
export function readLinks(value: string | undefined): { links: Map<string, string>; bad: string[] } {
  const links = new Map<string, string>();
  const bad: string[] = [];
  for (const entry of (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf("=");
    try {
      const url = new URL(entry.slice(at + 1).trim());
      if (at < 1 || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error();
      links.set(entry.slice(0, at).trim(), url.origin);
    } catch {
      bad.push(entry);
    }
  }
  return { links, bad };
}

function withAddress(db: DB, entry: Entry, links: Map<string, string>): Entry {
  const set = links.get(entry.name);
  if (set) return { ...entry, base: set };
  const feed = entry.feed && (db.prepare("SELECT url FROM feeds WHERE name = ?").get(entry.feed) as { url: string | null } | undefined)?.url;
  try {
    return feed ? { ...entry, base: new URL(feed).origin } : entry;
  } catch {
    return entry;
  }
}

/** Asks one server, briefly. Any answer short of a server error means it's there; a /health can say more. */
export async function probe(entry: Entry, timeoutMs = 2000): Promise<Status> {
  try {
    const res = await fetch(entry.base + entry.probe, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 500) return { state: "problem" };
    if (entry.probe !== "/health") {
      await res.body?.cancel();
      return { state: "answering" };
    }
    const body = await res.json() as { ok?: boolean; deployed?: { commit?: string; at?: string } | null };
    return { state: res.ok && body.ok ? "up" : "problem", commit: body.deployed?.commit?.slice(0, 7), deployedAt: body.deployed?.at };
  } catch (error) {
    return { state: error instanceof SyntaxError ? "problem" : "down" };
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const WORDS: Record<Status["state"], string> = { up: "up", answering: "answering", problem: "problem", down: "not answering" };

function card(entry: Entry, status: Status): string {
  const links = entry.links.map(([label, path]) => `<a href="${esc(entry.base + path)}">${esc(label)}</a>`).join(" · ");
  return `<tr><td class="state"><span class="${status.state}">●</span> ${WORDS[status.state]}</td>
<td><strong>${esc(entry.name)}</strong><div class="s">${esc(entry.about)}</div>${status.commit ? `<div class="s">${esc(status.commit)}${status.deployedAt ? ` · deployed ${esc(status.deployedAt.slice(0, 10))}` : ""}</div>` : ""}</td><td>${links}</td></tr>`;
}

export async function homePage(db: DB, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { links, bad } = readLinks(env.HOLDINGS_LINKS);
  const services = SERVICES.map((e) => withAddress(db, e, links));
  const clients = CLIENTS.map((e) => withAddress(db, e, links));
  const [serviceStates, clientStates] = await Promise.all([Promise.all(services.map((e) => probe(e))), Promise.all(clients.map((e) => probe(e)))]);
  const summary = checkSummary(db);
  const waiting = worklistCount(db);
  const feeds = holdingsFeeds(db).map((f) => `<tr><td>${esc(f.name)}</td><td>${f.error ? `<span class="problem">${esc(f.error)}</span>` : f.stale ? '<span class="problem">stale</span>' : "fresh"}</td><td class="s">${esc(f.ok_at?.replace("T", " ").slice(0, 16))}</td></tr>`).join("");
  const unknown = [...links.keys()].filter((name) => ![...SERVICES, ...CLIENTS].some((e) => e.name === name));
  const problems = [...bad, ...unknown];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Holdings</title>
<style>:root{color-scheme:light dark;--line:#8884;--mut:#777;--up:#2e7d4f;--warn:#9a6700;--bad:#b3261e}body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:24px 16px}
h1{margin:0}h2{font-size:1.05rem;margin:28px 0 6px}section{overflow-x:auto}table{border-collapse:collapse;width:100%}td{vertical-align:top;padding:8px 14px 8px 0;border-bottom:1px solid var(--line)}.s{color:var(--mut);font-size:.87rem}
.state{white-space:nowrap}.up{color:var(--up)}.answering{color:var(--up)}.problem{color:var(--bad)}.down{color:var(--bad)}</style></head><body>
<h1>Holdings</h1><p class="s">Finding a work across the authoring services.</p>
${problems.length ? `<p class="problem">HOLDINGS_LINKS has entries it can't use: ${esc(problems.join(", "))}.</p>` : ""}
<h2>This server</h2><section><table>
<tr><td><a href="/worklist">Worklist</a></td><td>${waiting ? `${waiting} waiting` : "nothing waiting"}</td></tr>
<tr><td><a href="/api/checks">Cross-service checks</a></td><td>${summary.ok} ok, ${summary.drift} drift, ${summary.fail} fail, ${summary.skipped} skipped</td></tr>
<tr><td><a href="/health">Health</a></td><td class="s">as JSON</td></tr></table></section>
${feeds ? `<h2>What it reads</h2><section><table>${feeds}</table></section>` : ""}
<h2>Core services</h2><section><table>${services.map((e, i) => card(e, serviceStates[i])).join("")}</table></section>
<h2>Clients</h2><section><table>${clients.map((e, i) => card(e, clientStates[i])).join("")}</table></section>
</body></html>`;
}
