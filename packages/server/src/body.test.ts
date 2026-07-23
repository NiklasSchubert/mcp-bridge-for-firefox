import { describe, expect, it } from "vitest";
import { classifyMime, encodeBody, looksBase64 } from "./body.js";

describe("classifyMime", () => {
  it.each([
    ["text/html", "utf8"],
    ["application/json; charset=utf-8", "utf8"],
    ["application/javascript", "utf8"],
    ["image/svg+xml", "utf8"],
    ["image/png", "base64"],
    ["application/octet-stream", "base64"],
    ["font/woff2", "base64"],
    [undefined, "utf8"],
  ])("%s → %s", (mime, expected) => {
    expect(classifyMime(mime as string | undefined)).toBe(expected);
  });
});

describe("looksBase64", () => {
  it("accepts a valid base64 string", () => {
    expect(looksBase64(Buffer.from("hello").toString("base64"))).toBe(true);
  });
  it("rejects arbitrary text", () => {
    expect(looksBase64("hello world!")).toBe(false);
  });
});

describe("encodeBody", () => {
  it("passes text through as utf8", () => {
    const r = encodeBody('{"a":1}', "application/json");
    expect(r.encoding).toBe("utf8");
    expect(r.body).toBe('{"a":1}');
    expect(r.truncated).toBe(false);
  });

  it("base64-encodes binary content", () => {
    const r = encodeBody("\x00\x01\x02", "application/octet-stream");
    expect(r.encoding).toBe("base64");
    expect(Buffer.from(r.body, "base64")).toEqual(Buffer.from("\x00\x01\x02", "binary"));
  });

  it("passes through already-base64 binary content", () => {
    const already = Buffer.from("\x00\x01").toString("base64");
    const r = encodeBody(already, "image/png");
    expect(r.body).toBe(already);
  });

  it("pages with offset + maxBytes and flags truncated", () => {
    const r = encodeBody("abcdefghij", "text/plain", { offset: 2, maxBytes: 3 });
    expect(r.body).toBe("cde");
    expect(r.totalBytes).toBe(10);
    expect(r.truncated).toBe(true);
  });
});
