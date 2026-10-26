import { describe, expect, it, vi } from "vitest";
import {
  Command,
  Notify,
  PROTOCOL_VERSION,
  type LeanEntry,
  type SessionHelloParams,
} from "../../shared/index.js";
import { TabRegistry, TabSession, tabKey } from "./session.js";

function lean(id: string): LeanEntry {
  return {
    id,
    method: "GET",
    url: "https://localhost/x",
    status: 200,
    resourceType: "xhr",
    mimeType: "application/json",
    size: 1,
    durationMs: 1,
    startedDateTime: "2026-07-22T00:00:00.000Z",
  };
}

function helloParams(over: Partial<SessionHelloParams> = {}): SessionHelloParams {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "sess-a",
    instanceId: "3f9a1c22-0000-4000-8000-000000000000",
    tabId: 7,
    url: "http://localhost:4200/",
    title: "App",
    networkActive: false,
    ...over,
  };
}

/** A session whose hello already went through, attached to `registry`. */
function connect(registry: TabRegistry, over: Partial<SessionHelloParams> = {}) {
  const session = new TabSession(vi.fn().mockResolvedValue({}), (key, s) =>
    registry.attach(key, s),
  );
  session.handleNotification(Notify.SESSION_HELLO, helloParams(over));
  return session;
}

describe("tabKey", () => {
  it("is the instance prefix plus tab id", () => {
    expect(tabKey(helloParams())).toBe("3f9a1c22:7");
  });
});

describe("TabSession handshake", () => {
  it("hello sends session.ack and reports ready with its key", () => {
    const send = vi.fn().mockResolvedValue({});
    const onReady = vi.fn();
    const session = new TabSession(send, onReady);
    session.handleNotification(Notify.SESSION_HELLO, helloParams());
    expect(send).toHaveBeenCalledWith(Command.SESSION_ACK, {
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(onReady).toHaveBeenCalledWith("3f9a1c22:7", session);
  });

  it("refuses a hello with another protocol version", () => {
    const onReady = vi.fn();
    const session = new TabSession(vi.fn(), onReady);
    session.handleNotification(Notify.SESSION_HELLO, helloParams({ protocolVersion: 1 }));
    expect(onReady).not.toHaveBeenCalled();
    expect(session.key).toBeUndefined();
  });
});

describe("TabSession guards", () => {
  it("NETWORK_INACTIVE until networkState flips active", () => {
    const session = connect(new TabRegistry());
    expect(() => session.assertNetworkActive()).toThrowError(
      expect.objectContaining({ code: "NETWORK_INACTIVE" }),
    );
    session.handleNotification(Notify.SESSION_NETWORK_STATE, { active: true });
    expect(() => session.assertNetworkActive()).not.toThrow();
  });

  it("STALE_SESSION for an id from another devtools session", () => {
    const session = connect(new TabRegistry());
    expect(() => session.assertFreshId("sess-a.5")).not.toThrow();
    expect(() => session.assertFreshId("sess-b.5")).toThrowError(
      expect.objectContaining({ code: "STALE_SESSION" }),
    );
  });
});

describe("TabSession buffer", () => {
  it("requestFinished appends; replayed ids don't duplicate", () => {
    const session = connect(new TabRegistry(), { networkActive: true });
    const finished = { id: "sess-a.1", leanEntry: lean("sess-a.1") };
    session.handleNotification(Notify.NETWORK_REQUEST_FINISHED, finished);
    session.handleNotification(Notify.NETWORK_REQUEST_FINISHED, finished);
    expect(session.list().matchCount).toBe(1);
  });

  it("navigated{flushed:true} clears; false keeps", () => {
    const session = connect(new TabRegistry(), { networkActive: true });
    session.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    session.handleNotification(Notify.NETWORK_NAVIGATED, { flushed: false });
    expect(session.list().matchCount).toBe(1);
    session.handleNotification(Notify.NETWORK_NAVIGATED, { flushed: true });
    expect(session.list().matchCount).toBe(0);
  });
});

describe("TabRegistry", () => {
  it("lists tabs from several profiles with their info", () => {
    const registry = new TabRegistry();
    connect(registry);
    connect(registry, {
      instanceId: "77aa00bb-0000-4000-8000-000000000000",
      tabId: 7,
      url: "http://localhost:3000/",
      title: "Other",
      cookieStoreId: "firefox-container-1",
    });
    expect(registry.list()).toEqual([
      {
        tab: "3f9a1c22:7",
        url: "http://localhost:4200/",
        title: "App",
        container: undefined,
        networkActive: false,
        selected: false,
      },
      {
        tab: "77aa00bb:7",
        url: "http://localhost:3000/",
        title: "Other",
        container: "firefox-container-1",
        networkActive: false,
        selected: false,
      },
    ]);
  });

  it("tabUpdated refreshes url and title", () => {
    const registry = new TabRegistry();
    const session = connect(registry);
    session.handleNotification(Notify.SESSION_TAB_UPDATED, {
      url: "http://localhost:4200/next",
      title: "Next",
    });
    expect(registry.list()[0]).toMatchObject({ url: "http://localhost:4200/next", title: "Next" });
  });

  it("NO_TAB_SELECTED even when exactly one tab is connected", () => {
    const registry = new TabRegistry();
    connect(registry);
    expect(() => registry.current()).toThrowError(
      expect.objectContaining({ code: "NO_TAB_SELECTED" }),
    );
  });

  it("UNKNOWN_TAB for a key that isn't connected", () => {
    expect(() => new TabRegistry().select("nope:1")).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_TAB" }),
    );
  });

  it("routes to the selected tab", () => {
    const registry = new TabRegistry();
    connect(registry);
    const other = connect(registry, { tabId: 8 });
    expect(registry.select("3f9a1c22:8").selected).toBe(true);
    expect(registry.current()).toBe(other);
  });

  it("TAB_DISCONNECTED after the selected tab drops, back once it reconnects", () => {
    const registry = new TabRegistry();
    const first = connect(registry);
    registry.select("3f9a1c22:7");
    registry.detach(first);
    expect(() => registry.current()).toThrowError(
      expect.objectContaining({ code: "TAB_DISCONNECTED" }),
    );
    const reopened = connect(registry, { sessionId: "sess-b" });
    expect(registry.current()).toBe(reopened);
  });

  it("a late close of a replaced session keeps the new one", () => {
    const registry = new TabRegistry();
    const old = connect(registry);
    const replacement = connect(registry);
    registry.detach(old);
    registry.select("3f9a1c22:7");
    expect(registry.current()).toBe(replacement);
  });
});
