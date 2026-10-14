import { expect, test } from "bun:test";
import { COWORK_RPC, COWORK_REMOTE_METHODS, COWORK_FILE_CHUNK_MAX_BYTES, CoworkOutputPath, CoworkOutputFileChunk } from "../src";
const request = { workspaceId: "workspace", locationId: "output-location", relativePath: "nested/file.bin", expectedLocationRevision: 1 };
test("output methods are strict local reads, requiring bounded relative paths and generations", () => {
  expect(COWORK_RPC["workspace.file.stat"].params.parse(request)).toEqual(request);
  for (const path of ["/absolute", "../outside", "a/../b", "./file", "a//b", "a/", "bad\0name", "\ud800", "😀".repeat(64)]) expect(CoworkOutputPath.safeParse(path).success).toBe(false);
  for (const path of ["binary.bin", 'quotes"\\tab\t/newline\n', "😀".repeat(63), "index.db", "a.db-wal"]) expect(CoworkOutputPath.safeParse(path).success).toBe(true);
  for (const method of ["workspace.output.list", "workspace.file.stat", "workspace.file.read", "workspace.file.readRange"] as const) expect((COWORK_REMOTE_METHODS as readonly string[]).includes(method)).toBe(false);
  const range = { ...request, expectedGeneration: "a".repeat(64), offset: 0, maxBytes: COWORK_FILE_CHUNK_MAX_BYTES };
  expect(COWORK_RPC["workspace.file.readRange"].params.safeParse(range).success).toBe(true);
  for (const extra of [{ path: "/host" }, { wake: true }, { initialize: true }, { maxBytes: COWORK_FILE_CHUNK_MAX_BYTES + 1 }, { offset: -1 }, { expectedGeneration: "not-a-generation" }]) expect(COWORK_RPC["workspace.file.readRange"].params.safeParse({ ...range, ...extra }).success).toBe(false);
  expect(COWORK_RPC["workspace.file.read"].params.safeParse(request).success).toBe(false);
});
test("worst escaping and binary chunk fit local response and outer wire budgets", () => {
  const relativePath = Array.from({ length: 16 }, () => "\u0001".repeat(250)).join("/");
  const bytes = Buffer.alloc(COWORK_FILE_CHUNK_MAX_BYTES, 255);
  const result = CoworkOutputFileChunk.parse({ workspaceId: request.workspaceId, locationId: request.locationId, relativePath, locationRevision: 1, generation: "a".repeat(64), bytes: bytes.length, kind: "file", offset: 0, nextOffset: bytes.length, eof: true, contentBase64: bytes.toString("base64"), encoding: "base64" });
  expect(Buffer.from(result.contentBase64, "base64")).toEqual(bytes);
  const rpc = { jsonrpc: "2.0", id: "i".repeat(200), result };
  const wire = { kind: "rpc", payload: Buffer.from(JSON.stringify(rpc)).toString("base64") };
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(384 * 1024);
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(512 * 1024);
});
