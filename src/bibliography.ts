import type { DB } from "./db.js";

/**
 * A bibliography for a list of citekeys, from the Zotero mirror (GET /api/bibliography, LAN only), so a renderer
 * can resolve the citations in a document without an author assembling a .bib by hand. Works filed in Zotero come
 * back as CSL JSON under the citekey asked for; a Calibre book that isn't filed is named, with its book id, for
 * corpus-mcp to describe; a citekey two works share is listed with its candidates rather than guessed at.
 */

type Zotero = Record<string, unknown> & { itemType: string; creators?: { creatorType: string; lastName?: string; firstName?: string; name?: string }[] };
export type Csl = Record<string, unknown> & { id: string; type: string };

/** Zotero item types as CSL types; anything else is a document. */
const TYPES: Record<string, string> = {
  book: "book", bookSection: "chapter", journalArticle: "article-journal", magazineArticle: "article-magazine",
  newspaperArticle: "article-newspaper", thesis: "thesis", report: "report", webpage: "webpage", blogPost: "post-weblog",
  conferencePaper: "paper-conference", encyclopediaArticle: "entry-encyclopedia", dictionaryEntry: "entry-dictionary",
  manuscript: "manuscript", letter: "personal_communication", email: "personal_communication", interview: "interview",
  film: "motion_picture", videoRecording: "motion_picture", audioRecording: "song", podcast: "song", presentation: "speech",
  statute: "legislation", bill: "bill", case: "legal_case", patent: "patent", map: "map", artwork: "graphic",
  computerProgram: "software", dataset: "dataset", preprint: "article", forumPost: "post", document: "document",
  radioBroadcast: "broadcast", tvBroadcast: "broadcast", hearing: "hearing", standard: "standard",
};

/** Zotero fields as CSL variables. Where several Zotero fields name one variable, the first with a value wins. */
const FIELDS: [zotero: string, csl: string][] = [
  ["title", "title"], ["caseName", "title"], ["nameOfAct", "title"], ["subject", "title"], ["shortTitle", "title-short"],
  ["publicationTitle", "container-title"], ["bookTitle", "container-title"], ["proceedingsTitle", "container-title"],
  ["encyclopediaTitle", "container-title"], ["dictionaryTitle", "container-title"], ["websiteTitle", "container-title"],
  ["blogTitle", "container-title"], ["forumTitle", "container-title"], ["programTitle", "container-title"],
  ["publisher", "publisher"], ["university", "publisher"], ["institution", "publisher"], ["studio", "publisher"], ["label", "publisher"],
  ["place", "publisher-place"], ["volume", "volume"], ["issue", "issue"], ["pages", "page"], ["numPages", "number-of-pages"],
  ["numberOfVolumes", "number-of-volumes"], ["edition", "edition"], ["series", "collection-title"], ["seriesNumber", "collection-number"],
  ["ISBN", "ISBN"], ["ISSN", "ISSN"], ["DOI", "DOI"], ["url", "URL"], ["language", "language"],
  ["thesisType", "genre"], ["reportType", "genre"], ["manuscriptType", "genre"], ["websiteType", "genre"],
  ["reportNumber", "number"], ["archive", "archive"], ["archiveLocation", "archive_location"], ["callNumber", "call-number"],
];

/** Zotero creator types as CSL roles; a type not here goes unlisted rather than passing as an author. */
const ROLES: Record<string, string> = {
  author: "author", editor: "editor", translator: "translator", seriesEditor: "collection-editor", bookAuthor: "container-author",
  contributor: "contributor", director: "director", interviewee: "author", interviewer: "interviewer", presenter: "author",
  artist: "author", performer: "author", podcaster: "author", programmer: "author", sponsor: "author", cartographer: "author",
  inventor: "author", composer: "composer", reviewedAuthor: "reviewed-author", recipient: "recipient",
};

/** A date as CSL date-parts when it starts or ends with one a machine can read, or a literal as Zotero holds it. */
export function cslDate(value: unknown): { "date-parts": number[][] } | { literal: string } | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T\s].*)?$/.exec(text);
  if (iso) return { "date-parts": [[iso[1], iso[2], iso[3]].filter((p) => p && Number(p)).map(Number)] };
  const year = /\b(\d{4})\b/.exec(text);
  return year ? { "date-parts": [[Number(year[1])]] } : { literal: text };
}

/** CSL variables set in Extra, one "name: value" to a line, as Zotero's own export reads them. */
function fromExtra(extra: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of String(extra ?? "").split("\n")) {
    const m = /^([A-Za-z][A-Za-z -]*?):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].trim().toLowerCase().replace(/\s+/g, "-");
    if (name === "original-date") out["original-date"] = cslDate(m[2]);
    else if (["original-publisher", "original-publisher-place", "original-title", "publisher", "publisher-place", "doi", "pmid", "pmcid"].includes(name)) {
      out[name.length <= 5 ? name.toUpperCase() : name] = m[2].trim();
    }
  }
  return out;
}

/** One Zotero item as a CSL JSON item under the given id. */
export function toCsl(data: Zotero, id: string): Csl {
  const csl: Csl = { id, type: TYPES[data.itemType] ?? "document" };
  // Extra first: a field the item fills in is the better source.
  Object.assign(csl, Object.fromEntries(Object.entries(fromExtra(data.extra)).filter(([, v]) => v !== undefined)));
  for (const [from, to] of FIELDS) {
    const value = data[from];
    if (typeof value === "string" && value.trim() && (csl[to] === undefined || to === "publisher" || to === "publisher-place")) {
      if (to === "title" && csl.title !== undefined) continue;
      if (to === "container-title" && csl["container-title"] !== undefined) continue;
      csl[to] = value.trim();
    }
  }
  for (const c of data.creators ?? []) {
    const role = ROLES[c.creatorType];
    if (!role) continue;
    const name = c.name ? { literal: c.name } : { ...(c.lastName ? { family: c.lastName } : {}), ...(c.firstName ? { given: c.firstName } : {}) };
    if (!Object.keys(name).length) continue;
    ((csl[role] ??= []) as unknown[]).push(name);
  }
  const issued = cslDate(data.date ?? data.dateEnacted ?? data.dateDecided ?? data.issueDate);
  if (issued) csl.issued = issued;
  const accessed = cslDate(data.accessDate);
  if (accessed && "date-parts" in accessed) csl.accessed = accessed;
  return csl;
}

export interface Bibliography {
  /** Works filed in Zotero, as CSL JSON; each id is the citekey asked for. */
  items: Csl[];
  /** Calibre books not filed in Zotero that carry the citekey, pinned or only proposed: corpus-mcp can describe them. */
  unfiled: { citekey: string; work: string; book_id: string | null; calibre_uuid: string | null }[];
  /** Citekeys more than one work answers to. */
  ambiguous: { citekey: string; candidates: string[] }[];
  /** Citekeys no work has, and works that can't be described (a quoted work matched to no item). */
  missing: string[];
}

/** At most this many citekeys to a request. */
export const MAX_CITEKEYS = 500;

export function bibliography(db: DB, citekeys: string[]): Bibliography {
  const out: Bibliography = { items: [], unfiled: [], ambiguous: [], missing: [] };
  const works = db.prepare("SELECT DISTINCT w.key, w.kind FROM works w JOIN work_keys k ON k.work_key = w.key WHERE k.key = ? AND k.kind = ? ORDER BY w.key");
  const item = db.prepare("SELECT data FROM zotero_items WHERE library = ? AND key = ? AND deleted = 0").pluck();
  const book = db.prepare("SELECT ref, detail FROM holdings WHERE work_key = ? AND form IN ('text', 'file') AND ref NOT LIKE 'zotero:%' ORDER BY form = 'text' DESC, ref");
  const seen = new Set<string>();
  for (const raw of citekeys) {
    const citekey = raw.trim().replace(/^@/, "");
    if (!citekey || seen.has(citekey.toLowerCase())) continue;
    seen.add(citekey.toLowerCase());
    // A work's own citekey first; a key corpus-mcp only proposes for an unfiled book when nothing has it.
    let found = works.all(citekey, "citekey") as { key: string; kind: string }[];
    if (!found.length) found = works.all(citekey, "proposed") as { key: string; kind: string }[];
    if (!found.length) { out.missing.push(citekey); continue; }
    if (found.length > 1) { out.ambiguous.push({ citekey, candidates: found.map((w) => w.key) }); continue; }
    const work = found[0];
    if (work.kind === "zotero") {
      const at = work.key.lastIndexOf("/");
      const data = item.get(work.key.slice("zotero:".length, at), work.key.slice(at + 1)) as string | undefined;
      if (!data) { out.missing.push(citekey); continue; }
      const parsed = JSON.parse(data) as Zotero;
      // The id is the key the document cites, as asked: a work can answer to a citekey its Zotero item doesn't carry
      // (a key pinned in corpus-mcp), and an entry under any other id wouldn't resolve the citation.
      out.items.push(toCsl(parsed, citekey));
    } else if (work.kind === "calibre") {
      const held = book.get(work.key) as { ref: string; detail: string } | undefined;
      const uuid = held ? (JSON.parse(held.detail) as { calibre_uuid?: string | null }).calibre_uuid ?? null : null;
      out.unfiled.push({ citekey, work: work.key, book_id: held?.ref ?? null, calibre_uuid: uuid ?? (work.key.startsWith("calibre:") ? work.key.slice(8) : null) });
    } else out.missing.push(citekey);
  }
  return out;
}
