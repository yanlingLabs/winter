// ComputerV2 Phase 4 — what Winter Headless's memory IS, for the pool's memory guard: the sum of each of its processes'
// PHYSICAL FOOTPRINT (the browser, the GPU and network processes, every renderer — the helper and every process under
// it), the number Activity Monitor shows as a process's "Memory".
//
// Not the sum of each process's resident size: Chromium's processes all map the same framework, so a resident-size sum
// counts its shared pages once per process. Measured (M-series, the live drill's pages, 2026-10-12): one tab read
// ~870 MiB that way and ~540 MiB as footprint; 24 plain pages ~3.0 GiB vs ~1.4 GiB; 24 media-heavy pages (WebGL,
// canvas, big SVGs) ~4.4 GiB vs ~3.3 GiB. The footprint also counts what the GPU process holds for the pages (their
// surfaces and WebGL buffers, ~37 MiB a media-heavy tab), which a resident size alone does not show.
//
// Read through libproc over bun:ffi (`proc_listchildpids` for the tree, `proc_pid_rusage` for each process's
// `ri_phys_footprint`) — microseconds, no process started, allowed for the daemon's own children. Where that library
// can't be reached, the old reading (a resident-size sum from one `ps`) stands in: it can only read HIGH, never hide
// memory.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { spawnSync } from "node:child_process";

/** How one process tree is walked and weighed (the pure part; `processTreeFootprint` binds it to libproc). */
export interface TreeReader {
  /** The process's direct children, or `undefined` when they can't be listed. */
  children(pid: number): number[] | undefined;
  /** The process's physical footprint, bytes, or `undefined` when there is no such process (it just exited). */
  footprint(pid: number): number | undefined;
}

/** The tree's footprint, bytes — `undefined` when the root itself can't be read (gone). A child that exits mid-walk
 *  counts nothing. */
export function treeFootprint(rootPid: number, reader: TreeReader): number | undefined {
  const root = reader.footprint(rootPid);
  if (root === undefined) return undefined;
  let total = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += pid === rootPid ? root : (reader.footprint(pid) ?? 0);
    for (const child of reader.children(pid) ?? []) if (!seen.has(child)) stack.push(child);
  }
  return total;
}

interface LibProc {
  proc_pid_rusage(pid: number, flavor: number, buffer: ReturnType<typeof ptr>): number;
  proc_listchildpids(pid: number, buffer: ReturnType<typeof ptr>, size: number): number;
}

let libproc: LibProc | null | undefined;

function lib(): LibProc | null {
  if (libproc !== undefined) return libproc;
  if (process.platform !== "darwin") { libproc = null; return libproc; }
  try {
    const l = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    libproc = l.symbols as unknown as LibProc;
  } catch {
    libproc = null;
  }
  return libproc;
}

/** `RUSAGE_INFO_V4`: `struct rusage_info_v4` — `ri_uuid[16]`, then u64s; `ri_phys_footprint` is the eighth (offset 72). */
const RUSAGE_INFO_V4 = 4;
const PHYS_FOOTPRINT_OFFSET = 72;
const RUSAGE_BUFFER_BYTES = 512; // sizeof(struct rusage_info_v4) is 296; room to spare

/** libproc's reading of one process tree (the daemon's own children: no privilege needed). */
export const libprocReader: TreeReader = {
  footprint(pid) {
    const l = lib();
    if (l === null) return undefined;
    const buf = Buffer.alloc(RUSAGE_BUFFER_BYTES);
    if (l.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buf)) !== 0) return undefined;
    return Number(buf.readBigUInt64LE(PHYS_FOOTPRINT_OFFSET));
  },
  children(pid) {
    const l = lib();
    if (l === null) return undefined;
    // It answers how many pids it wrote; a full buffer may have been cut short, so it is asked again with more room.
    for (let room = 256; room <= 65_536; room *= 4) {
      const buf = new Int32Array(room);
      const n = l.proc_listchildpids(pid, ptr(buf), buf.byteLength);
      if (n < 0) return undefined;
      if (n < room) return [...buf.subarray(0, n)].filter((p) => p > 0);
    }
    return undefined;
  },
};

/** Is libproc reachable from this process (over bun:ffi)? */
export function libprocAvailable(): boolean { return lib() !== null; }

/** The helper's memory as a person reads it: its whole process tree's physical footprint, bytes (`undefined` when the
 *  helper is gone). The resident-size sum stands in only where libproc can't be reached. */
export function processTreeFootprint(rootPid: number): number | undefined {
  if (!libprocAvailable()) return processTreeRss(rootPid);
  return treeFootprint(rootPid, libprocReader);
}

/** The old reading: the whole process tree's resident memory, bytes, from one `ps` (`-A -o pid=,ppid=,rss=`). It counts
 *  the pages Chromium's processes share once per process — kept as the stand-in where libproc can't be reached, and for
 *  the live drill's comparison. */
export function processTreeRss(rootPid: number): number | undefined {
  const r = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } });
  if (r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]); const ppid = Number(m[2]);
    rss.set(pid, Number(m[3]) * 1024);
    const list = children.get(ppid);
    if (list === undefined) children.set(ppid, [pid]); else list.push(pid);
  }
  if (!rss.has(rootPid)) return undefined;
  return treeFootprint(rootPid, { footprint: (pid) => rss.get(pid), children: (pid) => children.get(pid) });
}
