import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { COORDINATION_LEDGER_FILE, coordinationLedgerPath, type CoordinationPathInputs } from "../native/admission-probes";

/*
 * The Coordination directory and what lives beside the admission ledger (N2 S7B part 1). Everything here is host-side state that must outlive a
 * Winter home and must not be copied with one: the ledger, the installation id, the launcher's retained receipts and the launch journal.
 *
 * No function here reads `process.env` or the real home directory: the caller passes `CoordinationPathInputs` (the same two inputs
 * `coordinationLedgerPath` takes), so a test names a temp directory and nothing else is reachable.
 */

export class CoworkHostEnvError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CoworkHostEnvError"; }
}
const fail = (code: string): never => { throw new CoworkHostEnvError(code); };

/** The directory that holds the admission ledger, spelled by S6's pure function (so the host-storage fence and this module cannot drift). */
export function coordinationDirectory(inputs: CoordinationPathInputs): string { return dirname(coordinationLedgerPath(inputs)); }
export function coordinationLedgerFile(inputs: CoordinationPathInputs): string { return coordinationLedgerPath(inputs); }
export { COORDINATION_LEDGER_FILE };

const euid = (): number => process.geteuid?.() ?? -1;

/** A real directory (no symlink on the last component), owned by this user, mode 0700. Created private if missing; an existing one with other bits is refused, never repaired. */
export function ensurePrivateDirectory(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) fail("directory_path_invalid");
  // Walk the ancestors that exist BEFORE creating anything: a symlinked (or non-directory) ancestor is refused here, so a link planted above the path cannot make the
  // recursive mkdir below create directories somewhere else first.
  let walked = "";
  for (const component of path.split("/").slice(1)) {
    walked += `/${component}`;
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(walked); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink() || !info.isDirectory()) fail("directory_path_alias");
  }
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== euid() || (info.mode & 0o777) !== 0o700) fail("directory_not_private");
  if (realpathSync(path) !== path) fail("directory_path_alias");
}

/** The launcher refuses any path with a `.winter*` component, in any case (volumes are case-insensitive). The daemon refuses the same, before it creates anything. */
export function assertOutsideWinterHomes(path: string): void {
  for (const component of path.split("/")) if (component.toLowerCase().startsWith(".winter")) fail("path_inside_winter_home");
}

/** `path` with its deepest existing ancestor resolved through symlinks (the rest, which does not exist yet, appended as written). */
function canonicalizeExisting(path: string): string {
  let existing = path, rest = "";
  for (;;) {
    try { return join(realpathSync(existing), rest); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest = join(basename(existing), rest); existing = parent;
  }
}
/** The Coordination directory must be disjoint from the Winter home: not the home, not inside it (a home wipe or copy would take the ledger, receipts and journal with it), not above it. The name-based `.winter*` refusal above is not enough: the home can be anywhere. */
export function assertDisjointFromHome(directory: string, home: string): void {
  const a = canonicalizeExisting(directory), b = canonicalizeExisting(home);
  if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) fail("path_inside_winter_home");
}

const INSTALLATION_ID = /^inst-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const COWORK_INSTALLATION_ID_FILE = "cowork-installation-id";

/**
 * The durable per-install id the admission ledger pins in `admission_meta` forever. Its lifetime must equal the ledger's, so it lives beside the
 * ledger file: random, created once (a temp file linked into place, which cannot replace anything), 0600, and NEVER overwritten. An existing file
 * that is not exactly a valid id of this user is refused, not repaired (a repaired id would be `ledger_identity_mismatch` against the ledger anyway).
 */
export function loadOrCreateInstallationId(directory: string, mint: () => string = () => `inst-${randomUUID()}`): string {
  ensurePrivateDirectory(directory);
  const path = join(directory, COWORK_INSTALLATION_ID_FILE);
  const existing = readInstallationId(path);
  if (existing !== null) return existing;
  const id = mint();
  if (!INSTALLATION_ID.test(id)) fail("installation_id_invalid");
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, `${id}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { try { unlinkSync(temporary); } catch { /* gone */ } }
  const stored = readInstallationId(path);
  if (stored === null) return fail("installation_id_invalid");
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return stored;
}
function readInstallationId(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail("installation_id_invalid"); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== euid() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 128) return fail("installation_id_invalid");
    const buffer = Buffer.alloc(info.size); let read = 0;
    while (read < buffer.length) { const n = readSync(fd, buffer, read, buffer.length - read, read); if (n <= 0) break; read += n; }
    const text = buffer.subarray(0, read).toString("utf8");
    return /^inst-[0-9a-f-]{36}\n$/.test(text) && INSTALLATION_ID.test(text.slice(0, -1)) ? text.slice(0, -1) : fail("installation_id_invalid");
  } finally { closeSync(fd); }
}
