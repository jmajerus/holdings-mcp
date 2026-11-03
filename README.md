# holdings-mcp

What do I have, and in what form? One lookup over every work, whatever the medium: an item filed in Zotero,
a Calibre book with or without text, a paper book with quotes in quote-mcp. Each work is keyed the way every
other authoring service keys it (the Zotero item, its citekey) and says what can be done with it next: read
its text, find its quotes and notes, cite it.

It keeps a mirror of the Zotero libraries and polls two feeds: corpus-mcp's books and quote-mcp's quote
counts. It writes to none of them, and its MCP tools are read-only. [PLAN.md](PLAN.md) is the plan of record.

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
npm run serve           # MCP at http://localhost:8000/mcp, refreshing every 5 minutes
```

`npm run holdings -- status` prints what `holdings_status` answers. Run the tests with `npm test`.

## Deploying

On its own LXC (`holdings-mcp.localdomain`, port 8000), on quote-mcp's pattern:

```bash
npm run deploy -- --provision   # once: Node 22, the holdings user, directories
npm run deploy -- --env         # copy the Zotero and feed settings from .env to /etc/holdings-mcp/env
npm run deploy                  # build, test, install a release, health-check, roll back on failure
```

A nightly timer backs the store up to `/var/lib/holdings-mcp/backups` and keeps 14 days. Everything in the
store can be rebuilt from Zotero and the feeds except `former_keys`, which is why it's backed up.
After the first deploy, add a Cloudflare Access application for the host and add it to the Authoring MCP portal.
