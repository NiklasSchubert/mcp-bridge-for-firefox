/** Bumped whenever the wire contract changes incompatibly (SPEC §5.4). */
export const PROTOCOL_VERSION = 1;

/** WebSocket port the extension dials; must match the manifest CSP (SPEC §7). */
export const DEFAULT_WS_PORT = 8765;

// ── Method name constants ───────────────────────────────────────────────

/** Commands: server → extension (JSON-RPC requests, correlated by id). */
export const Command = {
  SESSION_ACK: "session.ack",
  DOM_EVAL: "dom.eval",
  NETWORK_GET_CONTENT: "network.getContent",
  CAPTURE_TAB: "capture.tab",
} as const;
export type Command = (typeof Command)[keyof typeof Command];

/** Notifications: extension → server (JSON-RPC notifications, no id). */
export const Notify = {
  SESSION_HELLO: "session.hello",
  SESSION_NETWORK_STATE: "session.networkState",
  SESSION_TAB_DISCONNECTED: "session.tabDisconnected",
  NETWORK_REQUEST_FINISHED: "network.requestFinished",
  NETWORK_NAVIGATED: "network.navigated",
} as const;
export type Notify = (typeof Notify)[keyof typeof Notify];

// ── Command params / results ────────────────────────────────────────────

export interface DomEvalParams {
  /** Opaque expression built server-side; the extension runs it verbatim. */
  expression: string;
}
/** Mirrors inspectedWindow.eval: [result, errorInfo]. */
export type DomEvalResult = [result: unknown, errorInfo?: DomEvalErrorInfo];

export interface DomEvalErrorInfo {
  /** page JS threw (has `value`) */
  isException?: boolean;
  value?: unknown;
  /** devtools-level error (has `code`) */
  isError?: boolean;
  code?: string;
}

export interface NetworkGetContentParams {
  id: string;
}

export interface Header {
  name: string;
  value: string;
}

/**
 * Full request detail served for `get_request` (SPEC §3).
 *
 * Deviation note: SPEC §5.2 sketches this primitive's result as the HAR
 * `getContent()` tuple `[content, mimeType]` (the lazy response body). But the
 * documented `get_request` shape also needs request/response headers and the
 * request body — data that only lives in the HAR entry held devtools-side. The
 * single source of truth is that entry, so the primitive is widened to carry
 * the full detail rather than adding a second header-fetch round-trip.
 */
export interface NetworkGetContentResult {
  requestHeaders: Header[];
  responseHeaders: Header[];
  requestBody?: string;
  /** raw response body from HAR getContent(); server encodes/pages it. */
  responseBody: string;
  mimeType: string;
}

export type CaptureFormat = "png" | "jpeg";
export interface CaptureTabParams {
  format: CaptureFormat;
  quality?: number;
  /** document-relative CSS px; captureTab crops natively (SPEC §3). */
  rect?: CaptureRect;
}
export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CaptureTabResult {
  dataUrl: string;
}

// ── Notification params ─────────────────────────────────────────────────

export interface SessionHelloParams {
  protocolVersion: number;
  sessionId: string;
  tabId: number;
  networkActive: boolean;
}

export interface SessionNetworkStateParams {
  active: boolean;
}

export interface NetworkRequestFinishedParams {
  id: string;
  leanEntry: LeanEntry;
}

export interface NetworkNavigatedParams {
  flushed: boolean;
}

// ── Shared payload types ────────────────────────────────────────────────

/** Lean network entry held in the server buffer (SPEC §3). */
export interface LeanEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  mimeType: string;
  /** encoded transfer size (HAR response.bodySize; -1 if unknown) */
  size: number;
  durationMs: number;
  startedDateTime: string;
}
