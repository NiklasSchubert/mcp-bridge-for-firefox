import { BridgeError, ErrorCode, type DomEvalResult } from "@bridge/protocol";

/** A successful page-side payload always carries `ok: true`. */
export interface OkPayload {
  ok: true;
  [k: string]: unknown;
}

const VALID_CODES = new Set<string>(Object.values(ErrorCode));

/**
 * Interpret a `dom.eval` command result (SPEC §5.2). The eval returns
 * inspectedWindow.eval's `[result, errorInfo]`; our built expressions encode
 * typed failures as `{ ok: false, code }`. Maps everything to either the
 * success payload or a thrown BridgeError.
 */
export function interpretDomResult(res: DomEvalResult): OkPayload {
  const [result, errorInfo] = res;

  // devtools/page-level eval failure (fallback path — expressions normally
  // catch page exceptions in-page)
  if (errorInfo && (errorInfo.isException || errorInfo.isError)) {
    const detail = errorInfo.isException
      ? stringify(errorInfo.value)
      : (errorInfo.code ?? "devtools eval error");
    throw new BridgeError(ErrorCode.EVAL_EXCEPTION, detail);
  }

  if (result === null || typeof result !== "object") {
    throw new BridgeError(
      ErrorCode.EVAL_EXCEPTION,
      "eval returned a non-object result",
    );
  }

  const payload = result as Record<string, unknown>;
  if (payload.ok === false) {
    const code =
      typeof payload.code === "string" && VALID_CODES.has(payload.code)
        ? (payload.code as ErrorCode)
        : ErrorCode.EVAL_EXCEPTION;
    throw new BridgeError(
      code,
      typeof payload.message === "string" ? payload.message : undefined,
    );
  }
  if (payload.ok !== true) {
    throw new BridgeError(
      ErrorCode.EVAL_EXCEPTION,
      "eval result missing ok flag",
    );
  }
  return payload as OkPayload;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
