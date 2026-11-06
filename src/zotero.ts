/**
 * A read-only Zotero Web API client, copied from quote-mcp's src/zotero.ts (itself from corpus-mcp's): long
 * timeouts, retries for network errors and 5xx, and the Backoff and Retry-After headers honoured. Keep the
 * copies in step until there's a shared package (PLAN.md, open questions).
 */

export interface ZoteroConfig {
  /** "users/<user id>" or "groups/<group id>". */
  library: string;
  apiKey: string;
  apiBase: string;
  /** Per request; the API can take tens of seconds. */
  timeoutMs?: number;
}

export interface ApiItem {
  links?: { alternate?: { href?: string } };
  key: string;
  version: number;
  data: {
    itemType: string; title?: string; date?: string; note?: string; parentItem?: string; extra?: string; citationKey?: string;
    ISBN?: string; url?: string; deleted?: number | boolean; contentType?: string; filename?: string; linkMode?: string;
    tags?: { tag: string; type?: number }[];
    creators?: { creatorType: string; lastName?: string; firstName?: string; name?: string }[];
  };
}

/** The API supplies the browser URL; numeric user IDs are not browser usernames. */
export function zoteroWebBase(item: ApiItem, library: string): string | null {
  try {
    const url = new URL(item.links?.alternate?.href ?? "");
    const suffix = `/items/${item.key}`;
    const path = url.pathname.replace(/\/$/, "");
    if (!["https:", "http:"].includes(url.protocol) || !["www.zotero.org", "zotero.org"].includes(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash || !path.endsWith(suffix)) return null;
    const base = path.slice(0, -suffix.length);
    if (library.startsWith("groups/") ? !(base === `/${library}` || base.startsWith(`/${library}/`)) || !/^\/groups\/\d+(?:\/[^/]+)?$/.test(base)
      : !/^\/[^/]+$/.test(base)) return null;
    return `https://www.zotero.org${base}`;
  } catch { return null; }
}

/** One config per library in HOLDINGS_ZOTERO_LIBRARIES, all with the same key. */
export function zoteroConfigs(env: NodeJS.ProcessEnv = process.env): ZoteroConfig[] {
  const libraries = [...new Set((env.HOLDINGS_ZOTERO_LIBRARIES ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  const apiKey = env.HOLDINGS_ZOTERO_API_KEY;
  if (!libraries.length || !apiKey) throw new Error("Set HOLDINGS_ZOTERO_LIBRARIES and HOLDINGS_ZOTERO_API_KEY (see .env.example).");
  for (const library of libraries) {
    if (!/^(users|groups)\/\d+$/.test(library)) throw new Error(`HOLDINGS_ZOTERO_LIBRARIES must list libraries like users/1234567, not "${library}".`);
  }
  return libraries.map((library) => ({ library, apiKey, apiBase: env.HOLDINGS_ZOTERO_API ?? "https://api.zotero.org" }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ZoteroClient {
  private notBefore = 0;

  constructor(private readonly config: ZoteroConfig, private readonly log: (text: string) => void = () => {}) {}

  async get(path: string, params: Record<string, string | number> = {}): Promise<{ body: unknown; headers: Headers }> {
    const url = new URL(`${this.config.apiBase.replace(/\/$/, "")}/${this.config.library}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    for (let attempt = 1; ; attempt++) {
      const wait = this.notBefore - Date.now();
      if (wait > 0) await sleep(wait);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "Zotero-API-Version": "3", "Zotero-API-Key": this.config.apiKey },
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 90_000),
        });
      } catch (error) {
        if (attempt >= 4) throw new Error(`Zotero did not answer ${url.pathname}: ${(error as Error).message}`);
        this.log(`Zotero did not answer (${(error as Error).message}); retrying.\n`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      // Backoff: the server is busy, so pause later requests too. Retry-After: this one must wait.
      const backoff = Number(res.headers.get("backoff"));
      if (backoff > 0) this.notBefore = Date.now() + backoff * 1000;
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        if (attempt >= 4) throw new Error(`Zotero answered ${res.status} for ${url.pathname}`);
        const retryAfter = res.headers.has("retry-after") ? Number(res.headers.get("retry-after")) || 0 : 2 * 2 ** attempt;
        this.log(`Zotero answered ${res.status}; retrying in ${retryAfter} s.\n`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 403) throw new Error("Zotero refused the API key (403). Check HOLDINGS_ZOTERO_API_KEY and its library access.");
      if (!res.ok) throw new Error(`Zotero answered ${res.status} for ${url.pathname}: ${(await res.text()).slice(0, 200)}`);
      return { body: await res.json(), headers: res.headers };
    }
  }

  /** Every item a listing returns, 100 at a time. */
  async getAll(path: string, params: Record<string, string | number> = {}, progress?: (done: number, total: number) => void): Promise<ApiItem[]> {
    const items: ApiItem[] = [];
    for (let start = 0; ; start += 100) {
      const { body, headers } = await this.get(path, { ...params, format: "json", limit: 100, start });
      const page = body as ApiItem[];
      items.push(...page);
      const total = Number(headers.get("total-results") ?? items.length);
      progress?.(items.length, total);
      if (!page.length || items.length >= total) return items;
    }
  }

  /**
   * Everything changed since a library version (trashed items included, flagged deleted), the keys
   * deleted since, and the library's version now.
   */
  async changesSince(since: number, progress?: (done: number, total: number) => void): Promise<{ items: ApiItem[]; deleted: string[]; version: number }> {
    const items: ApiItem[] = [];
    let version = since;
    for (let start = 0; ; start += 100) {
      const { body, headers } = await this.get("items", { format: "json", includeTrashed: 1, since, limit: 100, start });
      const page = body as ApiItem[];
      items.push(...page);
      version = Math.max(version, Number(headers.get("last-modified-version") ?? 0));
      const total = Number(headers.get("total-results") ?? items.length);
      progress?.(items.length, total);
      if (!page.length || items.length >= total) break;
    }
    const { body } = await this.get("deleted", { since });
    return { items, deleted: (body as { items?: string[] }).items ?? [], version };
  }

  /** Items by key, 50 to a request (the API's limit). */
  async getByKeys(keys: string[], progress?: (done: number, total: number) => void): Promise<ApiItem[]> {
    const items: ApiItem[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const { body } = await this.get("items", { format: "json", itemKey: keys.slice(i, i + 50).join(","), includeTrashed: 1 });
      items.push(...(body as ApiItem[]));
      progress?.(Math.min(i + 50, keys.length), keys.length);
    }
    return items;
  }
}
