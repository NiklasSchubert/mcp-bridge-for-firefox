import { afterEach, describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { listenOnFirstFreePort } from "./listen.js";

const HOST = "127.0.0.1";
const PORTS = [18765, 18766];

const open: WebSocketServer[] = [];

async function listen(ports: readonly number[]) {
  const result = await listenOnFirstFreePort(ports, HOST);
  open.push(result.wss);
  return result;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((wss) => new Promise((r) => wss.close(r))));
});

describe("listenOnFirstFreePort", () => {
  it("takes the first port when free", async () => {
    expect((await listen(PORTS)).port).toBe(18765);
  });

  it("skips a taken port", async () => {
    await listen(PORTS);
    expect((await listen(PORTS)).port).toBe(18766);
  });

  it("fails when every port is taken", async () => {
    await listen(PORTS);
    await listen(PORTS);
    await expect(listen(PORTS)).rejects.toThrow("in use");
  });
});
