# Glass Office findings: follow-up status

This tracks the fixes for the findings in iasp-mcp's
`docs/dev-briefs/Interop test 2 The Glass Office (2026-11-13).md`, following
`docs/dev-briefs/Glass Office findings plan.md`. holdings-mcp coordinates the work, and iasp-mcp re-renders the
essays end to end once the upstream fixes have landed.

| # | Finding | Owner | Status |
|---|---|---|---|
| 1 | `ghost` and `md` exports don't run citeproc | iasp-mcp | **done**, deployed `e751794` |
| 2 | holdings misses the Zotero match for main:643 (*Human Compatible*) | holdings-mcp + corpus-mcp | **done**: corpus `isbn_candidates` is live (PR #35, deployed `dfa064b`). Since the 12:42 refresh, `likely-missed-matches` flags main:643 → `zotero:users/827407/9BBBFFGU`. It also flags *Overcoming Mobbing* against `users/827407/TK8Z7VDH` and `groups/61098/2DXRTEEZ`. Both await a person's confirmation |
| 3 | `cite_quote` on unfiled works: `pandoc: null`, misleading warning | quote-mcp + corpus-mcp | **done**, deployed (`5af3ec3`): 846 cites as `[@russell2019human, chap. 1]` with \"This work isn't filed in Zotero yet\" |
| 4 | EPUB quotes have no locator | quote-mcp | **done**, deployed: 846 and 847 give chap. 1. 844 and 845 still give chap. 7 until `quote-mcp locators --apply` is run on the server |
| 5 | `cite_passage` names the nonexistent tool `file_zotero_reference` | corpus-mcp | **done**: the legacy `zotero_filing` block is dropped (deployed `dfa064b`) |
| 6 | Docs give the note-variant count as 22; it is 23 | iasp-mcp | **done** (`e751794`): the count is derived from `NOTE_VARIANT_SPECS` |
| 7 | Ghost export keeps the H1; `>` inside `.epigraph` nests | iasp-mcp | **done** (`e751794`): the H1 is stripped by default (`keep_title_h1` keeps it); `epigraph-blockquote` warning added |
| 8 | Portal tool names changed mid-session | portal config / all | **portal synced** 2026-11-13: holdings now exposes `holdings_status` (was `holdings_holdings_status`); corpus now exposes `corpus_status` (deployed), and its six retired quote tools are gone |
| 9 | Calibre metadata gaps (no ISBNs; Harmel-Law has no publisher) | a person, in Calibre | not code; see below |
| 10 | ~~Quote 848's page~~ | — | **withdrawn**: p. 422 is correct. File page 452 has the printed label 422. The 392 came from passing the printed number to `cite_passage`, whose `page` is a file page. The essay source is restored |

## holdings-mcp (`5112489`, deployed 2026-11-13 with `c7edb37`)

`c7edb37` keeps authenticated MCP working at the portal's registered root URL (`/`), next to the library page.

- `likely-missed-matches` now also compares the ISBNs printed in a book's text (`isbn_candidates`, an optional
  books-feed field) with Zotero ISBNs, but only when the Calibre record's own ISBNs give no match. The finding
  reads: `"<title>" prints an ISBN of zotero:<lib>/<key> in its text (not in its Calibre record).` A person still
  confirms the match at corpus-mcp's `/admin/zotero`, or with `pin_citekey main:643 russell2019human`.
- iasp-mcp is listed among the core services on `/` and `/admin`.
- The MCP tool `holdings_status` is now `status`, so the portal shows `holdings_status`.

## Needs a person

- quote-mcp: on the server, run `quote-mcp locators --id 844,845` (a dry run), then `--apply`. 844 and 845 should become chap. 7.2.
- Confirm main:643 → `9BBBFFGU` (`russell2019human`), and pick or dismiss *Overcoming Mobbing*'s match (`/worklist` or corpus-mcp's `/admin/zotero`).
- Copy `glass-office.pdf`, `glass-office.epub` and `interoperability-essay.epub` from `/var/lib/iasp-mcp/renders/` on the iasp-mcp server into this directory.
- Calibre: add ISBNs to *Reality Lost* (main:49), *Human Compatible* (main:643) and *Facilitating Software
  Architecture* (main:184), and a publisher to the last.

## Bibliography

`glass-office.bib` holds all four citekeys. Foucault and Russell are exported from Zotero; Hendricks & Vestergaard
and Harmel-Law aren't filed yet, so they come from corpus-mcp's `cite_passage`. Harmel-Law's publisher
(O'Reilly Media) is taken from its printed ISBN. It resolves cleanly with `pandoc --citeproc`.

## Renders

Rendered on 2026-11-13 through the deployed iasp-mcp (`e751794`, pandoc 3.1.11.1) with `render_document`, straight
from source with no hand edits. *The Glass Office* used `glass-office.md` with `glass-office.bib` as `bibtex_content`.
*The Chamber and the System* used iasp-mcp's `demo/interoperability-essay.md` with its `references.bib`.

| Format | The Glass Office | The Chamber and the System |
|---|---|---|
| Ghost | `glass-office.ghost.md` | `interoperability-essay.ghost.md` |
| Markdown | `glass-office.rendered.md` | `interoperability-essay.rendered.md` |
| HTML | `glass-office.html` | `interoperability-essay.html` |
| PDF | still on the iasp-mcp server | `interoperability-essay.pdf` |
| EPUB | still on the iasp-mcp server | still on the iasp-mcp server |

Checks, all passed:
- `validate_markdown` reports no issues for either essay.
- None of the 10 renders gave a warning. epubcheck passed for both EPUBs, and both PDFs are linearized.
- Ghost and Markdown have no raw `[@…]` citations, and `## References` has 4 entries in each.
- There are no `> >` lines. Ghost has no H1, while the Markdown keeps its H1 as intended.
- The epigraph reads "quoted in Hendricks and Vestergaard (2018, chap. 7.2)", and Harmel-Law's citation reads
  "(Harmel-Law 2024, 422)".

`glass-office-ghost.md` and `interoperability-essay-ghost.md` are the earlier hand-fixed exports, kept for comparison.

## Follow-ups found during the run

- iasp-mcp: a relative `output_dir` for `render_document` resolves against the read-only release directory, not
  `IASP_RENDER_DIR`, so it fails with ENOENT on the server. Fix dispatched.
- ~~The portal's cached `render_document` schema doesn't list `keep_title_h1`.~~ It does now, after the portal sync.
- quote-mcp: renaming `quote_worklist` to `worklist`, so the portal shows `quote_worklist` (dispatched).
- quote-mcp `5af3ec3`: 844 and 845 had been backfilled as "chap. 7", because a zero-width space in the outline title
  "7.<U+200B>2" split the number. Fixed and deployed (`5af3ec3`); the backfill still has to be run.
