import type { LeanEntry } from "@bridge/protocol";

export interface RequestFilters {
  urlContains?: string;
  method?: string;
  status?: number;
  resourceType?: string;
  limit?: number;
}

export interface ListResult {
  entries: LeanEntry[];
  /** total entries matching the filter, before `limit` is applied. */
  matchCount: number;
}

/**
 * The authoritative server-side lean-entry buffer (SPEC §4).
 *
 * FIFO-capped so Persist Logs can't grow it unboundedly: appending past the
 * cap evicts the oldest entry. Ids are unique within a session; on replay
 * after a server restart the same id must not duplicate, so append is
 * idempotent per id.
 */
export class RequestBuffer {
  private entries: LeanEntry[] = [];
  private readonly index = new Map<string, LeanEntry>();

  constructor(private readonly cap = 2000) {
    if (cap < 1) throw new RangeError("buffer cap must be >= 1");
  }

  /** Append (or replace an existing id). Evicts oldest past the cap. */
  add(entry: LeanEntry): void {
    if (this.index.has(entry.id)) {
      // replace in place, preserve ordering
      const i = this.entries.findIndex((e) => e.id === entry.id);
      if (i >= 0) this.entries[i] = entry;
      this.index.set(entry.id, entry);
      return;
    }
    this.entries.push(entry);
    this.index.set(entry.id, entry);
    while (this.entries.length > this.cap) {
      const evicted = this.entries.shift();
      if (evicted) this.index.delete(evicted.id);
    }
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  get(id: string): LeanEntry | undefined {
    return this.index.get(id);
  }

  /** Drop every entry (persist-off navigation flush, SPEC §4). */
  clear(): void {
    this.entries = [];
    this.index.clear();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Filtered, insertion-ordered view for `list_requests`. */
  list(filters: RequestFilters = {}): ListResult {
    const { urlContains, method, status, resourceType, limit } = filters;
    const matched = this.entries.filter((e) => {
      if (urlContains !== undefined && !e.url.includes(urlContains))
        return false;
      if (method !== undefined && e.method.toUpperCase() !== method.toUpperCase())
        return false;
      if (status !== undefined && e.status !== status) return false;
      if (resourceType !== undefined && e.resourceType !== resourceType)
        return false;
      return true;
    });
    const entries =
      limit !== undefined && limit >= 0 ? matched.slice(0, limit) : matched;
    return { entries, matchCount: matched.length };
  }
}
