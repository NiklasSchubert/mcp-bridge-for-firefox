/**
 * Background event page (SPEC §1, §5.5, §5.8): owns the WebSockets to the MCP
 * servers and `tabs.captureTab`; a multiplexer between those sockets and the
 * devtools-page runtime ports.
 *
 * Every tab with devtools open gets its own socket to every bridge server
 * found on SERVER_PORTS, so several MCP clients (one server each) can use
 * tabs from this profile in parallel. Each socket carries exactly one tab.
 *
 * Routing:
 *   - `capture.tab` command → handled locally for the socket's tab.
 *   - other server commands → forwarded to that tab's devtools port under a
 *     background-local id, since ids from different servers collide.
 *   - devtools responses → back to the socket that asked, original id restored.
 *   - devtools notifications → every socket of that tab.
 *   - devtools announce (hello + replay) → only the socket that just opened.
 *
 * The devtools ports also keep this event page alive while devtools is open
 * (SPEC §8). A tab's sockets only live while its devtools port is attached.
 */
import {
  Command,
  JSONRPC_VERSION,
  Notify,
  SERVER_PORTS,
  isRequest,
  isResponse,
  type CaptureTabParams,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SessionHelloParams,
  type SessionTabUpdatedParams,
  type TabInfo,
} from "../../shared/index.js";
import {
  ANNOUNCE,
  PORT_NAME_PREFIX,
  RPC_ERROR_CODE,
  SOCKET_UP,
  type AnnounceParams,
  type SocketUpParams,
} from "./internal.js";

/** How often to look for servers that started after the tab attached. */
const SCAN_INTERVAL_MS = 3_000;

interface AttachedTab {
  tabId: number;
  port: RuntimePort;
  info: TabInfo;
  cookieStoreId?: string;
  /** by server port */
  sockets: Map<number, WebSocket>;
}

interface PendingCommand {
  ws: WebSocket;
  id: JsonRpcId;
}

/** Per-profile UUID of this extension; tells profiles apart on the server. */
const instanceId = new URL(browser.runtime.getURL("/")).host;

const tabs = new Map<number, AttachedTab>();
const pending = new Map<number, PendingCommand>();
let nextLocalId = 1;
let scanTimer: ReturnType<typeof setInterval> | undefined;

// ── sockets ─────────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(tab: AttachedTab, msg: unknown): void {
  for (const ws of tab.sockets.values()) send(ws, msg);
}

function respondError(ws: WebSocket, id: JsonRpcId, message: string): void {
  send(ws, { jsonrpc: JSONRPC_VERSION, id, error: { code: RPC_ERROR_CODE, message } });
}

function connect(tab: AttachedTab, server: number): void {
  const ws = new WebSocket(`ws://127.0.0.1:${server}`);
  tab.sockets.set(server, ws);

  ws.addEventListener("open", () => {
    const params: SocketUpParams = { server };
    tab.port.postMessage({ jsonrpc: JSONRPC_VERSION, method: SOCKET_UP, params });
  });

  ws.addEventListener("message", (ev) => {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(String(ev.data)) as JsonRpcMessage;
    } catch {
      return;
    }
    handleServerMessage(tab, ws, msg);
  });

  // also fires after a failed dial; the next scan retries
  ws.addEventListener("close", () => {
    if (tab.sockets.get(server) === ws) tab.sockets.delete(server);
    for (const [localId, p] of pending) if (p.ws === ws) pending.delete(localId);
  });
}

function scan(): void {
  for (const tab of tabs.values()) {
    for (const server of SERVER_PORTS) {
      if (!tab.sockets.has(server)) connect(tab, server);
    }
  }
}

// ── server → ext ────────────────────────────────────────────────────────

function handleServerMessage(tab: AttachedTab, ws: WebSocket, msg: JsonRpcMessage): void {
  // the server only ever sends commands
  if (!isRequest(msg)) return;

  if (msg.method === Command.CAPTURE_TAB) {
    void handleCapture(tab, ws, msg);
    return;
  }
  const localId = nextLocalId++;
  pending.set(localId, { ws, id: msg.id });
  tab.port.postMessage({ ...msg, id: localId });
}

async function handleCapture(tab: AttachedTab, ws: WebSocket, req: JsonRpcRequest): Promise<void> {
  const p = req.params as CaptureTabParams;
  try {
    const dataUrl = await browser.tabs.captureTab(tab.tabId, {
      format: p.format,
      quality: p.quality,
      rect: p.rect,
    });
    send(ws, { jsonrpc: JSONRPC_VERSION, id: req.id, result: { dataUrl } });
  } catch (e) {
    respondError(ws, req.id, e instanceof Error ? e.message : "capture failed");
  }
}

// ── devtools → server ───────────────────────────────────────────────────

function withTabIdentity(tab: AttachedTab, msg: unknown): unknown {
  const m = msg as { method?: string; params?: object };
  if (m.method !== Notify.SESSION_HELLO) return msg;
  const params: SessionHelloParams = {
    ...(m.params as Omit<SessionHelloParams, "instanceId" | "tabId" | keyof TabInfo>),
    instanceId,
    tabId: tab.tabId,
    cookieStoreId: tab.cookieStoreId,
    ...tab.info,
  };
  return { ...m, params };
}

function handleDevtoolsMessage(tab: AttachedTab, raw: unknown): void {
  const msg = raw as JsonRpcMessage & { method?: string; params?: unknown };

  if (msg.method === ANNOUNCE) {
    const { server, messages } = msg.params as AnnounceParams;
    const ws = tab.sockets.get(server);
    if (!ws) return;
    for (const m of messages) send(ws, withTabIdentity(tab, m));
    return;
  }

  if (isResponse(msg)) {
    const target = pending.get(msg.id);
    if (!target) return;
    pending.delete(msg.id);
    send(target.ws, { ...msg, id: target.id });
    return;
  }

  broadcast(tab, msg);
}

// ── tab lifecycle ───────────────────────────────────────────────────────

function detach(tab: AttachedTab): void {
  tabs.delete(tab.tabId);
  for (const ws of tab.sockets.values()) ws.close();
  if (tabs.size === 0) {
    clearInterval(scanTimer);
    scanTimer = undefined;
  }
}

async function attach(port: RuntimePort, tabId: number): Promise<void> {
  let isPortOpen = true;
  port.onDisconnect.addListener(() => {
    isPortOpen = false;
    const tab = tabs.get(tabId);
    if (tab?.port === port) detach(tab);
  });

  // the hello carries url/title, so the tab only becomes dialable once they are known
  const browserTab = await browser.tabs.get(tabId);
  if (!isPortOpen) return;
  const tab: AttachedTab = {
    tabId,
    port,
    info: { url: browserTab.url ?? "", title: browserTab.title ?? "" },
    cookieStoreId: browserTab.cookieStoreId,
    sockets: new Map(),
  };
  tabs.set(tabId, tab);
  port.onMessage.addListener((raw) => handleDevtoolsMessage(tab, raw));
  scan();
  scanTimer ??= setInterval(scan, SCAN_INTERVAL_MS);
}

browser.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(PORT_NAME_PREFIX)) return;
  const tabId = Number(port.name.slice(PORT_NAME_PREFIX.length));
  void attach(port, tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, browserTab) => {
  const tab = tabs.get(tabId);
  const isRelevantChange = changeInfo.url !== undefined || changeInfo.title !== undefined;
  if (!tab || !isRelevantChange) return;
  tab.info = { url: browserTab.url ?? "", title: browserTab.title ?? "" };
  const params: SessionTabUpdatedParams = tab.info;
  broadcast(tab, { jsonrpc: JSONRPC_VERSION, method: Notify.SESSION_TAB_UPDATED, params });
});
