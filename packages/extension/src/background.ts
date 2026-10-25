/**
 * Background event page (SPEC §1, §5.5): owns the WebSocket to the MCP server
 * and `tabs.captureTab`; a dumb multiplexer between the socket and the
 * devtools-page runtime port.
 *
 * Routing:
 *   - `capture.tab` command  → handled locally.
 *   - everything else (session.ack / dom.* / network.*) → forwarded verbatim
 *     to the devtools port.
 *   - devtools→server traffic (notifications + command responses) → forwarded
 *     verbatim to the socket.
 *
 * The devtools port also keeps this event page alive while devtools is open
 * (SPEC §8). The socket only lives while a devtools port is attached.
 */
import {
  Command,
  DEFAULT_WS_PORT,
  JSONRPC_VERSION,
  Notify,
  isRequest,
  type CaptureTabParams,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "../../shared/index.js";
import { RPC_ERROR_CODE, SOCKET_UP } from "./internal.js";

const WS_URL = `ws://127.0.0.1:${DEFAULT_WS_PORT}`;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

let socket: WebSocket | undefined;
let devtoolsPort: RuntimePort | undefined;
let inspectedTabId: number | undefined;
let backoff = BACKOFF_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

// ── socket → server plumbing ────────────────────────────────────────────

function sendToServer(msg: JsonRpcMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function respondError(id: number, message: string): void {
  sendToServer({ jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERROR_CODE, message } });
}

function connect(): void {
  if (!devtoolsPort) return; // nothing to serve without a devtools page
  // Don't dial over a live/pending socket (would leak the previous one).
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  )
    return;
  clearTimeout(reconnectTimer);
  const ws = new WebSocket(WS_URL);
  socket = ws;

  ws.addEventListener("open", () => {
    backoff = BACKOFF_BASE_MS;
    // tell the devtools page to (re)announce hello + replay its buffer.
    devtoolsPort?.postMessage({
      jsonrpc: JSONRPC_VERSION,
      method: SOCKET_UP,
      params: {},
    });
  });

  ws.addEventListener("message", (ev) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(String(ev.data)) as JsonRpcMessage;
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return; // stale socket; a newer one is already live
    socket = undefined;
    scheduleReconnect();
  });

  // 'close' follows; reconnect is handled there.
  ws.addEventListener("error", () => ws.close());
}

function scheduleReconnect(): void {
  if (!devtoolsPort) return; // no tab to serve; stay idle (SPEC §5.7)
  const jitter = Math.random() * backoff * 0.5;
  const delay = Math.min(backoff, BACKOFF_CAP_MS) + jitter;
  reconnectTimer = setTimeout(connect, delay);
  backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
}

// ── server → ext command routing ────────────────────────────────────────

function handleServerMessage(msg: JsonRpcMessage): void {
  // Only requests (commands) need routing; the server never sends us
  // notifications or responses.
  if (!isRequest(msg)) return;
  const req = msg;

  if (req.method === Command.CAPTURE_TAB) {
    void handleCapture(req);
    return;
  }
  // session.ack / dom.* / network.* → forward verbatim to devtools page.
  devtoolsPort?.postMessage(req);
}

async function handleCapture(req: JsonRpcRequest): Promise<void> {
  if (inspectedTabId === undefined) {
    respondError(req.id, "no inspected tab");
    return;
  }
  const p = req.params as CaptureTabParams;
  try {
    const dataUrl = await browser.tabs.captureTab(inspectedTabId, {
      format: p.format,
      quality: p.quality,
      rect: p.rect,
    });
    sendToServer({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { dataUrl } });
  } catch (e) {
    respondError(req.id, e instanceof Error ? e.message : "capture failed");
  }
}

// ── devtools port (the runtime bridge) ──────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "bridge") return;
  devtoolsPort = port;

  port.onMessage.addListener((raw) => {
    const msg = raw as JsonRpcMessage & { method?: string; params?: unknown };
    // Peek at hello to learn the inspected tab id for captureTab.
    if (msg.method === Notify.SESSION_HELLO) {
      const params = msg.params as { tabId?: number } | undefined;
      if (params && typeof params.tabId === "number") inspectedTabId = params.tabId;
    }
    // Forward everything from devtools to the server verbatim.
    sendToServer(msg);
  });

  port.onDisconnect.addListener(() => {
    devtoolsPort = undefined;
    inspectedTabId = undefined;
    // devtools closed → tell the server the tab is gone (SPEC §5.5).
    sendToServer({
      jsonrpc: JSONRPC_VERSION,
      method: Notify.SESSION_TAB_DISCONNECTED,
      params: {},
    });
    clearTimeout(reconnectTimer);
    // We keep the socket; the server drops to no-tab. If the event page now
    // suspends, the socket drops too — fine, there's nothing to serve.
  });

  // A devtools page just attached — open (or reuse) the socket.
  if (socket && socket.readyState === WebSocket.OPEN) {
    port.postMessage({ jsonrpc: JSONRPC_VERSION, method: SOCKET_UP, params: {} });
  } else {
    backoff = BACKOFF_BASE_MS;
    connect();
  }
});
