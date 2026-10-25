import { describe, expect, it, vi } from "vitest";
import { JSONRPC_VERSION, type JsonRpcMessage } from "../../shared/index.js";
import { JsonRpcPeer } from "./jsonRpcPeer.js";

describe("JsonRpcPeer", () => {
  it("correlates a response to its request by id", async () => {
    const sent: JsonRpcMessage[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m), vi.fn());
    const p = peer.request("dom.eval", { expression: "1" });
    expect(sent).toHaveLength(1);
    const req = sent[0] as { id: number; method: string };
    expect(req.method).toBe("dom.eval");
    peer.handleMessage({
      jsonrpc: JSONRPC_VERSION,
      id: req.id,
      result: [42, undefined],
    });
    await expect(p).resolves.toEqual([42, undefined]);
  });

  it("generates monotonic ids and correlates concurrent commands", async () => {
    const sent: { id: number }[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m as { id: number }), vi.fn());
    const a = peer.request("capture.tab", {});
    const b = peer.request("dom.eval", {});
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    // resolve out of order
    peer.handleMessage({ jsonrpc: JSONRPC_VERSION, id: sent[1]!.id, result: "b" });
    peer.handleMessage({ jsonrpc: JSONRPC_VERSION, id: sent[0]!.id, result: "a" });
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
  });

  it("rejects on an error response", async () => {
    const sent: { id: number }[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m as { id: number }), vi.fn());
    const p = peer.request("network.getContent", { id: "x" });
    peer.handleMessage({
      jsonrpc: JSONRPC_VERSION,
      id: sent[0]!.id,
      error: { code: -32000, message: "boom" },
    });
    await expect(p).rejects.toThrow("boom");
  });

  it("dispatches notifications to the handler", () => {
    const onNote = vi.fn();
    const peer = new JsonRpcPeer(vi.fn(), onNote);
    peer.handleMessage({
      jsonrpc: JSONRPC_VERSION,
      method: "network.navigated",
      params: { flushed: true },
    });
    expect(onNote).toHaveBeenCalledWith("network.navigated", { flushed: true });
  });

  it("rejectAll fails every in-flight command", async () => {
    const peer = new JsonRpcPeer(vi.fn(), vi.fn());
    const p = peer.request("dom.eval", {});
    peer.rejectAll("socket closed");
    await expect(p).rejects.toThrow("socket closed");
  });

  it("rejects a command that never gets a response (timeout)", async () => {
    const peer = new JsonRpcPeer(vi.fn(), vi.fn(), 20);
    await expect(peer.request("dom.eval", {})).rejects.toThrow(/timed out/);
  });

  it("ignores an unknown/late response", () => {
    const peer = new JsonRpcPeer(vi.fn(), vi.fn());
    expect(() =>
      peer.handleMessage({ jsonrpc: JSONRPC_VERSION, id: 999, result: 1 }),
    ).not.toThrow();
  });
});
