import {
  JSONRPC_VERSION,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
} from "@bridge/protocol";

export type SendRaw = (msg: JsonRpcMessage) => void;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Default per-command timeout — a wedged extension must not hang a tool. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Transport-agnostic JSON-RPC 2.0 peer: generates monotonic request ids,
 * correlates responses, and dispatches inbound notifications. One instance
 * per live connection; the WS/runtime-port layer feeds it raw parsed messages
 * and supplies the `send` sink.
 */
export class JsonRpcPeer {
  private nextId: JsonRpcId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();

  constructor(
    private readonly send: SendRaw,
    private readonly onNotification: NotificationHandler,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Issue a server→ext command, resolving with its result. */
  request<R = unknown>(method: string, params: unknown): Promise<R> {
    const id = this.nextId++;
    return new Promise<R>((resolve, reject) => {
      const timer =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`command ${method} timed out`));
            }, this.timeoutMs)
          : undefined;
      if (timer && typeof timer.unref === "function") timer.unref();
      this.pending.set(id, {
        resolve: resolve as Pending["resolve"],
        reject,
        timer,
      });
      this.send({ jsonrpc: JSONRPC_VERSION, id, method, params });
    });
  }

  /** Feed one parsed inbound message. */
  handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return; // unknown/late response — drop
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (isErrorResponse(msg)) {
        const e = new Error(msg.error.message);
        (e as Error & { data?: unknown; rpcCode?: number }).data =
          msg.error.data;
        (e as Error & { rpcCode?: number }).rpcCode = msg.error.code;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (isNotification(msg)) {
      this.onNotification(msg.method, msg.params);
      return;
    }
    if (isRequest(msg)) {
      // The server does not currently accept inbound requests from the
      // extension; ignore to stay forward-compatible.
      return;
    }
  }

  /** Reject every in-flight command (connection dropped). */
  rejectAll(reason: string): void {
    const err = new Error(reason);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  get inFlight(): number {
    return this.pending.size;
  }
}
