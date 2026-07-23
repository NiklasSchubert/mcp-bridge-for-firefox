/**
 * JSON-RPC 2.0 envelope types — used verbatim over BOTH transports:
 * the WebSocket (server↔background) and the internal runtime port
 * (background↔devtools page). One envelope end-to-end (SPEC §5.1).
 */

export const JSONRPC_VERSION = "2.0" as const;

export type JsonRpcId = number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: M;
  params: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: M;
  params: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcError;
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

export function isErrorResponse(
  m: JsonRpcResponse,
): m is JsonRpcErrorResponse {
  return "error" in m;
}
