import type http from "node:http";
import { checkSummary } from "./checks.js";
import { type DB, now } from "./db.js";

/**
 * What the cross-service checks found that needs a person, at /worklist on the LAN. It's a view of the check
 * results, not a queue of its own: fix something at its source and it leaves at the next refresh. Only a
 * dismissal is stored here, for a finding someone has judged acceptable, with their reason. A dismissal lapses
 * when the finding's wording changes or the finding goes away (src/checks.ts).
 */

const LABELS: Record<string, string> = {
  "items-exist": "A feed names a Zotero item that isn't there",
  "one-quote-work-per-item": "Two quote-mcp works name one item",
  "one-work-per-exact-key": "One key names two works",
  "filed-but-unmatched": "Filed in Zotero, not matched in corpus-mcp",
  "likely-missed-matches": "Unfiled book shares an ISBN with a Zotero item",
};

/** Services and sources: shown as a banner, since no row of data would fix them. */
const SERVICE_CHECKS = new Set(["zotero-readers-in-step"]);
const REASON_MAX = 500;

export interface WorklistItem {
  check: string;
  label: string;
  ref: string;
  detail: string;
  severity: string;
  first_seen: string;
  dismissed?: { reason: string; at: string };
}

interface Row { check_name: string; ref: string; detail: string; severity: string; first_seen: string; reason: string | null; dismissed_at: string | null }

/** A citekey on one work in each library is the same work twice, which is expected; two works in one library clash. */
function acrossLibraries(detail: string): boolean {
  const libraries = detail.match(/(?:users|groups)\/\d+/g) ?? [];
  return libraries.length > 1 && new Set(libraries).size === libraries.length;
}

/** Whether a finding should wait for a person: anything failing, plus the kinds that only a person ever resolves. */
function needsPerson(check: string, ref: string, detail: string, severity: string): boolean {
  if (SERVICE_CHECKS.has(check)) return false;
  if (severity === "fail") return true;
  if (check === "likely-missed-matches") return true;
  return ref.startsWith("citekey:") && !acrossLibraries(detail);
}

export function worklist(db: DB): { open: WorklistItem[]; dismissed: WorklistItem[]; banners: string[] } {
  const rows = db.prepare(`SELECT f.check_name, f.ref, f.detail, f.severity, f.first_seen, d.reason, d.at AS dismissed_at
    FROM check_findings f LEFT JOIN check_dismissals d ON d.check_name = f.check_name AND d.ref = f.ref AND d.detail = f.detail
    ORDER BY f.first_seen, f.check_name, f.ref`).all() as Row[];
  const open: WorklistItem[] = [];
  const dismissed: WorklistItem[] = [];
  for (const r of rows) {
    if (!needsPerson(r.check_name, r.ref, r.detail, r.severity)) continue;
    const item: WorklistItem = { check: r.check_name, label: LABELS[r.check_name] ?? r.check_name, ref: r.ref, detail: r.detail, severity: r.severity, first_seen: r.first_seen };
    if (r.dismissed_at) dismissed.push({ ...item, dismissed: { reason: r.reason ?? "", at: r.dismissed_at } });
    else open.push(item);
  }
  const skipped = db.prepare("SELECT name, reason FROM checks WHERE result = 'skipped' ORDER BY name").all() as { name: string; reason: string | null }[];
  const services = rows.filter((r) => SERVICE_CHECKS.has(r.check_name) && r.severity === "fail");
  return { open, dismissed, banners: [...services.map((r) => r.detail), ...skipped.map((s) => `${LABELS[s.name] ?? s.name}: not checked, because ${s.reason ?? "its sources aren't available"}.`)] };
}

export function worklistCount(db: DB): number {
  return worklist(db).open.length;
}

/** Dismisses a finding on the list as it reads now, so different wording later brings it back. Anything else is refused. */
export function dismiss(db: DB, check: string, ref: string, reason: string): boolean {
  const finding = db.prepare("SELECT detail, severity FROM check_findings WHERE check_name = ? AND ref = ?").get(check, ref) as { detail: string; severity: string } | undefined;
  if (!finding || !needsPerson(check, ref, finding.detail, finding.severity)) return false;
  db.prepare(`INSERT INTO check_dismissals (check_name, ref, detail, reason, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (check_name, ref) DO UPDATE SET detail = excluded.detail, reason = excluded.reason, at = excluded.at`).run(check, ref, finding.detail, reason, now());
  return true;
}

export function restore(db: DB, check: string, ref: string): void {
  db.prepare("DELETE FROM check_dismissals WHERE check_name = ? AND ref = ?").run(check, ref);
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sourceOrigin(db: DB, feed: string): string | null {
  const row = db.prepare("SELECT url FROM feeds WHERE name = ?").get(feed) as { url: string | null } | undefined;
  try {
    return row?.url ? new URL(row.url).origin : null;
  } catch {
    return null;
  }
}

/** Where the fix happens: the Zotero items a finding names, and the service's own page for what it owns. */
function links(db: DB, item: WorklistItem): string {
  const out: string[] = [];
  for (const [, library, id, key] of item.detail.matchAll(/\b(users\/\d+|groups\/(\d+))\/([A-Z0-9]{8})\b/g)) {
    const target = library.startsWith("groups/") ? `zotero://select/groups/${id}/items/${key}` : `zotero://select/library/items/${key}`;
    out.push(`<a href="${target}">${esc(key)}</a>`);
  }
  const corpus = sourceOrigin(db, "books");
  const quotes = sourceOrigin(db, "counts");
  if (corpus && (item.check === "filed-but-unmatched" || item.check === "likely-missed-matches" || item.ref.startsWith("book:"))) out.push(`<a href="${esc(corpus)}/admin/zotero">corpus-mcp</a>`);
  if (quotes && (item.check === "one-quote-work-per-item" || item.ref.startsWith("quote:") || item.ref.startsWith("quotes:"))) out.push(`<a href="${esc(quotes)}/admin">quote-mcp</a>`);
  return [...new Set(out)].join(" · ");
}

const hidden = (item: WorklistItem) => `<input type="hidden" name="check" value="${esc(item.check)}"><input type="hidden" name="ref" value="${esc(item.ref)}">`;

function page(db: DB): string {
  const { open, dismissed, banners } = worklist(db);
  const summary = checkSummary(db);
  const row = (item: WorklistItem, i: number) => `<tr><td><span class="${item.severity === "fail" ? "fail" : "drift"}">${item.severity}</span></td>
<td><strong>${esc(item.label)}</strong><div>${esc(item.detail)}</div><div class="s">${esc(item.ref)} · first seen ${esc(item.first_seen.slice(0, 10))}${links(db, item) ? ` · ${links(db, item)}` : ""}</div></td>
<td><form method="post" action="/worklist/dismiss">${hidden(item)}<label class="s" for="reason-${i}">Why is this fine?</label><input id="reason-${i}" name="reason" required maxlength="${REASON_MAX}"><button>Dismiss</button></form></td></tr>`;
  const done = (item: WorklistItem) => `<tr><td><strong>${esc(item.label)}</strong><div>${esc(item.detail)}</div><div class="s">${esc(item.dismissed!.reason)} · ${esc(item.dismissed!.at.slice(0, 10))}</div></td>
<td><form method="post" action="/worklist/restore">${hidden(item)}<button>Bring back</button></form></td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Holdings worklist</title>
<style>:root{color-scheme:light dark;--line:#8884;--mut:#777;--fail:#b3261e;--drift:#9a6700}body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px}table{border-collapse:collapse;width:100%}td{vertical-align:top;padding:10px 12px 10px 0;border-bottom:1px solid var(--line)}.s{color:var(--mut);font-size:.87rem}
.fail{color:var(--fail);font-weight:600}.drift{color:var(--drift);font-weight:600}.banner{border-left:3px solid var(--fail);padding:6px 12px;margin:8px 0}input:not([type=hidden]){display:block;width:13rem;max-width:100%;margin:2px 0 6px}section{margin-top:24px;overflow-x:auto}</style></head><body>
<h1>Holdings worklist</h1><p class="s">${open.length} waiting · checks: ${summary.ok} ok, ${summary.drift} drift, ${summary.fail} fail, ${summary.skipped} skipped. Fix an item at its source and it leaves at the next refresh.</p>
${banners.map((b) => `<div class="banner">${esc(b)}</div>`).join("")}
<section>${open.length ? `<table>${open.map(row).join("")}</table>` : "<p>Nothing needs you right now.</p>"}</section>
${dismissed.length ? `<section><details><summary>${dismissed.length} dismissed</summary><table>${dismissed.map(done).join("")}</table></details></section>` : ""}
</body></html>`;
}

async function form(req: http.IncomingMessage): Promise<URLSearchParams | null> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Answers /worklist and its two forms; the caller has checked the request came over the LAN. */
export async function sendWorklist(db: DB, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const text = (status: number, message: string, headers: Record<string, string> = {}) =>
    void res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers }).end(message);
  if (url.pathname === "/worklist") {
    if (req.method !== "GET") return text(405, "GET the worklist.", { allow: "GET" });
    return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(db));
  }
  if (req.method !== "POST") return text(405, "POST to change the worklist.", { allow: "POST" });
  // A page elsewhere can post a form to a LAN address, so a browser's Origin has to be this host.
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return text(403, "This form only works from the worklist page.");
  const body = await form(req);
  const check = body?.get("check")?.trim();
  const ref = body?.get("ref")?.trim();
  if (!check || !ref) return text(400, "A check and a finding are required.");
  if (url.pathname === "/worklist/restore") restore(db, check, ref);
  else {
    const reason = body?.get("reason")?.trim();
    if (!reason) return text(400, "Say why this finding is fine.");
    if (reason.length > REASON_MAX) return text(400, `Keep the reason to ${REASON_MAX} characters.`);
    if (!dismiss(db, check, ref, reason)) return text(404, "That finding has gone, or isn't one that can be dismissed.");
  }
  res.writeHead(303, { location: "/worklist", "cache-control": "no-store" }).end();
}
