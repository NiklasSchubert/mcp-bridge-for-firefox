/**
 * The 7 typed error codes (SPEC §6). Two origins:
 *  - connection-level: resolved server-side from tracked session state.
 *  - execution-level:  returned inside a dom.* / network.* command response.
 */

export const ErrorCode = {
  // connection-level
  NO_TAB_CONNECTED: "NO_TAB_CONNECTED",
  NETWORK_INACTIVE: "NETWORK_INACTIVE",
  STALE_SESSION: "STALE_SESSION",
  // execution-level
  NO_MATCH: "NO_MATCH",
  NO_SELECTION: "NO_SELECTION",
  EVAL_EXCEPTION: "EVAL_EXCEPTION",
  BODY_UNAVAILABLE: "BODY_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Error thrown/serialized across boundaries carrying a typed code. */
export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "BridgeError";
  }
}
