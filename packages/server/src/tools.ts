import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BridgeError,
  Command,
  ErrorCode,
  type CaptureFormat,
  type CaptureRect,
  type CaptureTabResult,
  type DomEvalResult,
  type NetworkGetContentResult,
} from "../../shared/index.js";
import type { TabRegistry, TabSession } from "./session.js";
import type { RequestFilters } from "./buffer.js";
import { interpretDomResult } from "./dom.js";
import {
  buildDumpSubtree,
  buildGetComputedStyles,
  buildGetElement,
  buildScreenshotProbe,
} from "./evalBuilder.js";
import { toDocumentRect } from "./rect.js";
import { encodeBody, type Paging } from "./body.js";

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

// ── Schemas ─────────────────────────────────────────────────────────────

const paging = {
  maxBytes: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
};

const captureSchema = {
  format: z.enum(["png", "jpeg"]).optional(),
  quality: z.number().int().min(0).max(100).optional(),
};

const viewportProbeSchema = z.object({
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  scrollX: z.number(),
  scrollY: z.number(),
});

interface CaptureOptions {
  format?: CaptureFormat;
  quality?: number;
}

/** An omitted selector targets the Inspector selection `$0`. */
interface Target {
  selector?: string;
}

// ── Handlers (exported for unit testing) ────────────────────────────────

export function createToolHandlers(registry: TabRegistry) {
  async function domTool(session: TabSession, expression: string) {
    const res = await session.command<DomEvalResult>(Command.DOM_EVAL, {
      expression,
    });
    return interpretDomResult(res);
  }

  async function capture(session: TabSession, opts: CaptureOptions, rect?: CaptureRect) {
    const cap = await session.command<CaptureTabResult>(Command.CAPTURE_TAB, {
      format: opts.format ?? "png",
      quality: opts.quality,
      rect,
    });
    return imageResult(cap.dataUrl);
  }

  return {
    list_tabs: (): Promise<CallToolResult> =>
      guard(async () => jsonResult({ tabs: registry.list() })),

    select_tab: ({ tab }: { tab: string }): Promise<CallToolResult> =>
      guard(async () => jsonResult(registry.select(tab))),

    list_requests: (filters: RequestFilters = {}): Promise<CallToolResult> =>
      guard(async () => jsonResult(registry.current().list(filters))),

    get_request: ({ id, ...opts }: { id: string } & Paging): Promise<CallToolResult> =>
      guard(async () => {
        const session = registry.current();
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

    get_element: ({ selector, ...opts }: Target & Paging = {}): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(registry.current(), buildGetElement(selector, opts));
        return jsonResult({ ...(r.element as object), matchCount: r.matchCount });
      }),

    get_computed_styles: ({
      selector,
      ...opts
    }: {
      selector: string;
      properties?: string[];
      all?: boolean;
    }): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(registry.current(), buildGetComputedStyles(selector, opts));
        return jsonResult({ styles: r.styles, matchCount: r.matchCount });
      }),

    dump_subtree: ({ selector, depth }: { selector: string; depth?: number }): Promise<CallToolResult> =>
      guard(async () => {
        const r = await domTool(registry.current(), buildDumpSubtree(selector, depth));
        return jsonResult({
          tree: r.tree,
          truncated: r.truncated,
          matchCount: r.matchCount,
        });
      }),

    screenshot_viewport: (opts: CaptureOptions = {}): Promise<CallToolResult> =>
      guard(async () => capture(registry.current(), opts)),

    screenshot_element: ({ selector, ...opts }: Target & CaptureOptions = {}): Promise<CallToolResult> =>
      guard(async () => {
        const session = registry.current();
        const probe = viewportProbeSchema.safeParse(
          await domTool(session, buildScreenshotProbe(selector)),
        );
        if (!probe.success)
          throw new BridgeError(
            ErrorCode.EVAL_EXCEPTION,
            "screenshot probe returned a malformed rect",
          );
        return capture(session, opts, toDocumentRect(probe.data));
      }),
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

// ── MCP registration ────────────────────────────────────────────────────

export function registerTools(server: McpServer, registry: TabRegistry): void {
  const h = createToolHandlers(registry);

  server.registerTool(
    "list_tabs",
    {
      description:
        "List browser tabs with DevTools open, across all Firefox profiles. `tab` is `<profile-instance>:<tabId>`; tabs sharing the prefix are in the same profile.",
      inputSchema: {},
    },
    h.list_tabs,
  );

  server.registerTool(
    "select_tab",
    {
      description:
        "Choose the tab (a `tab` value from list_tabs) every other tool in this session operates on. Required before any other tool.",
      inputSchema: { tab: z.string() },
    },
    h.select_tab,
  );

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
    h.list_requests,
  );

  server.registerTool(
    "get_request",
    {
      description:
        "Fetch full detail (headers + bodies) for one captured request by id.",
      inputSchema: { id: z.string(), ...paging },
    },
    h.get_request,
  );

  server.registerTool(
    "get_element",
    {
      description:
        "Get the first element matching a CSS selector in the inspected page's main frame.",
      inputSchema: { selector: z.string(), ...paging },
    },
    h.get_element,
  );

  server.registerTool(
    "get_selected_element",
    {
      description: "Get the element currently selected in the Inspector ($0).",
      inputSchema: paging,
    },
    h.get_element,
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
    h.get_computed_styles,
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
    h.dump_subtree,
  );

  server.registerTool(
    "screenshot_viewport",
    { description: "Screenshot the visible viewport of the inspected tab.", inputSchema: captureSchema },
    h.screenshot_viewport,
  );

  server.registerTool(
    "screenshot_element",
    {
      description:
        "Screenshot a single element (scrolls it into view first) matched by selector.",
      inputSchema: { selector: z.string(), ...captureSchema },
    },
    h.screenshot_element,
  );

  server.registerTool(
    "screenshot_selected_element",
    {
      description: "Screenshot the Inspector-selected element ($0).",
      inputSchema: captureSchema,
    },
    h.screenshot_element,
  );
}
