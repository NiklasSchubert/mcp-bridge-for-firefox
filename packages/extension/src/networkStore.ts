import type { LeanEntry } from "@bridge/protocol";

interface Held<E> {
  id: string;
  entry: E;
  leanEntry: LeanEntry;
}

/**
 * Devtools-side id→entry map + lean-entry replay buffer (SPEC §4, §5.3).
 *
 * FIFO-capped so Persist Logs can't grow it unboundedly. Holds the live HAR
 * entry (for lazy getContent) alongside the lean entry (for hello replay).
 * Generic over the entry type to stay decoupled from the browser API.
 */
export class NetworkStore<E = unknown> {
  private order: string[] = [];
  private readonly map = new Map<string, Held<E>>();

  constructor(private readonly cap = 2000) {
    if (cap < 1) throw new RangeError("store cap must be >= 1");
  }

  add(id: string, entry: E, leanEntry: LeanEntry): void {
    if (!this.map.has(id)) this.order.push(id);
    this.map.set(id, { id, entry, leanEntry });
    while (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.map.delete(evicted);
    }
  }

  get(id: string): E | undefined {
    return this.map.get(id)?.entry;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  clear(): void {
    this.order = [];
    this.map.clear();
  }

  get size(): number {
    return this.order.length;
  }

  /** Lean entries in insertion order, for hello replay. */
  replay(): { id: string; leanEntry: LeanEntry }[] {
    return this.order.map((id) => {
      const h = this.map.get(id)!;
      return { id: h.id, leanEntry: h.leanEntry };
    });
  }
}
