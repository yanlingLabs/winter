import { dlopen, FFIType } from "bun:ffi";
import { CoworkError } from "./types";

export interface ResolvedFolderBookmark { path: string; close(): void }
export type FolderBookmarkResolver = (data: Buffer) => ResolvedFolderBookmark;
let native: ReturnType<typeof load> | undefined;
function load() {
  const ref = FFIType.u64; // CF references may be tagged; never round them through JS numbers.
  return dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFDataCreate: { args: [ref, FFIType.ptr, FFIType.i64], returns: ref },
    CFURLCreateByResolvingBookmarkData: { args: [ref, ref, FFIType.u64, ref, ref, FFIType.ptr, FFIType.ptr], returns: ref },
    CFURLCopyScheme: { args: [ref], returns: ref },
    CFStringGetCString: { args: [ref, FFIType.ptr, FFIType.i64, FFIType.u32], returns: FFIType.bool },
    CFURLGetFileSystemRepresentation: { args: [ref, FFIType.bool, FFIType.ptr, FFIType.i64], returns: FFIType.bool },
    CFURLStartAccessingSecurityScopedResource: { args: [ref], returns: FFIType.bool },
    CFURLStopAccessingSecurityScopedResource: { args: [ref], returns: FFIType.void },
    CFRelease: { args: [ref], returns: FFIType.void },
  });
}
/** No UI, mounting, bookmark refresh or stale adoption. Implicit Mac-picker bookmarks can cross
 * processes; app-scoped explicit bookmarks are not presumed to delegate scope to this daemon. */
export const resolveMacFolderBookmark: FolderBookmarkResolver = data => {
  if (process.platform !== "darwin") throw new CoworkError("unsupported_topology");
  native ??= load(); const cf = native.symbols;
  const bookmark = BigInt(cf.CFDataCreate(0n, data, BigInt(data.length)));
  if (bookmark === 0n) throw new CoworkError("authority_denied");
  let url = 0n, accessing = false, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    if (accessing) cf.CFURLStopAccessingSecurityScopedResource(url);
    if (url !== 0n) cf.CFRelease(url);
    cf.CFRelease(bookmark);
  };
  try {
    const stale = Buffer.alloc(1);
    // withoutUI | withoutMounting | withoutImplicitStartAccessing (SDK CFURL.h).
    url = BigInt(cf.CFURLCreateByResolvingBookmarkData(0n, bookmark, 0x8300n, 0n, 0n, stale, null));
    if (url === 0n || stale[0] !== 0) throw new CoworkError("authority_denied");
    const scheme = BigInt(cf.CFURLCopyScheme(url)), bytes = Buffer.alloc(16);
    try {
      if (scheme === 0n || !cf.CFStringGetCString(scheme, bytes, BigInt(bytes.length), 0x08000100) || bytes.toString("utf8", 0, bytes.indexOf(0)) !== "file") throw new CoworkError("authority_denied");
    } finally { if (scheme !== 0n) cf.CFRelease(scheme); }
    accessing = cf.CFURLStartAccessingSecurityScopedResource(url);
    // False can mean no scope is needed by an unsandboxed local daemon. Actual directory open
    // and permissions still must succeed; this never reports a granted sandbox extension.
    const path = Buffer.alloc(4096);
    if (!cf.CFURLGetFileSystemRepresentation(url, true, path, BigInt(path.length))) throw new CoworkError("authority_denied");
    const end = path.indexOf(0);
    if (end <= 0) throw new CoworkError("authority_denied");
    return { path: path.toString("utf8", 0, end), close };
  } catch { close(); throw new CoworkError("authority_denied"); }
};
