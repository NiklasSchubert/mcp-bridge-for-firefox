import { describe, expect, it } from "vitest";
import { interpretDomResult } from "./dom.js";

describe("interpretDomResult", () => {
  it("returns the ok payload", () => {
    expect(interpretDomResult([{ ok: true, matchCount: 1, x: 2 }])).toEqual({
      ok: true,
      matchCount: 1,
      x: 2,
    });
  });

  it("maps a typed page code to a BridgeError", () => {
    expect(() => interpretDomResult([{ ok: false, code: "NO_MATCH" }])).toThrowError(
      expect.objectContaining({ code: "NO_MATCH" }),
    );
    expect(() =>
      interpretDomResult([{ ok: false, code: "NO_SELECTION" }]),
    ).toThrowError(expect.objectContaining({ code: "NO_SELECTION" }));
  });

  it("unknown page code degrades to EVAL_EXCEPTION", () => {
    expect(() =>
      interpretDomResult([{ ok: false, code: "WAT" }]),
    ).toThrowError(expect.objectContaining({ code: "EVAL_EXCEPTION" }));
  });

  it("errorInfo.isException → EVAL_EXCEPTION", () => {
    expect(() =>
      interpretDomResult([undefined, { isException: true, value: "boom" }]),
    ).toThrowError(expect.objectContaining({ code: "EVAL_EXCEPTION" }));
  });

  it("errorInfo.isError → EVAL_EXCEPTION", () => {
    expect(() =>
      interpretDomResult([undefined, { isError: true, code: "E_PROTOCOLERROR" }]),
    ).toThrowError(expect.objectContaining({ code: "EVAL_EXCEPTION" }));
  });

  it("non-object result → EVAL_EXCEPTION", () => {
    expect(() => interpretDomResult([42])).toThrowError(
      expect.objectContaining({ code: "EVAL_EXCEPTION" }),
    );
  });
});
