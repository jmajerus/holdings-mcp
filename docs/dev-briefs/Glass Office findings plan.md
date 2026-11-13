1. ### Recommended Lead Agent Repository: **`holdings-mcp`** (with **`iasp-mcp`** as the end-to-end acceptance verifier)

  If you are running one Claude Code session per repository window, **`holdings-mcp` is the natural lead/coordinator**, for four reasons:

  1. **It already owns the cross-service contract and health checks**:
     - `holdings-mcp` is where the previous 2026-11-02 cross-service architecture review (`holdings-mcp/PLAN.md`) and `docs/cross-service-checks.md` live, and its `/admin` and `holdings_status` already probe and reconcile `corpus-mcp`, `quote-mcp`, `terminology-mcp`, and `zotero-mcp`.
  2. **It sits at the join point of identity across the suite**:
     - Work keys (`zotero:<library>/<key>`), citekeys, Calibre book IDs (`main:643`), ISBNs, and `quote-mcp` work IDs (`quote:741`) all converge in `holdings-mcp`.
  3. **It has no heavy build/rendering state of its own**:
     - Unlike `corpus-mcp` (MuPDF/indexing) or `iasp-mcp` (Pandoc/XeLaTeX rendering), `holdings-mcp` is lightweight and read-only, making its window ideal for writing the shared dev-briefs, sequencing cross-repo changes, and verifying cross-service invariants after each sibling deploys.
  4. **`iasp-mcp` acts as the downstream "integration testbench"**:
     - While `holdings-mcp` coordinates upstream data/tool contracts, `iasp-mcp` is the final consumer at the end of the authoring pipeline: once upstream fixes land in `corpus-mcp`, `quote-mcp`, and `holdings-mcp`, the `iasp-mcp` agent runs the end-to-end essay render (`ghost`, `md`, `html`, `pdf`, `epub`) to prove the whole chain works.

  ---

  ### How the "Glass Office" Findings (`docs/dev-briefs/Interop test 2 The Glass Office (2026-11-13).md`) Map to Each Repository Window

  Here is how the lead agent in `holdings-mcp` can dispatch the findings from that brief across your windows:

  | Window / Repo                | Findings to Own                                              | Concrete Changes                                             |
  | ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
  | **1. `holdings-mcp` (Lead)** | **Finding #2** (missed Zotero match on `main:643` *Human Compatible*) + **Tool naming** | • Include `corpus-mcp`'s `isbn_candidates` (printed ISBNs) when matching Calibre books to Zotero items, or surface them in `likely-missed-matches` so `main:643` joins `9BBBFFGU` (`russell2019human`).<br>• Add `iasp-mcp` (`http://iasp-mcp.localdomain:8000`) to `SERVICES` in `src/home.ts`.<br>• Optional: rename `holdings_status` → `status` so the portal exposes `holdings_status` instead of `holdings_holdings_status`. |
  | **2. `corpus-mcp`**          | **Finding #5** (broken `file_zotero_reference` tool name) + **Tool cleanup** | • In `cite_passage`, update `zotero_filing.tool` from `file_zotero_reference` to `zotero_add_item` (or drop the legacy `zotero_filing` block).<br>• Remove the 6 retired quote stub tools (`save_quote`, `search_quotes`, `get_quote`, `cite_quote`, `update_quote`, `delete_quote`) now that `quote-mcp` is live.<br>• Optional: rename `corpus_status` → `status`. |
  | **3. `quote-mcp`**           | **Finding #3** (`cite_quote` on unfiled Calibre works) + **Finding #4** (EPUB chapter locators) | • **#3**: When a quote comes from an unfiled Calibre book (`origin: "corpus"`), have `cite_quote` fall back to `corpus-mcp`'s `proposed_citekey` (instead of `csl.id: "work-741"`, `pandoc: null`, and the misleading *"uses the old site's record"* warning).<br>• **#4**: When `add_quote` verifies an EPUB passage with `position.section`, store a chapter/section locator (e.g. `ch. 7.2` or `chap. 1`) instead of leaving `locator: null` and flagging `no_locator`. |
  | **4. `iasp-mcp`**            | **Finding #1** (`citeproc` in `ghost` and `md`) + **Finding #6** (22 vs 23 note variants in prose) + **Finding #7** (Ghost H1 stripping & nested `>` inside `.epigraph`) | • **#1**: Run a Pandoc `--citeproc` pre-pass (or citation resolver) for `ghost` and `md` when `bibliography` or `bibtex_content` is supplied so `[@key, loc]` and `## References` are resolved automatically.<br>• **#6**: Update the remaining `"22"` string in `src/queries.ts` (`compose_intent` warning and `note-variants` guide) and `demo/` prose to `"23"`.<br>• **#7a**: Strip the leading `# Title` H1 in `ghost` export (or add a default `strip_title_h1: true` option) so it doesn't duplicate Ghost's native post title.<br>• **#7b**: Strip leading `> ` prefixes inside `wrapGhostEpigraph` so authoring `> ...` inside `::: {.epigraph}` never produces `> >`, and add an `epigraph-blockquote` check in `validate_markdown`. |

  ### Suggested Workflow Across Windows
  1. Open **`holdings-mcp`** as your lead coordinator and point it at `/home/john/Workspace/iasp-mcp/docs/dev-briefs/Interop test 2 The Glass Office (2026-11-13).md`.
  2. Have `corpus-mcp`, `quote-mcp`, and `holdings-mcp` land their upstream fixes (#2, #3, #4, #5) and deploy.
  3. Have **`iasp-mcp`** land the rendering/validation fixes (#1, #6, #7), deploy, and re-render both *The Chamber and the System* and *The Glass Office* to confirm clean Ghost, Markdown, HTML, EPUB, and PDF output.