import { createHash } from "node:crypto";
import { GitPublicationError } from "./types";

/*
 * Bundle intake: how a feature branch's commits get from the guest to the host in N2.
 *
 * N2 has no virtio-fs, no vsock and no guest network. The one channel is the guest FILE CHANNEL (stat, ranged read), which
 * is host-initiated: the host asks, the guest answers bounded bytes. So the guest writes a FULL git bundle to a path the
 * HOST chose, and the host pulls it with `stat` + sequential `readRange`, then hands the bytes to the publication broker
 * (which re-verifies everything: header, pack budget, fsck, ancestry). Nothing here gives the guest a way to reach a
 * remote, and nothing here pushes: the push is the host-side transport, behind the broker.
 *
 * The port below is STRUCTURAL on purpose. The guest file channel's own anti-wiring pin forbids any other src file from
 * naming that module, so the real client is proven assignable to this port in a test, not by an import. Everything the
 * port returns is untrusted guest bytes and is checked as such: binding echo, generation pinning, contiguous offsets,
 * exact end of file, strict base64-free decoding done by the channel, and a second stat after the last byte.
 */

/** What every channel call binds. The HOST derives all of it; none of it comes from the guest. */
export interface PublishBundleBinding {
  readonly workspaceId: string; readonly sessionId: string; readonly locationId: string; readonly relativePath: string;
  readonly incarnationId: string; readonly sourceRevision: number;
}
export interface PublishBundleStat extends PublishBundleBinding { readonly generation: string; readonly bytes: number; readonly kind: "file" }
export interface PublishBundleChunk extends PublishBundleStat {
  readonly offset: number; readonly nextOffset: number; readonly eof: boolean; readonly content: Uint8Array;
}
export interface PublishBundlePort {
  stat(input: PublishBundleBinding, options?: { readonly signal?: AbortSignal }): Promise<PublishBundleStat>;
  readRange(input: PublishBundleBinding & { readonly expectedGeneration: string; readonly offset: number; readonly maxBytes?: number },
    options?: { readonly signal?: AbortSignal }): Promise<PublishBundleChunk>;
}

export const PUBLISH_CHUNK_BYTES = 256 * 1024;
const BINDING_KEYS = ["workspaceId", "sessionId", "locationId", "relativePath", "incarnationId", "sourceRevision"] as const;
const GENERATION = /^[a-f0-9]{64}$/;

const fail = (code: ConstructorParameters<typeof GitPublicationError>[0]): never => { throw new GitPublicationError(code); };
function sameBinding(a: PublishBundleBinding, b: PublishBundleBinding): boolean { return BINDING_KEYS.every(key => a[key] === b[key]); }

/** The path the host asks for: derived from the request id alone, under a fixed staging directory. The guest never names it. */
export function publishBundlePath(requestId: string): string {
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return fail("invalid_request");
  return `.winter-publish/${requestId}.bundle`;
}

export interface PulledBundle { readonly bytes: Uint8Array; readonly sha256: string; readonly generation: string }

/** Pull one bundle. Any fault is a typed `GitPublicationError` that carries no guest text. */
export async function pullPublishBundle(port: PublishBundlePort, binding: PublishBundleBinding, limits: { readonly maxBytes: number; readonly chunkBytes?: number }, signal?: AbortSignal): Promise<PulledBundle> {
  const chunkBytes = limits.chunkBytes ?? PUBLISH_CHUNK_BYTES;
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > PUBLISH_CHUNK_BYTES) return fail("invalid_request");
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) return fail("cancelled");
    try { return await call(); } catch (error) {
      if (error instanceof GitPublicationError) throw error;
      if (signal?.aborted) return fail("cancelled");
      return fail("bundle_unavailable");
    }
  };
  const options = { signal };
  const first = await guard(() => port.stat(binding, options));
  if (!first || first.kind !== "file" || !sameBinding(first, binding) || !GENERATION.test(first.generation) || !Number.isSafeInteger(first.bytes) || first.bytes < 1) return fail("bundle_unavailable");
  // The size budget is judged BEFORE one byte is read.
  if (first.bytes > limits.maxBytes) return fail("object_budget");
  const out = new Uint8Array(first.bytes), hash = createHash("sha256");
  let offset = 0;
  while (offset < first.bytes) {
    const want = Math.min(chunkBytes, first.bytes - offset);
    const chunk = await guard(() => port.readRange({ ...binding, expectedGeneration: first.generation, offset, maxBytes: want }, options));
    if (!chunk || !sameBinding(chunk, binding) || chunk.generation !== first.generation || chunk.bytes !== first.bytes || chunk.kind !== "file") return fail("bundle_stale");
    const length = chunk.content?.length;
    // Contiguous, non-empty, never more than asked, never past the stat'ed size, EOF exactly where the size ends.
    if (!(chunk.content instanceof Uint8Array) || chunk.offset !== offset || length < 1 || length > want || chunk.nextOffset !== offset + length
      || chunk.eof !== (offset + length === first.bytes)) return fail("bundle_unavailable");
    out.set(chunk.content, offset); hash.update(chunk.content); offset += length;
  }
  // Sandwich: the file the guest reports now is the file it reported first.
  const last = await guard(() => port.stat(binding, options));
  if (!last || last.kind !== "file" || !sameBinding(last, binding) || last.generation !== first.generation || last.bytes !== first.bytes) return fail("bundle_stale");
  return { bytes: out, sha256: hash.digest("hex"), generation: first.generation };
}
