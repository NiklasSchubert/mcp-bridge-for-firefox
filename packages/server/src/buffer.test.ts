import { describe, expect, it } from "vitest";
import type { LeanEntry } from "@bridge/protocol";
import { RequestBuffer } from "./buffer.js";

function entry(id: string, over: Partial<LeanEntry> = {}): LeanEntry {
  return {
    id,
    method: "GET",
    url: `https://localhost/${id}`,
    status: 200,
    resourceType: "xhr",
    mimeType: "application/json",
    size: 10,
    durationMs: 5,
    startedDateTime: "2026-07-22T00:00:00.000Z",
    ...over,
  };
}

describe("RequestBuffer", () => {
  it("stores and retrieves by id", () => {
    const b = new RequestBuffer();
    b.add(entry("s.1"));
    expect(b.has("s.1")).toBe(true);
    expect(b.get("s.1")?.url).toBe("https://localhost/s.1");
    expect(b.size).toBe(1);
  });

  it("FIFO-evicts the oldest past the cap", () => {
    const b = new RequestBuffer(2);
    b.add(entry("s.1"));
    b.add(entry("s.2"));
    b.add(entry("s.3"));
    expect(b.size).toBe(2);
    expect(b.has("s.1")).toBe(false); // evicted
    expect(b.has("s.2")).toBe(true);
    expect(b.has("s.3")).toBe(true);
  });

  it("replaying the same id is idempotent (no duplicate)", () => {
    const b = new RequestBuffer();
    b.add(entry("s.1", { status: 200 }));
    b.add(entry("s.1", { status: 304 }));
    expect(b.size).toBe(1);
    expect(b.get("s.1")?.status).toBe(304);
  });

  it("clear empties the buffer", () => {
    const b = new RequestBuffer();
    b.add(entry("s.1"));
    b.clear();
    expect(b.size).toBe(0);
    expect(b.has("s.1")).toBe(false);
  });

  it("rejects an invalid cap", () => {
    expect(() => new RequestBuffer(0)).toThrow(RangeError);
  });

  describe("list filters", () => {
    const b = new RequestBuffer();
    b.add(entry("s.1", { method: "GET", url: "https://x/api/users", status: 200, resourceType: "xhr" }));
    b.add(entry("s.2", { method: "POST", url: "https://x/api/login", status: 401, resourceType: "xhr" }));
    b.add(entry("s.3", { method: "GET", url: "https://x/img.png", status: 200, resourceType: "image" }));

    it("filters by urlContains", () => {
      expect(b.list({ urlContains: "/api/" }).matchCount).toBe(2);
    });
    it("filters by method case-insensitively", () => {
      expect(b.list({ method: "get" }).matchCount).toBe(2);
    });
    it("filters by status", () => {
      expect(b.list({ status: 401 }).entries[0]?.id).toBe("s.2");
    });
    it("filters by resourceType", () => {
      expect(b.list({ resourceType: "image" }).matchCount).toBe(1);
    });
    it("limit caps entries but matchCount reflects total", () => {
      const r = b.list({ status: 200, limit: 1 });
      expect(r.entries).toHaveLength(1);
      expect(r.matchCount).toBe(2);
    });
    it("preserves insertion order", () => {
      expect(b.list().entries.map((e) => e.id)).toEqual(["s.1", "s.2", "s.3"]);
    });
  });
});
