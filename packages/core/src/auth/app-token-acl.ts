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
// CRASH SAFETY, because a token lost between the delete and the add would unpair the app and the phone:
//   1. write a SHADOW item `<name>.migrating` holding the value (created by this process, so readable);
//   2. delete the original; 3. add it back with the new ACL; 4. read it back and compare;
//   5. delete the shadow; 6. write the marker `<home>/migration/app-token-acl.json`.
// `recoverAppTokenShadows` runs at boot BEFORE `ensureTokens` — which would otherwise mint a fresh random
// token for a missing original — and restores an original from a shadow that outlived it (or drops a
// shadow whose original survived). The marker records the trusted set, so the migration re-runs when it
// changes (the app moved, a new dev build path) and is a no-op otherwise.
//
// WHO IS TRUSTED. Dist: the app bundle `winter-core` itself lives in (`<Winter.app>/Contents/Resources/
// winter-core`, realpath'd — the Homebrew `winter` link resolves there too). Nothing else: Launch Services
// can resolve `com.winter.app` to a local Release build (CLAUDE.md), which must not be granted the dist
// tokens. Dev (spec §7 B's "bun + Winter Dev"): this process (`bun`, or a compiled dev binary) plus every
// `com.winter.app.dev` bundle Launch Services knows. Never a path from an environment variable: a dev daemon
// runs under `bun` from a repository checkout, and `bun` autoloads that checkout's `.env`.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOKEN_NAMES } from "./tokens";
import { addGenericPasswordWithAccess, deleteGenericPassword, genericPasswordPresent, readGenericPassword, ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, type KeychainTarget } from "./keychain-ffi";

/** The two items the APP reads (the admin token is the CLI's, the same binary as the daemon). */
export const APP_READ_TOKEN_NAMES: readonly string[] = [TOKEN_NAMES.harness, TOKEN_NAMES.remote];
export const APP_TOKEN_SHADOW_SUFFIX = ".migrating";
export const APP_TOKEN_ACL_MARKER_VERSION = 1;

export function appTokenAclMarkerPath(home: string): string {
  return join(home, "migration", "app-token-acl.json");
}

export interface AppTokenAclTarget {
  keychain: KeychainTarget;
  /** The daemon's Keychain service (`profile.ts`'s `keychainService()`). */
  service: string;
  /** The applications the items' decrypt ACL names besides this process (absolute bundle/binary paths). */
  apps: readonly string[];
  /** This process's own executable, as recorded in the marker (the ACL entry itself is `null` = self). */
  self: string;
  home: string;
  log?: (line: string) => void;
}

interface Marker {
  v: number;
  service: string;
  self: string;
  apps: string[];
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

function trusted(target: AppTokenAclTarget): (string | null)[] {
  return [null, ...target.apps];
}

/**
 * BEFORE `ensureTokens`: finish what an interrupted migration left. A shadow without its original is
 * restored (with the new ACL — the migration had got past the delete); a shadow beside its original is
 * dropped (the original was never deleted, or was already re-added). Returns the accounts it restored.
 * Never throws: a failure is one log line and the item is left as found.
 */
export function recoverAppTokenShadows(target: AppTokenAclTarget): string[] {
  const restored: string[] = [];
  for (const name of APP_READ_TOKEN_NAMES) {
    const shadow = `${name}${APP_TOKEN_SHADOW_SUFFIX}`;
    try {
      if (!genericPasswordPresent(target.keychain, target.service, shadow)) continue;
      if (genericPasswordPresent(target.keychain, target.service, name)) {
        deleteGenericPassword(target.keychain, target.service, shadow);
        continue;
      }
      const value = readGenericPassword(target.keychain, target.service, shadow);
      if (value === null || value === "") continue;
      addGenericPasswordWithAccess(target.keychain, { service: target.service, account: name, value, trustedApplications: trusted(target) });
      if (readGenericPassword(target.keychain, target.service, name) !== value) throw new KeychainFfiError("verify", -1, name);
      deleteGenericPassword(target.keychain, target.service, shadow);
      restored.push(name);
      target.log?.(`keychain: restored ${name} from its migration shadow`);
    } catch (err) {
      target.log?.(`keychain: could not recover ${name} from its migration shadow (${err instanceof KeychainFfiError ? `OSStatus ${err.status}` : err instanceof Error ? err.name : "error"}) — left as found`);
    }
  }
  return restored;
}

export type AppTokenAclOutcome = { kind: "current" } | { kind: "migrated"; names: string[] } | { kind: "failed"; name: string; reason: string };

/**
 * AFTER `ensureTokens`: re-create each app-read token with the ACL naming this process and `target.apps`.
 * `values` is what `ensureTokens` returned (by item name). A no-op when the marker already records this
 * exact trusted set. On a failure it stops, leaves the shadow for the next boot's recovery when the
 * original is gone, and writes no marker.
 */
export function migrateAppTokenAcl(target: AppTokenAclTarget, values: Readonly<Record<string, string>>): AppTokenAclOutcome {
  const marker = readMarker(target.home);
  if (marker !== undefined && marker.service === target.service && marker.self === target.self && sameSet(marker.apps, target.apps)) return { kind: "current" };
  // Every trusted path must exist BEFORE any item is touched: `SecTrustedApplicationCreateFromPath` fails on
  // a missing one, and failing there would come after the original's delete (recoverable, but needlessly).
  const missing = target.apps.find((app) => !existsSync(app));
  if (missing !== undefined) {
    target.log?.(`keychain: the app-token access lists were left as they are (${missing} does not exist)`);
    return { kind: "failed", name: APP_READ_TOKEN_NAMES[0]!, reason: "trusted application missing" };
  }
  const done: string[] = [];
  for (const name of APP_READ_TOKEN_NAMES) {
    const value = values[name];
    if (value === undefined || value === "") continue;
    const shadow = `${name}${APP_TOKEN_SHADOW_SUFFIX}`;
    let originalDeleted = false;
    try {
      // 1. The shadow (a stale one from an older crash is replaced).
      deleteGenericPassword(target.keychain, target.service, shadow);
      addGenericPasswordWithAccess(target.keychain, { service: target.service, account: shadow, value, trustedApplications: [null] });
      if (readGenericPassword(target.keychain, target.service, shadow) !== value) throw new KeychainFfiError("verify shadow", -1, shadow);
      // 2–4. Delete, re-add with the ACL, read back.
      deleteGenericPassword(target.keychain, target.service, name);
      originalDeleted = true;
      try {
        addGenericPasswordWithAccess(target.keychain, { service: target.service, account: name, value, trustedApplications: trusted(target) });
      } catch (err) {
        // Another writer re-created it between our delete and add (a second daemon cannot — the boot lock —
        // but a human with `security` could): it holds a token, so leave it and keep the shadow's value out.
        if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) throw err;
      }
      if (readGenericPassword(target.keychain, target.service, name) !== value) throw new KeychainFfiError("verify", -1, name);
      // 5. The shadow's job is done.
      deleteGenericPassword(target.keychain, target.service, shadow);
      done.push(name);
    } catch (err) {
      const reason = err instanceof KeychainFfiError ? `${err.operation}: OSStatus ${err.status}` : err instanceof Error ? err.name : "error";
      target.log?.(`keychain: ${name} kept its old access list (${reason})${originalDeleted ? " — its shadow stays for the next boot to restore" : ""}`);
      return { kind: "failed", name, reason };
    }
  }
  const next: Marker = { v: APP_TOKEN_ACL_MARKER_VERSION, service: target.service, self: target.self, apps: [...target.apps], migratedAt: new Date().toISOString() };
  const path = appTokenAclMarkerPath(target.home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  target.log?.(`keychain: ${done.join(" and ")} readable by ${target.apps.length === 1 ? target.apps[0] : `${target.apps.length} app bundles`} without a prompt`);
  return { kind: "migrated", names: done };
}

/** The app bundle an executable lives in, when it is `<X.app>/Contents/Resources/<binary>` (the embedded
 *  `winter-core`), else `undefined`. Pure. */
export function enclosingAppBundle(executable: string): string | undefined {
  const m = /^(.+\.app)\/Contents\/Resources\/[^/]+$/.exec(executable);
  return m?.[1];
}

/**
 * Which app bundles to trust (see this file's header). `lookup` is Launch Services by bundle id
 * (`keychain-ffi.ts`'s `applicationPathsForBundleId`), injected so the rule is testable.
 */
export function trustedAppBundlesFor(input: { profile: "dist" | "dev"; executable: string; lookup: (bundleId: string) => string[]; exists?: (p: string) => boolean }): string[] {
  const exists = input.exists ?? existsSync;
  const own = enclosingAppBundle(input.executable);
  const out = new Set<string>();
  if (own !== undefined) out.add(own);
  if (input.profile === "dev") for (const p of input.lookup("com.winter.app.dev")) if (exists(p)) out.add(p);
  return [...out];
}

/** `process.execPath`, symlinks resolved (the Homebrew `winter` link → the app's `winter-core`). */
export function realExecutable(execPath: string = process.execPath): string {
  try {
    return realpathSync(execPath);
  } catch {
    return execPath;
  }
}

/**
 * The production boot's target: the user's default keychain, the daemon's own service, this process and
 * the trusted bundles for its profile. `undefined` (with one log line) when there is no app to trust —
 * a dist daemon run outside an app bundle, a dev machine with no Winter Dev build Launch Services knows —
 * or when Launch Services cannot be asked. Only the real production boot calls this (`daemon.ts`: no
 * injected `secrets`, macOS).
 */
export function appTokenAclBootTarget(input: { home: string; service: string; profile: "dist" | "dev"; log: (line: string) => void; lookup: (bundleId: string) => string[] }): AppTokenAclTarget | undefined {
  const self = realExecutable();
  let apps: string[];
  try {
    apps = trustedAppBundlesFor({ profile: input.profile, executable: self, lookup: input.lookup });
  } catch (err) {
    input.log(`keychain: the app-token access lists were not checked (${err instanceof Error ? err.name : "error"})`);
    return undefined;
  }
  if (apps.length === 0) {
    input.log(`keychain: no ${input.profile === "dev" ? "Winter Dev build" : "enclosing Winter app"} to grant the pairing tokens to — their access lists are left as they are`);
    return undefined;
  }
  return { keychain: null, service: input.service, apps, self, home: input.home, log: input.log };
}
