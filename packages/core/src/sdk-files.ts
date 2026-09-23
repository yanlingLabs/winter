// WS-21 (Contract C): the daemon's readers and writers of the two claude-format files in the shared
// runtime home — `<home>/sdk/settings.json` (claude `Settings`) and `<home>/sdk/.winter.json` (claude's
// `.claude.json` shape: user `mcpServers`, local-scope `projects[<abs root>].mcpServers`).
//
// Both files are also the USER's (spec §2.2: "Written by: daemon; the user"), so:
//
//  - Reads never throw. A missing file is `{}`; an unparseable one (a hand edit in progress, a torn
//    write by some other tool) is reported through the `…Detailed` readers and read as `{}` by the
//    plain ones. Keep-last-good across a torn edit is the settings watcher's job (`settings-watcher.ts`),
//    not this module's.
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
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
  return next;
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
