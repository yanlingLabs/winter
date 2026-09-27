// WS-25 §7 B: the Mac app reads the daemon's two pairing tokens without a Keychain prompt.
//
// THE PROBLEM (`.superpowers/sdd/2026-09-27-keychain-prompts/progress.md`). `harness-token` and
// `remote-token` are created by `winter-core` (`auth/tokens.ts`, through `Bun.secrets`), so their decrypt
// ACL names `winter-core` alone. The app (`AppModel.swift`'s `KeychainToken.readHarnessToken`,
// `RemoteHost.swift`'s `readRemoteToken`) is a different binary, and its read raises the consent prompt.
//
// THE FIX. Re-create each item ONCE with an ACL that names both `winter-core` (this process, `null` below)
// and the Winter app bundle. Only a trusted application may change an existing item's ACL, and doing so
// (`SecKeychainItemSetAccess`) asks the user for the keychain PASSWORD — so the item is instead DELETED
// and ADDED again by its creator, which is silent. The value is the one `ensureTokens` just read in this
// process; nothing is decrypted for the migration.
//
// CRASH SAFETY, because a token lost between the delete and the add would unpair the app and the phone
// (and lock every client out: the IPC server checks each hello against the Keychain item):
//   0. build both access objects (the wide one, and a self-only fallback) BEFORE any item is touched, and
//      reuse them for both items — the delete→add window is two Keychain calls, nothing else;
//   1. write a SHADOW item `<name>.migrating` holding the value (created by this process, so readable);
//   2. delete the original; 3. add it back with the wide ACL; 4. read it back and compare;
//   5. delete the shadow; 6. write the marker `<home>/migration/app-token-acl.json`.
// A failure after step 2 restores the VALUE at once, in-process: with the wide ACL, else self-only (the
// pre-migration posture — the app prompts as before, nothing else changes); the shadow stays only if
// even that failed. `recoverAppTokenShadows` runs at EVERY qualifying boot BEFORE `ensureTokens` — which
// would otherwise mint a fresh token for a missing original — whether or not there is anything to trust:
// it restores an original from a shadow that outlived it (value first, the ACL second), and drops a
// shadow beside its original ONLY when both hold the same value (a differing pair is kept and logged —
// either could be the one clients hold). The marker records the trusted set BY DESIGNATED REQUIREMENT, so
// the migration re-runs when that set changes (or when `ensureTokens` had to mint an item) and is a no-op
// otherwise — a DerivedData path change or a Homebrew `bun` upgrade keeps the same requirement.
//
// WHO IS TRUSTED. Dist: the app bundle `winter-core` itself lives in (`<Winter.app>/Contents/Resources/
// winter-core`, realpath'd — the Homebrew `winter` link resolves there too). Nothing else: Launch Services
// can resolve `com.winter.app` to a local Release build (CLAUDE.md), which must not be granted the dist
// tokens. Dev (spec §7 B's "bun + Winter Dev"): this process (`bun`, or a compiled dev binary) plus the
// `com.winter.app.dev` bundles Launch Services knows THAT ARE SIGNED BY WINTER'S TEAM (`WINTER_TEAM_ID`,
// `project.yml`'s `DEVELOPMENT_TEAM`), one per designated requirement. Never a path from an environment
// variable: a dev daemon runs under `bun` from a repository checkout, and `bun` autoloads that `.env`.
//
// THE PARTITION LIST IS THE CREATOR'S, AND ONLY THE CREATOR'S (measured live 2026-09-27; Apple's Security
// sources). Beside the decrypt entry, a partition-enabled keychain (the login keychain) gives every item a
// `partition_id` entry, and a reader whose partition (`teamid:<team>`, `apple:`, or `cdhash:<hash>` for
// ad-hoc code — securityd `clientid.cpp`'s `partitionIdForProcess`) is not listed is PROMPTED even when the
// decrypt entry trusts it. That entry cannot be chosen here:
//   - securityd writes it itself when the item is created, from the creating process alone
//     (`localkey.cpp`'s `LocalKey::setOwner` → `acls.cpp`'s `createClientPartitionID`);
//   - every client ACL edit — the ones `SecKeychainItemCreateFromContent` makes to apply our `SecAccess`
//     included (`Access.cpp`'s `setAccess(target, maker)`, under the maker's credential) — runs with the
//     partition tag PRESERVED unless the credential carries the keychain PASSWORD (`acls.cpp`'s
//     `changeAcl`), and `objectacl.cpp`'s `cssmChangeAcl` refuses an add, replace or delete of a tagged
//     entry (`CSSM_ERRCODE_OPERATION_AUTH_DENIED`);
//   - the public API cannot even build a tagged entry: `SecACLCreateWithSimpleContents` +
//     `SecACLUpdateAuthorizations(partition-id)` makes an UNTAGGED entry that `dump-keychain -a` prints as
//     `partition_id` but securityd never consults (`findPartitionSubject` looks up by tag) — a trap.
// So the list is exactly `teamid:<creator's team>`. Dist: `winter-core` and Winter.app share Winter's team,
// so the app is never prompted. Dev under Homebrew `bun` (another team): Winter Dev is asked once per item
// after every re-creation, and "Always Allow" appends its team — re-creating drops it again, so the
// migration must never re-run merely because the list lacks a team. The cure is the creator: a dev daemon
// signed by Winter's team (`unpartitionedTeams` below names the gap in the boot log).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATION_SHADOW_SUFFIX } from "./secret-store";
import { TOKEN_NAMES } from "./tokens";
import { addGenericPassword, createKeychainAccess, deleteGenericPassword, genericPasswordPresent, readGenericPassword, ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, type KeychainAccess, type KeychainTarget } from "./keychain-ffi";

/** The two items the APP reads (the admin token is the CLI's, the same binary as the daemon). */
export const APP_READ_TOKEN_NAMES: readonly string[] = [TOKEN_NAMES.harness, TOKEN_NAMES.remote];
export const APP_TOKEN_SHADOW_SUFFIX = MIGRATION_SHADOW_SUFFIX;
export const APP_TOKEN_ACL_MARKER_VERSION = 2;
/** The Apple developer team Winter's apps are signed by (`apple/Winter/project.yml`'s `DEVELOPMENT_TEAM`). */
export const WINTER_TEAM_ID = "37N77U9RSZ";

export function appTokenAclMarkerPath(home: string): string {
  return join(home, "migration", "app-token-acl.json");
}

/** The Keychain calls this module makes — the real FFI, or a test's wrapper that fails on cue. */
export interface AppTokenKeychainOps {
  present(target: KeychainTarget, service: string, account: string): boolean;
  read(target: KeychainTarget, service: string, account: string): string | null;
  remove(target: KeychainTarget, service: string, account: string): boolean;
  add(target: KeychainTarget, item: { service: string; account: string; value: string; access: KeychainAccess }): void;
  createAccess(description: string, trustedApplications: readonly (string | null)[]): KeychainAccess;
}

export const REAL_APP_TOKEN_KEYCHAIN_OPS: AppTokenKeychainOps = {
  present: genericPasswordPresent,
  read: readGenericPassword,
  remove: deleteGenericPassword,
  add: addGenericPassword,
  createAccess: createKeychainAccess,
};

/** Where the tokens live and how to reach them. */
export interface AppTokenKeychain {
  keychain: KeychainTarget;
  /** The daemon's Keychain service (`profile.ts`'s `keychainService()`). */
  service: string;
  ops?: AppTokenKeychainOps;
  log?: (line: string) => void;
}

/** Who the wide ACL trusts: one path per designated requirement, and the sorted requirement set (this
 *  process's own included) the marker compares. */
export interface AppTokenTrust {
  apps: string[];
  requirements: string[];
  /** The trusted apps' teams that the re-created items' partition list will NOT hold, because this process
   *  (the creator) is not signed by that team (see the header). Absent when there is none (dist). */
  unpartitionedTeams?: string[];
}

/** The two access objects, built once per boot (see the header, step 0). `wide` is absent when there is no
 *  one to trust or it could not be built; `selfOnly` when even that could not be built. */
export interface AppTokenAccess {
  wide?: KeychainAccess;
  selfOnly?: KeychainAccess;
  release(): void;
}

interface Marker {
  v: number;
  service: string;
  requirements: string[];
  migratedAt: string;
}

function readMarker(home: string): Marker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(appTokenAclMarkerPath(home), "utf8")) as Marker;
    return parsed.v === APP_TOKEN_ACL_MARKER_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function describe(err: unknown): string {
  return err instanceof KeychainFfiError ? `${err.operation}: OSStatus ${err.status}` : err instanceof Error ? err.name : "error";
}

/** Builds the access objects for a boot. Never throws: a failure is logged and that object is absent. */
export function prepareAppTokenAccess(kc: AppTokenKeychain, trust: AppTokenTrust | undefined): AppTokenAccess {
  const ops = kc.ops ?? REAL_APP_TOKEN_KEYCHAIN_OPS;
  let wide: KeychainAccess | undefined;
  let selfOnly: KeychainAccess | undefined;
  try {
    selfOnly = ops.createAccess("Winter pairing token", [null]);
  } catch (err) {
    kc.log?.(`keychain: the self-only access list could not be built (${describe(err)})`);
  }
  if (trust !== undefined) {
    try {
      wide = ops.createAccess("Winter pairing token", [null, ...trust.apps]);
    } catch (err) {
      kc.log?.(`keychain: the app-token access list could not be built (${describe(err)}) — the tokens keep theirs`);
    }
  }
  return {
    ...(wide !== undefined ? { wide } : {}),
    ...(selfOnly !== undefined ? { selfOnly } : {}),
    release() {
      wide?.release();
      selfOnly?.release();
    },
  };
}

/**
 * Puts `value` back at `name` (which must be absent): with the wide ACL when there is one, else — or when
 * that add fails — self-only. Verified by reading it back. Returns which ACL it got; throws when neither
 * worked (the caller keeps the shadow).
 */
function restoreValue(kc: AppTokenKeychain, access: AppTokenAccess, name: string, value: string): "wide" | "self-only" {
  const ops = kc.ops ?? REAL_APP_TOKEN_KEYCHAIN_OPS;
  const attempts: Array<["wide" | "self-only", KeychainAccess | undefined]> = [["wide", access.wide], ["self-only", access.selfOnly]];
  let last: unknown = new KeychainFfiError("restore", -1, name);
  for (const [which, acl] of attempts) {
    if (acl === undefined) continue;
    try {
      ops.add(kc.keychain, { service: kc.service, account: name, value, access: acl });
    } catch (err) {
      if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) {
        last = err;
        continue;
      }
    }
    if (ops.read(kc.keychain, kc.service, name) === value) return which;
    last = new KeychainFfiError("verify", -1, name);
  }
  throw last;
}

/**
 * BEFORE `ensureTokens`, at every qualifying boot (whatever the trust target): finish what an interrupted
 * migration left (see the header). Returns the accounts it restored. Never throws.
 */
export function recoverAppTokenShadows(kc: AppTokenKeychain, access: AppTokenAccess): string[] {
  const ops = kc.ops ?? REAL_APP_TOKEN_KEYCHAIN_OPS;
  const restored: string[] = [];
  for (const name of APP_READ_TOKEN_NAMES) {
    const shadow = `${name}${APP_TOKEN_SHADOW_SUFFIX}`;
    try {
      if (!ops.present(kc.keychain, kc.service, shadow)) continue;
      const value = ops.read(kc.keychain, kc.service, shadow);
      if (value === null || value === "") {
        kc.log?.(`keychain: ${shadow} holds no value — left as found`);
        continue;
      }
      if (ops.present(kc.keychain, kc.service, name)) {
        if (ops.read(kc.keychain, kc.service, name) === value) ops.remove(kc.keychain, kc.service, shadow);
        else kc.log?.(`keychain: ${shadow} and ${name} hold DIFFERENT values — both kept; remove the shadow once the paired clients work`);
        continue;
      }
      const which = restoreValue(kc, access, name, value);
      ops.remove(kc.keychain, kc.service, shadow);
      restored.push(name);
      kc.log?.(`keychain: restored ${name} from its migration shadow (${which} access list)`);
    } catch (err) {
      kc.log?.(`keychain: could not recover ${name} from its migration shadow (${describe(err)}) — left as found`);
    }
  }
  return restored;
}

export type AppTokenAclOutcome = { kind: "current" } | { kind: "migrated"; names: string[] } | { kind: "failed"; name: string; reason: string };

/**
 * AFTER `ensureTokens`: re-create each app-read token with the wide ACL. `values` is what `ensureTokens`
 * returned (by item name) and `minted` the items it created this boot. A no-op when the marker records the
 * same requirement set and nothing was minted. On a failure it stops, restores what it deleted (see the
 * header), and writes no marker.
 */
export function migrateAppTokenAcl(kc: AppTokenKeychain, access: AppTokenAccess, trust: AppTokenTrust, home: string, values: Readonly<Record<string, string>>, minted: readonly string[] = []): AppTokenAclOutcome {
  const ops = kc.ops ?? REAL_APP_TOKEN_KEYCHAIN_OPS;
  const marker = readMarker(home);
  const remint = minted.some((n) => APP_READ_TOKEN_NAMES.includes(n));
  if (!remint && marker !== undefined && marker.service === kc.service && sameSet(marker.requirements, trust.requirements)) return { kind: "current" };
  if (access.wide === undefined || access.selfOnly === undefined) return { kind: "failed", name: APP_READ_TOKEN_NAMES[0]!, reason: "no access list" };
  const done: string[] = [];
  for (const name of APP_READ_TOKEN_NAMES) {
    const value = values[name];
    if (value === undefined || value === "") continue;
    const shadow = `${name}${APP_TOKEN_SHADOW_SUFFIX}`;
    let originalDeleted = false;
    try {
      // 1. The shadow. One left from an older crash that recovery kept (its value differs) is not ours to
      // overwrite: this item is left alone until a human settles it.
      if (ops.present(kc.keychain, kc.service, shadow)) {
        if (ops.read(kc.keychain, kc.service, shadow) !== value) throw new KeychainFfiError("an older shadow with a different value", -1, shadow);
        ops.remove(kc.keychain, kc.service, shadow);
      }
      ops.add(kc.keychain, { service: kc.service, account: shadow, value, access: access.selfOnly });
      if (ops.read(kc.keychain, kc.service, shadow) !== value) throw new KeychainFfiError("verify shadow", -1, shadow);
      // 2–4. Delete, re-add with the wide ACL, read back.
      ops.remove(kc.keychain, kc.service, name);
      originalDeleted = true;
      try {
        ops.add(kc.keychain, { service: kc.service, account: name, value, access: access.wide });
      } catch (err) {
        // Re-created between our delete and add (only a human with `security` could: the credential
        // migration lock keeps a second daemon out). The read-back below decides whether it holds our value.
        if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) throw err;
      }
      if (ops.read(kc.keychain, kc.service, name) !== value) throw new KeychainFfiError("verify", -1, name);
      // 5. The shadow's job is done.
      ops.remove(kc.keychain, kc.service, shadow);
      done.push(name);
    } catch (err) {
      const reason = describe(err);
      if (!originalDeleted) {
        kc.log?.(`keychain: ${name} kept its old access list (${reason})`);
        return { kind: "failed", name, reason };
      }
      // I1: never leave the boot without the token — every client's hello is checked against it.
      let restoredWith: "wide" | "self-only" | undefined;
      try {
        if (ops.present(kc.keychain, kc.service, name) && ops.read(kc.keychain, kc.service, name) === value) restoredWith = "wide";
        else if (!ops.present(kc.keychain, kc.service, name)) restoredWith = restoreValue(kc, access, name, value);
      } catch { /* the shadow stays for the next boot */ }
      if (restoredWith !== undefined) {
        try { ops.remove(kc.keychain, kc.service, shadow); } catch { /* recovery drops an equal shadow next boot */ }
        kc.log?.(`keychain: ${name} could not take the new access list (${reason}) — restored with the ${restoredWith} one`);
      } else {
        kc.log?.(`keychain: ${name} could not be restored (${reason}) — its shadow stays for the next boot to restore`);
      }
      return { kind: "failed", name, reason };
    }
  }
  const next: Marker = { v: APP_TOKEN_ACL_MARKER_VERSION, service: kc.service, requirements: [...trust.requirements].sort(), migratedAt: new Date().toISOString() };
  const path = appTokenAclMarkerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  if (trust.unpartitionedTeams === undefined) {
    kc.log?.(`keychain: ${done.join(" and ")} readable by ${trust.apps.length === 1 ? trust.apps[0] : `${trust.apps.length} app bundles`} without a prompt`);
  } else {
    kc.log?.(`keychain: ${done.join(" and ")} re-created with the app in the access list, but their partition list names only this process's team (not ${trust.unpartitionedTeams.map((t) => `teamid:${t}`).join(", ")}) — the app is asked once per item; a dev daemon signed by team ${WINTER_TEAM_ID} avoids it`);
  }
  return { kind: "migrated", names: done };
}

/** The app bundle an executable lives in, when it is `<X.app>/Contents/Resources/<binary>` (the embedded
 *  `winter-core`), else `undefined`. Pure. */
export function enclosingAppBundle(executable: string): string | undefined {
  const m = /^(.+\.app)\/Contents\/Resources\/[^/]+$/.exec(executable);
  return m?.[1];
}

/** What code signing says about a path: its team and its designated requirement (either may be absent —
 *  unsigned, ad hoc). */
export interface CodeSigningFacts {
  teamId?: string;
  requirement?: string;
}

/** `codesign -d -v -r-` (read-only, never prompts): `TeamIdentifier=` and `designated => `. Bounded by
 *  `timeoutMs`; a timed-out inspection answers nothing (unsigned, as far as trust is concerned). */
export function codeSigningFacts(path: string, timeoutMs = 5_000): CodeSigningFacts {
  const r = spawnSync("/usr/bin/codesign", ["-d", "-v", "-r-", path], { encoding: "utf8", timeout: Math.max(1, timeoutMs) });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const team = /^TeamIdentifier=(.+)$/m.exec(text)?.[1]?.trim();
  const requirement = /^designated => (.+)$/m.exec(text)?.[1]?.trim();
  return { ...(team !== undefined && team !== "not set" ? { teamId: team } : {}), ...(requirement !== undefined ? { requirement } : {}) };
}

/** The whole trust scan's budget at boot (Launch Services + every `codesign`): the scan runs before the IPC
 *  server listens, so it must never hold the daemon's first clients for long. */
export const TRUST_SCAN_BUDGET_MS = 5_000;
/** The floor any single inspection still gets once the budget is spent (this process and its own bundle
 *  are always inspected — their requirements key the marker). */
const MIN_INSPECT_MS = 1_000;

/**
 * Who to trust (see this file's header). `lookup` is Launch Services by bundle id, `inspect` code signing —
 * both injected so the rule is testable. `undefined` when there is no app to trust.
 *
 * BOUNDED (re-review item 1): the scan runs at boot BEFORE the IPC server listens — kept there rather than
 * moved after `listen`, because the shadow recovery must precede `ensureTokens` and the migration must run
 * before a client can read a token mid-rewrite. So it gets ONE budget (`budgetMs`, default
 * `TRUST_SCAN_BUDGET_MS`): once spent, no further Winter Dev bundle is inspected and the scan proceeds with
 * what is known — an UNINSPECTED bundle is never trusted. Each `codesign` gets only what is left.
 */
export function trustFor(input: { profile: "dist" | "dev"; executable: string; lookup: (bundleId: string) => string[]; inspect?: (path: string, timeoutMs: number) => CodeSigningFacts; exists?: (p: string) => boolean; budgetMs?: number; now?: () => number }): AppTokenTrust | undefined {
  const exists = input.exists ?? existsSync;
  const inspect = input.inspect ?? codeSigningFacts;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? TRUST_SCAN_BUDGET_MS);
  const left = (): number => deadline - now();
  const requirementOf = (path: string, facts: CodeSigningFacts): string => facts.requirement ?? `path ${path}`;
  const byRequirement = new Map<string, string>();
  const appTeams = new Set<string>();
  const own = enclosingAppBundle(input.executable);
  // Dist trusts the bundle winter-core RUNS FROM — this process's own app, never a Launch Services lookup.
  if (own !== undefined && exists(own)) {
    const facts = inspect(own, Math.max(MIN_INSPECT_MS, left()));
    byRequirement.set(requirementOf(own, facts), own);
    if (facts.teamId !== undefined) appTeams.add(facts.teamId);
  }
  const selfFacts = inspect(input.executable, Math.max(MIN_INSPECT_MS, left()));
  const self = requirementOf(input.executable, selfFacts);
  if (input.profile === "dev" && left() > 0) {
    for (const path of [...input.lookup("com.winter.app.dev")].sort()) {
      if (left() <= 0) break; // budget spent: what is not inspected is not trusted
      if (!exists(path)) continue;
      const facts = inspect(path, left());
      if (facts.teamId !== WINTER_TEAM_ID) continue;
      const req = requirementOf(path, facts);
      if (!byRequirement.has(req)) {
        byRequirement.set(req, path);
        appTeams.add(facts.teamId);
      }
    }
  }
  if (byRequirement.size === 0) return undefined;
  // securityd partitions an item by its creator's team (the header); an unsigned or ad-hoc creator
  // (`cdhash:`) shares no team with anyone. A report only: nothing re-runs over it.
  const unpartitioned = [...appTeams].filter((team) => team !== selfFacts.teamId).sort();
  return { apps: [...byRequirement.values()], requirements: [...new Set([self, ...byRequirement.keys()])].sort(), ...(unpartitioned.length > 0 ? { unpartitionedTeams: unpartitioned } : {}) };
}

/** `process.execPath`, symlinks resolved (the Homebrew `winter` link → the app's `winter-core`). */
export function realExecutable(execPath: string = process.execPath): string {
  try {
    return realpathSync(execPath);
  } catch {
    return execPath;
  }
}

/** The production boot's trust target (`trustFor` over this process), `undefined` with one log line when
 *  there is nobody to trust or Launch Services / codesign cannot be asked. */
export function appTokenAclBootTrust(input: { profile: "dist" | "dev"; log: (line: string) => void; lookup: (bundleId: string) => string[] }): AppTokenTrust | undefined {
  let trust: AppTokenTrust | undefined;
  try {
    trust = trustFor({ profile: input.profile, executable: realExecutable(), lookup: input.lookup });
  } catch (err) {
    input.log(`keychain: the app-token access lists were not checked (${err instanceof Error ? err.name : "error"})`);
    return undefined;
  }
  if (trust === undefined) input.log(`keychain: no ${input.profile === "dev" ? "Winter Dev build signed by Winter's team" : "enclosing Winter app"} to grant the pairing tokens to — their access lists are left as they are`);
  return trust;
}
