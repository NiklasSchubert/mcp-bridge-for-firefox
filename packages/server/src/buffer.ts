import type { LeanEntry } from "../../shared/index.js";

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
  // Map keeps insertion order, and re-setting an existing key keeps its slot.
  private readonly entries = new Map<string, LeanEntry>();

  constructor(private readonly cap = 2000) {}

  add(entry: LeanEntry): void {
    this.entries.set(entry.id, entry);
    if (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Drop every entry (persist-off navigation flush, SPEC §4). */
  clear(): void {
    this.entries.clear();
  }

  /** Filtered, insertion-ordered view for `list_requests`. */
  list(filters: RequestFilters = {}): ListResult {
    const { urlContains, method, status, resourceType, limit } = filters;
    const matched = [...this.entries.values()].filter((e) => {
      if (urlContains !== undefined && !e.url.includes(urlContains))
        return false;
      if (method !== undefined && e.method.toUpperCase() !== method.toUpperCase())
        return false;
      if (status !== undefined && e.status !== status) return false;
      if (resourceType !== undefined && e.resourceType !== resourceType)
        return false;
      return true;
    });
    const entries = limit !== undefined ? matched.slice(0, limit) : matched;
    return { entries, matchCount: matched.length };
  }
}
