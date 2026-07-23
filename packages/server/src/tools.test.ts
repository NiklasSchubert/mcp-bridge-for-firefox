import { describe, expect, it } from "vitest";
import {
  Command,
  Notify,
  PROTOCOL_VERSION,
  type LeanEntry,
} from "@bridge/protocol";
import { SessionManager } from "./session.js";
import { createToolHandlers } from "./tools.js";

type Responder = (method: string, params: any) => unknown | Promise<unknown>;

function setup(responder: Responder, networkActive = true) {
  const send = (method: string, params: unknown) =>
    Promise.resolve(responder(method, params));
  const sm = new SessionManager(send);
  sm.onSocketConnect();
  sm.handleNotification(Notify.SESSION_HELLO, {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "sess",
    tabId: 1,
    networkActive,
  });
  return { sm, handlers: createToolHandlers(sm) };
}

function payload(res: { content: { type: string; text?: string }[]; isError?: boolean }) {
  const first = res.content[0]!;
  return JSON.parse(first.text!);
}

function lean(id: string, over: Partial<LeanEntry> = {}): LeanEntry {
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
    ...over,
  };
}

describe("list_requests", () => {
  it("returns buffer entries", async () => {
    const { sm, handlers } = setup(() => ({}));
    sm.handleNotification(Notify.NETWORK_REQUEST_FINISHED, {
      id: "sess.1",
      leanEntry: lean("sess.1"),
    });
    const res = await handlers.list_requests();
    expect(res.isError).toBeUndefined();
    expect(payload(res).matchCount).toBe(1);
  });

  it("NETWORK_INACTIVE when panel not activated", async () => {
    const { handlers } = setup(() => ({}), false);
    const res = await handlers.list_requests();
    expect(res.isError).toBe(true);
    expect(payload(res).code).toBe("NETWORK_INACTIVE");
  });
});

describe("get_request", () => {
  it("returns headers + encoded body", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.NETWORK_GET_CONTENT)
        return {
          requestHeaders: [{ name: "Accept", value: "*/*" }],
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          requestBody: undefined,
          responseBody: '{"ok":1}',
          mimeType: "application/json",
        };
      return {};
    });
    const res = await handlers.get_request("sess.1");
    const p = payload(res);
    expect(p.responseBody).toBe('{"ok":1}');
    expect(p.encoding).toBe("utf8");
    expect(p.requestHeaders[0].name).toBe("Accept");
  });

  it("STALE_SESSION for a foreign id (no round-trip)", async () => {
    let called = false;
    const { handlers } = setup((m) => {
      if (m === Command.NETWORK_GET_CONTENT) called = true;
      return {};
    });
    const res = await handlers.get_request("other.1");
    expect(payload(res).code).toBe("STALE_SESSION");
    expect(called).toBe(false);
  });

  it("BODY_UNAVAILABLE when getContent rejects", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.NETWORK_GET_CONTENT)
        return Promise.reject(new Error("evicted"));
      return {};
    });
    const res = await handlers.get_request("sess.9");
    expect(payload(res).code).toBe("BODY_UNAVAILABLE");
  });
});

describe("DOM tools", () => {
  it("get_element returns first match + matchCount", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.DOM_EVAL)
        return [{ ok: true, matchCount: 3, element: { tagName: "div", attributes: {} } }];
      return {};
    });
    const p = payload(await handlers.get_element("div"));
    expect(p.tagName).toBe("div");
    expect(p.matchCount).toBe(3);
  });

  it("get_element NO_MATCH surfaces typed error", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.DOM_EVAL) return [{ ok: false, code: "NO_MATCH" }];
      return {};
    });
    const res = await handlers.get_element("nope");
    expect(res.isError).toBe(true);
    expect(payload(res).code).toBe("NO_MATCH");
  });

  it("get_selected_element NO_SELECTION", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.DOM_EVAL) return [{ ok: false, code: "NO_SELECTION" }];
      return {};
    });
    expect(payload(await handlers.get_selected_element()).code).toBe("NO_SELECTION");
  });

  it("NO_TAB_CONNECTED when session not ready", async () => {
    const { sm, handlers } = setup((m) => {
      if (m === Command.DOM_EVAL) return [{ ok: true, element: {} }];
      return {};
    });
    sm.handleNotification(Notify.SESSION_TAB_DISCONNECTED, {});
    const res = await handlers.get_element("div");
    expect(payload(res).code).toBe("NO_TAB_CONNECTED");
  });
});

describe("screenshots", () => {
  it("screenshot_viewport returns image content, no rect", async () => {
    let capturedParams: any;
    const { handlers } = setup((m, p) => {
      if (m === Command.CAPTURE_TAB) {
        capturedParams = p;
        return { dataUrl: "data:image/png;base64,AAAA" };
      }
      return {};
    });
    const res = await handlers.screenshot_viewport();
    const content = res.content[0] as any;
    expect(content.type).toBe("image");
    expect(content.data).toBe("AAAA");
    expect(capturedParams.rect).toBeUndefined();
  });

  it("screenshot_element probes then crops with document-relative rect", async () => {
    let capturedRect: any;
    const { handlers } = setup((m, p) => {
      if (m === Command.DOM_EVAL)
        return [{ ok: true, rect: { x: 10, y: 20, width: 30, height: 40 }, scrollX: 5, scrollY: 100 }];
      if (m === Command.CAPTURE_TAB) {
        capturedRect = p.rect;
        return { dataUrl: "data:image/png;base64,BBBB" };
      }
      return {};
    });
    const res = await handlers.screenshot_element("#el");
    expect((res.content[0] as any).data).toBe("BBBB");
    expect(capturedRect).toEqual({ x: 15, y: 120, width: 30, height: 40 });
  });

  it("screenshot_element NO_MATCH", async () => {
    const { handlers } = setup((m) => {
      if (m === Command.DOM_EVAL) return [{ ok: false, code: "NO_MATCH" }];
      return {};
    });
    const res = await handlers.screenshot_element("#missing");
    expect(payload(res).code).toBe("NO_MATCH");
  });
});
