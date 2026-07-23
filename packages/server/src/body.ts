/**
 * Response-body encoding classification for `get_request` (SPEC §3, §10).
 *
 * `network.getContent` yields `[content, mimeType]`. Text-ish bodies are
 * returned as UTF-8; binary bodies are base64-encoded and disambiguated by
 * mimeType. Classification is mime-driven (the empirical base64 heuristic is a
 * build-time check, SPEC §10).
 */

const TEXT_MIME_RE =
  /^(text\/|application\/(json|javascript|ecmascript|xml|xhtml\+xml|ld\+json|manifest\+json|graphql)|image\/svg\+xml)/i;

export type BodyEncoding = "utf8" | "base64";

export function classifyMime(mimeType: string | undefined): BodyEncoding {
  if (!mimeType) return "utf8";
  const bare = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return TEXT_MIME_RE.test(bare) ? "utf8" : "base64";
}

/** Heuristic: does a string already look like base64 (no obvious binary)? */
export function looksBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

export interface EncodedBody {
  body: string;
  encoding: BodyEncoding;
  totalBytes: number;
  truncated: boolean;
}

export interface BodyPaging {
  maxBytes?: number;
  offset?: number;
}

/**
 * Encode + page a body. For base64 bodies, if getContent already returned
 * base64 it is passed through; otherwise the raw string bytes are base64-ed.
 * Paging (offset/maxBytes) applies to the emitted (post-encoding) string.
 */
export function encodeBody(
  content: string,
  mimeType: string | undefined,
  paging: BodyPaging = {},
): EncodedBody {
  const encoding = classifyMime(mimeType);
  let emitted: string;
  if (encoding === "base64") {
    emitted = looksBase64(content)
      ? content
      : Buffer.from(content, "binary").toString("base64");
  } else {
    emitted = content;
  }
  const total = emitted.length;
  const offset = clampInt(paging.offset, 0);
  const max = clampInt(paging.maxBytes, total);
  const sliced = emitted.slice(offset, offset + max);
  return {
    body: sliced,
    encoding,
    totalBytes: total,
    truncated: offset + sliced.length < total || offset > 0,
  };
}

function clampInt(n: number | undefined, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}
