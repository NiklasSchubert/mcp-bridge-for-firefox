/**
 * Extension-internal control messages carried over the runtime port (never
 * reach the server). Distinguished from real protocol traffic by the
 * `bridge.` method prefix.
 */
export const Internal = {
  /** background → devtools: WS (re)connected; (re)announce hello + replay. */
  SOCKET_UP: "bridge.socketUp",
  /** background → devtools: WS dropped. */
  SOCKET_DOWN: "bridge.socketDown",
} as const;

/** Default WS port — must match the server default (SPEC §7). */
export const DEFAULT_WS_PORT = 8765;

/** JSON-RPC error codes used in ext→server command responses. */
export const RpcError = {
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
  NO_INSPECTED_TAB: -32001,
  CAPTURE_FAILED: -32002,
  /** execution-level failure; `message` carries the typed BridgeError code. */
  EXECUTION: -32050,
} as const;
