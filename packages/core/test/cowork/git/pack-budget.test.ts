import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { checkPackBudget } from "../../../src/cowork/git/pack-budget";

function size(value: number): Buffer {
  const bytes: number[] = [];
  do { const part = value % 128; value = Math.floor(value / 128); bytes.push(part | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function entry(type: number, data: Buffer, declared = data.length): Buffer {
  const header = [(type << 4) | (declared % 16)]; let rest = Math.floor(declared / 16);
  while (rest) { header[header.length - 1]! |= 128; header.push(rest % 128); rest = Math.floor(rest / 128); }
  return Buffer.concat([Buffer.from(header), ...(type === 7 ? [Buffer.alloc(20, 1)] : []), deflateSync(data)]);
}
function pack(entries: Buffer[], count = entries.length): Buffer {
  const header = Buffer.alloc(12); header.write("PACK"); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...entries]); return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
const limits = { objects: 10, expandedObjectBytes: 64 };

test("pack preflight counts plain and declared delta results without expanding a delta graph", async () => {
  await checkPackBudget(pack([entry(3, Buffer.from("base")), entry(7, Buffer.concat([size(4), size(8), Buffer.from([0x90, 4, 0x90, 4])]))]), limits);
  await expect(checkPackBudget(pack([entry(3, Buffer.from("x")), entry(7, Buffer.concat([size(1), size(32)])), entry(7, Buffer.concat([size(32), size(32)]))]), limits)).rejects.toMatchObject({ code: "object_budget" });
});
test("a tiny delta program cannot ask Git to allocate an enormous result", async () => {
  const bomb = pack([entry(3, Buffer.from("x")), entry(7, Buffer.concat([size(1), size(2 ** 40), Buffer.from([0x90, 1])]))]);
  expect(bomb.length).toBeLessThan(150);
  await expect(checkPackBudget(bomb, limits)).rejects.toMatchObject({ code: "object_budget" });
});
test("header object count rejects excessive tiny objects before zlib or Git", async () => {
  await expect(checkPackBudget(pack([], 200_001), limits)).rejects.toMatchObject({ code: "object_budget" });
});
test("the zlib decoder caps actual bytes even when a pack lies about its size", async () => {
  await expect(checkPackBudget(pack([entry(3, Buffer.alloc(32, 1), 1)]), limits)).rejects.toMatchObject({ code: "object_budget" });
  await expect(checkPackBudget(pack([entry(3, Buffer.alloc(65, 1))]), limits)).rejects.toMatchObject({ code: "object_budget" });
});
test("malformed size, streams, checksum and trailing data cannot cross preflight", async () => {
  const valid = pack([entry(3, Buffer.from("x"))]); const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1]! ^= 1;
  for (const data of [corrupt, pack([Buffer.from([0xff])]), pack([entry(3, Buffer.from("x")), Buffer.from([0])], 1), pack([entry(0, Buffer.from("x"))])])
    await expect(checkPackBudget(data, limits)).rejects.toMatchObject({ code: "invalid_bundle" });
});
test("a cancelled preflight never proceeds with object decoding", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(checkPackBudget(pack([entry(3, Buffer.from("x"))]), limits, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
});
