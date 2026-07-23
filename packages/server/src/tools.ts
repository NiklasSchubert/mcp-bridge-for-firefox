import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BridgeError,
  Command,
  ErrorCode,
  type CaptureFormat,
  type CaptureTabResult,
  type DomEvalResult,
  type NetworkGetContentResult,
} from "@bridge/protocol";
import type { SessionManager } from "./session.js";
import { interpretDomResult } from "./dom.js";
import {
  buildDumpSubtree,
  buildGetComputedStyles,
  buildGetElement,
  buildGetSelectedElement,
  buildScreenshotProbe,
  buildScreenshotProbeSelected,
} from "./evalBuilder.js";
import { toDocumentRect, type ViewportProbe } from "./rect.js";
import { encodeBody } from "./body.js";

// ── MCP result helpers ──────────────────────────────────────────────────

function jsonResult(obj: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function errorResult(code: ErrorCode, message?: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code, message }) }],
  };
}

function imageResult(dataUrl: string): CallToolResult {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return errorResult(ErrorCode.EVAL_EXCEPTION, "malformed capture data URL");
  return { content: [{ type: "image", mimeType: m[1]!, data: m[2]! }] };
}

/** Run a handler, converting any BridgeError to a typed MCP error result. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BridgeError) return errorResult(e.code, e.message);
    return errorResult(
      ErrorCode.EVAL_EXCEPTION,
      e instanceof Error ? e.message : undefined,
    );
  }
}

// ── Shared paging schema ────────────────────────────────────────────────

const paging = {
  maxBytes: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
};

// ── Handlers (exported for unit testing) ────────────────────────────────

export function createToolHandlers(session: SessionManager) {
  async function domTool(expression: string) {
    session.assertReady(); // NO_TAB_CONNECTED resolved server-side, no round-trip
    const res = await session.command<DomEvalResult>(Command.DOM_EVAL, {
      expression,
    });
    return interpretDomResult(res);
  }

  return {
    list_requests: (filters?: {
      urlContains?: string;
      method?: string;
      status?: number;
      resourceType?: string;
      limit?: number;
    }): Promise<CallToolResult> =>
      guard(async () => jsonResult(session.list(filters))),

    get_request: (
      id: string,
      opts: { maxBytes?: number; offset?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () => {
        session.assertFreshId(id);
        let detail: NetworkGetContentResult;
        try {
          detail = await session.command<NetworkGetContentResult>(
            Command.NETWORK_GET_CONTENT,
            { id },
          );
        } catch (e) {
          if (e instanceof BridgeError) throw e;
          throw new BridgeError(
            ErrorCode.BODY_UNAVAILABLE,
            e instanceof Error ? e.message : undefined,
          );
        }
        const encoded = encodeBody(detail.responseBody, detail.mimeType, opts);
        return jsonResult({
          requestHeaders: detail.requestHeaders,
          responseHeaders: detail.responseHeaders,
          requestBody: detail.requestBody,
          responseBody: encoded.body,
          encoding: encoded.encoding,
          mimeType: detail.mimeType,
          truncated: encoded.truncated,
          totalBytes: encoded.totalBytes,
        });
      }),

    get_element: (
      selector: string,
      opts: { maxBytes?: number; offset?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(buildGetElement(selector, opts));
        return jsonResult({ ...(r.element as object), matchCount: r.matchCount });
      }),

    get_selected_element: (
      opts: { maxBytes?: number; offset?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(buildGetSelectedElement(opts));
        return jsonResult({ ...(r.element as object), matchCount: r.matchCount });
      }),

    get_computed_styles: (
      selector: string,
      opts: { properties?: string[]; all?: boolean } = {},
    ): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(buildGetComputedStyles(selector, opts));
        return jsonResult({ styles: r.styles, matchCount: r.matchCount });
      }),

    dump_subtree: (
      selector: string,
      depth?: number,
    ): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(buildDumpSubtree(selector, depth));
        return jsonResult({
          tree: r.tree,
          truncated: r.truncated,
          matchCount: r.matchCount,
        });
      }),

    screenshot_viewport: (
      opts: { format?: CaptureFormat; quality?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () => {
        session.assertReady();
        const cap = await session.command<CaptureTabResult>(Command.CAPTURE_TAB, {
          format: opts.format ?? "png",
          quality: opts.quality,
        });
        return imageResult(cap.dataUrl);
      }),

    screenshot_element: (
      selector: string,
      opts: { format?: CaptureFormat; quality?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () =>
        captureWithProbe(session, buildScreenshotProbe(selector), opts),
      ),

    screenshot_selected_element: (
      opts: { format?: CaptureFormat; quality?: number } = {},
    ): Promise<CallToolResult> =>
      guard(async () =>
        captureWithProbe(session, buildScreenshotProbeSelected(), opts),
      ),
  };
}

async function captureWithProbe(
  session: SessionManager,
  expression: string,
  opts: { format?: CaptureFormat; quality?: number },
): Promise<CallToolResult> {
  session.assertReady();
  const res = await session.command<DomEvalResult>(Command.DOM_EVAL, {
    expression,
  });
  const probe = asViewportProbe(interpretDomResult(res));
  const rect = toDocumentRect(probe);
  const cap = await session.command<CaptureTabResult>(Command.CAPTURE_TAB, {
    format: opts.format ?? "png",
    quality: opts.quality,
    rect,
  });
  return imageResult(cap.dataUrl);
}

/** Narrow an ok payload to a screenshot probe, or fail with a typed error. */
function asViewportProbe(payload: Record<string, unknown>): ViewportProbe {
  const rect = payload.rect as Record<string, unknown> | undefined;
  if (
    !rect ||
    typeof rect.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number" ||
    typeof payload.scrollX !== "number" ||
    typeof payload.scrollY !== "number"
  ) {
    throw new BridgeError(
      ErrorCode.EVAL_EXCEPTION,
      "screenshot probe returned a malformed rect",
    );
  }
  return {
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    },
    scrollX: payload.scrollX,
    scrollY: payload.scrollY,
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

// ── MCP registration ────────────────────────────────────────────────────

export function registerTools(server: McpServer, session: SessionManager): void {
  const h = createToolHandlers(session);

  server.registerTool(
    "list_requests",
    {
      description:
        "List captured network requests (lean entries) from the inspected tab. Drill into one with get_request.",
      inputSchema: {
        urlContains: z.string().optional(),
        method: z.string().optional(),
        status: z.number().int().optional(),
        resourceType: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (args) => h.list_requests(args),
  );

  server.registerTool(
    "get_request",
    {
      description:
        "Fetch full detail (headers + bodies) for one captured request by id.",
      inputSchema: { id: z.string(), ...paging },
    },
    async ({ id, maxBytes, offset }) => h.get_request(id, { maxBytes, offset }),
  );

  server.registerTool(
    "get_element",
    {
      description:
        "Get the first element matching a CSS selector in the inspected page's main frame.",
      inputSchema: { selector: z.string(), ...paging },
    },
    async ({ selector, maxBytes, offset }) =>
      h.get_element(selector, { maxBytes, offset }),
  );

  server.registerTool(
    "get_selected_element",
    {
      description: "Get the element currently selected in the Inspector ($0).",
      inputSchema: { ...paging },
    },
    async ({ maxBytes, offset }) => h.get_selected_element({ maxBytes, offset }),
  );

  server.registerTool(
    "get_computed_styles",
    {
      description:
        "Get computed styles for the first element matching a selector (curated subset unless all=true).",
      inputSchema: {
        selector: z.string(),
        properties: z.array(z.string()).optional(),
        all: z.boolean().optional(),
      },
    },
    async ({ selector, properties, all }) =>
      h.get_computed_styles(selector, { properties, all }),
  );

  server.registerTool(
    "dump_subtree",
    {
      description:
        "Dump the DOM subtree (tag/attributes/children) under a selector to a given depth.",
      inputSchema: {
        selector: z.string(),
        depth: z.number().int().nonnegative().optional(),
      },
    },
    async ({ selector, depth }) => h.dump_subtree(selector, depth),
  );

  const captureSchema = {
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
  };

  server.registerTool(
    "screenshot_viewport",
    { description: "Screenshot the visible viewport of the inspected tab.", inputSchema: captureSchema },
    async ({ format, quality }) => h.screenshot_viewport({ format, quality }),
  );

  server.registerTool(
    "screenshot_element",
    {
      description:
        "Screenshot a single element (scrolls it into view first) matched by selector.",
      inputSchema: { selector: z.string(), ...captureSchema },
    },
    async ({ selector, format, quality }) =>
      h.screenshot_element(selector, { format, quality }),
  );

  server.registerTool(
    "screenshot_selected_element",
    {
      description: "Screenshot the Inspector-selected element ($0).",
      inputSchema: { ...captureSchema },
    },
    async ({ format, quality }) =>
      h.screenshot_selected_element({ format, quality }),
  );
}
