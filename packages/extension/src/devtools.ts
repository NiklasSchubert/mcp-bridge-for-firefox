/**
 * Devtools page (SPEC §1, §5): ephemeral document that owns devtools.network
 * (HAR buffer) and inspectedWindow.eval. It mints request ids, keeps an
 * id→live-HAR-entry map to serve network.getContent later, buffers lean
 * entries for replay, and executes the dom and network commands. Its open
 * runtime port to the background keeps the event page alive (SPEC §8).
 */
import {
  Command,
  ErrorCode,
  JSONRPC_VERSION,
  Notify,
  PROTOCOL_VERSION,
  type DevtoolsHelloParams,
  type DomEvalParams,
  type JsonRpcRequest,
  type LeanEntry,
  type NetworkGetContentParams,
  type NetworkGetContentResult,
} from "../../shared/index.js";
import {
  ANNOUNCE,
  PORT_NAME_PREFIX,
  RPC_ERROR_CODE,
  SOCKET_UP,
  type AnnounceParams,
  type SocketUpParams,
} from "./internal.js";
import { NetworkStore } from "./networkStore.js";

const sessionId = crypto.randomUUID();
const tabId = browser.devtools.inspectedWindow.tabId;
const store = new NetworkStore<HarEntry>();

let counter = 0; // monotonic, never reset on navigation (SPEC §5.3)
let networkActive = false;
let totalSeen = 0; // entries seen this session, for persist-log inference

const port = browser.runtime.connect({ name: `${PORT_NAME_PREFIX}${tabId}` });

// ── outbound helpers ────────────────────────────────────────────────────

function notify(method: string, params: unknown): void {
  port.postMessage({ jsonrpc: JSONRPC_VERSION, method, params });
}
function respond(id: number, result: unknown): void {
  port.postMessage({ jsonrpc: JSONRPC_VERSION, id, result });
}
function respondError(id: number, message: string): void {
  port.postMessage({ jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERROR_CODE, message } });
}

function setNetworkActive(active: boolean): void {
  if (active === networkActive) return;
  networkActive = active;
  notify(Notify.SESSION_NETWORK_STATE, { active });
}

// ── session announce + replay ───────────────────────────────────────────

function announce(server: number): void {
  const hello: DevtoolsHelloParams = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    networkActive,
  };
  // replay buffered lean entries so a newly found or restarted (empty)
  // server rebuilds its buffer with the same ids (SPEC §5.4).
  const replay = store.replay().map((params) => ({
    jsonrpc: JSONRPC_VERSION,
    method: Notify.NETWORK_REQUEST_FINISHED,
    params,
  }));
  const params: AnnounceParams = {
    server,
    messages: [
      { jsonrpc: JSONRPC_VERSION, method: Notify.SESSION_HELLO, params: hello },
      ...replay,
    ],
  };
  port.postMessage({ jsonrpc: JSONRPC_VERSION, method: ANNOUNCE, params });
}

// ── network capture ─────────────────────────────────────────────────────

function resourceTypeOf(entry: HarEntry): string {
  if (entry._resourceType) return entry._resourceType;
  const mime = entry.response.content?.mimeType ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.includes("javascript")) return "script";
  if (mime.includes("css")) return "stylesheet";
  if (mime.includes("html")) return "document";
  if (mime.includes("json")) return "xhr";
  return "other";
}

function toLean(id: string, entry: HarEntry): LeanEntry {
  const bs = entry.response.bodySize;
  const size =
    bs != null && bs >= 0
      ? bs
      : (entry.response._transferSize ?? entry.response.content?.size ?? -1);
  return {
    id,
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response.status,
    resourceType: resourceTypeOf(entry),
    mimeType: entry.response.content?.mimeType ?? "",
    size,
    durationMs: Math.round(entry.time ?? 0),
    startedDateTime: entry.startedDateTime,
  };
}

browser.devtools.network.onRequestFinished.addListener((entry) => {
  const id = `${sessionId}.${++counter}`;
  const leanEntry = toLean(id, entry);
  store.add(id, entry, leanEntry);
  totalSeen++;
  setNetworkActive(true);
  notify(Notify.NETWORK_REQUEST_FINISHED, { id, leanEntry });
});

browser.devtools.network.onNavigated.addListener(() => {
  void reconcileNavigation();
});

async function reconcileNavigation(): Promise<void> {
  // Persist Logs isn't readable; infer it (SPEC §4). If the monitor kept
  // fewer entries than we've seen, it reset ⇒ persist off ⇒ flush.
  let flushed = false;
  try {
    const har = await browser.devtools.network.getHAR();
    flushed = har.entries.length < totalSeen;
    totalSeen = flushed ? har.entries.length : totalSeen;
  } catch {
    flushed = false;
  }
  if (flushed) store.clear(); // counter is intentionally NOT reset
  notify(Notify.NETWORK_NAVIGATED, { flushed });
}

// ── inbound command / control handling ──────────────────────────────────

port.onMessage.addListener((raw) => {
  const msg = raw as { method?: string; id?: number; params?: unknown };
  if (msg.method === SOCKET_UP) {
    announce((msg.params as SocketUpParams).server);
    return;
  }
  if (typeof msg.id === "number" && typeof msg.method === "string") {
    const req = msg as JsonRpcRequest;
    // Guard the whole dispatch so every inbound id always gets a response,
    // even if a browser API rejects — otherwise the server command hangs.
    handleCommand(req).catch((e) =>
      respondError(req.id, e instanceof Error ? e.message : "command failed"),
    );
  }
});

async function handleCommand(req: JsonRpcRequest): Promise<void> {
  switch (req.method) {
    case Command.SESSION_ACK:
      respond(req.id, {});
      return;
    case Command.DOM_EVAL: {
      const { expression } = req.params as DomEvalParams;
      const result = await browser.devtools.inspectedWindow.eval(expression);
      respond(req.id, result); // [result, errorInfo]
      return;
    }
    case Command.NETWORK_GET_CONTENT: {
      await handleGetContent(req);
      return;
    }
    default:
      respondError(req.id, `unknown method ${req.method}`);
  }
}

async function handleGetContent(req: JsonRpcRequest): Promise<void> {
  const { id } = req.params as NetworkGetContentParams;
  const entry = store.get(id);
  if (!entry) {
    respondError(req.id, ErrorCode.BODY_UNAVAILABLE);
    return;
  }
  try {
    const [content, mimeType] = await entry.getContent();
    const result: NetworkGetContentResult = {
      requestHeaders: entry.request.headers,
      responseHeaders: entry.response.headers,
      requestBody: entry.request.postData?.text,
      responseBody: content ?? "",
      mimeType: mimeType || entry.response.content?.mimeType || "",
    };
    respond(req.id, result);
  } catch (e) {
    respondError(req.id, e instanceof Error ? e.message : ErrorCode.BODY_UNAVAILABLE);
  }
}

// ── init ────────────────────────────────────────────────────────────────

// Panel is cosmetic; capture works regardless of whether it's focused.
void browser.devtools.panels.create("MCP Bridge", "", "panel.html").catch(() => {
  /* panel creation is best-effort */
});

// If the network panel was already active before us, reflect it.
void browser.devtools.network
  .getHAR()
  .then((har) => {
    if (har.entries.length > 0) {
      totalSeen = har.entries.length;
      setNetworkActive(true);
    }
  })
  .catch(() => {
    /* getHAR may be empty/unavailable pre-activation */
  });
