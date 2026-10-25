#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BridgeError,
  DEFAULT_WS_PORT,
  ErrorCode,
  type JsonRpcMessage,
} from "../../shared/index.js";
import { SessionManager, type CommandSender } from "./session.js";
import { JsonRpcPeer } from "./jsonRpcPeer.js";
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
  // The active extension WS connection (single tab, SPEC §1). Commands route
  // to whichever peer is currently attached; none → NO_TAB_CONNECTED.
  let activePeer: JsonRpcPeer | undefined;
  const sendCommand: CommandSender = (method, params) =>
    activePeer
      ? activePeer.request(method, params)
      : Promise.reject(new BridgeError(ErrorCode.NO_TAB_CONNECTED));

  const session = new SessionManager(sendCommand);

  const mcp = new McpServer({
    name: "firefox-mcp-bridge",
    version: "0.1.0",
  });
  registerTools(mcp, session);

  // ── WebSocket server (the extension dials in) ─────────────────────────
  const wss = new WebSocketServer({ port: DEFAULT_WS_PORT, host: HOST });
  wss.on("listening", () => log(`WS server listening on ws://${HOST}:${DEFAULT_WS_PORT}`));
  wss.on("error", (err: NodeJS.ErrnoException) => {
    // A failed bind (e.g. EADDRINUSE from a leftover server) leaves us running
    // headless on stdio: no extension can ever attach, so every tool errors
    // with NO_TAB_CONNECTED. Fail loudly instead of hiding the cause.
    if (err.code === "EADDRINUSE") {
      log(
        `FATAL: port ${DEFAULT_WS_PORT} already in use — another bridge server is running. Stop it.`,
      );
      process.exit(1);
    }
    log("WS server error:", err);
  });

  wss.on("connection", (ws: WebSocket) => {
    log("extension connected");
    const peer = new JsonRpcPeer(
      (msg) => ws.send(JSON.stringify(msg)),
      (method, params) => session.handleNotification(method, params),
    );
    activePeer = peer;
    session.onSocketConnect();

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
      log("extension disconnected");
      if (activePeer === peer) {
        activePeer = undefined;
        session.onSocketClose();
      }
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
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
