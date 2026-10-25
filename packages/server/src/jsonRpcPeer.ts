import {
  JSONRPC_VERSION,
  isErrorResponse,
  isNotification,
  isResponse,
  type JsonRpcId,
  type JsonRpcMessage,
} from "../../shared/index.js";

export type SendRaw = (msg: JsonRpcMessage) => void;
export type NotificationHandler = (method: string, params: unknown) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${method} timed out`));
      }, this.timeoutMs);
      timer.unref();
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
      clearTimeout(p.timer);
      if (isErrorResponse(msg)) {
        p.reject(new Error(msg.error.message));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (isNotification(msg)) this.onNotification(msg.method, msg.params);
  }

  /** Reject every in-flight command (connection dropped). */
  rejectAll(reason: string): void {
    const err = new Error(reason);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
