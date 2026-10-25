import { describe, expect, it } from "vitest";
import type { LeanEntry } from "../../shared/index.js";
import { NetworkStore } from "./networkStore.js";

function lean(id: string): LeanEntry {
  return {
    id,
    method: "GET",
    url: `https://localhost/${id}`,
    status: 200,
    resourceType: "xhr",
    mimeType: "application/json",
    size: 1,
    durationMs: 1,
    startedDateTime: "2026-07-22T00:00:00.000Z",
  };
}

describe("NetworkStore", () => {
  it("holds entry + leanEntry by id", () => {
    const s = new NetworkStore<{ body: string }>();
    s.add("s.1", { body: "hi" }, lean("s.1"));
    expect(s.get("s.1")).toEqual({ body: "hi" });
  });

  it("FIFO-evicts oldest past the cap (entry + replay)", () => {
    const s = new NetworkStore<number>(2);
    s.add("s.1", 1, lean("s.1"));
    s.add("s.2", 2, lean("s.2"));
    s.add("s.3", 3, lean("s.3"));
    expect(s.get("s.1")).toBeUndefined();
    expect(s.replay().map((r) => r.id)).toEqual(["s.2", "s.3"]);
  });

  it("replay preserves insertion order", () => {
    const s = new NetworkStore<number>();
    s.add("s.1", 1, lean("s.1"));
    s.add("s.2", 2, lean("s.2"));
    expect(s.replay().map((r) => r.id)).toEqual(["s.1", "s.2"]);
  });

  it("clear empties everything", () => {
    const s = new NetworkStore<number>();
    s.add("s.1", 1, lean("s.1"));
    s.clear();
    expect(s.get("s.1")).toBeUndefined();
    expect(s.replay()).toEqual([]);
  });
});
