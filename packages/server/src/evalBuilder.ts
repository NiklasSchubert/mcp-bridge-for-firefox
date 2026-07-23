/**
 * Builds the opaque `dom.eval` expression strings (SPEC §5.6 injection safety).
 *
 * Every selector / param is `JSON.stringify`-d into the string here, in Node —
 * the extension NEVER concatenates. Each expression is a self-contained IIFE
 * that runs in the inspected page's main world and returns a JSON-serializable
 * discriminated result:
 *
 *   { ok: true,  ... }                    → success payload
 *   { ok: false, code: ErrorCode, ... }   → typed execution error
 *
 * A page exception is caught in-page and reported as EVAL_EXCEPTION so the
 * server always receives structured output (it also treats inspectedWindow
 * `errorInfo.isException` as EVAL_EXCEPTION as a fallback).
 */

export interface HtmlPaging {
  /** cap on serialized outerHTML length (chars) */
  maxBytes?: number;
  /** offset into outerHTML for paging */
  offset?: number;
}

const DEFAULT_HTML_CAP = 50_000;
const DEFAULT_TEXT_CAP = 2_000;
const DEFAULT_SUBTREE_DEPTH = 3;

/** Curated common computed-style properties returned by default (SPEC §3). */
export const CURATED_STYLE_PROPS = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "box-sizing",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "opacity",
  "visibility",
  "z-index",
  "flex",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "overflow",
] as const;

/** Shared page-side helpers, inlined into every expression. */
const PAGE_HELPERS = `
  const __rect = (el) => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, right:r.right, bottom:r.bottom, left:r.left }; };
  const __attrs = (el) => { const o = {}; for (const a of el.attributes) o[a.name] = a.value; return o; };
  const __serialize = (el, cap, offset) => {
    const html = el.outerHTML;
    const total = html.length;
    const start = offset > 0 ? offset : 0;
    const slice = html.slice(start, start + cap);
    return {
      tagName: el.tagName.toLowerCase(),
      attributes: __attrs(el),
      textContent: el.textContent,
      outerHTML: slice,
      boundingRect: __rect(el),
      truncated: start + slice.length < total || start > 0,
      totalBytes: total,
    };
  };
`;

function wrap(body: string): string {
  return `(() => {\n  try {\n${PAGE_HELPERS}\n${body}\n  } catch (e) {\n    return { ok: false, code: "EVAL_EXCEPTION", message: String((e && e.message) || e) };\n  }\n})()`;
}

/** Coerce to a safe finite non-negative integer for embedding as a literal. */
function num(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
    return fallback;
  return Math.floor(n);
}

export function buildGetElement(
  selector: string,
  paging: HtmlPaging = {},
): string {
  const sel = JSON.stringify(selector);
  const cap = num(paging.maxBytes, DEFAULT_HTML_CAP);
  const off = num(paging.offset, 0);
  return wrap(`
    const nodes = document.querySelectorAll(${sel});
    if (nodes.length === 0) return { ok: false, code: "NO_MATCH" };
    return { ok: true, matchCount: nodes.length, element: __serialize(nodes[0], ${cap}, ${off}) };
  `);
}

export function buildGetSelectedElement(paging: HtmlPaging = {}): string {
  const cap = num(paging.maxBytes, DEFAULT_HTML_CAP);
  const off = num(paging.offset, 0);
  return wrap(`
    if (typeof $0 === "undefined" || $0 === null || !($0 instanceof Element)) return { ok: false, code: "NO_SELECTION" };
    return { ok: true, matchCount: 1, element: __serialize($0, ${cap}, ${off}) };
  `);
}

export function buildGetComputedStyles(
  selector: string,
  opts: { properties?: string[]; all?: boolean } = {},
): string {
  const sel = JSON.stringify(selector);
  const propList = JSON.stringify(
    opts.properties && opts.properties.length > 0
      ? opts.properties
      : [...CURATED_STYLE_PROPS],
  );
  const all = opts.all === true;
  return wrap(`
    const nodes = document.querySelectorAll(${sel});
    if (nodes.length === 0) return { ok: false, code: "NO_MATCH" };
    const cs = getComputedStyle(nodes[0]);
    const styles = {};
    if (${all}) {
      for (let i = 0; i < cs.length; i++) { const p = cs[i]; styles[p] = cs.getPropertyValue(p); }
    } else {
      for (const p of ${propList}) { styles[p] = cs.getPropertyValue(p); }
    }
    return { ok: true, matchCount: nodes.length, styles };
  `);
}

export function buildDumpSubtree(
  selector: string,
  depth: number = DEFAULT_SUBTREE_DEPTH,
): string {
  const sel = JSON.stringify(selector);
  const d = num(depth, DEFAULT_SUBTREE_DEPTH);
  const tcap = DEFAULT_TEXT_CAP;
  return wrap(`
    const root = document.querySelector(${sel});
    if (!root) return { ok: false, code: "NO_MATCH" };
    let truncated = false;
    const walk = (el, remaining) => {
      const node = { tag: el.tagName.toLowerCase(), attributes: __attrs(el), children: [] };
      const kids = el.children;
      if (remaining <= 0) {
        if (kids.length > 0) truncated = true;
        const t = (el.textContent || "");
        node.text = t.length > ${tcap} ? (t.slice(0, ${tcap})) : t;
        if (t.length > ${tcap}) truncated = true;
        return node;
      }
      for (const k of kids) node.children.push(walk(k, remaining - 1));
      return node;
    };
    return { ok: true, matchCount: 1, tree: walk(root, ${d}), truncated };
  `);
}

/**
 * Element-screenshot geometry probe (SPEC §3). Scrolls the element into view
 * (the one accepted page-interaction exception) and returns its
 * viewport-relative rect plus scroll offsets so the server can convert to
 * document-relative CSS px.
 */
export function buildScreenshotProbe(selector: string): string {
  const sel = JSON.stringify(selector);
  return wrap(`
    const el = document.querySelector(${sel});
    if (!el) return { ok: false, code: "NO_MATCH" };
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { ok: true, rect: { x:r.x, y:r.y, width:r.width, height:r.height }, scrollX: window.scrollX, scrollY: window.scrollY };
  `);
}

/** Same probe for the Inspector selection `$0`. */
export function buildScreenshotProbeSelected(): string {
  return wrap(`
    if (typeof $0 === "undefined" || $0 === null || !($0 instanceof Element)) return { ok: false, code: "NO_SELECTION" };
    $0.scrollIntoView({ block: "center", inline: "center" });
    const r = $0.getBoundingClientRect();
    return { ok: true, rect: { x:r.x, y:r.y, width:r.width, height:r.height }, scrollX: window.scrollX, scrollY: window.scrollY };
  `);
}
