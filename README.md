# holdings-mcp

What do I have, and in what form? One lookup over every work, whatever the medium: an item filed in Zotero,
a Calibre book with or without text, a paper book with quotes in quote-mcp. Each work is keyed the way every
other authoring service keys it (the Zotero item, its citekey) and says what can be done with it next: read
its text, find its quotes and notes, cite it.

It keeps a mirror of the Zotero libraries and polls two feeds: corpus-mcp's books and quote-mcp's quote
counts. It writes to none of them, and its MCP tools are read-only. [PLAN.md](PLAN.md) is the plan of record.

corpus-mcp and quote-mcp read Zotero through it, so only holdings-mcp syncs with zotero.org (see
[Zotero through holdings-mcp](#zotero-through-holdings-mcp)). Writes to Zotero go through zotero-mcp.

## MCP tools

| Name | What it does |
|---|---|
| `find_work` | Works by words in the title or creators, by author, by any key, or by what they have (`text`, `file`, `quotes`, `notes`). |
| `get_work` | One work by any key: every key it has, every holding, and what stands in the way of citing it. |
| `holdings_status` | Each source's freshness and errors, counts, Calibre books not yet filed, and feed entries that couldn't be placed. |

Every tool takes any key a work has, and the answer lists all of them:
`zotero:<library>/<item key>` (the work's key), the citekey (`@` optional), the bare item key, a Calibre book
id (`main:42`), `calibre:<uuid>`, `quote:<id>`, or an ISBN. A Calibre book not filed in Zotero is keyed
`calibre:<uuid>`, and a quoted work quote-mcp can't match to one item is keyed `quote:<id>`. Once the work
is filed and matched, its old key is recorded under `former_keys` and keeps resolving.

## Quick start

Requires Node.js 22 or later; `better-sqlite3` compiles natively.

```bash
npm install
cp .env.example .env    # then set HOLDINGS_ZOTERO_API_KEY, and the feed URLs once they're deployed
npm run refresh         # sync Zotero, poll the feeds, build the works
npm run serve           # MCP at http://localhost:8000/mcp, refreshing every 2 minutes
```

`npm run holdings -- status` prints what `holdings_status` answers. Run the tests with `npm test`.

## Zotero through holdings-mcp

On the LAN only (through Access they're a 404), the server answers the part of the Zotero Web API that
corpus-mcp and quote-mcp sync with, from its mirror, notes included:

| Request | Answers |
|---|---|
| `GET /zotero/<library>/items` | Items changed since a library version: `since`, `includeTrashed`, `itemType`, `itemKey`, `limit` (100 at most), `start`, `format=json` |
| `GET /zotero/<library>/items/top` | The same, for items without a parent |
| `GET /zotero/<library>/deleted` | Keys deleted for good since a version (`since`) |
| `POST /api/refresh` | Refreshes now, after any refresh already running: for a service that just wrote to Zotero |
| `/` | A home page: this server's pages, the core services and clients with whether each is answering. Addresses can be overridden with `HOLDINGS_LINKS` |
| `/worklist` | The page below: what the checks found that needs a person |
| `GET /api/checks` | The cross-service checks in full, and who last read `/zotero`; `since=<time>` limits findings to those first seen since then |

Each sets `Last-Modified-Version` and, for listings, `Total-Results`, as Zotero does. The versions are
Zotero's own, so a service that synced from Zotero carries on from its version. Any other parameter
(`q`, `tag`, `sort`, …) is refused rather than ignored. To switch a service, set its base URL:

```bash
CORPUS_ZOTERO_API=http://holdings-mcp.localdomain:8000/zotero   # corpus-mcp
QUOTE_ZOTERO_API=http://holdings-mcp.localdomain:8000/zotero    # quote-mcp
```

It's as fresh as the last refresh: every `HOLDINGS_REFRESH_SECONDS` (120 by default), or sooner with
`POST /api/refresh`.

## Cross-service checks

After every refresh holdings-mcp tests what must hold between the services and reports it; it never fixes
anything ([docs/cross-service-checks.md](docs/cross-service-checks.md)). `/health` has the summary,
`holdings_status` and `GET /api/checks` the results. `/worklist` on the LAN lists what needs a person, with links
to where each fix happens: anything failing, likely missed matches, and a citekey clash inside one library. A
citekey shared across your two libraries is expected and left out. Fix an item at its source and it leaves at the
next refresh. To accept one, dismiss it with a reason, kept in the store; different wording brings it back, as does
its returning after it went away. To check who reads the Zotero mirror, list them:

```bash
HOLDINGS_ZOTERO_READERS=corpus-mcp=192.168.1.179:300,quote-mcp=192.168.1.210:1800   # name=address:seconds it syncs every
```

## Deploying

On its own LXC (`holdings-mcp.localdomain`, port 8000), on quote-mcp's pattern:

```bash
npm run deploy -- --provision   # once: Node 22, the holdings user, directories
npm run deploy -- --env         # copy the Zotero and feed settings from .env to /etc/holdings-mcp/env
npm run deploy                  # build, test, install a release, health-check, roll back on failure
```

A deploy whose migration changes the store's schema keeps a copy of the store from before it, and a
rollback puts that copy back, since the previous release refuses a newer schema.

A nightly timer backs the store up to `/var/lib/holdings-mcp/backups` and keeps 14 days. Everything in the
store can be rebuilt from Zotero and the feeds except `former_keys`, which is why it's backed up.
After the first deploy, add a Cloudflare Access application for the host and add it to the Authoring MCP portal.
