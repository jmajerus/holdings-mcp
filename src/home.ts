import { checkSummary } from "./checks.js";
import { healthStatus } from "./health.js";
import { type DB, getMeta } from "./db.js";
import { findWork, holdingsStatus, ToolError, type Has } from "./queries.js";
import { worklistCount } from "./worklist.js";

/**
 * LAN pages: library search at /, and operational information at /admin, including the other core services
 * and clients, each with whether it's answering right now. Addresses have defaults, corpus-mcp's and
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
  let res: Response;
  try {
    res = await fetch(entry.base + entry.probe, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { state: "down" };
  }
  try {
    if (res.status >= 500 || entry.probe !== "/health") {
      await res.body?.cancel();
      return { state: res.status >= 500 ? "problem" : "answering" };
    }
    const body = await res.json() as { ok?: unknown; deployed?: { commit?: unknown; at?: unknown } | null } | null;
    const commit = body?.deployed?.commit;
    const at = body?.deployed?.at;
    return {
      state: res.ok && body?.ok === true ? "up" : "problem",
      ...(typeof commit === "string" ? { commit: commit.slice(0, 7) } : {}),
      ...(typeof at === "string" ? { deployedAt: at } : {}),
    };
  } catch {
    // It answered, then sent something that isn't JSON, or stopped partway.
    return { state: "problem" };
  }
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const WORDS: Record<Status["state"], string> = { up: "up", answering: "answering", problem: "problem", down: "not answering" };

function card(entry: Entry, status: Status): string {
  const links = entry.links.map(([label, path]) => `<a href="${esc(entry.base + path)}">${esc(label)}</a>`).join(" · ");
  return `<tr><td class="state"><span class="${status.state}">●</span> ${WORDS[status.state]}</td>
<td><strong>${esc(entry.name)}</strong><div class="s">${esc(entry.about)}</div>${status.commit ? `<div class="s">${esc(status.commit)}${status.deployedAt ? ` · deployed ${esc(status.deployedAt.slice(0, 10))}` : ""}</div>` : ""}</td><td>${links}</td></tr>`;
}

const date = (value: string | null) => value && !Number.isNaN(Date.parse(value))
  ? `<time datetime="${esc(value)}">${esc(new Date(value).toISOString().replace("T", " ").replace("Z", " UTC"))}</time>` : "Not yet";

const FIELD_LABELS: Record<string, string> = {
  ok: "Server responding", version: "Application version", works: "Works in the library",
  last_refresh: "Last library refresh", errors: "Feed errors", checks: "Check summary",
  worklist: "Findings awaiting review", deployed: "Deployment", at: "Recorded at",
  commit: "Full commit", branch: "Branch", local: "Installed from local checkout", dirty: "Uncommitted changes",
  ok_at: "Last successful read", checked_at: "Last checked", changed_at: "Last changed",
  fail: "Failed", ok_count: "Passed", drift: "Drift", skipped: "Not checked", failing: "Failing checks",
  name: "Name", result: "Result", count: "Findings", fix: "Next step", reason: "Reason not checked",
  first_seen: "First seen", last_seen: "Last seen", ref: "Reference", detail: "Finding", severity: "Severity",
  feeds: "Source snapshots", examples: "Example findings", address: "Client address", library: "Zotero library",
  last_read: "Last read", last_since: "Last requested Zotero version", url: "Source address", entries: "Entries",
};
const label = (key: string) => FIELD_LABELS[key] ?? key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

/** Render every field, including new deployment metadata, as labelled HTML rather than JSON. */
export function present(value: unknown): string {
  if (value === null || value === undefined) return '<span class="s">Not available</span>';
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return number(value);
  if (typeof value === "string") return /^\d{4}-\d\d-\d\dT/.test(value) && !Number.isNaN(Date.parse(value)) ? date(value) : esc(value);
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="s">None</span>';
    if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
      const columns = [...new Set(value.flatMap((v) => Object.keys(v)))];
      return `<div class="table-wrap"><table><thead><tr>${columns.map((k) => `<th scope="col">${esc(label(k))}</th>`).join("")}</tr></thead><tbody>${value.map((v) => `<tr>${columns.map((k) => `<td>${present(v[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    return `<ul>${value.map((v) => `<li>${present(v)}</li>`).join("")}</ul>`;
  }
  return `<dl class="fields">${Object.entries(value).map(([key, v]) => `<div><dt>${esc(label(key))}</dt><dd>${present(v)}</dd></div>`).join("")}</dl>`;
}
const number = (value: number) => value.toLocaleString("en-US");
const CHECK_LABELS: Record<string, string> = {
  "items-exist": "Referenced Zotero items exist",
  "one-quote-work-per-item": "Quote works have unique Zotero matches",
  "one-work-per-exact-key": "Work keys are unambiguous",
  "filed-but-unmatched": "Filed books match the corpus",
  "likely-missed-matches": "Possible book matches",
  "zotero-readers-in-step": "Services are keeping up with Zotero",
};
const RESULT_LABELS: Record<string, string> = { ok: "Passed", drift: "Drift", fail: "Failed", skipped: "Not checked" };

function locationGlyph(location: "Calibre" | "Zotero" | "Quotes"): string {
  const drawing = location === "Calibre"
    ? '<path d="M3 7h4v13H3zM10 3h4v17h-4zM16 6l4-1 3 14-4 1z"/>'
    : location === "Zotero" ? '<path d="M5 5h14L5 19h14"/>'
    : '<path d="M4 6h6v8H4zM10 14l-3 4M14 6h6v8h-6zM20 14l-3 4"/>';
  return `<span class="location-icon ${location.toLowerCase()}" role="img" aria-label="In ${location}" title="In ${location}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${drawing}</svg></span>`;
}

function catalogBase(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}

/** Display Zotero note HTML as readable text; never insert source markup into the page. */
function noteText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (!name.startsWith("#")) return named[name.toLowerCase()] ?? entity;
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
    }).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
}

/** Links and finding instructions use current copies, never former keys or guessed matches. */
function workLocations(db: DB, work: ReturnType<typeof findWork>["works"][number], corpus: string | null, quotesBase: string | null, lan: boolean) {
  const copies = (db.prepare("SELECT detail FROM holdings WHERE work_key = ? AND form IN ('text', 'file') ORDER BY ref").all(work.key) as { detail: string }[])
    .map((row) => JSON.parse(row.detail) as { source?: string; book_id?: string; library?: string; formats?: string[] })
    .filter((copy) => copy.source === "calibre" && typeof copy.book_id === "string");
  const zotero = /^zotero:(users|groups)\/(\d+)\/([A-Z0-9]{8})$/.exec(work.key);
  const notes = zotero ? (db.prepare("SELECT key, data FROM zotero_items WHERE library = ? AND parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY key").all(`${zotero[1]}/${zotero[2]}`, zotero[3]) as { key: string; data: string }[])
    .map((row) => ({ key: row.key, text: noteText((JSON.parse(row.data) as { note?: string }).note ?? "") })) : [];
  const webBase = zotero ? getMeta(db, `zotero_web_base:${zotero[1]}/${zotero[2]}`) : null;
  const web = webBase && zotero ? `${webBase}/items/${zotero[3]}` : null;
  const app = zotero ? `zotero://select/${zotero[1] === "groups" ? `groups/${zotero[2]}` : "library"}/items/${zotero[3]}` : null;
  const bookLink = (id: string) => corpus ? `${corpus}/${encodeURIComponent(id)}` : null;
  const quoteIds = [...new Set((db.prepare("SELECT detail FROM holdings WHERE work_key = ? AND form = 'quotes'").all(work.key) as { detail: string }[])
    .map((row) => (JSON.parse(row.detail) as { work_id?: number }).work_id)
    .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0))];
  const quoteLinks = quotesBase ? quoteIds.map((id) => `<a href="${esc(quotesBase)}/works/${id}">Read quotes${quoteIds.length > 1 ? ` (record ${id})` : ""}</a>`) : [];
  const linkedGlyph = (location: "Calibre" | "Zotero" | "Quotes", href: string | null) => href
    ? `<a class="location-link" href="${esc(href)}" aria-label="Open ${location} record" title="Open ${location} record">${locationGlyph(location)}</a>`
    : locationGlyph(location);
  const firstBook = copies.length ? bookLink(copies[0].book_id!) : null;
  const firstQuotes = quotesBase && quoteIds.length ? `${quotesBase}/works/${quoteIds[0]}` : null;
  const glyphs = `${copies.length ? linkedGlyph("Calibre", firstBook) : ""}${zotero ? linkedGlyph("Zotero", web ?? app) : ""}${firstQuotes ? linkedGlyph("Quotes", firstQuotes) : ""}`;
  // A citekey names its Zotero record first; works outside Zotero fall back to their actual holding.
  const primaryHref = web ?? app ?? firstBook ?? firstQuotes;
  const primaryLabel = zotero ? "Zotero" : firstBook ? "Calibre" : "Quotes";
  const finding = `<details class="work-location"><summary aria-label="Location details for ${esc(work.title || "Untitled work")}"></summary>
    ${zotero ? `<p><strong>Zotero:</strong> ${zotero[1] === "groups" ? "Group" : "User"} library ${esc(zotero[2])}, item <code>${esc(zotero[3])}</code>.<br>${web ? `<a href="${esc(web)}">Open web library</a> · ` : ""}<a href="${esc(app)}">Select in Zotero desktop</a><br><span class="s">The web library may require sign-in. The desktop link needs Zotero installed and this library synced.</span></p>` : ""}
    ${copies.map((copy) => {
      const id = copy.book_id!;
      const numericId = /:(\d+)$/.exec(id)?.[1];
      return `<p><strong>Calibre:</strong> library <strong>${esc(copy.library || id.split(":")[0])}</strong>, book <code>${esc(id)}</code>${copy.formats?.length ? ` · ${esc(copy.formats.join(", ").toUpperCase())}` : ""}.<br>${corpus ? `<a href="${esc(bookLink(id))}">Open this copy’s details</a><br>` : ""}${numericId ? `In Calibre, switch to this library and search <code>id:${esc(numericId)}</code>.` : `Search this library for <strong>${esc(work.title)}</strong>.`}</p>`;
    }).join("")}
    ${notes.length ? `<div class="zotero-notes"><strong>Zotero notes (${notes.length})</strong>${lan ? notes.map((note) => `<div class="note-text">${esc(note.text || "Empty note")}</div>`).join("") : '<p>Open the Zotero record to read its notes.</p>'}</div>` : ""}
    ${zotero && !Object.keys(work.holdings).length && !notes.length ? '<p>This is a bibliographic record only: no searchable text, files, quotes, or notes are recorded here.</p>' : ""}
    ${!copies.length && !zotero ? `<p>This is a quote-store record without a confirmed Zotero or Calibre match. ${firstQuotes ? "The quotes glyph opens its quote-store record." : "Search the quote store for this title or citekey."}</p><p>Record: <code>${esc(work.key)}</code></p>` : ""}
    ${quoteLinks.length ? `<p><strong>Quotes and notes:</strong> ${quoteLinks.join(" · ")}</p>` : ""}
    </details>`;
  return { glyphs, finding, primaryHref, primaryLabel, notesCount: notes.length };
}

function library(db: DB, params: URLSearchParams, env: NodeJS.ProcessEnv, lan: boolean): string {
  const query = params.get("q")?.trim() ?? "";
  const key = params.get("key")?.trim() ?? "";
  const form = params.get("has") ?? "";
  const has = (["text", "file", "quotes", "notes"] as const).find((h) => h === form);
  const rawOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const limit = 20;
  const { links } = readLinks(env.HOLDINGS_LINKS);
  const corpus = lan ? `${withAddress(db, SERVICES[0], links).base}/admin/books`
    : catalogBase(env.HOLDINGS_CATALOG_URL) ? `${catalogBase(env.HOLDINGS_CATALOG_URL)}/books` : null;
  let results = "";
  try {
    const found = findWork(db, { query, key, has: has ? [has] : undefined, limit, offset });
    const pageLink = (start: number, label: string) => {
      const next = new URLSearchParams({ q: query, key, has: has ?? "", offset: String(start) });
      return `<a href="/?${esc(next.toString())}#library">${label}</a>`;
    };
    results = found.total ? `<p class="s">${number(found.total)} matching works · showing ${number(offset + 1)}–${number(Math.min(offset + limit, found.total))}</p>
      <ul class="works">${found.works.map((w) => { const location = workLocations(db, w, corpus, catalogBase(env.HOLDINGS_QUOTES_URL), lan); return `<li><div class="work-heading"><strong>${esc(w.title || "Untitled work")}</strong><span class="locations">${location.glyphs}</span></div>
      <div class="s">${esc(w.creators.join(", ") || "Unknown author")}${w.year ? ` · ${esc(w.year)}` : ""}</div>
      <div>${Object.keys(w.holdings).filter((h) => h !== "notes").map((h) => `<span class="badge">${esc(h === "text" ? "Searchable text" : h === "file" ? "Files" : "Quotes / notes")}</span>`).join(" ") || (location.notesCount ? "" : '<span class="s">Bibliographic record only</span>')}${location.notesCount ? ` <span class="badge">${location.notesCount} Zotero ${location.notesCount === 1 ? "note" : "notes"}</span>` : ""}</div>
      <div class="s">${location.primaryHref ? `<a class="citekey-link" href="${esc(location.primaryHref)}" title="View in ${location.primaryLabel}"><code>${esc(w.citekey ? `@${w.citekey}` : w.key)}</code></a>` : `<code>${esc(w.citekey ? `@${w.citekey}` : w.key)}</code>`}</div>
      ${w.cannot_cite?.length ? `<div class="warning">Citation needs attention: ${esc(w.cannot_cite.map((b) => b.replaceAll("_", " ")).join(", "))}</div>` : ""}${location.finding}</li>`; }).join("")}</ul>
      <nav class="pagination" aria-label="Search results">${offset ? pageLink(Math.max(0, offset - limit), "← Previous") : ""}${offset + limit < found.total ? pageLink(offset + limit, "Next →") : ""}</nav>`
      : `<p class="empty">${query || key || has ? 'No works match these filters. Try fewer words or <a href="/#library">clear the filters</a>.' : "No works yet. Library records will appear after the first successful refresh."}</p>`;
    if (found.total && offset >= found.total) results = '<p>No works on this page. <a href="/?' + esc(new URLSearchParams({ q: query, key, has: has ?? "" }).toString()) + '#library">Return to the first page</a>.</p>';
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    results = `<p class="problem" role="alert">${esc(error.message)}</p>`;
  }
  return `<section id="library"><h2>Find a work</h2><p class="s">Browse your library, or search titles and authors. Use * for a word prefix.</p><p class="location-legend s">Locations: <span>${locationGlyph("Calibre")} Calibre</span><span>${locationGlyph("Zotero")} Zotero</span>${catalogBase(env.HOLDINGS_QUOTES_URL) ? `<span>${locationGlyph("Quotes")} Quotes</span>` : ""}</p>
    <form method="get" action="/#library" class="search">
    <label>Title or author<input type="search" name="q" value="${esc(query)}" placeholder="e.g. systems thinking"></label>
    <label>Citekey, ISBN or item key<input name="key" value="${esc(key)}" placeholder="Optional exact key"></label>
    <label>Available material<select name="has"><option value="">All works</option>${(["text", "file", "quotes", "notes"] as Has[]).map((h) => `<option value="${h}"${has === h ? " selected" : ""}>${({ text: "Searchable text", file: "Files", quotes: "Quotes", notes: "Notes" })[h]}</option>`).join("")}</select></label>
    <button type="submit">Search library</button><a href="/#library">Clear</a></form>${results}</section>`;
}

/** The library page stays local to the store; it never waits for service health probes. */
export async function homePage(db: DB, env: NodeJS.ProcessEnv = process.env, params = new URLSearchParams(), showAdmin = true): Promise<string> {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const stats: [number, string][] = [
    [count("SELECT COUNT(*) AS n FROM works"), "Works in your library"],
    ...(["text", "file", "quotes"] as const).map((form): [number, string] => [
      (db.prepare("SELECT COUNT(DISTINCT work_key) AS n FROM holdings WHERE form = ?").get(form) as { n: number }).n,
      { text: "With searchable text", file: "With files", quotes: "With quotes or notes" }[form],
    ]),
  ];
  return page(false, `<div class="stats">${stats.map(([n, label]) => `<div class="stat"><strong>${number(n)}</strong><span class="s">${label}</span></div>`).join("")}</div>
    <p class="s">A work may have text, files, and quotes, so these totals can overlap.</p>${library(db, params, env, showAdmin)}`, showAdmin);
}

export async function adminPage(db: DB, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { links, bad } = readLinks(env.HOLDINGS_LINKS);
  const services = SERVICES.map((e) => withAddress(db, e, links));
  const clients = CLIENTS.map((e) => withAddress(db, e, links));
  const [serviceStates, clientStates] = await Promise.all([Promise.all(services.map((e) => probe(e))), Promise.all(clients.map((e) => probe(e)))]);
  const summary = checkSummary(db);
  const waiting = worklistCount(db);
  const status = holdingsStatus(db);
  const feeds = status.feeds.map((f) => `<tr><th scope="row">${esc(f.name)}</th><td><span class="badge ${f.error ? "problem" : f.stale ? "warning" : "up"}">${f.error ? "Error" : f.stale ? "Stale" : "Fresh"}</span>${f.error ? `<div class="problem">${esc(f.error)}</div>` : ""}</td><td>${f.entries === null ? "—" : number(f.entries)}</td><td class="s">${date(f.ok_at)}</td></tr>`).join("");
  const checks = status.checks.map((c) => `<details class="check"><summary><span class="badge ${c.result === "ok" ? "up" : c.result === "fail" ? "problem" : "warning"}">${esc(RESULT_LABELS[c.result] ?? c.result)}</span> ${esc(CHECK_LABELS[c.name] ?? c.name)} <span class="s">· ${number(c.count)} findings</span></summary>
    ${present({ name: c.name, checked_at: c.checked_at, ...(c.first_seen ? { first_seen: c.first_seen } : {}), ...(c.reason ? { reason: c.reason } : {}), feeds: c.feeds })}
    ${c.examples.length ? `<h3>Example findings</h3>${present(c.examples)}${c.count > c.examples.length ? `<p class="s">Showing ${c.examples.length} of ${number(c.count)} findings, as in the check response.</p>` : ""}` : c.result === "ok" ? "<p>No issues found.</p>" : ""}
    <p><strong>Next step:</strong> ${esc(c.fix)}</p></details>`).join("");
  const health = healthStatus(db, env);
  const unknown = [...links.keys()].filter((name) => ![...SERVICES, ...CLIENTS].some((e) => e.name === name));
  const problems = [...bad, ...unknown];
  return page(true, `
${problems.length ? `<p class="problem">HOLDINGS_LINKS has entries it can't use: ${esc(problems.join(", "))}.</p>` : ""}
<aside class="notice"><strong>${waiting ? `${number(waiting)} findings need a person` : "Nothing waiting on the worklist"}</strong><p>Review matching problems and citation conflicts, or dismiss findings you have checked.</p><a href="/worklist">Open worklist →</a></aside>
<section id="server-health"><h2>Server health</h2><p class="s">Current server response, library state, feed errors, and full deployment information.</p>${present({ ...health, checks: { ok_count: health.checks.ok, drift: health.checks.drift, fail: health.checks.fail, skipped: health.checks.skipped, failing: health.checks.failing } })}</section>
<section id="checks"><h2>Cross-service checks</h2><p class="s">${summary.ok} passed · ${summary.drift} drift · ${summary.fail} failed · ${summary.skipped} not checked. Drift means services differ; expand a check for details and next steps.</p>${checks || '<p>No checks have run yet. Results appear after a refresh.</p>'}</section>
<section id="readers"><h2>Zotero readers</h2><p class="s">Clients that have read the Zotero mirror, including their library, last read time, and requested library version.</p>${status.zotero_readers.length ? present(status.zotero_readers) : "<p>No clients have read the Zotero mirror yet.</p>"}</section>
<section><h2>Data freshness</h2><p class="s">These are the saved feeds used to build this library. A feed is stale after 30 minutes without a successful response.</p>${feeds ? `<div class="table-wrap"><table><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Entries</th><th scope="col">Last success</th></tr></thead><tbody>${feeds}</tbody></table></div><details><summary>All feed details</summary>${present(status.feeds)}</details>` : "<p>No feeds have been read yet.</p>"}</section>
<section id="services"><h2>Core services</h2><p class="s">Live availability when this page opened. Feed freshness is shown separately above.</p><div class="table-wrap"><table><thead><tr><th scope="col">Status</th><th scope="col">Service</th><th scope="col">Open</th></tr></thead><tbody>${services.map((e, i) => card(e, serviceStates[i])).join("")}</tbody></table></div></section>
<section><h2>Clients</h2><div class="table-wrap"><table><thead><tr><th scope="col">Status</th><th scope="col">Client</th><th scope="col">Open</th></tr></thead><tbody>${clients.map((e, i) => card(e, clientStates[i])).join("")}</tbody></table></div></section>`);
}

function page(admin: boolean, content: string, showAdmin = true): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Holdings · ${admin ? "Admin" : "Library"}</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{color-scheme:light dark;--bg:#f4f6f8;--panel:#fff;--text:#202b38;--line:#dce2e8;--mut:#526273;--link:#155b91;--up:#21633e;--warn:#805500;--bad:#ad2525}
*{box-sizing:border-box}body{font:15px/1.6 system-ui,sans-serif;color:var(--text);background:var(--bg);max-width:76rem;margin:auto;padding:32px 24px}a{color:var(--link);text-underline-offset:3px}h1{font-size:2.3rem;letter-spacing:-.04em;margin:0}h2{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0 16px}header{margin-bottom:24px}nav{display:flex;flex-wrap:wrap;gap:20px}section,.notice{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;margin:20px 0;scroll-margin-top:20px;overflow-wrap:anywhere}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:10px}.stat strong{display:block;font-size:1.8rem;line-height:1.3}.s{color:var(--mut);font-size:.88rem}.up,.answering{color:var(--up)}.warning{color:var(--warn)}.problem,.down{color:var(--bad)}.badge{display:inline-block;font-size:.8rem;font-weight:600;border:1px solid var(--line);border-radius:5px;padding:2px 7px;margin:2px 0}.notice{border-left:4px solid var(--link)}.notice p{margin:4px 0}.search{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.search label{flex:1 1 180px;font-size:.88rem;font-weight:600}input,select,button{font:inherit;border:1px solid var(--line);border-radius:6px;padding:9px 10px}input,select{display:block;width:100%;margin-top:5px;color:var(--text);background:var(--panel)}button{background:var(--link);color:white;cursor:pointer}nav a[aria-current="page"]{font-weight:700;text-decoration-thickness:3px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:3px}.note-text{white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid var(--line);padding:8px 12px;margin:8px 0}.work-location{margin-top:8px;font-size:.88rem}.work-location summary{width:32px;min-height:32px;line-height:32px;list-style-position:inside;text-align:center}.work-location p{margin:10px 0}.location-link{display:inline-flex;text-decoration:none}.work-heading{display:flex;align-items:baseline;gap:10px}.locations{display:inline-flex;gap:5px;flex-shrink:0}.location-icon{display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--line);border-radius:5px;background:var(--panel)}.location-icon svg{width:18px;height:18px}.calibre{color:var(--link)}.zotero{color:#a53043}.location-legend{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px}.location-legend>span:not(:last-child){white-space:nowrap}.works{list-style:none;padding:0}.works li{padding:16px 0;border-bottom:1px solid var(--line)}code{font-size:.85rem;overflow-wrap:anywhere}.pagination{justify-content:space-between}.check{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer}.fields{margin:12px 0}.fields>div{display:grid;grid-template-columns:minmax(140px,1fr) minmax(0,3fr);gap:16px;padding:8px 0;border-bottom:1px solid var(--line)}dt{font-weight:600}dd{margin:0;min-width:0}dd ul{margin:0;padding-left:20px}h3{font-size:1rem}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{vertical-align:top;padding:12px 14px 12px 0;border-bottom:1px solid var(--line)}th{font-weight:600}.state{white-space:nowrap}.empty{padding:20px 0}.skip{position:absolute;top:-100px}.skip:focus{top:8px;background:var(--panel);padding:8px}
@media(prefers-color-scheme:dark){:root{--bg:#151c24;--panel:#1d2732;--text:#e1e8ef;--line:#394858;--mut:#adbbc9;--link:#8dc8fa;--up:#8ed4a6;--warn:#e3c277;--bad:#ffa5a5}button{color:#151c24}.zotero{color:#ffa4b3}}
@media(max-width:650px){body{padding:20px 12px}section{padding:16px}.stats{grid-template-columns:repeat(2,1fr)}.state{white-space:normal}th,td{padding-right:10px}.search button{width:100%}}
</style></head><body><a class="skip" href="#main">Skip to content</a>
<header><h1>Holdings${admin ? " admin" : ""}</h1><p>${admin ? "Library maintenance, data freshness, and authoring services." : "Your library across Zotero, Calibre, and the quote store."}</p>
<nav aria-label="Main navigation"><a href="/"${admin ? "" : ' aria-current="page"'}>Library</a>${showAdmin ? `<a href="/admin"${admin ? ' aria-current="page"' : ""}>Admin</a>` : ""}${admin ? '<a href="/worklist">Worklist</a><a href="#checks">Checks</a><a href="#services">Services</a><a href="#server-health">Server health</a><a href="#readers">Zotero readers</a>' : '<a href="#library">Find a work</a>'}</nav></header>
<main id="main">${content}</main></body></html>`;
}
