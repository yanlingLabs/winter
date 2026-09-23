// WS-21 (Contract C): the daemon's readers and writers of the two claude-format files in the shared
// runtime home — `<home>/sdk/settings.json` (claude `Settings`) and `<home>/sdk/.winter.json` (claude's
// `.claude.json` shape: user `mcpServers`, local-scope `projects[<abs root>].mcpServers`).
//
// Both files are also the USER's (spec §2.2: "Written by: daemon; the user"), so:
//
//  - Reads never throw. A missing file is `{}`; an unparseable one (a hand edit in progress, a torn
//    write by some other tool) is reported through the `…Detailed` readers and read as `{}` by the
//    plain ones. Feature code reads through `liveSdkSettings`/`liveSdkGlobalConfig`, which keep the
//    last good version across an unparseable one (see "Live reads" below); the settings watcher
//    (`SdkFilesWatcher`, `settings-watcher.ts`) only adds a debounced notification on top.
//  - Writes are read-modify-write through a mutator and REFUSE to clobber a file that exists but does
//    not parse (`SdkFileUnreadable`): replacing a half-edited file with `{…one key…}` would silently
//    discard every other setting the user had.
//  - Writes are atomic: a sibling temp file (0600, `wx`), fsync, then `rename` over the target, so a
//    concurrent reader — the watcher, a runtime child, the user's editor — sees either the old bytes or
//    the new ones, never a prefix. The directory is created 0700 when missing.
//
// Callers in this process are single-threaded and every update is synchronous from read to rename, so
// two in-process writers cannot interleave. A writer in ANOTHER process (the CLI with no daemon, the
// user) is last-writer-wins — exactly claude's own discipline for these files (F15).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { sdkGlobalConfigPath, sdkSettingsPath } from "./agent/paths";

/** claude `Settings`, as far as the daemon reads or writes it. Every other key is preserved verbatim. */
export interface SdkSettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
    [key: string]: unknown;
  };
  outputStyle?: string;
  autoMemoryEnabled?: boolean;
  autoMemoryDirectory?: string;
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

/** claude's `.claude.json` (`sdk/.winter.json`), as far as the daemon reads or writes it. */
export interface SdkGlobalConfigFile {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown>; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type SdkFileRead<T> =
  | { state: "ok"; value: T }
  | { state: "missing" }
  | { state: "invalid"; reason: string };

/** A write refused because the file on disk exists but is not a JSON object. The message names the
 *  file and the parse failure's CLASS only — never its content, which may hold a secret. */
export class SdkFileUnreadable extends Error {
  readonly code = "sdk_file_unreadable";
  constructor(readonly path: string, readonly reason: string) {
    super(`${path} is not a readable JSON object (${reason}); fix or remove it, then retry — it was left untouched`);
    this.name = "SdkFileUnreadable";
  }
}

function readJsonObjectDetailed<T>(path: string): SdkFileRead<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "invalid", reason: code ?? "unreadable" };
  }
  if (raw.trim() === "") return { state: "invalid", reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "invalid", reason: "not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "invalid", reason: "not a JSON object" };
  return { state: "ok", value: parsed as T };
}

/**
 * Atomic write: temp file beside the target (0600, exclusive create), fsync, rename. The parent
 * directory is created 0700 when missing. On any failure the temp file is removed and the target is
 * untouched.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

function updateJsonObject<T extends Record<string, unknown>>(path: string, mutate: (current: T) => T): T {
  const read = readJsonObjectDetailed<T>(path);
  if (read.state === "invalid") throw new SdkFileUnreadable(path, read.reason);
  const current = read.state === "ok" ? read.value : ({} as T);
  // The mutator gets a deep copy: a mutator that edits in place and then throws must not have
  // changed anything a caller still holds.
  const next = mutate(structuredClone(current));
  writeJsonAtomic(path, next);
  remember(path, next);
  return next;
}

// ── Live reads (keep-last-good) ──────────────────────────────────────────────────────────────────
//
// The daemon's feature code reads these files through the `live…` readers below, at the moment it
// needs a value (a spawn, an RPC) — never a boot snapshot, so an edit reaches the next read with no
// restart. Each read costs one `stat`: the parsed value is cached against the file's identity
// (inode, mtime, size), and re-parsed only when that changes. A file that exists but does not parse —
// a hand edit caught half-saved — keeps the LAST GOOD value (the same keep-last-good posture as the
// settings watcher), is reported once per distinct bad version, and is retried on the next read. A
// missing file is a real state (the user deleted it) and reads as `{}`.
interface LiveEntry { sig: string; value: Record<string, unknown> }
const live = new Map<string, LiveEntry>();
const reportedInvalid = new Set<string>();

function signatureOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

function remember(path: string, value: Record<string, unknown>): void {
  live.set(path, { sig: signatureOf(path), value });
}

function liveRead<T extends Record<string, unknown>>(path: string): T {
  const sig = signatureOf(path);
  const hit = live.get(path);
  if (hit !== undefined && hit.sig === sig) return hit.value as T;
  const r = readJsonObjectDetailed<T>(path);
  if (r.state === "ok") { live.set(path, { sig, value: r.value }); return r.value; }
  if (r.state === "missing") { live.set(path, { sig, value: {} }); return {} as T; }
  const key = `${path}\u0000${sig}`;
  if (!reportedInvalid.has(key)) {
    reportedInvalid.add(key);
    if (reportedInvalid.size > 256) reportedInvalid.clear();
    console.error(`sdk-files: ${path} is not a readable JSON object (${r.reason}) — keeping the last good version`);
  }
  return (hit?.value ?? {}) as T;
}

/** `sdk/settings.json` as the daemon reads it now: live, cached, keep-last-good. Treat as READ-ONLY. */
export function liveSdkSettings(home: string): SdkSettingsFile {
  return liveRead<SdkSettingsFile>(sdkSettingsPath(home));
}

/** `sdk/.winter.json` as the daemon reads it now: live, cached, keep-last-good. Treat as READ-ONLY. */
export function liveSdkGlobalConfig(home: string): SdkGlobalConfigFile {
  return liveRead<SdkGlobalConfigFile>(sdkGlobalConfigPath(home));
}

/** `sdk/settings.json` with its state (`ok`/`missing`/`invalid`). */
export function readSdkSettingsDetailed(home: string): SdkFileRead<SdkSettingsFile> {
  return readJsonObjectDetailed<SdkSettingsFile>(sdkSettingsPath(home));
}

/** `sdk/settings.json`, or `{}` when missing or unparseable. Never throws. */
export function readSdkSettings(home: string): SdkSettingsFile {
  const r = readSdkSettingsDetailed(home);
  return r.state === "ok" ? r.value : {};
}

/** Read-modify-write `sdk/settings.json` atomically (0600). Throws `SdkFileUnreadable` rather than
 *  replace a file that exists but does not parse. Returns what was written. */
export function updateSdkSettings(home: string, mutate: (current: SdkSettingsFile) => SdkSettingsFile): SdkSettingsFile {
  return updateJsonObject<SdkSettingsFile>(sdkSettingsPath(home), mutate);
}

/** `sdk/.winter.json` with its state (`ok`/`missing`/`invalid`). */
export function readSdkGlobalConfigDetailed(home: string): SdkFileRead<SdkGlobalConfigFile> {
  return readJsonObjectDetailed<SdkGlobalConfigFile>(sdkGlobalConfigPath(home));
}

/** `sdk/.winter.json`, or `{}` when missing or unparseable. Never throws. */
export function readSdkGlobalConfig(home: string): SdkGlobalConfigFile {
  const r = readSdkGlobalConfigDetailed(home);
  return r.state === "ok" ? r.value : {};
}

/** Read-modify-write `sdk/.winter.json` atomically (0600). Same refusal as `updateSdkSettings`. */
export function updateSdkGlobalConfig(home: string, mutate: (current: SdkGlobalConfigFile) => SdkGlobalConfigFile): SdkGlobalConfigFile {
  return updateJsonObject<SdkGlobalConfigFile>(sdkGlobalConfigPath(home), mutate);
}

/** Invalidate the cached parse of `path`, so the next live read re-reads the file even if its
 *  identity (inode, mtime, size) happens not to have changed — an in-place same-size rewrite within
 *  one mtime tick. The last good VALUE is kept, so a file that is unparseable at that moment still
 *  reads as its last good version. The settings watcher calls it on every settled change. */
export function forgetSdkFile(path: string): void {
  const entry = live.get(path);
  if (entry !== undefined) live.set(path, { sig: "", value: entry.value });
}
