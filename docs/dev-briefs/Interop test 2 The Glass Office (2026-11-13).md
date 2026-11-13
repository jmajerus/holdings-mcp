# Interop test 2: "The Glass Office" (2026-11-13)

<!-- Restored in holdings-mcp from the copy read on 2026-11-13. The original, untracked in iasp-mcp/docs/dev-briefs/,
     was removed during the follow-up. Line breaks inside the first list are joined; the text is otherwise unchanged. -->

A second six-server run, modelled on *The Chamber and the System* (blog.majerus.us/interoperability-2/), on a new topic: workplace surveillance and measurement.

## What was written to the services

- quote-mcp: quotes 844–848 were added and verified against Calibre text, tagged `project:glass-office`.

  - 844, 845: Hendricks & Vestergaard, *Reality Lost* (main:49), ch. 7.2
  - 846, 847: Russell, *Human Compatible* (main:643), ch. 1
  - 848: Harmel-Law, *Facilitating Software Architecture* (main:184), p. 422 (quoting Deming)

- Existing quote **411** (Foucault, p. 187, transcribed, grade A) was used as-is.

- No writes were made to Zotero, terminology, or Calibre.

## Findings

1. **IASP `ghost` and `md` exports don't run citeproc.** `bibtex_content` is ignored, `[@key, loc]` passes through as raw text, and `## References` is left empty, with no warning. The `html` build resolves the same citations correctly. The live interoperability-2 article shows the same symptom (raw keys followed by hand-made footnotes). Workaround used this time: author-date citations were pre-resolved in the source before the Ghost export.
2. **holdings-mcp missed a Zotero match.** Calibre main:643 (*Human Compatible*) is reported `not_in_zotero`. But Zotero item `9BBBFFGU` (`russell2019human`) has ISBN 9780525558620, which is one of the ISBNs printed in the EPUB (corpus `isbn_candidates`). `cite_passage` flags the likely match, but holdings doesn't use it. Fix: match on `isbn_candidates`, or `pin_citekey main:643 russell2019human`.
3. **quote-mcp `cite_quote` on unfiled works** returns `pandoc: null` and `csl.id: "work-741"`. Its warning says the citation "uses the old site's record", which is misleading for an agent-added quote. It could fall back to corpus `proposed_citekey`.
4. **EPUB quotes have no locator.** The section is written only into `comment`, and the quote is flagged `no_locator`. `cite_quote` does return `position.section`, so the chapter could be stored as the locator.
5. **Broken tool name.** corpus `cite_passage` → `zotero_filing.tool` names `file_zotero_reference`, which no portal server exposes (the closest is `zotero_add_item`).
6. **Note-variant count disagrees.** `iasp_status` says 23, the note-variants guide and `compose_intent` say 22, and the guide's own table lists 23 rows.
7. Ghost export issues.
   - It keeps the body `# Title` H1, which duplicates Ghost's title field. It was stripped by hand.
   - Writing `>` lines inside an `.epigraph` fence produces a nested `> >` blockquote, and `validate_markdown` doesn't warn about it.
8. **Portal names changed mid-session.** `iasp_iasp_status` became `iasp_status`, and `iasp_get_term` and `iasp_list_sets` dropped out of the deferred list.
9. **Calibre metadata gaps.** None of the three Calibre books has an ISBN, and Harmel-Law has no publisher.
