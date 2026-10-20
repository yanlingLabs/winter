import { dlopen, FFIType } from "bun:ffi";

/*
 * A stable identity for the volume a path lives on: the APFS/HFS volume UUID (`getattrlist` with ATTR_VOL_UUID). `st_dev` is NOT used: it can change when a volume
 * is remounted or a disk is attached in another order, which would turn a harmless remount into a permanent `home_identity_mismatch`. Null when it cannot be read
 * (the caller refuses; nothing is guessed).
 */
const ATTR_BIT_MAP_COUNT = 5;
const ATTR_VOL_INFO = 0x80000000;
const ATTR_VOL_UUID = 0x00040000;
const FSOPT_NOFOLLOW = 0x00000001;

export interface VolumeUuidLibrary { query(path: string): Uint8Array | null }
let library: VolumeUuidLibrary | undefined;
function load(): VolumeUuidLibrary {
  if (library) return library;
  if (process.platform !== "darwin") throw new Error("unsupported_topology");
  const lib = dlopen("/usr/lib/libSystem.B.dylib", { getattrlist: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32], returns: FFIType.i32 } });
  library = {
    query(path) {
      // struct attrlist { u16 bitmapcount; u16 reserved; u32 commonattr, volattr, dirattr, fileattr, forkattr; }
      const list = Buffer.alloc(24);
      list.writeUInt16LE(ATTR_BIT_MAP_COUNT, 0); list.writeUInt32LE(0, 4); list.writeUInt32LE((ATTR_VOL_INFO | ATTR_VOL_UUID) >>> 0, 8);
      const out = Buffer.alloc(64);
      const status = lib.symbols.getattrlist!(Buffer.from(`${path}\0`), list, out, BigInt(out.length), FSOPT_NOFOLLOW) as number;
      return status === 0 ? Uint8Array.from(out) : null;
    },
  };
  return library;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Reply layout: u32 total length, then the 16 byte uuid. Anything shorter, a nil uuid or an inconsistent length is null. */
export function parseVolumeUuidReply(raw: Uint8Array | null): string | null {
  if (!raw || raw.length < 20) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) < 20) return null;
  const bytes = Buffer.from(raw.subarray(4, 20));
  if (bytes.every(byte => byte === 0)) return null;
  const hex = bytes.toString("hex");
  const text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return UUID.test(text) ? text : null;
}
/** `vol-<uuid>`, a ledger-safe id. */
export function readVolumeId(path: string, lib: VolumeUuidLibrary = { query: p => load().query(p) }): string | null {
  try { const uuid = parseVolumeUuidReply(lib.query(path)); return uuid === null ? null : `vol-${uuid}`; } catch { return null; }
}
