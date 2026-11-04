# Cross-service checks

**Status: proposed 2026-11-03, revised 2026-11-04 after phase 4. Step 1 of "Order of work" is built
(`src/checks.ts`); the quote and anchor checks and the deploy step aren't.**

Each service tests its own logic, and each passes. The bugs found so far
live in the seams, where one service assumes what another has already
done. The example that prompted this brief: quote-mcp's take-over of
corpus-mcp's quotes returned an existing quote with the same words before
it asked corpus-mcp anything, so the origin, the tags, and the anchor were
never recorded. quote-mcp's tests passed, because from its side returning
the existing quote was right; Copilot caught it in review. Phase 4 showed a second kind of gap:
after corpus-mcp and quote-mcp switched to reading Zotero through holdings-mcp, nothing over HTTP
could show they had, and confirming it took a person running commands on each server.

holdings-mcp already reads from every service and changes nothing, so it's
where the seams get checked. After each refresh it tests a short list of
things that must hold between the services, and reports what it found.

## Rules

- **Read-only.** A check never fixes anything. Each names the repository
  that owns the fix.
- **Two severities.** `fail`: the data is wrong (a dangling id, an item that
  isn't there). `drift`: something expected to heal on its own hasn't
  yet (an anchor waiting for its retry, a match not yet confirmed). Drift
  that lasts longer than its allowance becomes `fail`.
- **Age matters.** Each finding is stored with when it was first and last seen, so a
  finding that's been there for a minute (a feed between refreshes) reads
  differently from one that's been there for a week.
- **No verdict on stale inputs.** A check whose inputs include a feed that
  failed or is stale reports `skipped`, naming the feed,
  rather than passing or failing on old data. `holdings_status` already marks a feed stale
  after 30 minutes without a good fetch; the checks use that.
- **Examples, not dumps.** Each check reports a count and up to ten
  examples (ids and keys), enough to start fixing.
- **Correct data passes.** A check fires only on something that is wrong or waiting. Editions
  that share an ISBN, or duplicates that share a citekey, are allowed (`find_work` already asks the
  caller to pick), so no check fails on them.

## The checks

### Works and keys (holdings-mcp and its feeds)

These need nothing beyond what holdings-mcp reads today.

| Check | Severity | What it catches | Fix in |
|---|---|---|---|
| **Items that exist.** Every Zotero item the books or counts feed names is a work in holdings-mcp's mirror (not trashed, deleted, or missing). An entry with no `work_id` whose item is gone isn't placed on any work, and the finding says so. Replaces the `problems` list `holdings_status` had. | drift (an hour), then fail: quote-mcp's counts only learn of a trashed item at its next import, up to half an hour later | A book or quotes still tied to an item trashed in Zotero; quotes lost from the holdings because their entry couldn't be placed | corpus-mcp or quote-mcp |
| **One quote-mcp work per item.** No two quote-mcp works in the counts feed name the same Zotero item. | fail | A filing that should have merged works (`former_work_ids`) and didn't | quote-mcp |
| **One work per exact key.** No Zotero item key, Calibre UUID, Calibre book id, or `quote:` id names two works. Citekeys two works share are reported as drift (two libraries' Better BibTeX keys colliding, or duplicate items); ISBNs aren't checked. | fail; drift for citekeys | An exact key that resolves to the wrong work; a former key reused | holdings-mcp; Zotero for citekeys |
| **Filed but unmatched.** A `calibre:` work whose UUID is in a Zotero item's Extra (`Calibre UUID: …`) in holdings-mcp's mirror. Each finding names the item's library. | drift (an hour), then fail | corpus-mcp's mirror lagging. An item filed in `groups/61098` can never match: corpus-mcp matches against one library (`CORPUS_ZOTERO_LIBRARY`, `users/827407`), and holdings-mcp mirrors two. Until corpus-mcp reads both, those findings stay `fail` and say why. | corpus-mcp |
| **Likely missed matches.** A `calibre:` work and a Zotero item that share an ISBN. | drift (reported, never fails); `skipped` while corpus-mcp's books feed sends no `isbns`, as it doesn't yet | Matches waiting for a person on corpus-mcp's Zotero page; 558 books were unmatched at deploy | a person, at corpus-mcp's `/admin/zotero` |

### Zotero readers (holdings-mcp ↔ corpus-mcp, quote-mcp)

holdings-mcp records, for each client address and library, when it last read `/zotero/<library>/…` (a
listing's first page, or `/deleted`) and the `since` it asked from. That needs nothing from the other services.

| Check | Severity | What it catches | Fix in |
|---|---|---|---|
| **Readers in step.** Each service configured as a reader (`HOLDINGS_ZOTERO_READERS`, e.g. `corpus-mcp=192.168.1.179:300,quote-mcp=192.168.1.210:1800`: address and sync interval in seconds) has read `/zotero` within three of its intervals. The `since` it last asked from is shown beside it, so a reader stuck on an old version is visible too. | drift (three intervals), then fail | A service that went back to reading zotero.org (a lost env line, a deploy that didn't push it), or whose sync timer stopped | the reader's repository |

### Quotes and anchors (corpus-mcp ↔ quote-mcp)

These need the snapshots under "What holdings-mcp needs from the others".

| Check | Severity | What it catches | Fix in |
|---|---|---|---|
| **Verified without an anchor.** Every quote-mcp quote checked against a Calibre book has an anchor in corpus-mcp under its id. Quotes flagged `anchor_missing` count as drift for a day (`retryAnchors` posts them again after each import), then fail. | fail / drift | The take-over bug above; a lost `POST /api/anchors` | quote-mcp |
| **Anchor without a quote.** Every corpus-mcp anchor's `quote_id` is a quote in quote-mcp. | fail | A quote deleted or merged without `DELETE /api/anchors` | quote-mcp |
| **Anchor on the wrong book.** An anchor's `calibre_uuid` is a book of the quote's work. | fail | An anchor posted under the wrong id; a work merged into the wrong item | quote-mcp |
| **Orphans passed on.** An anchor corpus-mcp has marked `orphaned` shows on its quote in quote-mcp as `anchor_lost`. quote-mcp follows `GET /api/anchors/changes` (quote-mcp #9), so this is drift for one quote-mcp import interval, then fail. | drift, then fail | A rescan that lost a quote's place, unseen by quote-mcp | quote-mcp |
| **corpus-mcp holds no quotes.** corpus-mcp's own store is empty apart from quotes 1 (waiting on the user) and 2 (a test quote, skipped). The take-over of the rest is done (old→new 1→831, 3→830, 4→829, 5→828). Dropped once corpus-mcp's quote tools retire and its store is empty. | fail | A quote saved through corpus-mcp's retiring `save_quote` | corpus-mcp, then quote-mcp |

### Later

When phase 5 lands: every concept quote-mcp resolves a tag to is a term in
terminology-mcp that isn't retired, and quote-mcp's and corpus-mcp's
changelog cursors are within a few changes of terminology-mcp's head.

## What holdings-mcp needs from the others

The quote and anchor checks need read-only snapshots. Each is LAN-only, with an ETag, like the feeds:

| From | Endpoint | Gives |
|---|---|---|
| corpus-mcp | `GET /api/anchors/changes` from the start (exists), or `GET /api/anchors` | Every anchor: `quote_id`, `calibre_uuid`, `status`, `updated_at`. No text: the checks need only the ids. Replaying the changes feed from the start gives every anchor's current state if corpus-mcp never trims its log; ask corpus-mcp before adding a second route. |
| quote-mcp | `GET /api/holdings/quotes` | Every quote that has, or should have, an anchor: `id`, `work_id`, `calibre_uuid` of its book, `status`, `flags`, and its origins (`kind`, `ref`). |
| corpus-mcp | `GET /api/quotes` (exists) | Its own quotes, for the "holds no quotes" check. Already paged at 200. |

## Where results show

- **`holdings_status`** gains `checks`: each check's name, result (`ok`,
  `drift`, `fail`, `skipped`), count, first and last seen, the feeds it used with
  their age, and up to ten examples. Its `problems` list goes.
- **`/health`** gains a summary: how many checks are `ok`, `drift`, `fail`, and `skipped`, and
  the names of those failing, so the state is visible over HTTP without MCP.
- **`GET /api/checks`** (LAN only) returns the full results, as `holdings_status` does.
- **`checks` and `check_findings` tables** keep each check's last result, and findings with when each was
  first and last seen, so the results can say how long something's been wrong. `holdings_status` and
  `GET /api/checks` also list `zotero_readers`.

On live data at 2026-11-04, before any deploy: five checks `ok`, none failing; `one-work-per-exact-key` at
`drift` with 41 citekeys, each a work held in both libraries; `likely-missed-matches` `skipped`.

## Checks after a deploy

corpus-mcp's and quote-mcp's deploys run from the workstation against their own servers; they
can't run a holdings-mcp command, whose store is on holdings-mcp's server. So after its release
switch a deploy calls holdings-mcp over the LAN:

1. `POST /api/refresh`, so the checks see the newly deployed service's feeds.
2. `GET /api/checks?since=<the release switch>`, which reports the findings first seen since then.

Only new findings count, so a finding that was there before the deploy doesn't block an unrelated
one. A new `fail` is printed as a warning and doesn't roll the deploy back: a rollback puts back
code, units, and schema, not data a release has already sent to another service. Once the checks
have run for a while without false alarms, a new `fail` can fail the deploy.

## Tests

Each check gets a fixture in which its invariant is broken, and a test that
it's reported, and a fixture of correct data it must pass (editions sharing an ISBN; a feed
between refreshes). The first broken fixture is the take-over bug above: a corpus-mcp quote whose
words quote-mcp already has, taken over without its origin, tags, or
anchor. The verified-without-an-anchor check should fail on it.

## Order of work

1. Built. In holdings-mcp alone: the tables and results in `holdings_status`, `/health` and
   `GET /api/checks`; the works-and-keys checks (replacing `problems`); and the Zotero-readers check.
2. The snapshots: ask corpus-mcp whether its changes feed is a full history, and add
   `GET /api/holdings/quotes` in quote-mcp; then the quote and anchor checks.
3. The deploy step (refresh, then new findings since the switch) in corpus-mcp's and quote-mcp's
   deploys, as a warning first.
