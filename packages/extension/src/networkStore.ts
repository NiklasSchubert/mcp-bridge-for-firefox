import type { LeanEntry } from "../../shared/index.js";

/**
 * Devtools-side id→entry map + lean-entry replay buffer (SPEC §4, §5.3).
 *
 * FIFO-capped so Persist Logs can't grow it unboundedly. Holds the live HAR
 * entry (for lazy getContent) alongside the lean entry (for hello replay).
 * Generic over the entry type to stay decoupled from the browser API.
 */
export class NetworkStore<E = unknown> {
  // Map keeps insertion order, and re-setting an existing key keeps its slot.
  private readonly map = new Map<string, { entry: E; leanEntry: LeanEntry }>();

  constructor(private readonly cap = 2000) {}

  add(id: string, entry: E, leanEntry: LeanEntry): void {
    this.map.set(id, { entry, leanEntry });
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  get(id: string): E | undefined {
    return this.map.get(id)?.entry;
  }

  clear(): void {
    this.map.clear();
  }

  /** Lean entries in insertion order, for hello replay. */
  replay(): { id: string; leanEntry: LeanEntry }[] {
    return [...this.map].map(([id, { leanEntry }]) => ({ id, leanEntry }));
  }
}
