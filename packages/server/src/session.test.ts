import { describe, expect, it, vi } from "vitest";
import {
  Command,
  Notify,
  PROTOCOL_VERSION,
  type LeanEntry,
} from "../../shared/index.js";
import { SessionManager } from "./session.js";

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

function hello(sm: SessionManager, sessionId: string, networkActive = false) {
  sm.onSocketConnect();
  sm.handleNotification(Notify.SESSION_HELLO, {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    tabId: 7,
    networkActive,
  });
}

describe("SessionManager handshake", () => {
  it("hello → ready and sends session.ack command", () => {
    const send = vi.fn().mockResolvedValue({});
    const sm = new SessionManager(send);
    hello(sm, "sess-a");
    expect(() => sm.assertReady()).not.toThrow();
    expect(send).toHaveBeenCalledWith(Command.SESSION_ACK, {
      protocolVersion: PROTOCOL_VERSION,
    });
  });
});

describe("connection-level guards", () => {
  it("NO_TAB_CONNECTED before hello", () => {
    const sm = new SessionManager(vi.fn());
    expect(() => sm.assertReady()).toThrowError(
      expect.objectContaining({ code: "NO_TAB_CONNECTED" }),
    );
  });

  it("NETWORK_INACTIVE when panel not active", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", false);
    expect(() => sm.assertNetworkActive()).toThrowError(
      expect.objectContaining({ code: "NETWORK_INACTIVE" }),
    );
  });

  it("networkState notification flips active", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", false);
    sm.handleNotification(Notify.SESSION_NETWORK_STATE, { active: true });
    expect(() => sm.assertNetworkActive()).not.toThrow();
  });

  it("STALE_SESSION for an id from another session", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    expect(() => sm.assertFreshId("sess-a.5")).not.toThrow();
    expect(() => sm.assertFreshId("sess-b.5")).toThrowError(
      expect.objectContaining({ code: "STALE_SESSION" }),
    );
  });
});

describe("buffer wiring", () => {
  it("requestFinished appends; list requires network active", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    expect(sm.list().matchCount).toBe(1);
  });

  it("navigated{flushed:true} clears; false keeps", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    sm.handleNotification(Notify.NETWORK_NAVIGATED, { flushed: false });
    expect(sm.list().matchCount).toBe(1);
    sm.handleNotification(Notify.NETWORK_NAVIGATED, { flushed: true });
    expect(sm.list().matchCount).toBe(0);
  });

  it("same sessionId reconnect keeps buffer (idempotent replay)", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    sm.onSocketClose();
    hello(sm, "sess-a", true); // reconnect, same session
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    expect(sm.list().matchCount).toBe(1);
  });

  it("new sessionId drops the old buffer", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess-a.1",
      leanEntry: lean("sess-a.1"),
    });
    hello(sm, "sess-b", true); // fresh devtools page
    expect(sm.list().matchCount).toBe(0);
  });
});

describe("lifecycle drops", () => {
  it("tabDisconnected → no-tab, tools blocked", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.handleNotification(Notify.SESSION_TAB_DISCONNECTED, {});
    expect(() => sm.assertReady()).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("devtools closed") }),
    );
  });

  it("socket close → disconnected", () => {
    const sm = new SessionManager(vi.fn().mockResolvedValue({}));
    hello(sm, "sess-a", true);
    sm.onSocketClose();
    expect(() => sm.assertReady()).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("no extension connected") }),
    );
  });
});
