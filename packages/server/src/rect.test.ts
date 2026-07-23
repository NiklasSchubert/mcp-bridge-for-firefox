import { describe, expect, it } from "vitest";
import { toDocumentRect } from "./rect.js";

describe("toDocumentRect", () => {
  it("adds scroll offsets to viewport coords", () => {
    expect(
      toDocumentRect({
        rect: { x: 10, y: 20, width: 100, height: 50 },
        scrollX: 5,
        scrollY: 200,
      }),
    ).toEqual({ x: 15, y: 220, width: 100, height: 50 });
  });

  it("rounds sub-pixel values", () => {
    const r = toDocumentRect({
      rect: { x: 10.4, y: 20.6, width: 100.5, height: 50.5 },
      scrollX: 0,
      scrollY: 0,
    });
    expect(r).toEqual({ x: 10, y: 21, width: 101, height: 51 });
  });

  it("clamps negatives and zero size", () => {
    const r = toDocumentRect({
      rect: { x: -30, y: -5, width: 0, height: 0 },
      scrollX: 10,
      scrollY: 0,
    });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
  });
});
