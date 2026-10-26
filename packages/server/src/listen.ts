import { WebSocketServer } from "ws";

function bind(port: number, host: string): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host });
    wss.once("listening", () => resolve(wss));
    wss.once("error", reject);
  });
}

function isAddressInUse(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "EADDRINUSE";
}

/**
 * Every MCP client session spawns its own server, so each takes the first
 * port in the shared range that is still free.
 * @throws when every port is taken, or on any bind error other than EADDRINUSE
 */
export async function listenOnFirstFreePort(
  ports: readonly number[],
  host: string,
): Promise<{ wss: WebSocketServer; port: number }> {
  for (const port of ports) {
    try {
      return { wss: await bind(port, host), port };
    } catch (e) {
      if (!isAddressInUse(e)) throw e;
    }
  }
  throw new Error(`all bridge ports ${ports.join(", ")} are in use`);
}
