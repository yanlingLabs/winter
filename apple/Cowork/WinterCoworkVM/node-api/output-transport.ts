import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

/** Structurally identical to the SDK's host-only HostOutputTransport capability.
 * The trusted host verifies the packaged addon path/hash/signature before
 * composing this factory. Runtime RPC can never nominate a factory or FD. */
export interface NativeHostOutputTransport {
  readonly stdoutFd: number;
  readonly stderrFd: number;
  closeWriters(): void;
  pause(): void;
  resume(): void;
  start(onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): Promise<unknown>;
  dispose(): void;
  statistics(): { pendingBytes: number; peakPendingBytes: number; readCalls: number; chunkLimit: number; sharedReaders: number; paused: boolean; flagsVerified: boolean };
}
export function createNativeHostOutputTransportFactory(verifiedAddonPath: string): () => Promise<NativeHostOutputTransport> {
  if (!isAbsolute(verifiedAddonPath)) throw new Error("A verified protected absolute native addon path is required");
  const addon = createRequire(import.meta.url)(verifiedAddonPath);
  if (typeof addon.createOutputTransport !== "function") throw new Error("Packaged native output transport capability is unavailable");
  return async () => addon.createOutputTransport();
}
