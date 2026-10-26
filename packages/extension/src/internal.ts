/**
 * Extension-internal control messages carried over the runtime port (never
 * reach the server). Distinguished from real protocol traffic by the
 * `bridge.` method prefix.
 */

/** background → devtools: a socket to `params.server` opened; send it hello + replay. */
export const SOCKET_UP = "bridge.socketUp";

/** devtools → background: `params.messages` go only to the socket of `params.server`. */
export const ANNOUNCE = "bridge.announce";

export interface SocketUpParams {
  server: number;
}

export interface AnnounceParams {
  server: number;
  messages: unknown[];
}

/** The devtools page names its port `bridge:<tabId>` so the background knows the tab up front. */
export const PORT_NAME_PREFIX = "bridge:";

/** JSON-RPC error code for every ext→server command failure; the server only reads `message`. */
export const RPC_ERROR_CODE = -32000;
