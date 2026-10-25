/**
 * Extension-internal control message carried over the runtime port (never
 * reaches the server). Distinguished from real protocol traffic by the
 * `bridge.` method prefix. background → devtools: WS (re)connected;
 * (re)announce hello + replay.
 */
export const SOCKET_UP = "bridge.socketUp";

/** JSON-RPC error code for every ext→server command failure; the server only reads `message`. */
export const RPC_ERROR_CODE = -32000;
