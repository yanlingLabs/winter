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
// daemon's own boot recovery, puts the original back). The orchestrator holds the home's daemon lock for the
// whole run, so no daemon can boot mid-transition and mint fresh pairing tokens.
//
// ONE-WAY. After it, a dev-profile process that is NOT the compiled binary (a `bun`-run CLI, a `bun`-run
// daemon) is prompted for every item it reads. Both sides refuse anything but the dev profile on its default
// home and the dev Keychain service.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { acquireLock } from "../lock";
import { resolveWinterProfile, type WinterProfile } from "../profile";
import { isDefaultWinterHome } from "../winter-dir";
import { APP_TOKEN_SHADOW_SUFFIX } from "./app-token-acl";
import { recoverCredentialShadows, REAL_CREDENTIAL_KEYCHAIN_OPS, writeCredentialAclMarker, type CredentialKeychain } from "./credential-acl";
import { ERR_SEC_DUPLICATE_ITEM, KeychainFfiError, keychainUnlocked, withKeychainUserInteractionDisabled, type KeychainAccess } from "./keychain-ffi";

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

export type AdoptResponse = { ok: true; service?: string; restored?: string[] } | { ok: false; reason: string };

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
export function createAdoptHandler(kc: CredentialKeychain, access: KeychainAccess, home: string): (req: AdoptRequest) => AdoptResponse {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  const q = <T>(fn: () => T): T => withKeychainUserInteractionDisabled(fn);
  return (req) => {
    try {
      switch (req.op) {
        case "hello":
          return { ok: true, service: kc.service };
        case "recover":
          return { ok: true, restored: q(() => recoverCredentialShadows(kc, access, { dropEqualShadows: false, owns: isItem })) };
        case "shadow": {
          if (!isItem(req.account)) return { ok: false, reason: "not an item" };
          const shadow = `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`;
          if (q(() => ops.present(kc.keychain, kc.service, shadow))) {
            // A re-run after an interruption: the same value is the same step, done already.
            return q(() => ops.read(kc.keychain, kc.service, shadow)) === req.value ? { ok: true } : { ok: false, reason: `${shadow} holds a different value` };
          }
          q(() => ops.add(kc.keychain, { service: kc.service, account: shadow, value: req.value, access }));
          return q(() => ops.read(kc.keychain, kc.service, shadow)) === req.value ? { ok: true } : { ok: false, reason: `${shadow} did not read back` };
        }
        case "commit": {
          const shadow = `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`;
          const value = q(() => ops.read(kc.keychain, kc.service, shadow));
          if (value === null || value === "") return { ok: false, reason: `${shadow} is missing` };
          if (q(() => ops.present(kc.keychain, kc.service, req.account))) return { ok: false, reason: `${req.account} is still there` };
          try {
            q(() => ops.add(kc.keychain, { service: kc.service, account: req.account, value, access }));
          } catch (err) {
            if (!(err instanceof KeychainFfiError && err.status === ERR_SEC_DUPLICATE_ITEM)) throw err;
          }
          if (q(() => ops.read(kc.keychain, kc.service, req.account)) !== value) return { ok: false, reason: `${req.account} did not read back` };
          q(() => ops.remove(kc.keychain, kc.service, shadow));
          return { ok: true };
        }
        case "drop":
          q(() => ops.remove(kc.keychain, kc.service, `${req.account}${APP_TOKEN_SHADOW_SUFFIX}`));
          return { ok: true };
        case "marker":
          writeCredentialAclMarker(home, kc.service, { migrated: req.migrated, skipped: req.skipped });
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
 * home's daemon lock. Never throws for a Keychain failure: an item it cannot read, shadow or delete is
 * skipped (it keeps bun as its creator); a failed commit stops the run with that item's shadow in place.
 */
export async function runDevKeychainTransition(kc: CredentialKeychain, send: (req: AdoptRequest) => Promise<AdoptResponse>, log: (line: string) => void = () => {}): Promise<DevTransitionOutcome> {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  const q = <T>(fn: () => T): T => withKeychainUserInteractionDisabled(fn);
  const hello = await send({ op: "hello" });
  if (!hello.ok) return { kind: "stopped", account: "(child)", reason: hello.reason, adopted: [], skipped: [] };
  if (hello.service !== kc.service) return { kind: "stopped", account: "(child)", reason: `the child uses ${hello.service ?? "no service"}, not ${kc.service}`, adopted: [], skipped: [] };
  const recovered = await send({ op: "recover" });
  const restored = recovered.ok ? recovered.restored ?? [] : [];
  if (restored.length > 0) log(`restored from an earlier run's shadows: ${restored.join(", ")}`);
  const accounts = [...new Set(q(() => ops.list(kc.keychain, kc.service)))].filter(isItem).sort();
  const adopted: string[] = [];
  const skipped: string[] = [];
  for (const account of accounts) {
    let value: string | null;
    try {
      value = q(() => ops.read(kc.keychain, kc.service, account));
    } catch (err) {
      // Most often an item an earlier run already adopted (the child created it: this process may not read it).
      skipped.push(account);
      log(`${account}: not readable by this process without a prompt (${describe(err)}) — left as it is`);
      continue;
    }
    if (value === null || value === "") continue;
    const shadowed = await send({ op: "shadow", account, value });
    value = null;
    if (!shadowed.ok) {
      skipped.push(account);
      log(`${account}: the new creator could not write its shadow (${shadowed.reason}) — left as it is`);
      continue;
    }
    try {
      q(() => ops.remove(kc.keychain, kc.service, account));
    } catch (err) {
      await send({ op: "drop", account });
      skipped.push(account);
      log(`${account}: could not be deleted by this process (${describe(err)}) — left as it is`);
      continue;
    }
    const committed = await send({ op: "commit", account });
    if (!committed.ok) {
      log(`${account}: the new creator could not re-create it (${committed.reason}) — its shadow holds the value; re-run the transition (or start the compiled daemon, whose boot restores it)`);
      return { kind: "stopped", account, reason: committed.reason, adopted, skipped };
    }
    adopted.push(account);
  }
  await send({ op: "marker", migrated: adopted.length, skipped: skipped.length });
  await send({ op: "done" });
  return { kind: "done", adopted, skipped, restored };
}

/**
 * Run under `bun` BEFORE starting the signed binary on the dev home: `true` when an item there is still one
 * THIS process reads silently — i.e. bun still owns the items, the transition has not run, and the signed
 * binary's first reads would prompt. Reads at most one item, with interaction disabled; the value is
 * discarded. `false` on a fresh home (no items) or once every item belongs to the signed binary.
 */
export function oldCreatorStillOwnsItems(kc: CredentialKeychain): boolean {
  const ops = kc.ops ?? REAL_CREDENTIAL_KEYCHAIN_OPS;
  return withKeychainUserInteractionDisabled(() => {
    const accounts = ops.list(kc.keychain, kc.service).filter(isItem).sort((a, b) => (a === "admin-token" ? -1 : b === "admin-token" ? 1 : a.localeCompare(b)));
    for (const account of accounts.slice(0, 3)) {
      try {
        const value = ops.read(kc.keychain, kc.service, account);
        if (value !== null && value !== "") return true;
      } catch {
        /* not this process's: look at the next one */
      }
    }
    return false;
  });
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
  const kc: CredentialKeychain = { keychain: null, service, log: (line) => process.stderr.write(`${line}\n`) };
  let access: KeychainAccess;
  try {
    access = withKeychainUserInteractionDisabled(() => REAL_CREDENTIAL_KEYCHAIN_OPS.createAccess("Winter credential", [null]));
  } catch (err) {
    return fatal(`the access list could not be built (${describe(err)})`);
  }
  const handle = createAdoptHandler(kc, access, home);
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
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => { exited = true; for (const w of waiting.splice(0)) w({ ok: false, reason: `the child exited (${code ?? "signal"})` }); resolve(code); }));
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let r: AdoptResponse;
      try { r = JSON.parse(line) as AdoptResponse; } catch { r = { ok: false, reason: "unparsable response" }; }
      waiting.shift()?.(r);
    }
  });
  return {
    send: (req) => new Promise((resolve) => {
      if (exited) return resolve({ ok: false, reason: "the child has exited" });
      // A child that stops answering must not hold the home's lock forever: time out, and kill it so no
      // later response can be paired with the wrong request.
      const timer = setTimeout(() => {
        const at = waiting.indexOf(answer);
        if (at >= 0) waiting.splice(at, 1);
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        resolve({ ok: false, reason: `no answer to ${req.op} within ${timeoutMs} ms` });
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
 * The whole transition, as `scripts/dev-daemon.ts --transition` runs it: guards, the home's daemon lock (a
 * live dev daemon refuses it), the child, the run. `binary` is the signed compiled `winter-core`.
 */
export async function transitionDevKeychain(input: { binary: string; home: string; env: NodeJS.ProcessEnv; log: (line: string) => void }): Promise<DevTransitionOutcome> {
  const refusal = devTransitionRefusal({ profile: resolveWinterProfile(input.env), home: input.home, service: DEV_KEYCHAIN_SERVICE });
  if (refusal !== undefined) throw new Error(refusal);
  if (!keychainUnlocked(null)) throw new Error("the default keychain is locked — unlock it and run again");
  const lock = await acquireLock(join(input.home, "run", "core.lock"), join(input.home, "run", "core.sock"));
  try {
    const child = spawnAdoptChild({ file: input.binary, args: [DEV_KEYCHAIN_ADOPT_ARG] }, input.env);
    try {
      return await runDevKeychainTransition({ keychain: null, service: DEV_KEYCHAIN_SERVICE, log: input.log }, child.send, input.log);
    } finally {
      await child.close();
    }
  } finally {
    lock.release();
  }
}
