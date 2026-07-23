import {
  BridgeError,
  Command,
  ErrorCode,
  Notify,
  PROTOCOL_VERSION,
  type NetworkNavigatedParams,
  type NetworkRequestFinishedParams,
  type SessionHelloParams,
  type SessionNetworkStateParams,
} from "@bridge/protocol";
import { RequestBuffer, type RequestFilters, type ListResult } from "./buffer.js";

export type SessionState =
  | "disconnected" // no WS connection
  | "handshaking" // WS up, awaiting session.hello
  | "ready" // devtools session attached
  | "no-tab"; // devtools closed, WS still up

export type CommandSender = (
  method: string,
  params: unknown,
) => Promise<unknown>;

/** Per-state explanation for a NO_TAB_CONNECTED, so the client sees the cause. */
const NO_TAB_HINT: Record<SessionState, string> = {
  disconnected: "no extension connected — is Firefox open with the bridge extension loaded?",
  handshaking: "extension connected but session.hello not completed yet — retry shortly",
  "no-tab": "devtools closed — open devtools on the target tab",
  ready: "ready", // unreachable from assertReady
};

/**
 * Server-side session state machine + authoritative network buffer (SPEC §5.7).
 *
 * Transport-agnostic: WS lifecycle events and parsed ext→server notifications
 * are fed in; outgoing commands go through an injected sender. Connection-level
 * errors (NO_TAB_CONNECTED / NETWORK_INACTIVE / STALE_SESSION) are resolved
 * here with no round-trip (SPEC §6).
 */
export class SessionManager {
  private state: SessionState = "disconnected";
  private sessionId: string | undefined;
  private tabId: number | undefined;
  private networkActive = false;
  readonly buffer: RequestBuffer;

  constructor(
    private readonly send: CommandSender,
    bufferCap = 2000,
  ) {
    this.buffer = new RequestBuffer(bufferCap);
  }

  getState(): SessionState {
    return this.state;
  }
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  getTabId(): number | undefined {
    return this.tabId;
  }
  isNetworkActive(): boolean {
    return this.networkActive;
  }

  /** Send a server→ext command over the active connection. */
  command<R = unknown>(method: string, params: unknown): Promise<R> {
    return this.send(method, params) as Promise<R>;
  }

  // ── WS lifecycle ──────────────────────────────────────────────────────

  onSocketConnect(): void {
    this.state = "handshaking";
  }

  onSocketClose(): void {
    this.state = "disconnected";
    this.networkActive = false;
  }

  // ── ext→server notification dispatch ──────────────────────────────────

  /** Route a parsed notification; returns a promise if it triggers a command. */
  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case Notify.SESSION_HELLO:
        this.onHello(params as SessionHelloParams);
        break;
      case Notify.SESSION_NETWORK_STATE:
        this.networkActive = (params as SessionNetworkStateParams).active;
        break;
      case Notify.SESSION_TAB_DISCONNECTED:
        this.onTabDisconnected();
        break;
      case Notify.NETWORK_REQUEST_FINISHED: {
        const p = params as NetworkRequestFinishedParams;
        this.buffer.add(p.leanEntry);
        break;
      }
      case Notify.NETWORK_NAVIGATED:
        if ((params as NetworkNavigatedParams).flushed) this.buffer.clear();
        break;
      // unknown notifications are ignored (forward-compatible)
    }
  }

  private onHello(p: SessionHelloParams): void {
    // protocolVersion guards future wire changes (SPEC §5.4): an incompatible
    // extension is refused rather than silently half-attached.
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      console.error(
        `[bridge-server] rejecting hello: protocol ${p.protocolVersion} != ${PROTOCOL_VERSION}`,
      );
      return; // stay handshaking; no ack, no ready
    }
    // A different sessionId means a new devtools page: the old buffer belongs
    // to a dead session — drop it so stale ids can't rebind (SPEC §5.3).
    // Same sessionId (server restart reconnect) keeps replay idempotent.
    if (this.sessionId !== undefined && this.sessionId !== p.sessionId) {
      this.buffer.clear();
    }
    this.sessionId = p.sessionId;
    this.tabId = p.tabId;
    this.networkActive = p.networkActive;
    this.state = "ready";
    // ack rides the server→ext command channel (SPEC §5.4)
    void this.send(Command.SESSION_ACK, { protocolVersion: PROTOCOL_VERSION });
  }

  private onTabDisconnected(): void {
    this.state = "no-tab";
    this.networkActive = false;
  }

  // ── connection-level guards (no round-trip) ───────────────────────────

  assertReady(): void {
    if (this.state !== "ready")
      // Code stays NO_TAB_CONNECTED (SPEC §6); the message pins the sub-state
      // so the client can tell "server never dialed" from "devtools closed".
      throw new BridgeError(ErrorCode.NO_TAB_CONNECTED, NO_TAB_HINT[this.state]);
  }

  assertNetworkActive(): void {
    this.assertReady();
    if (!this.networkActive)
      throw new BridgeError(
        ErrorCode.NETWORK_INACTIVE,
        "network capture is inactive — open the Network panel and reload the page",
      );
  }

  /** Reject an id whose sessionId prefix != the current session (SPEC §5.3). */
  assertFreshId(id: string): void {
    this.assertReady();
    const dot = id.lastIndexOf(".");
    const prefix = dot >= 0 ? id.slice(0, dot) : id;
    if (this.sessionId === undefined || prefix !== this.sessionId)
      throw new BridgeError(ErrorCode.STALE_SESSION);
  }

  list(filters?: RequestFilters): ListResult {
    this.assertNetworkActive();
    return this.buffer.list(filters);
  }
}
