import { describe, expect, test } from "bun:test";
import { RpcRequest, RpcResponse, RpcNotification, parseIncoming, ERR } from "../src/jsonrpc";

describe("jsonrpc envelopes", () => {
  test("valid request parses", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "session.create", params: { scope: "global" } } as const;
    expect(RpcRequest.parse(msg)).toEqual(msg);
  });

  test("request without id is a notification, not a request", () => {
    const msg = { jsonrpc: "2.0", method: "event", params: {} } as const;
    expect(() => RpcRequest.parse(msg)).toThrow();
    expect(RpcNotification.parse(msg)).toEqual(msg);
  });

  test("success and error responses parse", () => {
    expect(RpcResponse.parse({ jsonrpc: "2.0", id: 1, result: { ok: true } }).id).toBe(1);
    const err = RpcResponse.parse({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "unauthorized" } });
    expect("error" in err && err.error.code).toBe(-32001);
  });

  test("notification WITH an id is rejected (refine must see unknown keys)", () => {
    expect(() => RpcNotification.parse({ jsonrpc: "2.0", method: "m", id: 1 })).toThrow();
  });

  test("parseIncoming discriminates request vs notification vs response", () => {
    expect(parseIncoming({ jsonrpc: "2.0", id: 1, method: "m" }).kind).toBe("request");
    expect(parseIncoming({ jsonrpc: "2.0", method: "m" }).kind).toBe("notification");
    expect(parseIncoming({ jsonrpc: "2.0", id: 1, result: {} }).kind).toBe("response");
    expect(() => parseIncoming({ hello: "garbage" })).toThrow();
  });

  // Fix 1: RpcResponse must enforce exactly one of result/error
  test("response with BOTH result and error is rejected", () => {
    expect(() => RpcResponse.parse({ jsonrpc: "2.0", id: 1, result: null, error: { code: -1, message: "x" } })).toThrow();
  });

  test("response with NEITHER result nor error is rejected", () => {
    expect(() => RpcResponse.parse({ jsonrpc: "2.0", id: 1 })).toThrow();
    expect(() => RpcResponse.parse({ jsonrpc: "2.0", id: 1, result: undefined })).toThrow();
  });

  // Fix 2: RpcNotification strips unknown top-level keys
  test("notification strips unknown top-level keys (consistent with request)", () => {
    const parsed = RpcNotification.parse({ jsonrpc: "2.0", method: "m", extra: "x" });
    expect("extra" in parsed).toBe(false);
  });

  test("RpcResponse narrows without casts", () => {
    const r = RpcResponse.parse({ jsonrpc: "2.0", id: 3, result: { v: 1 } });
    if ("error" in r) {
      expect(r.error.message).toBeString();
    } else {
      expect(r.result).toEqual({ v: 1 });
    }
  });

  test("error response with id:null parses (JSON-RPC parse-error frames)", () => {
    const r = RpcResponse.parse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    expect("error" in r && r.error.code).toBe(-32700);
  });

  test("REQUESTS still reject id:null", () => {
    expect(() => RpcRequest.parse({ jsonrpc: "2.0", id: null, method: "m" })).toThrow();
  });
});

describe("standard error codes", () => {
  test("JSON-RPC reserved codes are exported", () => {
    expect(ERR.PARSE_ERROR).toBe(-32700);
    expect(ERR.INVALID_REQUEST).toBe(-32600);
    expect(ERR.METHOD_NOT_FOUND).toBe(-32601);
    expect(ERR.INVALID_PARAMS).toBe(-32602);
    expect(ERR.INTERNAL).toBe(-32603);
  });

  test("RETRY is its own code: a transient refusal the caller repeats, never INTERNAL", () => {
    expect(ERR.RETRY).toBe(-32007);
    expect(new Set(Object.values(ERR)).size).toBe(Object.values(ERR).length);
  });
});
