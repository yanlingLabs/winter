/** Bundle this exact existing parser for Node. The native bootstrap checks containment and
 * hard CPU/FD limits before exec; the owning host verifies this runtime and payload before input. */
import { createHash } from "node:crypto";
import { validateReadAdvertisement, validateUploadPackRequest, validateUploadPackResponse } from "./read-wire";
import { DEFAULT_GIT_READ_LIMITS, GitReadError } from "./read-types";

const headerBytes = 20, maximumBytes = 67_108_864;
async function main(): Promise<void> {
  process.stdout.write("WGH1\n");
  let header = Buffer.alloc(headerBytes), received = 0, length: number | undefined, body: Buffer | undefined;
  for await (const input of process.stdin) {
    const chunk = Buffer.from(input as Uint8Array); let offset = 0;
    if (received < headerBytes) {
      const copy = Math.min(chunk.length, headerBytes - received); chunk.copy(header, received, 0, copy); received += copy; offset = copy;
      if (received === headerBytes) {
        length = header.readUInt32BE(8);
        if (header.subarray(0, 4).toString() !== "WGP1" || ![1, 2, 3].includes(header[4]!) || header[5] || header[6] || header[7]
          || !length || length > (header[4] === 3 ? maximumBytes : 1_048_576) || !header.readUInt32BE(12) || header.readUInt32BE(12) > 10_000
          || !header.readUInt32BE(16) || header.readUInt32BE(16) > 67_108_864) throw new GitReadError("invalid_request");
        body = Buffer.allocUnsafe(length);
      }
    }
    if (offset < chunk.length) {
      if (!body || length === undefined || received - headerBytes + chunk.length - offset > length) throw new GitReadError("invalid_request");
      chunk.copy(body, received - headerBytes, offset); received += chunk.length - offset;
    }
  }
  if (!body || length === undefined || received !== headerBytes + length) throw new GitReadError("invalid_request");
  let status = 0;
  try {
    if (header[4] === 1) validateUploadPackRequest(body);
    else if (header[4] === 2) validateReadAdvertisement(body);
    else await validateUploadPackResponse(body, { ...DEFAULT_GIT_READ_LIMITS, objects: header.readUInt32BE(12), expandedObjectBytes: header.readUInt32BE(16) });
  } catch (error) { status = error instanceof GitReadError ? ({ invalid_request: 1, invalid_response: 2, budget_exceeded: 3 } as Record<string, number>)[error.code] ?? 2 : 2; }
  const receipt = Buffer.alloc(40); receipt.write("WGR1"); receipt.writeUInt32BE(status, 4); createHash("sha256").update(body).digest().copy(receipt, 8);
  await new Promise<void>((resolve, reject) => process.stdout.write(receipt, error => error ? reject(error) : resolve()));
}
void main().catch(() => { process.exitCode = 77; });
