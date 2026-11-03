# holdings-mcp, and quotes moving to quote-mcp

**Status: proposed 2026-11-02. Nothing here is built. The plan of record is
holdings-mcp's [PLAN.md](https://github.com/jmajerus/holdings-mcp/blob/main/PLAN.md).**

A review of corpus-mcp, quote-mcp, and terminology-mcp found that an agent
using the Authoring MCP portal still has to know which repository holds a
book or a quote. Two changes fix that:

- **holdings-mcp**, a new service, gives one lookup over every work
  (`find_work`, `get_work`), keyed by Zotero item key and citekey, saying
  which holdings each has: text in Calibre, quotes, notes.
- **Quotes move to quote-mcp**, as quote-mcp's PLAN.md already decided
  ("Corpus quotes", phase 6) and this repo's PLAN.md records as superseding
  its own quote design. corpus-mcp keeps the anchors and the check against
  Calibre text.

The rule behind both: records have one home; capabilities stay with the
material. A quote is the same record from an ebook or a paper book.
Searching, reading, and verifying text needs the file, so it stays here.

## What stays, what goes

| Stays in corpus-mcp | Moves or retires |
|---|---|
| `search_corpus`, `read_book`, `render_page`, `get_book_outline`, `list_books`, `list_tags`, `list_shelves` | `save_quote` → quote-mcp's `add_quote`, which asks corpus-mcp to verify |
| `cite_passage`, `pin_citekey`, the Zotero matching and its admin page | `search_quotes`, `get_quote`, `update_quote`, `delete_quote`, `cite_quote` → quote-mcp's |
| Quote anchors, re-anchoring after scans, the reader's highlights | Quote text, note, and tags → quote-mcp |
| `propose_tags`, `tagging_worklist`, `vocabulary_report`, `get_tag_vocabulary` | `add_provisional_term` and the overlay → terminology-mcp (phase 5) |
| | The Zotero mirror → holdings-mcp (phase 4); matching stays here |

## 1. Books feed for holdings-mcp (holdings phase 1)

`GET /api/holdings/books`, on the LAN, with an ETag; a snapshot of every
indexed book:

```json
{
  "version": 1,
  "books": [{
    "calibre_uuid": "f2b79da7-…", "book_id": "main:223", "library": "main",
    "title": "Learning Systems Thinking", "authors": ["Diana Montalion"], "year": 2024,
    "formats": ["pdf"], "has_text": true,
    "citekey": "montalion2024learning", "citekey_source": "pinned",
    "zotero": { "library": "users/123", "key": "ABCD1234" }
  }]
}
```

- `has_text` is false for a book with no text layer.
- `citekey` is a real key only (pinned, Calibre's, or the matched item's),
  never a proposed one, as in the public key list.
- `zotero` is the matched item, or null. Candidates a person hasn't
  confirmed aren't sent.
- Books with an excluded tag (`private`) aren't sent, as they aren't
  indexed.

## 2. Verify and anchors for quote-mcp (holdings phase 3)

quote-mcp's PLAN.md asks for "a small read-only verify endpoint". It is
`save_quote`'s check without the save:

`POST /api/verify` with `{ "book": "<book id, citekey, or Calibre UUID>",
"text": "…", "page": 155 }` (page optional) returns either

- `{ "match": true, "text": "<the book's exact wording>", "anchor": { … },
  "locator": "p. 211", "page_label": "211", "section": "…" }`, where the
  anchor is today's columns: `calibre_uuid`, `start_page`, `start_offset`,
  `end_page`, `end_offset`, `prefix`, `suffix`, `sha256`; or
- `{ "match": false, "closest": [ … ] }`, the closest passages, as
  `save_quote` returns now.

Then the anchors become corpus-mcp's only quote data:

- **`anchors`** table: today's anchor columns plus `quote_id` (quote-mcp's
  id) and `status` (`verified`, `orphaned`). `POST /api/anchors` stores one
  for a quote-mcp id after a successful verify.
- **Anchor changes** feed, `GET /api/anchors/changes?since=N`, numbered
  like terminology-mcp's changelog: re-anchored, orphaned, found again.
  quote-mcp reads it to keep each quote's status and flags current.
- The reader keeps highlighting quotes from the anchors; to show a quote's
  note or tags there, it reads them from quote-mcp.

## 3. Moving the quotes (holdings phase 3)

In this order:

1. **The skill.** Once quote-mcp has `add_quote`, `skills/cited-article`
   calls it instead of `save_quote`, and quote-mcp's `cite_quote` instead of
   this one. This is the step that matters soonest: it stops new quotes
   landing here.
2. **The five quotes.** quote-mcp imports them (origin `corpus`, status
   `verified`), keeping their tags as written (`project:on-curiosity` and
   `test:standalone-article` included); their anchors stay here under the
   new ids. Quote 2 is a test and may simply be dropped.
3. **The tools.** The five quote tools and `save_quote` retire. For one
   release they can answer with a pointer to quote-mcp's tools rather than
   disappear.
4. **The admin pages.** Saving a quote from the reader posts to quote-mcp
   after the verify.

## 4. Later

- **Zotero items from holdings-mcp** (holdings phase 4). Matching reads
  items from holdings-mcp instead of syncing zotero.org itself. Matching,
  its evidence, and its admin page stay here.
- **Following terminology-mcp** (holdings phase 5). This repo's PLAN.md
  stage 3: follow the subject scheme's changelog, as quote-mcp follows
  `human-work`; the overlay's terms are proposed there, and
  `add_provisional_term` becomes a call to terminology-mcp's `propose_term`.
- **Tool descriptions.** Arguments that take a book say they also take a
  work key or citekey from holdings-mcp's `find_work`.
