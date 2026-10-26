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
  type SessionTabUpdatedParams,
  type TabInfo,
} from "../../shared/index.js";
import { RequestBuffer, type RequestFilters, type ListResult } from "./buffer.js";

export type CommandSender = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export interface TabSummary extends TabInfo {
  tab: string;
  container?: string;
  networkActive: boolean;
  selected: boolean;
}

const INSTANCE_PREFIX_LENGTH = 8;

/** Unique across profiles: Firefox tab ids only count up within one profile. */
export function tabKey(hello: Pick<SessionHelloParams, "instanceId" | "tabId">): string {
  return `${hello.instanceId.slice(0, INSTANCE_PREFIX_LENGTH)}:${hello.tabId}`;
}

/**
 * One extension WebSocket = one devtools page on one tab (SPEC §5.7). Holds
 * that tab's network buffer. Connection-level errors (NETWORK_INACTIVE /
 * STALE_SESSION) are resolved here with no round-trip (SPEC §6).
 */
export class TabSession {
  private hello: SessionHelloParams | undefined;
  private info: TabInfo = { url: "", title: "" };
  private networkActive = false;
  private readonly buffer = new RequestBuffer();

  constructor(
    private readonly send: CommandSender,
    private readonly onReady: (key: string, session: TabSession) => void = () => {},
  ) {}

  /** Defined once the hello handshake completed. */
  get key(): string | undefined {
    return this.hello && tabKey(this.hello);
  }

  command<R = unknown>(method: string, params: unknown): Promise<R> {
    return this.send(method, params) as Promise<R>;
  }

  handleNotification(method: string, params: unknown): void {
    switch (method) {
      case Notify.SESSION_HELLO:
        this.onHello(params as SessionHelloParams);
        break;
      case Notify.SESSION_NETWORK_STATE:
        this.networkActive = (params as SessionNetworkStateParams).active;
        break;
      case Notify.SESSION_TAB_UPDATED: {
        const { url, title } = params as SessionTabUpdatedParams;
        this.info = { url, title };
        break;
      }
      case Notify.NETWORK_REQUEST_FINISHED:
        this.buffer.add((params as NetworkRequestFinishedParams).leanEntry);
        break;
      case Notify.NETWORK_NAVIGATED:
        if ((params as NetworkNavigatedParams).flushed) this.buffer.clear();
        break;
      // unknown notifications are ignored (forward-compatible)
    }
  }

  private onHello(p: SessionHelloParams): void {
    // An incompatible extension is refused rather than half-attached (SPEC §5.4).
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      console.error(
        `[bridge-server] rejecting hello: protocol ${p.protocolVersion} != ${PROTOCOL_VERSION}`,
      );
      return;
    }
    this.hello = p;
    this.info = { url: p.url, title: p.title };
    this.networkActive = p.networkActive;
    void this.send(Command.SESSION_ACK, { protocolVersion: PROTOCOL_VERSION });
    this.onReady(tabKey(p), this);
  }

  summary(key: string, selected: boolean): TabSummary {
    return {
      tab: key,
      ...this.info,
      container: this.hello?.cookieStoreId,
      networkActive: this.networkActive,
      selected,
    };
  }

  assertNetworkActive(): void {
    if (!this.networkActive)
      throw new BridgeError(
        ErrorCode.NETWORK_INACTIVE,
        "network capture is inactive — open the Network panel and reload the page",
      );
  }

  /** Reject an id whose sessionId prefix != this devtools session (SPEC §5.3). */
  assertFreshId(id: string): void {
    const dot = id.lastIndexOf(".");
    const prefix = dot >= 0 ? id.slice(0, dot) : id;
    if (prefix !== this.hello?.sessionId)
      throw new BridgeError(ErrorCode.STALE_SESSION);
  }

  list(filters?: RequestFilters): ListResult {
    this.assertNetworkActive();
    return this.buffer.list(filters);
  }
}

/**
 * Every tab connected to this server, from any Firefox profile, plus the one
 * the MCP client picked. Tools never fall back to a tab on their own: picking
 * one goes through `select_tab`, which the client can permission-gate.
 */
export class TabRegistry {
  private readonly tabs = new Map<string, TabSession>();
  private selectedKey: string | undefined;

  attach(key: string, session: TabSession): void {
    this.tabs.set(key, session);
  }

  detach(session: TabSession): void {
    const key = session.key;
    // a reconnect may already have replaced this session under the same key
    if (key !== undefined && this.tabs.get(key) === session) this.tabs.delete(key);
  }

  list(): TabSummary[] {
    return [...this.tabs].map(([key, s]) => s.summary(key, key === this.selectedKey));
  }

  select(key: string): TabSummary {
    const session = this.tabs.get(key);
    if (!session)
      throw new BridgeError(ErrorCode.UNKNOWN_TAB, `no connected tab "${key}" — call list_tabs`);
    this.selectedKey = key;
    return session.summary(key, true);
  }

  /** The selected tab's session; the selection survives devtools being reopened. */
  current(): TabSession {
    if (this.selectedKey === undefined)
      throw new BridgeError(
        ErrorCode.NO_TAB_SELECTED,
        "no tab selected — call list_tabs, then select_tab",
      );
    const session = this.tabs.get(this.selectedKey);
    if (!session)
      throw new BridgeError(
        ErrorCode.TAB_DISCONNECTED,
        `tab ${this.selectedKey} is not connected — reopen its DevTools or select_tab another`,
      );
    return session;
  }
}
