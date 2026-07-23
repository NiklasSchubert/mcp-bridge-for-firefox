import { describe, expect, it } from "vitest";
import {
  buildDumpSubtree,
  buildGetComputedStyles,
  buildGetElement,
  buildGetSelectedElement,
  buildScreenshotProbe,
} from "./evalBuilder.js";

// ── Minimal fake DOM to actually execute the built expressions ──────────

class FakeEl {
  attributes: { name: string; value: string }[] = [];
  children: FakeEl[] = [];
  textContent = "";
  outerHTML = "<div></div>";
  constructor(public tagName = "DIV") {}
  getBoundingClientRect() {
    return { x: 1, y: 2, width: 3, height: 4, top: 2, right: 4, bottom: 6, left: 1 };
  }
  scrollIntoView() {}
}
// so `$0 instanceof Element` works
const FakeElement = FakeEl;

interface EvalEnv {
  queries?: string[];
  matches?: FakeEl[];
  selected?: FakeEl | null;
  styleValues?: Record<string, string>;
}

function run(expr: string, env: EvalEnv = {}) {
  const queries = env.queries ?? [];
  const matches = env.matches ?? [];
  const document = {
    querySelectorAll(sel: string) {
      queries.push(sel);
      return matches;
    },
    querySelector(sel: string) {
      queries.push(sel);
      return matches[0] ?? null;
    },
  };
  const win = { scrollX: 100, scrollY: 200 };
  const getComputedStyle = (_el: unknown) => {
    const vals = env.styleValues ?? {};
    const keys = Object.keys(vals);
    return {
      length: keys.length,
      item: (i: number) => keys[i],
      getPropertyValue: (p: string) => vals[p] ?? "",
      ...Object.fromEntries(keys.map((k, i) => [i, k])),
    };
  };
  const fn = new Function(
    "document",
    "window",
    "getComputedStyle",
    "$0",
    "Element",
    `return ${expr};`,
  );
  return fn(document, win, getComputedStyle, env.selected ?? undefined, FakeElement);
}

describe("evalBuilder injection safety", () => {
  it("JSON.stringifies the selector — no breakout", () => {
    const nasty = `"]); globalThis.pwned = 1; ((`;
    const expr = buildGetElement(nasty);
    const queries: string[] = [];
    run(expr, { queries, matches: [] });
    // the selector reached querySelectorAll intact, as a single string arg
    expect(queries).toEqual([nasty]);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("embeds the selector as a quoted literal, never raw", () => {
    const expr = buildGetElement('a"b');
    expect(expr).toContain(JSON.stringify('a"b'));
    expect(expr).not.toContain('querySelectorAll(a"b');
  });
});

describe("buildGetElement", () => {
  it("NO_MATCH on zero matches", () => {
    expect(run(buildGetElement("div"), { matches: [] })).toEqual({
      ok: false,
      code: "NO_MATCH",
    });
  });

  it("serializes the first match with attributes + rect", () => {
    const el = new FakeEl("SPAN");
    el.attributes = [{ name: "id", value: "x" }];
    el.textContent = "hi";
    el.outerHTML = "<span id=x>hi</span>";
    const r = run(buildGetElement("span"), { matches: [el, new FakeEl()] }) as any;
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(2);
    expect(r.element.tagName).toBe("span");
    expect(r.element.attributes).toEqual({ id: "x" });
    expect(r.element.boundingRect.width).toBe(3);
    expect(r.element.truncated).toBe(false);
    expect(r.element.totalBytes).toBe("<span id=x>hi</span>".length);
  });

  it("caps outerHTML at maxBytes and flags truncated", () => {
    const el = new FakeEl();
    el.outerHTML = "x".repeat(100);
    const r = run(buildGetElement("div", { maxBytes: 10 }), { matches: [el] }) as any;
    expect(r.element.outerHTML).toHaveLength(10);
    expect(r.element.truncated).toBe(true);
  });
});

describe("buildGetSelectedElement", () => {
  it("NO_SELECTION when $0 absent", () => {
    expect(run(buildGetSelectedElement(), { selected: null })).toEqual({
      ok: false,
      code: "NO_SELECTION",
    });
  });
  it("serializes $0 when present", () => {
    const el = new FakeEl("A");
    const r = run(buildGetSelectedElement(), { selected: el }) as any;
    expect(r.ok).toBe(true);
    expect(r.element.tagName).toBe("a");
  });
});

describe("buildGetComputedStyles", () => {
  it("returns curated subset by default", () => {
    const r = run(buildGetComputedStyles("div"), {
      matches: [new FakeEl()],
      styleValues: { display: "block", color: "rgb(0,0,0)" },
    }) as any;
    expect(r.ok).toBe(true);
    expect(r.styles.display).toBe("block");
    expect(r.styles).toHaveProperty("position");
  });
  it("NO_MATCH when nothing matches", () => {
    expect(run(buildGetComputedStyles("div"), { matches: [] })).toEqual({
      ok: false,
      code: "NO_MATCH",
    });
  });
});

describe("buildDumpSubtree", () => {
  it("walks children to the given depth and flags truncation", () => {
    const root = new FakeEl("UL");
    const li = new FakeEl("LI");
    const deep = new FakeEl("SPAN");
    li.children = [deep];
    root.children = [li];
    const r = run(buildDumpSubtree("ul", 1), { matches: [root] }) as any;
    expect(r.ok).toBe(true);
    expect(r.tree.tag).toBe("ul");
    expect(r.tree.children[0].tag).toBe("li");
    // depth 1 stops below <li>, so its <span> child is not expanded
    expect(r.tree.children[0].children).toEqual([]);
    expect(r.truncated).toBe(true);
  });
});

describe("buildScreenshotProbe", () => {
  it("returns rect + scroll offsets", () => {
    const r = run(buildScreenshotProbe("div"), { matches: [new FakeEl()] }) as any;
    expect(r.ok).toBe(true);
    expect(r.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(r.scrollX).toBe(100);
    expect(r.scrollY).toBe(200);
  });
  it("NO_MATCH when selector misses", () => {
    expect(run(buildScreenshotProbe("div"), { matches: [] })).toEqual({
      ok: false,
      code: "NO_MATCH",
    });
  });
});
