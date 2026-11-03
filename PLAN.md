# holdings-mcp: plan

holdings-mcp answers one question for an agent: **what do I have, and in what
form?** It returns one row per work, whatever the medium, keyed the same way
every other authoring service keys it, and says what can be done with each
work next: read its text, find its quotes and notes, cite it.

In library terms, a bibliographic record describes a work, and holdings
describe the copies a library has of it. Here the copies are a book in
Calibre with its text, a book on the shelf, an item filed in Zotero, and the
quotes and margin notes taken from any of them.

It came out of a review of corpus-mcp, quote-mcp, and terminology-mcp on
2026-11-02, which also settles where quotes live. The review is summarised
below, because it decides which service owns what.

## The review (2026-11-02)

The three services are served together through the Cloudflare MCP portal, so
an agent sees them as one connector. Their tools still made it pick a
repository:

| Overlap | corpus-mcp | quote-mcp | terminology-mcp |
|---|---|---|---|
| Quote records | `save_quote`, `search_quotes`, `get_quote`, `update_quote`, `delete_quote`, `cite_quote` | `search_quotes`, `get_quote`, `cite_quote` (read-only) | |
| Finding a book | `list_books` (Calibre) | `work` argument of `search_quotes` (Zotero) | |
| Zotero mirror | whole library, the fields matching needs (`data.db`) | whole library, each item's full data (`zotero_items`) | |
| Concept sets | | `list_sets` (`vocab/sets.json`) | `list_sets`, `get_set`, `expand_set` |
| Coining terms | `add_provisional_term` (its taxonomy overlay) | | `propose_term` |

- **Quotes.** quote-mcp's PLAN.md already decided that it owns every quote
  and corpus-mcp keeps only the anchor ("Corpus quotes", phase 6), and
  corpus-mcp's PLAN.md marks its own quote design superseded. At the review,
  corpus-mcp held 5 quotes (one a test) and quote-mcp about 830.
  corpus-mcp's `cited-article` skill still writes through `save_quote`, so
  the gap that the migration has to close grows with every article.
- **Books.** A book has two identities: a Calibre id (`main:42`) in
  corpus-mcp and a Zotero item key in quote-mcp. corpus-mcp links them, and
  is the only service that does.
- **Vocabulary.** corpus-mcp's overlay and terminology-mcp's provisional
  terms do the same job in two places; quote-mcp's sets for `human-work`
  live outside terminology-mcp, which holds the scheme.

## Principles

1. **Consolidate records; keep capabilities with the material.** A quote is
   the same record whether it came from an ebook or a paper book, so quotes
   have one home. Searching, reading, and verifying text is something only a
   file allows, so it stays where the files are. Buying the ebook of a book
   you quoted on paper moves nothing: corpus-mcp starts being able to verify
   the quotes quote-mcp already has.
2. **One key for a work, everywhere.** The Zotero item key, with its
   citekey, names a work in every tool on every server. A Calibre book not
   yet filed in Zotero has an interim key (see Keys).
3. **The client never needs to know which server answered.** An agent finds
   a work once with `find_work`, then passes its key to `search_corpus`,
   `read_book`, `search_quotes`, or `cite_quote`. Nothing in a tool's name
   or arguments should require knowing where it runs.
4. **Copies follow feeds; answers come from the source.** holdings-mcp
   keeps a local copy of what it joins, refreshed from feeds, so
   `find_work` is one local query. Anything authoritative (a quote's text, a
   passage, a citation) is read from the service that owns it.

## Who owns what

| Service | Owns | Does not own |
|---|---|---|
| **holdings-mcp** | The Zotero mirror; the list of works and their keys; which holdings each work has; the lookup | Any quote, passage, or term; writes to Zotero or Calibre |
| **corpus-mcp** | Calibre book text and its index; reading, rendering, verifying passages; quote anchors; matching Calibre books to Zotero items | Quote records (after the migration) |
| **quote-mcp** | Quotes and margin notes, from any medium: text, locator, comment, tags, history | Book text; concept definitions |
| **terminology-mcp** | Schemes, terms, relations, and concept sets, including `human-work`'s sets | Anything tagged with them |
| **Zotero** | Bibliographic records and citekeys (Better BibTeX) | |
| **zotero-mcp** (portal) | Managing the Zotero library: filing, attachments, annotations | Finding works across the services: that's `find_work` |

## Decisions

| | |
|---|---|
| Name | `holdings-mcp`. "Catalogue" is taken by Concept Clusters (curated puzzle lists) and by both public sites' `catalogue` level; "library" by Calibre and Zotero; "shelf" by Calibre-Web. |
| Scope | Works in the Zotero libraries it mirrors, plus Calibre books not yet filed there. Not only books: a filed article is a work too. |
| Keys | A work's key is `zotero:<library>/<item key>` (stable), and the citekey is accepted wherever a key is. See Keys. |
| Writes | None to Zotero, Calibre, corpus-mcp, or quote-mcp. Its MCP tools are read-only. |
| Storage | SQLite (`holdings.db`) on its own LXC: a nightly online backup kept 14 days and Proxmox backups, as corpus-mcp and quote-mcp do. Not Postgres: the data is small, and a shared database would couple the services more tightly than feeds. |
| Runtime | A systemd service on its own LXC (`holdings-mcp.localdomain`, port 8000), with its own Cloudflare Access application, added to the Authoring MCP portal. |
| Language | TypeScript on Node 22, `better-sqlite3`. The Zotero client and sync start as copies of quote-mcp's `src/zotero.ts` and `src/sync.ts` (see open questions on a shared package). |
| Public site | None for now. |

## Keys

A work can be found by any key it has, and every response gives all of them:

| Key | Example | Notes |
|---|---|---|
| Work key | `zotero:users/123/ABCD1234` | Primary, from the Zotero item. |
| Citekey | `franklin1999real` | Better BibTeX's `citationKey`, or a key pinned in corpus-mcp. |
| Calibre book id | `main:42` | corpus-mcp's id, for a book that has text. |
| Calibre UUID | `calibre:f2b7…` | The interim work key for a Calibre book with no Zotero item. |
| quote-mcp work id | `quote:417` | The interim work key for a work quote-mcp has quotes from but can't match to one Zotero item (`unmatched` or `ambiguous`): about 200 at the review, most of them paper books from the old site. |
| ISBN | `9780887846236` | Looked up, never a work's key. |

When an unfiled work is filed in Zotero and matched, its work key changes
from `calibre:…` or `quote:…` to `zotero:…`. The old key goes to
`former_keys` and keeps resolving, as terminology-mcp keeps former slugs.
A Calibre book and a quote-mcp work that are both unfiled aren't joined on
title guesses; filing the book in Zotero joins them.

## Data

- **`zotero_items`**: the mirror, one row per item with its full data, kept
  current by library version (quote-mcp's pattern: changes since the last
  version, deletions flagged, the version saved with the changes).
- **`works`**: one row per work: key, item type, title, creators, year,
  citekey, and `former_keys`. Built from top-level Zotero items, plus
  Calibre books with no match and quote-mcp works with no single match.
- **`holdings`**: what a work has, one row per form:
  - `text`: a Calibre book with a text layer (book id, library, formats);
  - `file`: a Calibre book without text, or a Zotero attachment;
  - `quotes`: counts of quotes and notes, and how many are verified.
- **`feeds`**: for each feed, when it last answered, its ETag, and any error.

Print copies aren't recorded yet: nothing in the sources says reliably that a
book is on the shelf (see open questions).

## Feeds

Each is a snapshot with an ETag, polled every few minutes: a few hundred
books and works a few hundred bytes each, so a numbered changelog isn't
worth it yet. Snapshots can become changelogs later without changing the
tools.

| Feed | From | What |
|---|---|---|
| Zotero | zotero.org | The libraries' items, incrementally by library version. |
| Books | corpus-mcp, `GET /api/holdings/books` | Each indexed book: Calibre UUID and book id, title, authors, year, formats, whether it has text, its pinned or Calibre citekey, and the Zotero item it's matched to. |
| Quote counts | quote-mcp, `GET /api/holdings/counts` | Per work: its Zotero item (or, when there's no single match, its quote-mcp id, title, authors, year, and candidate items), and counts of quotes, notes, and verified quotes. |

corpus-mcp keeps matching Calibre books to Zotero items: it has the evidence
(the UUID in Extra, ISBNs read from the text) and the admin page where a
person confirms candidates. holdings-mcp takes the matches as given.

## MCP tools

All read-only.

| Name | Title | What it does |
|---|---|---|
| `find_work` | Find a work | Works by words in the title or creators, by author, by any key, or by what they have (`text`, `quotes`, `notes`). Each result gives the work's keys, its bibliographic fields, and its holdings, with the tools to call next. |
| `get_work` | Get a work | One work by any key: every key it has, every holding, and what stands in the way of citing it (not filed in Zotero, no citekey, an ambiguous edition). |
| `holdings_status` | Holdings status | Each feed's freshness and errors, counts, and Calibre books still unmatched. |

A result's holdings say what to do next, for example:

```json
{
  "key": "zotero:users/123/ABCD1234",
  "citekey": "montalion2024learning",
  "title": "Learning Systems Thinking",
  "creators": ["Diana Montalion"],
  "year": 2024,
  "holdings": {
    "text": { "book_id": "main:223", "formats": ["pdf"], "tools": ["search_corpus", "read_book"] },
    "quotes": { "quotes": 1, "notes": 0, "verified": 1, "tools": ["search_quotes"] }
  }
}
```

A paper book with quotes has no `text` holding, so an agent knows not to try
`search_corpus` rather than learning it from an empty result.

The other services' tool descriptions say that their book or work argument
takes a key from `find_work`.

## Phases

0. **Repository and Zotero.** The store, the Zotero mirror, `works` from
   Zotero alone, `find_work`, `get_work`, `holdings_status`, the nightly
   backup. Deployed to its LXC, behind Access, in the portal.
1. **Books from corpus-mcp.** corpus-mcp's books feed; `text` and `file`
   holdings; unfiled Calibre books as works with `calibre:` keys.
2. **Quote counts from quote-mcp.** quote-mcp's counts feed; `quotes`
   holdings.
3. **One quote store** (in corpus-mcp and quote-mcp; can run alongside 0–2).
   corpus-mcp's verify endpoint; quote-mcp's `add_quote`; the
   `cited-article` skill writes to quote-mcp; corpus-mcp's quotes move,
   leaving their anchors; corpus-mcp's quote tools retire. The step that
   matters soonest is the skill, which stops new quotes landing in
   corpus-mcp.
4. **One Zotero mirror.** corpus-mcp and quote-mcp read Zotero items from
   holdings-mcp instead of mirroring the library themselves. quote-mcp keeps
   reading the notes it imports quotes from until that's settled (see open
   questions).
5. **Vocabulary** (in corpus-mcp, quote-mcp, terminology-mcp). corpus-mcp
   follows terminology-mcp's changelog and its overlay retires, with
   `add_provisional_term` becoming a call to `propose_term`; `human-work`'s
   sets move into terminology-mcp, and quote-mcp follows `set-*` changes.

The dev-briefs `holdings-and-quotes.md` in corpus-mcp and quote-mcp
(`docs/dev-briefs/`) give each repository its share of phases 1–5.

## Status (2026-11-03)

- **Deployed:** phases 0–2. holdings-mcp runs
  on `holdings-mcp.localdomain` behind Access and is in the Authoring MCP portal. At deploy it held
  2,113 works:
  - 1,349 Zotero items;
  - 558 Calibre books not in Zotero;
  - 182 unmatched and 24 ambiguous quoted works.
  The mirror holds every Zotero item, notes included, as quote-mcp's does.
- **Phase 1:** corpus-mcp's books feed (corpus-mcp #10) sends indexed books only. As built, it differs from
  the brief:
  - `zotero.matched_by` is `confirmed`, `calibre_uuid`, or `isbn`, and all three count as matches;
  - `formats` lists only the format the index read;
  - `calibre_uuid` can be null, in which case the book id is the interim key.
  At deploy only 8 of 566 books were matched to a Zotero item. The rest show as `calibre:` works, apart
  from their Zotero items and quotes, until corpus-mcp's matching confirms them.
- **Phase 2:** quote-mcp's counts feed (quote-mcp #5) gives every entry `work_id` and `match`. A filed
  work's quotes move to the work of its Zotero item, and `former_work_ids` names the ids it absorbed; their
  `quote:` keys resolve to it. Filings made before that deploy weren't recorded.
- **Phase 3:** deployed. corpus-mcp `eb74690` serves `POST /api/verify`, `POST`/`DELETE /api/anchors`,
  and `GET /api/anchors/changes` (with a `log` id). quote-mcp `2fdf7ba` has `add_quote`, plus #8:
  `cite_quote` returns prose, book and position, and `take-corpus-quotes` brings corpus-mcp's quotes over.
  Filing data still comes from corpus-mcp's `cite_passage`, and `pin_citekey` stays in corpus-mcp.
  An unmatched work that `add_quote` makes for a Calibre book carries `calibre_uuid` in the counts feed,
  and holdings-mcp joins it to that book's work: the UUID is an exact link, not a guess from the title.
  §3.1 is corpus-mcp #13 (open): `cited-article` saves quotes with `add_quote` and cites them with
  `cite_quote`, and drafts mark them `<!-- quote <id> -->`. corpus-mcp's four real quotes are in
  quote-mcp, verified and anchored (old→new 1→831, 3→830, 4→829, 5→828; the test quote 2 skipped); all
  four books are in Zotero, so they joined their Zotero works. Next: corpus-mcp cleans up (§3.2) and
  retires its quote tools (§3.3); quote-mcp follows the anchor changes feed (§2.4).
- **Deploys** in all three repos roll back on any failure after the release switch, units included
  (holdings-mcp #1, quote-mcp #7, corpus-mcp #12). quote-mcp also puts back the store from before a
  migration that changed its schema.
- **Libraries:** both, `users/827407` and `groups/61098`, the libraries quote-mcp reads
  (`HOLDINGS_ZOTERO_LIBRARIES`).

## Open questions

- **Print copies.** How should holdings-mcp know a paper book is on the
  shelf? A Zotero tag such as `shelf`, a Zotero collection, or quote-mcp's
  works with no Calibre text? Until then, a paper book shows as a work with
  quotes and no `text`.
- **Libraries.** Which Zotero libraries to mirror: the personal library
  only, or the WorkCreatively group too? quote-mcp's PLAN.md asks the same
  about citing.
- **Unfiled works.** Keep `calibre:` and `quote:` keys for works never
  filed, or file every quoted book into Zotero's staging collection? Filing
  is a Zotero write, which quote-mcp's phase 4 also waits on. Until then,
  the roughly 200 quoted works outside Zotero have no citekey.
- **Notes in the mirror.** Should holdings-mcp mirror Zotero notes too, so
  quote-mcp can drop its own sync entirely, or should quote-mcp keep reading
  notes itself?
- **Shared code.** The Zotero client, the sync, the nightly backup, and the
  D1 drain are already copied between corpus-mcp and quote-mcp, and
  holdings-mcp would make a third copy. A shared package, on the model of
  `@jmajerus/citekey` (`packages/citekey` in corpus-mcp, which quote-mcp's
  PLAN.md names for the Zotero client), or copies kept in step?
- **Later, the public sites.** corpus-mcp's and quote-mcp's public sites
  link to each other by exchanging citekey lists. holdings-mcp could serve
  that join instead, if it ever has a public face.
