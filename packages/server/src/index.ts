#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import type { WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_PORTS, type JsonRpcMessage } from "../../shared/index.js";
import { TabRegistry, TabSession } from "./session.js";
import { JsonRpcPeer } from "./jsonRpcPeer.js";
import { listenOnFirstFreePort } from "./listen.js";
import { registerTools } from "./tools.js";

const HOST = "127.0.0.1";

/**
 * stdout is the MCP channel — all diagnostics go to stderr. Clients like
 * opencode discard the child's stderr, so set BRIDGE_LOG=<file> to also tee
 * every line to a file for post-hoc debugging of the handshake/session.
 */
const LOG_FILE = process.env.BRIDGE_LOG;
function log(...args: unknown[]): void {
  console.error("[bridge-server]", ...args);
  if (!LOG_FILE) return;
  try {
    const line = args
      .map((a) => (typeof a === "string" ? a : String(a)))
      .join(" ");
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [bridge-server] ${line}\n`);
  } catch {
    /* logging must never crash the server */
  }
}

async function main(): Promise<void> {
  const registry = new TabRegistry();

  const mcp = new McpServer({
    name: "firefox-mcp-bridge",
    version: "0.2.0",
  });
  registerTools(mcp, registry);

  // ── WebSocket server (one connection per devtools tab) ────────────────
  const { wss, port } = await listenOnFirstFreePort(SERVER_PORTS, HOST);
  log(`WS server listening on ws://${HOST}:${port}`);
  wss.on("error", (err) => log("WS server error:", err));

  wss.on("connection", (ws: WebSocket) => {
    const peer = new JsonRpcPeer(
      (msg) => ws.send(JSON.stringify(msg)),
      (method, params) => session.handleNotification(method, params),
    );
    const session = new TabSession(
      (method, params) => peer.request(method, params),
      (key, s) => {
        log(`tab ${key} connected`);
        registry.attach(key, s);
      },
    );

    ws.on("message", (data) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(data.toString()) as JsonRpcMessage;
      } catch {
        log("dropping non-JSON frame");
        return;
      }
      peer.handleMessage(msg);
    });

    ws.on("close", () => {
      if (session.key) log(`tab ${session.key} disconnected`);
      registry.detach(session);
      peer.rejectAll("socket closed");
    });

    ws.on("error", (err) => log("WS connection error:", err));
  });

  // ── MCP stdio transport ───────────────────────────────────────────────
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP server ready on stdio");

  const shutdown = () => {
    log("shutting down");
    wss.close();
    void mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // the open WS server would keep an orphan alive, holding a port from the range
  process.stdin.on("end", shutdown);
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
