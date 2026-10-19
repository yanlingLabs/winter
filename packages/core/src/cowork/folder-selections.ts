import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { openDirAt, AT_FDCWD } from "../computer-use/browser/fd-fs";
import { canonicalizeForWrite } from "../agent/paths";
import { CoworkError, type SourceAccess, type SourceSelection } from "./types";
import { CoworkFolderGrants } from "./folder-grants";
import type { WorkspaceSource } from "./types";
import type { CoworkPrincipal } from "./authority";
import { resolveMacFolderBookmark, type FolderBookmarkResolver, type ResolvedFolderBookmark } from "./folder-bookmark";

export interface PreparedFolder { selectionId: string; kind: "folder"; label: string; access: SourceAccess; state: "prepared"; expiresAt: string }
interface Entry { owner: string; connectionId: number; bookmark: Buffer; scoped: ResolvedFolderBookmark; fd: number; path: string; identity: string; selection: Extract<SourceSelection, { kind: "folder" }>; expires: number; expiresAt: string }
export interface FolderSelectionOptions {
  /** Host-generated/current protected roots. Includes all owning homes, coordination and credential roots. */
  protectedRoots(): readonly string[];
  resolver?: FolderBookmarkResolver;
  now?: () => number;
  ttlMs?: number;
  durable?: CoworkFolderGrants;
}
const denied = () => { throw new CoworkError("authority_denied"); };
function identity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isDirectory()) return denied();
  return `${stat.dev}:${stat.ino}`;
}
/** Walk every component with descriptor-relative no-follow opens; no writable share or file handle
 * escapes this class. A preparation is an ephemeral host-owned grant, never a ready source. */
function directory(path: string): number {
  let fd = openDirAt(AT_FDCWD, "/");
  try {
    for (const name of path.split("/").filter(Boolean)) {
      const child = openDirAt(fd, name); closeSync(fd); fd = child;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
export class CoworkFolderSelections {
  private closed = false;
  private readonly entries = new Map<string, Entry>();
  private readonly requests = new Map<string, { digest: string; selectionId: string; owner: string; connectionId: number }>();
  private readonly grantIds = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttl: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly options: FolderSelectionOptions) {
    this.now = options.now ?? (() => performance.now());
    this.ttl = options.ttlMs ?? 5 * 60_000;
    if (!Number.isFinite(this.ttl) || this.ttl < 1 || this.ttl > 5 * 60_000) throw new CoworkError("invalid_request");
    // No timer until a selection exists (a production daemon never creates one): armed by `arm()` on the first entry, cleared when the map empties.
  }
  private arm() { if (this.timer || this.closed) return; this.timer = setInterval(() => this.sweep(), Math.min(this.ttl, 10_000)); this.timer.unref(); }
  private owner(principal: CoworkPrincipal) { if (principal.kind !== "local-user") return denied(); return principal.id; }
  private checkPolicy(canonical: string): void {
    const target = canonical.toLowerCase();
    for (const root of this.options.protectedRoots()) {
      for (const spelling of [resolve(root), canonicalizeForWrite(resolve(root))]) {
        const p=spelling.toLowerCase();
        if (target===p || target.startsWith(p+"/") || p.startsWith(target==="/"?"/":target+"/")) return denied();
      }
    }
  }
  private checkRoot(path: string): string {
    if (!isAbsolute(path) || path.includes("\0")) return denied();
    const canonical = realpathSync(path); this.checkPolicy(canonical);
    return canonical;
  }
  prepare(principal: CoworkPrincipal, connectionId: number, bookmarkBase64: string, label: string, access: SourceAccess, requestId: string = randomUUID()): PreparedFolder {
    if (this.closed) return denied();
    const owner = this.owner(principal); this.sweep();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(requestId)) throw new CoworkError("invalid_request");
    const key = JSON.stringify([owner, connectionId, requestId]), digest = createHash("sha256").update(JSON.stringify([bookmarkBase64, label, access])).digest("hex");
    const prior = this.requests.get(key);
    if (prior) {
      if (prior.digest !== digest) throw new CoworkError("request_conflict");
      const entry = this.entries.get(prior.selectionId);
      if (!entry) return denied(); // Expiry/revocation cannot mint or extend a replayed grant.
      try { this.validate(entry); } catch { this.drop(prior.selectionId); return denied(); }
      return { selectionId: prior.selectionId, kind: "folder", label, access, state: "prepared", expiresAt: entry.expiresAt };
    }
    if (this.requests.size >= 4096) return denied(); // Bounded receipts until disconnect, never evict into re-granting.
    if (!Number.isSafeInteger(connectionId) || connectionId < 1 || this.entries.size >= 128 || [...this.entries.values()].filter(e => e.owner === owner && e.connectionId === connectionId).length >= 16) return denied();
    const bookmark = Buffer.from(bookmarkBase64, "base64");
    if (bookmark.length === 0 || bookmark.length > 64 * 1024 || bookmark.toString("base64") !== bookmarkBase64 || !["read-only", "read-write"].includes(access) || !label.trim() || label.length > 200 || /[\0\r\n]/.test(label)) throw new CoworkError("invalid_request");
    let scoped: ResolvedFolderBookmark | undefined, fd: number | undefined;
    try {
      scoped = (this.options.resolver ?? resolveMacFolderBookmark)(bookmark);
      const path = this.checkRoot(scoped.path); fd = directory(path);
      accessSync(path, constants.R_OK | constants.X_OK | (access === "read-write" ? constants.W_OK : 0));
      const observed = identity(fd), selectionId = randomUUID(), grantRef = randomUUID(), expires = this.now() + this.ttl;
      const expiresAt = new Date(Date.now() + this.ttl).toISOString();
      const entry: Entry = { owner, connectionId, bookmark, scoped, fd, path, identity: observed, expires, expiresAt,
        selection: { kind: "folder", label, access, detail: { grantRef, rootIdentity: randomUUID() } } };
      this.validate(entry); // Re-resolve/reopen after all intake work, before publishing the grant.
      this.entries.set(selectionId, entry); this.grantIds.set(grantRef, selectionId); this.arm();
      this.requests.set(key, { digest, selectionId, owner, connectionId });
      return { selectionId, kind: "folder", label, access, state: "prepared", expiresAt };
    } catch { if (fd !== undefined) closeSync(fd); scoped?.close(); return denied(); }
  }
  private validate(entry: Entry): void {
    if (this.now() >= entry.expires || identity(entry.fd) !== entry.identity) return denied();
    const resolved = (this.options.resolver ?? resolveMacFolderBookmark)(entry.bookmark);
    let fd: number | undefined;
    try {
      const path = this.checkRoot(resolved.path);
      // Relocation/replacement never silently becomes the same grant.
      if (path !== entry.path) return denied();
      fd = directory(path);
      accessSync(path, constants.R_OK | constants.X_OK | (entry.selection.access === "read-write" ? constants.W_OK : 0));
      if (identity(fd) !== entry.identity) return denied();
    } finally { if (fd !== undefined) closeSync(fd); resolved.close(); }
  }
  selection(principal: CoworkPrincipal, connectionId: number, id: string): SourceSelection | undefined {
    if (this.closed) return undefined;
    const owner = this.owner(principal); this.sweep(); const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner || entry.connectionId !== connectionId) return undefined;
    try { this.validate(entry); return structuredClone(entry.selection); } catch { this.drop(id); return undefined; }
  }
  /** Native preflight before the repository starts its IMMEDIATE mutation. */
  prepareConsumption(principal: CoworkPrincipal, connectionId: number, id: string): { bind(source: WorkspaceSource): void; committed(): void } {
    const owner = this.owner(principal), entry = this.entries.get(id), durable = this.options.durable;
    if (this.closed || !durable || !entry || entry.owner !== owner || entry.connectionId !== connectionId || durable.consumed(id)) return denied();
    this.validate(entry);
    let bound = false;
    return {
      bind: source => {
        if (this.closed || this.entries.get(id) !== entry || this.now() >= entry.expires || identity(entry.fd) !== entry.identity) return denied();
        this.checkPolicy(entry.path);
        durable.bind(source, owner, id, {
          bookmark: entry.bookmark, path: entry.path, identity: entry.identity,
          rootIdentity: entry.selection.detail.rootIdentity, grantRef: entry.selection.detail.grantRef, access: entry.selection.access,
        });
        bound = true;
      },
      committed: () => { if (bound && durable.consumed(id)) this.drop(id); },
    };
  }
  folder(grantRef: string) {
    if (this.closed) return undefined;
    this.sweep(); const id = this.grantIds.get(grantRef), entry = id ? this.entries.get(id) : undefined;
    if (!entry) {
      const grant = this.options.durable?.get(grantRef);
      if (!grant) return undefined;
      let scoped: ResolvedFolderBookmark | undefined, fd: number | undefined;
      try {
        scoped = (this.options.resolver ?? resolveMacFolderBookmark)(grant.bookmark);
        const path = this.checkRoot(scoped.path);
        if (path !== grant.path) return denied();
        fd = directory(path);
        if (identity(fd) !== grant.identity) return denied();
        accessSync(path, constants.R_OK | constants.X_OK | (grant.access === "read-write" ? constants.W_OK : 0));
        // Final reopen/descriptor comparison after all intake work; no replacement adoption.
        const second = directory(path);
        try { if (identity(second) !== grant.identity) return denied(); } finally { closeSync(second); }
        return { rootIdentity: grant.rootIdentity, writable: grant.access === "read-write", revoked: false };
      } catch {
        this.options.durable!.invalidate(grant);
        return undefined;
      } finally {
        if (fd !== undefined) closeSync(fd);
        scoped?.close(); grant.bookmark.fill(0);
      }
    }
    try { this.validate(entry); return { rootIdentity: entry.selection.detail.rootIdentity, writable: entry.selection.access === "read-write", revoked: false }; }
    catch { this.drop(id!); return undefined; }
  }
  revoke(principal: CoworkPrincipal, connectionId: number, id: string): void {
    const owner = this.owner(principal), entry = this.entries.get(id);
    if (this.options.durable?.consumed(id)) return; // UI cleanup cannot revoke an accepted source grant.
    if (!entry) {
      if ([...this.requests.values()].some(r => r.selectionId === id && r.owner === owner && r.connectionId === connectionId)) return;
      return denied();
    }
    if (entry.owner !== owner || entry.connectionId !== connectionId) return denied();
    this.drop(id);
  }
  private drop(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); this.grantIds.delete(entry.selection.detail.grantRef);
    try { closeSync(entry.fd); } finally { entry.scoped.close(); entry.bookmark.fill(0); }
  }
  private sweep() {
    for (const [id, e] of this.entries) if (this.now() >= e.expires) this.drop(id);
    if (this.entries.size === 0 && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }
  closeConnection(connectionId: number) { for (const [id, e] of this.entries) if (e.connectionId === connectionId) this.drop(id); for (const [key, r] of this.requests) if (r.connectionId === connectionId) this.requests.delete(key); }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; for (const id of [...this.entries.keys()]) this.drop(id); this.requests.clear(); }
}
