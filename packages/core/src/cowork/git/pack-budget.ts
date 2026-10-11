import { createHash } from "node:crypto";
import { inflate } from "node:zlib";
import { GitPublicationError } from "./types";

const fail = (code: "object_budget" | "invalid_bundle" | "cancelled"): never => { throw new GitPublicationError(code); };
type Inflated = { buffer: Buffer; engine: { bytesWritten: number } };

/** Preflight the bounded SHA-1 full pack BEFORE Git can expand a delta chain.
 * This bounds declared reconstructed sizes and bounded zlib output, not native
 * Git's total RSS or CPU. Git/fsck still validate object identities and graphs.
 * Format: https://git-scm.com/docs/pack-format */
export async function checkPackBudget(pack: Uint8Array, limits: { objects: number; expandedObjectBytes: number }, signal?: AbortSignal): Promise<void> {
  const data = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength), end = data.length - 20;
  if (data.length < 32 || data.subarray(0, 4).toString() !== "PACK" || ![2, 3].includes(data.readUInt32BE(4))) fail("invalid_bundle");
  const count = data.readUInt32BE(8);
  if (count > limits.objects) fail("object_budget");
  if (!count || !createHash("sha1").update(data.subarray(0, end)).digest().equals(data.subarray(end))) fail("invalid_bundle");
  let offset = 12, expanded = 0, programs = 0;
  const objectOffsets = new Set<number>();
  const byte = (): number => { if (offset >= end) fail("invalid_bundle"); return data[offset++]!; };
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) fail("cancelled");
    const start = offset; objectOffsets.add(start);
    let header = byte(); const type = (header >> 4) & 7;
    let size = header & 15, multiplier = 16;
    while (header & 128) {
      header = byte(); size += (header & 127) * multiplier;
      if (!Number.isSafeInteger(size) || size > limits.expandedObjectBytes) fail("object_budget");
      multiplier *= 128;
      if (!Number.isSafeInteger(multiplier) && (header & 128)) fail("invalid_bundle");
    }
    if (![1, 2, 3, 4, 6, 7].includes(type)) fail("invalid_bundle");
    if (size > limits.expandedObjectBytes) fail("object_budget");
    const delta = type === 6 || type === 7;
    if (type === 6) {
      let encoded = byte(), distance = encoded & 127;
      while (encoded & 128) {
        encoded = byte(); distance = (distance + 1) * 128 + (encoded & 127);
        if (!Number.isSafeInteger(distance) || distance > start - 12) fail("invalid_bundle");
      }
      if (distance < 1 || !objectOffsets.has(start - distance)) fail("invalid_bundle");
    } else if (type === 7) {
      if (offset + 20 > end) fail("invalid_bundle"); offset += 20;
    }
    if (delta) { programs += size; if (programs > limits.expandedObjectBytes) fail("object_budget"); }
    else { expanded += size; if (expanded > limits.expandedObjectBytes) fail("object_budget"); }
    let result: Inflated;
    try {
      // maxOutputLength is enforced by the native convenience decoder; a stream
      // callback after expansion would be too late to bound an inflated buffer.
      result = await new Promise<Inflated>((resolve, reject) => inflate(data.subarray(offset, end),
        { info: true, maxOutputLength: Math.max(1, size) }, (error, output) => error ? reject(error) : resolve(output as unknown as Inflated)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") fail("object_budget");
      fail("invalid_bundle");
    }
    if (signal?.aborted) fail("cancelled");
    const consumed = result!.engine?.bytesWritten;
    if (!Buffer.isBuffer(result!.buffer) || result!.buffer.length !== size || !Number.isSafeInteger(consumed) || consumed < 1 || offset + consumed > end) fail("invalid_bundle");
    offset += consumed;
    if (delta) {
      let cursor = 0;
      const deltaSize = (): number => {
        let value = 0, multiplier = 1, part: number;
        do {
          if (cursor >= result!.buffer.length) fail("invalid_bundle");
          part = result!.buffer[cursor++]!; value += (part & 127) * multiplier;
          if (!Number.isSafeInteger(value) || value > limits.expandedObjectBytes) fail("object_budget");
          multiplier *= 128;
          if (!Number.isSafeInteger(multiplier) && (part & 128)) fail("invalid_bundle");
        } while (part & 128);
        return value;
      };
      deltaSize(); // Source must also fit, even when represented by another delta.
      expanded += deltaSize();
      if (!Number.isSafeInteger(expanded) || expanded > limits.expandedObjectBytes) fail("object_budget");
    }
  }
  if (offset !== end) fail("invalid_bundle");
}
