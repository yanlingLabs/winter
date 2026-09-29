// WS-27: the ONE-TIME move of the dev Keychain items from Homebrew `bun` to a Winter-signed `winter-core`.
//
// WHY. A dev daemon run as `bun` creates its items as `bun`, so their partition list names bun's team
// (`app-token-acl.ts`'s header): Winter Dev is asked once per pairing token. The cure is a dev daemon that is
// a compiled `winter-core` signed by Winter's team (`scripts/dev-daemon.ts`). But its first read of every
// item `bun` created would prompt — a decrypt by a binary the item does not name, from another team.
//
// HOW. Only an item's creator decides its partition list, so the NEW binary must create every item; only the
// OLD one can read and delete them silently. The two cooperate over a pipe:
//   - the orchestrator (`runDevKeychainTransition`, run under `bun` — the old creator) lists the accounts
//     attributes-only and reads each value;
//   - the child (`winter-core __dev-keychain-adopt`, the new creator) writes the shadow `<account>.migrating`
//     and reads it back; the orchestrator deletes the original; the child adds the original from its own
//     shadow, self-only, reads it back and drops the shadow.
// A value crosses only that pipe, once, in the `shadow` request; nothing is logged or written elsewhere.
// Afterwards every item is the compiled binary's, self-only; the daemon's boot re-widens the two pairing
// tokens for Winter Dev (the app-token marker's trusted set changed with the creator), now with a
// partition list that names Winter's team.
//
// CRASH SAFETY. Every shadow is the CHILD's, so the compiled binary can read it silently: an interrupted run
// leaves either the pair (shadow + bun's original — re-run the transition: the `shadow` step is idempotent
// for an equal value) or the shadow alone (the child's `recover` at the start of a re-run, or the compiled
// daemon's own boot recovery, puts the original back). Before anything else the orchestrator runs its own
// recovery as `bun`, so shadows a crashed `bun`-run migration left are restored (or, beside their original,
// dropped as stale) and then adopted like any other item.
//
// EXCLUSION. The orchestrator holds the home's CREDENTIAL MIGRATION LOCK (`credential-migration-lock.ts`,
// judged on pid liveness — a booting daemon, which has no socket yet, cannot slip past it) for the whole
// run, and the child refuses to act unless its parent holds it. It also takes the daemon's boot lock, so a
// RUNNING dev daemon refuses the transition. A daemon booting mid-run finds the migration lock held and does
// no Keychain pass. The run stops — writing no marker — the moment the child exits, stops answering, or
// fails its recovery or the marker.
//
// ONE-WAY. After it, a dev-profile process that is NOT the compiled binary (a `bun`-run CLI, a `bun`-run
// daemon) is prompted for every item it reads. Both sides refuse anything but the dev profile on its default
// home and the dev Keychain service.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../lock";
import { resolveWinterProfile, type WinterProfile } from "../profile";
import { codeSigningFacts, realExecutable } from "./app-token-acl";
import { acquireCredentialMigrationLock, credentialMigrationLockHolder, processStartSeconds } from "./credential-migration-lock";
import { isDefaultWinterHome } from "../winter-dir";
import { APP_TOKEN_SHADOW_SUFFIX } from "./app-token-acl";
import { isCredentialAccount, putBack, readStoredValue, recoverCredentialShadows, REAL_CREDENTIAL_KEYCHAIN_OPS, sameBytes, writeCredentialAclMarker, type CredentialKeychain } from "./credential-acl";
import { KeychainFfiError, keychainUnlocked, withKeychainUserInteractionDisabled, type KeychainAccess } from "./keychain-ffi";

/** The compiled binary's route for the child side. */
export const DEV_KEYCHAIN_ADOPT_ARG = "__dev-keychain-adopt";
/** The only service either side will touch. */
export const DEV_KEYCHAIN_SERVICE = "com.winter.core.dev";

export type AdoptRequest =
  | { op: "hello" }
  | { op: "recover" }
  | { op: "shadow"; account: string; value: string }
  | { op: "commit"; account: string }
  | { op: "drop"; account: string }
  | { op: "marker"; migrated: number; skipped: number }
  | { op: "done" };

/** `fatal`: the CHANNEL failed (the child exited, stopped answering, or answered garbage) — the run stops. */
export type AdoptResponse = { ok: true; service?: string; restored?: string[] } | { ok: false; reason: string; fatal?: true };

/** Why this process must not take part, or `undefined`. Both sides check it. */
export function devTransitionRefusal(input: { profile: WinterProfile; home: string; service: string; platform?: NodeJS.Platform }): string | undefined {
  if ((input.platform ?? process.platform) !== "darwin") return "the dev Keychain transition runs only on macOS";
  if (input.profile !== "dev") return "the dev Keychain transition runs only on the dev profile (WINTER_PROFILE=dev)";
  if (input.service !== DEV_KEYCHAIN_SERVICE) return `the dev Keychain transition touches only ${DEV_KEYCHAIN_SERVICE}, not ${input.service}`;
  if (!isDefaultWinterHome(input.home, "dev")) return `the dev Keychain transition runs only on the dev profile's default home (~/.winter-dev), not ${input.home}`;
  return undefined;
}

function describe(err: unknown): string {
  return err instanceof KeychainFfiError ? `${err.operation}: OSStatus ${err.status}` : err instanceof Error ? err.message : "error";
}

/** Every account the transition owns: anything that is not itself a shadow. */
function isItem(account: string): boolean {
  return account !== "" && !account.endsWith(APP_TOKEN_SHADOW_SUFFIX);
}

/**
 * THE CHILD (the new creator): one request, one response, synchronously. `access` is the self-only access
 * object (this process). Every Keychain call runs with user interaction disabled. Never logs a value.
 */
export function createAdoptHandler(kc: CredentialKeychain, access: KeychainAccess, home: string, requirement: string | undefined): (req: AdoptRequest) => AdoptResponse {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  const q = <T>(fn: () => T): T => withKeychainUserInteractionDisabled(fn);
  return (req) => {
    try {
      switch (req.op) {
        case "hello":
          return { ok: true, service: kc.service };
        case "recover":
          return { ok: true, restored: q(() => recoverCredentialShadows(kc, access, { dropShadowsBesideOriginals: false, owns: isItem })) };
        case "shadow": {
          if (!isItem(req.account)) return { ok: false, reason: "not an item" };
          const shadow = `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`;
          const bytes = new Uint8Array(Buffer.from(req.value, "utf8"));
          if (q(() => ops.present(kc.keychain, kc.service, shadow))) {
            // A re-run after an interruption: the same value is the same step, done already. A different one
            // beside a credential is stale (the original is the newer write): replaced. Beside a pairing token
            // it is kept — either value could be what the paired clients hold — and the item is left alone.
            if (sameBytes(q(() => ops.readBytes(kc.keychain, kc.service, shadow)), bytes)) return { ok: true };
            if (!isCredentialAccount(req.account)) return { ok: false, reason: `${shadow} holds a different value — kept` };
            q(() => ops.remove(kc.keychain, kc.service, shadow));
          }
          q(() => ops.add(kc.keychain, { service: kc.service, account: shadow, value: req.value, access }));
          return sameBytes(q(() => ops.readBytes(kc.keychain, kc.service, shadow)), bytes) ? { ok: true } : { ok: false, reason: `${shadow} did not read back` };
        }
        case "commit": {
          const shadow = `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`;
          const value = q(() => readStoredValue(kc, shadow));
          if (value === null) return { ok: false, reason: `${shadow} is missing` };
          if (q(() => ops.present(kc.keychain, kc.service, req.account))) return { ok: false, reason: `${req.account} is still there` };
          q(() => putBack(kc, access, req.account, value));
          q(() => ops.remove(kc.keychain, kc.service, shadow));
          return { ok: true };
        }
        case "drop":
          q(() => ops.remove(kc.keychain, kc.service, `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`));
          return { ok: true };
        case "marker":
          if (req.migrated === 0 && req.skipped > 0) return { ok: true }; // nothing landed here: not "done"
          if (requirement === undefined) return { ok: true }; // never a marker keyed on a path
          writeCredentialAclMarker(home, kc.service, requirement, { migrated: req.migrated, skipped: req.skipped });
          return { ok: true };
        case "done":
          return { ok: true };
      }
    } catch (err) {
      return { ok: false, reason: describe(err) };
    }
  };
}

export type DevTransitionOutcome =
  | { kind: "done"; adopted: string[]; skipped: string[]; restored: string[] }
  | { kind: "stopped"; account: string; reason: string; adopted: string[]; skipped: string[] };

/**
 * THE ORCHESTRATOR (the old creator — run it under `bun`): moves every item under `kc.service` to the child's
 * creation (see the header). `send` is the child's handler, over a pipe or in-process. The caller holds the
 * credential migration lock. An item it cannot read (or whose value is not valid UTF-8), shadow or delete is
 * skipped (it keeps bun as its creator); a failed commit, a failed recovery or marker, or a channel failure
 * stops the run — without a marker.
 */
export async function runDevKeychainTransition(kc: CredentialKeychain, send: (req: AdoptRequest) => Promise<AdoptResponse>, log: (line: string) => void = () => {}): Promise<DevTransitionOutcome> {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  const q = <T>(fn: () => T): T => withKeychainUserInteractionDisabled(fn);
  const adopted: string[] = [];
  const skipped: string[] = [];
  const stop = (account: string, reason: string): DevTransitionOutcome => ({ kind: "stopped", account, reason, adopted, skipped });
  const hello = await send({ op: "hello" });
  if (!hello.ok) return stop("(child)", hello.reason);
  if (hello.service !== kc.service) return stop("(child)", `the child uses ${hello.service ?? "no service"}, not ${kc.service}`);
  // The OLD creator's own recovery first: shadows a crashed bun-run migration left are bun's, which the child
  // cannot read. Restored (or, beside their original, dropped as stale), they are then adopted below.
  const oldAccess = q(() => ops.createAccess("Winter credential", [null]));
  let restored: string[];
  try {
    restored = q(() => recoverCredentialShadows({ ...kc, log: (line) => log(line) }, oldAccess, { dropShadowsBesideOriginals: true, owns: isItem }));
  } finally {
    oldAccess.release();
  }
  const recovered = await send({ op: "recover" });
  if (!recovered.ok) return stop("(recover)", recovered.reason);
  restored = [...restored, ...(recovered.restored ?? [])];
  if (restored.length > 0) log(`restored from an earlier run's shadows: ${restored.join(", ")}`);
  const accounts = [...new Set(q(() => ops.list(kc.keychain, kc.service)))].filter(isItem).sort();
  for (const account of accounts) {
    let value: string | null;
    try {
      value = q(() => readStoredValue(kc, account))?.text ?? null;
    } catch (err) {
      // Most often an item an earlier run already adopted (the child created it: this process may not read it).
      skipped.push(account);
      log(`${account}: not readable by this process without a prompt, or not UTF-8 (${describe(err)}) — left as it is`);
      continue;
    }
    if (value === null) continue;
    const shadowed = await send({ op: "shadow", account, value });
    value = null;
    if (!shadowed.ok) {
      if (shadowed.fatal) return stop(account, shadowed.reason);
      skipped.push(account);
      log(`${account}: the new creator could not write its shadow (${shadowed.reason}) — left as it is`);
      continue;
    }
    let removed: boolean;
    try {
      removed = q(() => ops.remove(kc.keychain, kc.service, account));
    } catch (err) {
      const dropped = await send({ op: "drop", account });
      if (!dropped.ok && dropped.fatal) return stop(account, dropped.reason);
      skipped.push(account);
      log(`${account}: could not be deleted by this process (${describe(err)}) — left as it is`);
      continue;
    }
    if (!removed) {
      // It vanished since the read (a removal landed): nothing to re-create; the child's shadow goes.
      const dropped = await send({ op: "drop", account });
      if (!dropped.ok && dropped.fatal) return stop(account, dropped.reason);
      skipped.push(account);
      log(`${account}: vanished before the delete — left removed`);
      continue;
    }
    const committed = await send({ op: "commit", account });
    if (!committed.ok) {
      log(`${account}: the new creator could not re-create it (${committed.reason}) — its shadow holds the value; re-run the transition (or start the compiled daemon, whose boot restores it)`);
      return stop(account, committed.reason);
    }
    adopted.push(account);
  }
  if (!(adopted.length === 0 && skipped.length > 0)) {
    const marked = await send({ op: "marker", migrated: adopted.length, skipped: skipped.length });
    if (!marked.ok) return stop("(marker)", marked.reason);
  }
  await send({ op: "done" });
  return { kind: "done", adopted, skipped, restored };
}

/**
 * Run under `bun` BEFORE starting the signed binary on the dev home: `true` when ANY item there is still one
 * THIS process reads silently — i.e. bun still owns it, and the signed binary's first read of it would
 * prompt. Every account is tried, with interaction disabled; values are discarded. `false` on a fresh home
 * (no items) or once every item belongs to the signed binary.
 */
export function oldCreatorStillOwnsItems(kc: CredentialKeychain): boolean {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  return withKeychainUserInteractionDisabled(() => {
    for (const account of ops.list(kc.keychain, kc.service).filter(isItem)) {
      try {
        const bytes = ops.readBytes(kc.keychain, kc.service, account);
        if (bytes !== null && bytes.length > 0) return true;
      } catch {
        /* not this process's: look at the next one */
      }
    }
    return false;
  });
}

/** The transition refuses while `core.lock` names ANY live process — answering socket or not (a daemon
 *  mid-boot has none yet). `core.lock` records when it was written (`startedAt`, after its writer started),
 *  so a live pid whose process STARTED later than that is a reused pid, and the lock is stale. */
export function bootLockHolderRefusal(home: string, startOf: (pid: number) => number | undefined = processStartSeconds): string | undefined {
  const path = join(home, "run", "core.lock");
  let record: { pid?: unknown; startedAt?: unknown };
  try { record = JSON.parse(readFileSync(path, "utf8")) as typeof record; } catch { return undefined; }
  const pid = record.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  if (typeof record.startedAt === "number") {
    const started = startOf(pid);
    // One second of slack for the two clocks' rounding.
    if (started !== undefined && started > Math.floor(record.startedAt / 1000) + 1) return undefined;
  }
  return `pid ${pid} holds ${path} (a dev daemon running or booting) — stop it and run again, or remove run/core.lock if no dev daemon is running`;
}

/** The child acts only while the orchestrator — its PARENT — holds the home's credential migration lock. */
export function adoptLockRefusal(home: string, parentPid: number): string | undefined {
  const holder = credentialMigrationLockHolder(home);
  return holder !== undefined && holder === parentPid ? undefined : `the credential migration lock is not held by the parent process (${holder ?? "no holder"})`;
}

/** The child's process loop: NDJSON requests on stdin, one NDJSON response each on stdout. */
export async function runDevKeychainAdopt(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  const profile = resolveWinterProfile(env);
  const home = env.WINTER_HOME ?? "";
  const service = profile === "dev" ? DEV_KEYCHAIN_SERVICE : "com.winter.core";
  const refusal = devTransitionRefusal({ profile, home, service });
  const fatal = (reason: string): never => {
    process.stderr.write(`winter-core: ${DEV_KEYCHAIN_ADOPT_ARG} refused: ${reason}\n`);
    process.exit(2);
  };
  if (refusal !== undefined) fatal(refusal);
  if (!keychainUnlocked(null)) fatal("the default keychain is locked");
  const lockRefusal = adoptLockRefusal(home, process.ppid);
  if (lockRefusal !== undefined) fatal(lockRefusal);
  // No path stand-in: without a designated requirement the child adopts but writes no marker.
  const requirement = codeSigningFacts(realExecutable(), 2_000).requirement;
  const kc: CredentialKeychain = { keychain: null, service, log: (line) => process.stderr.write(`${line}\n`) };
  let access: KeychainAccess;
  try {
    access = withKeychainUserInteractionDisabled(() => REAL_CREDENTIAL_KEYCHAIN_OPS.createAccess("Winter credential", [null]));
  } catch (err) {
    return fatal(`the access list could not be built (${describe(err)})`);
  }
  const handle = createAdoptHandler(kc, access, home, requirement);
  await serveAdoptRequests(handle, process.stdin, (line) => process.stdout.write(line));
  access.release();
  // As `workflows/subprocess-entry.ts` does: let the last response line flush before the process ends.
  setTimeout(() => process.exit(0), 50);
  return await new Promise<never>(() => {});
}

/** The child's request loop over any byte stream: one NDJSON response per NDJSON request, until `done` or
 *  the end of input. Separate from `runDevKeychainAdopt` so a test drives the very same loop over a pipe. */
export async function serveAdoptRequests(handle: (req: AdoptRequest) => AdoptResponse, input: AsyncIterable<unknown>, write: (line: string) => void): Promise<void> {
  let buf = "";
  for await (const chunk of input) {
    buf += Buffer.from(chunk as Uint8Array).toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let req: AdoptRequest;
      try {
        req = JSON.parse(line) as AdoptRequest;
      } catch {
        write(`${JSON.stringify({ ok: false, reason: "unparsable request" })}\n`);
        continue;
      }
      write(`${JSON.stringify(handle(req))}\n`);
      if (req.op === "done") return;
    }
  }
}

/** How long the orchestrator waits for any one response before it treats the child as gone. */
export const ADOPT_REQUEST_TIMEOUT_MS = 30_000;

/** A running child's request door: sequential, one response per request. */
export function spawnAdoptChild(command: { file: string; args: string[] }, env: NodeJS.ProcessEnv, timeoutMs: number = ADOPT_REQUEST_TIMEOUT_MS): { send: (req: AdoptRequest) => Promise<AdoptResponse>; close: () => Promise<number | null> } {
  const child = spawn(command.file, command.args, { stdio: ["pipe", "pipe", "inherit"], env });
  const waiting: Array<(r: AdoptResponse) => void> = [];
  let buf = "";
  let exited = false;
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => { exited = true; for (const w of waiting.splice(0)) w({ ok: false, reason: `the child exited (${code ?? "signal"})`, fatal: true }); resolve(code); }));
  // A request written to a child that already exited raises EPIPE on stdin; "close" above answers every
  // waiter fatally, so the stream error only needs a listener (uncaught, it would kill this process).
  child.stdin!.on("error", () => { /* reported via "close" */ });
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let r: AdoptResponse;
      try { r = JSON.parse(line) as AdoptResponse; } catch { r = { ok: false, reason: "unparsable response", fatal: true }; }
      waiting.shift()?.(r);
    }
  });
  return {
    send: (req) => new Promise((resolve) => {
      if (exited) return resolve({ ok: false, reason: "the child has exited", fatal: true });
      // A child that stops answering must not hold the home's lock forever: time out, and kill it so no
      // later response can be paired with the wrong request.
      const timer = setTimeout(() => {
        const at = waiting.indexOf(answer);
        if (at >= 0) waiting.splice(at, 1);
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve({ ok: false, reason: `no answer to ${req.op} within ${timeoutMs} ms`, fatal: true });
      }, timeoutMs);
      const answer = (r: AdoptResponse): void => { clearTimeout(timer); resolve(r); };
      waiting.push(answer);
      child.stdin!.write(`${JSON.stringify(req)}\n`);
    }),
    close: async () => {
      child.stdin!.end();
      return exit;
    },
  };
}

/**
 * The whole transition, as `scripts/dev-daemon.ts --transition` runs it: guards, the home's credential
 * migration lock (pid liveness: a daemon mid-boot refuses it too) and its boot lock (a running dev daemon
 * refuses it), the child, the run. `binary` is the signed compiled `winter-core`.
 */
export async function transitionDevKeychain(input: { binary: string; home: string; env: NodeJS.ProcessEnv; log: (line: string) => void }): Promise<DevTransitionOutcome> {
  const refusal = devTransitionRefusal({ profile: resolveWinterProfile(input.env), home: input.home, service: DEV_KEYCHAIN_SERVICE });
  if (refusal !== undefined) throw new Error(refusal);
  if (!keychainUnlocked(null)) throw new Error("the default keychain is locked — unlock it and run again");
  const migrationLock = acquireCredentialMigrationLock(input.home);
  if ("heldBy" in migrationLock) throw new Error(`pid ${migrationLock.heldBy} holds the credential migration lock (a dev daemon booting, or another transition) — wait for it and run again`);
  let lock;
  try {
    const busy = bootLockHolderRefusal(input.home);
    if (busy !== undefined) throw new Error(busy);
    lock = await acquireLock(join(input.home, "run", "core.lock"), join(input.home, "run", "core.sock"));
  } catch (err) {
    migrationLock.release();
    throw err;
  }
  try {
    const child = spawnAdoptChild({ file: input.binary, args: [DEV_KEYCHAIN_ADOPT_ARG] }, input.env);
    try {
      return await runDevKeychainTransition({ keychain: null, service: DEV_KEYCHAIN_SERVICE, log: input.log }, child.send, input.log);
    } finally {
      await child.close();
    }
  } finally {
    lock.release();
    migrationLock.release();
  }
}
