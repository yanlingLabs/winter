import type { AdmissionOwner, CoworkAdmissionLedger } from "./admission";
import type { CoworkGuestStartPort } from "./service";
import { CoworkImagePins, type CoworkImageDigests } from "./images";
import { CoworkError } from "./types";
import type { CoworkRepository } from "./repository";
import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkVolumes } from "./volumes";
import type { CoworkVolumeBackup } from "./volume-backup";
import { CoworkNativeAuthority } from "./native/authority";
import type { CoworkNativeGuestRecords } from "./native/guest-records";
import type { CoworkProvisioningPort } from "./session-ports";
import { CoworkNativeHost, type CoworkLauncherPort, type CoworkNativeHostDeps, type CoworkNativeImagePins, type CoworkNativeRunning, type CoworkNativeStartRequest } from "./native/host";
import { CoworkNativePower } from "./native/power";
import { COWORK_NATIVE_LIMITS, coworkNativeHostStopWaitMs } from "./native/protocol";
import { CoworkNativeReceiptKeyStore, type CoworkNativeReceiptKey, type CoworkNativeSecretSlot } from "./native/receipt-mac";
import { CoworkNativeRecovery, describeNativeError, type CoworkNativeDurableReceiptPort, type CoworkNativeOwnerRecoverPort, type CoworkNativeRecoveryReport } from "./native/recovery";
import { CoworkNativeStopRegistry, type CoworkNativeHostBoot, type CoworkNativeLaunchJournalPort, type CoworkNativeRecoverGuards } from "./native/stop-proof";

/*
 * N2 S7: the daemon's one door to the native worker host (S1), and the only module outside `cowork/native/` that may import it.
 *
 * INERT BY CONSTRUCTION. Creating a wiring builds nothing: no host, no volumes object, no ledger, no launcher, no process, no socket,
 * no timer, no file. The host is built the first time a workspace start asks for it, from an ENVIRONMENT that the daemon's caller
 * injects. Production injects none: every host fact the environment holds (the launcher, the admission ledger's installation id,
 * the home binding, the backup port, the retained-receipt store) is still an undecided owner point or an unmerged slice, so in
 * production nothing here runs: the Cowork service has no native port, so a Cowork start refuses with `unsupported_topology` before it gets this far
 * (`native_unavailable` is only what this wiring throws if it is asked directly), and nothing else happens. No setting, environment variable or flag reads
 * this: the only way in is the `environment` option of `startDaemon`, which only code can pass.
 *
 * D1 is binding here, and this module decides nothing about it. A disk is released only by what the host's recovery accepts as
 * proof (an orderly receipt, a changed host boot, an owner recover after two checks). `reconcileAtBoot` is record-and-refuse:
 * with an environment it runs the host's own recovery (which never releases on weaker evidence); without one it reads the records
 * and writes NOTHING.
 */

export type CoworkNativeUnavailableCode = "native_unavailable" | "native_closing" | "receipt_key_unavailable";
export class CoworkNativeUnavailableError extends Error {
  constructor(readonly code: CoworkNativeUnavailableCode) { super(code); this.name = "CoworkNativeUnavailableError"; }
}

/** What the host needs that is a host fact rather than a Core record. Every member is injected; none has a default. */
export interface CoworkNativeEnvironment {
  readonly launcher: CoworkLauncherPort;
  readonly admission: CoworkAdmissionLedger;
  readonly backup: CoworkVolumeBackup;
  readonly hostBoot: CoworkNativeHostBoot;
  /** This daemon process as the admission ledger knows it. */
  readonly daemon: () => AdmissionOwner;
  /** The launcher's retained receipts, the owner-recover input and its guards, and the durable launch journal. Absent means refuse: recovery then keeps ownership. */
  readonly receipts?: CoworkNativeDurableReceiptPort;
  readonly ownerRecover?: CoworkNativeOwnerRecoverPort;
  /** The two guard probes, or a factory that receives the volumes object the wiring builds (the process probe needs to know whether any volume still names an owner). */
  readonly guards?: CoworkNativeRecoverGuards | ((context: { readonly volumes: Pick<CoworkVolumes, "records"> }) => CoworkNativeRecoverGuards);
  /** Called once, right after the host is built, so an environment can reach the host (the pressure guard halts writers by stopping guests). */
  readonly bindHost?: (host: { activeWorkspaces(): string[]; stop(workspaceId: string, reason: "shutdown"): Promise<{ readonly released: boolean }> }) => void;
  /** Awaited before every start (a fresh disk-pressure sample, timers started). Failing refuses the start. */
  readonly prepareStart?: () => Promise<void>;
  /** Called at shutdown, after the guests were drained: timers stopped, the ledger closed. */
  readonly close?: () => void;
  readonly journal?: CoworkNativeLaunchJournalPort;
  /** The host's durable guest records (the boot at `hello`, its end proof, the data volume's UUID). Absent: nothing is recorded and no boot is attested as ended. */
  readonly guestRecords?: CoworkNativeGuestRecords;
  /** The outputs directory preparer and the share directory opener (see `native/host.ts`). Absent: nothing is created, and a start that asks for shares is refused. */
  readonly outputs?: { ensure(workspaceId: string, logicalSessionId: string): void };
  /** The provisioning port of this environment (the door's shape). Reached only through `provisioningPort()` below, and only when an environment was injected. */
  readonly provisioningPort?: CoworkProvisioningPort;
  readonly shareDirectories?: { open(hostPath: string): { readonly fd: number; readonly device: string; readonly inode: string; close(): void } };
  /** Timers, clocks, checkpoints and the conversation source: everything of the host's own that is not one of the structural ports above. */
  readonly hostOptions?: Partial<Omit<CoworkNativeHostDeps, "records" | "volumes" | "admission" | "authority" | "power" | "recovery" | "registry" | "hostBoot" | "launcher" | "images" | "journal" | "daemon">>;
}
export interface CoworkNativeWiringOptions {
  readonly db: RuntimeStateDb; readonly records: CoworkRepository; readonly home: string;
  /** Called at most once, lazily. Absent in production. A throw is treated as "unavailable" and is retried on the next ask. */
  readonly environment?: () => CoworkNativeEnvironment;
  /** Overrides the image-pin source (tests). The default is a read-only view of the stored pins. */
  readonly imagePins?: Pick<CoworkImagePins, "get" | "assertPinned">;
  /** The daemon's secret store (its Keychain service). The receipt MAC key lives in it, under `cowork-native-receipt-mac-v1`, created on the first start that needs it
   * and read (never created) at boot. Absent: no key exists, so a start refuses (`no_receipt_key`) and every retained receipt is Class B. Never touched until a start or a boot scan that
   * has something to settle asks for it, and never without an environment. */
  readonly secrets?: CoworkNativeSecretSlot;
  /** How long a Keychain read for the receipt key may take before it counts as "no key" (boot) or refuses the start. A JS timer cannot interrupt a call that blocks the
   * main thread; it bounds a promise that never settles (a prompt waiting for a person, a locked Keychain) and nothing else. Default 5000. */
  readonly keyReadTimeoutMs?: number;
  /** Test seam that can only SHORTEN the shutdown bound below the contract's host wait; it can never lengthen it. */
  readonly shutdownBoundMs?: number;
}

/** Binds the host's `ImagePins` port to the stored pin bookkeeping (PR #46). The launch digest is the pinned RUNTIME image's, and it is
 * accepted only after `assertPinned` has compared it with the live pin: no pin refuses (`image_unpinned`), and a pending update never
 * counts (only the confirmed digests are live). */
export function bindCoworkImagePins(pins: Pick<CoworkImagePins, "get" | "assertPinned">): CoworkNativeImagePins {
  return {
    runtimeImageDigest(workspaceId: string): string {
      const pin = pins.get(workspaceId);
      if (pin === null) {
        // assertPinned names the refusal (`image_unpinned`); the throw below is only for a pins object that did not refuse.
        pins.assertPinned(workspaceId, { baseImageDigest: "0".repeat(64), runtimeImageDigest: "0".repeat(64) });
        throw new Error("image_unpinned");
      }
      const live: CoworkImageDigests = { baseImageDigest: pin.baseImageDigest, runtimeImageDigest: pin.runtimeImageDigest };
      pins.assertPinned(workspaceId, live);
      return live.runtimeImageDigest;
    },
  };
}

/** A read-only pin view: the update and export paths need an authority and a compatibility oracle, and both refuse everything here. */
export function readOnlyImagePins(db: RuntimeStateDb): CoworkImagePins {
  return new CoworkImagePins(db, { authorize: () => false }, { compatible: () => false });
}

export interface CoworkNativeBootReport {
  /** "host" when the host's own recovery ran, "records" when only the records were read (no environment). */
  readonly source: "host" | "records";
  readonly reports: readonly CoworkNativeRecoveryReport[];
}

export class CoworkNativeWiring implements CoworkGuestStartPort {
  private hostInstance: CoworkNativeHost | undefined;
  private closing = false;
  private readonly starting = new Set<Promise<unknown>>();
  private drainBudgetMs: number = COWORK_NATIVE_LIMITS.drainBudgetMs;
  private receiptKey: CoworkNativeReceiptKey | null = null;
  private environmentInstance: CoworkNativeEnvironment | undefined;
  private readonly keys: CoworkNativeReceiptKeyStore | undefined;
  constructor(private readonly options: CoworkNativeWiringOptions) { this.keys = options.secrets ? new CoworkNativeReceiptKeyStore(options.secrets) : undefined; }

  /** True once the host has been built (never at construction). */
  get built(): boolean { return this.hostInstance !== undefined; }

  /** The environment, built once (by the first thing that needs it: a provisioning question or a start). Throws `native_unavailable` when there is none, and a failed build is retried at the next ask. */
  private environment(): CoworkNativeEnvironment {
    if (this.environmentInstance) return this.environmentInstance;
    const make = this.options.environment;
    if (!make) throw new CoworkNativeUnavailableError("native_unavailable");
    try { this.environmentInstance = make(); } catch { throw new CoworkNativeUnavailableError("native_unavailable"); }
    return this.environmentInstance;
  }

  /** The door's provisioning port over this wiring's environment, or undefined when no environment was injected (production). Lazy: nothing is built until the port is asked;
   *  until the environment exists and says so, `available()` is false and `admit` refuses `unsupported_topology`. */
  provisioningPort(): CoworkProvisioningPort | undefined {
    if (!this.options.environment) return undefined;
    const port = (): CoworkProvisioningPort | undefined => { try { return this.environment().provisioningPort; } catch { return undefined; } };
    return {
      available: () => { try { return port()?.available() === true; } catch { return false; } },
      admit: principal => { const inner = port(); if (inner === undefined) throw new CoworkError("unsupported_topology"); inner.admit(principal); },
      provision: async (workspaceId, operationId) => {
        const inner = port();
        // No port in the environment is NOT a definite failure (a `failed` answer concludes a never-booted creation for good): it throws, which the service treats as
        // uncertain and retries at the next resume. Only the port itself may say `failed`.
        if (inner === undefined) throw new CoworkError("unsupported_topology");
        try { return await inner.provision(workspaceId, operationId); } catch { return { status: "failed", reason: "provision_failed" }; }
      },
    };
  }

  /** Build the host from the environment, once. Throws `native_unavailable` when there is none. */
  private host(): CoworkNativeHost {
    if (this.hostInstance) return this.hostInstance;
    const environment = this.environment();
    const { db, records, home } = this.options;
    const registry = new CoworkNativeStopRegistry();
    const authority = new CoworkNativeAuthority({ records, hostBoot: environment.hostBoot, registry });
    const volumes = new CoworkVolumes(db, home, authority.volumes, environment.backup, undefined, authority.filesystem);
    const power = new CoworkNativePower(db);
    const recovery = new CoworkNativeRecovery({ records, volumes, admission: environment.admission, power, registry, hostBoot: environment.hostBoot, receiptKey: () => this.receiptKey,
      receipts: environment.receipts, ownerRecover: environment.ownerRecover, guestRecords: environment.guestRecords, guards: typeof environment.guards === "function" ? environment.guards({ volumes }) : environment.guards, journal: environment.journal, now: environment.hostOptions?.now });
    const images = bindCoworkImagePins(this.options.imagePins ?? readOnlyImagePins(db));
    this.drainBudgetMs = environment.hostOptions?.timeouts?.drainBudgetMs ?? COWORK_NATIVE_LIMITS.drainBudgetMs;
    this.hostInstance = new CoworkNativeHost({ ...environment.hostOptions, records, volumes, admission: environment.admission, authority, power, recovery, registry, hostBoot: environment.hostBoot,
      launcher: environment.launcher, images, receiptKey: () => this.receiptKey, journal: environment.journal, daemon: environment.daemon,
      ...(environment.guestRecords ? { guestRecords: environment.guestRecords } : {}), ...(environment.outputs ? { outputs: environment.outputs } : {}), ...(environment.shareDirectories ? { shareDirectories: environment.shareDirectories } : {}) });
    try { environment.bindHost?.({ activeWorkspaces: () => this.hostInstance!.activeWorkspaces(), stop: (workspaceId, reason) => this.hostInstance!.stop(workspaceId, reason) }); } catch { /* an environment that cannot bind has no pressure halt; the guard then reports unconfirmed */ }
    return this.hostInstance;
  }

  /** The Keychain bound: the promise's own value, or `expired` after the bound. A late settlement is dropped by the caller never reading it, and the timer is always cleared. */
  private async withinSecretBound<T>(work: Promise<T>, expired: T | Error): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<T | Error>(resolve => { timer = setTimeout(() => resolve(expired), this.options.keyReadTimeoutMs ?? 5_000); timer.unref?.(); });
    try { const value = await Promise.race([work, bound]); if (value instanceof Error && value === expired) throw value; return value as T; }
    finally { if (timer) clearTimeout(timer); }
  }

  /** The service's door. Refused once shutdown began. */
  async start(workspaceId: string, request?: CoworkNativeStartRequest): Promise<CoworkNativeRunning> {
    if (this.closing) throw new CoworkNativeUnavailableError("native_closing");
    const host = this.host();
    try { await this.environmentInstance?.prepareStart?.(); } catch { throw new CoworkNativeUnavailableError("native_unavailable"); }
    if (this.keys && this.receiptKey === null) {
      // Created on first need. A Keychain that cannot be read or written, or does not answer in time, refuses the start; nothing has moved yet.
      try { this.receiptKey = await this.withinSecretBound(this.keys.ensure(), new Error("keychain_timeout")); } catch { throw new CoworkNativeUnavailableError("receipt_key_unavailable"); }
    }
    if (this.closing) throw new CoworkNativeUnavailableError("native_closing");
    const started = host.start(workspaceId, request);
    this.starting.add(started);
    try { return await started; } finally { this.starting.delete(started); }
  }

  /** Daemon start. Record-and-refuse: nothing is released here on weaker evidence than the host's recovery accepts, and without an
   * environment nothing is written at all. Never throws. */
  async reconcileAtBoot(): Promise<CoworkNativeBootReport> {
    const { records } = this.options;
    // The cheap, read-only scan first. A retained workspace needs settling when its power is not `stopped` OR any of its volumes still names an
    // owner, whatever its power says (the host's recovery uses the same two facts, plus the admission row). An admission row exists only for a
    // workspace that was ever launched (`incarnationId` set), so with an environment injected a launched workspace is also handed to the host,
    // whose recovery reads the ledger; a database where nothing was ever launched builds and asks for nothing.
    const pending: CoworkNativeRecoveryReport[] = [];
    let launched = false;
    try {
      const owned = new Set(this.options.db.db.query<{ workspace_id: string }, []>("SELECT DISTINCT workspace_id FROM cowork_volumes WHERE owner_json IS NOT NULL").all().map(row => row.workspace_id));
      for (const workspace of records.list()) {
        if (workspace.state !== "retained") continue;
        if (workspace.incarnationId !== null) launched = true;
        if (workspace.power === "stopped" && !owned.has(workspace.workspaceId)) continue;
        pending.push({ workspaceId: workspace.workspaceId, action: "retained", evidence: null, power: workspace.power, ownerRetained: true, admission: "none", reason: "native host unavailable; ownership kept" });
      }
    } catch (error) { console.error(`cowork: native boot scan failed (${describeNativeError(error)})`); return { source: "records", reports: [] }; }
    if (!this.options.environment || (pending.length === 0 && !launched)) return { source: "records", reports: pending };
    try {
      const host = this.host();
      // Read only: boot never creates the key. No key (missing, unreadable, malformed) leaves every retained receipt Class B.
      // Bounded: an expiry means "no key", exactly like a missing one, so a locked Keychain or an access prompt cannot stall the daemon's start.
      if (this.keys && this.receiptKey === null) this.receiptKey = await this.withinSecretBound(this.keys.read(), null);
      return { source: "host", reports: host.bootReconcile() };
    }
    catch (error) {
      console.error(`cowork: native boot reconcile failed (${describeNativeError(error)}); ownership kept`);
      return { source: "host", reports: pending.map(report => ({ ...report, reason: "boot reconcile could not run; ownership kept" })) };
    }
  }

  /** The stop tail. Returns undefined, with no await and no timer, when no host was ever built, nothing is starting and nothing is
   * live: the no-op path costs one property read. Otherwise it stops every live guest and waits for in-flight starts to settle, bounded
   * by the contract's host wait for the stop (budget + exit allowance + margins, 65 s at the default). It never rejects, and a guest that
   * did not stop in time simply keeps its ownership: the launcher drains on owner loss, and the next boot reconciles. */
  beginShutdown(): Promise<void> | undefined {
    this.closing = true;
    const host = this.hostInstance;
    if (!host || (host.activeWorkspaces().length === 0 && this.starting.size === 0)) { this.closeEnvironment(); return undefined; }
    const bound = Math.min(coworkNativeHostStopWaitMs(this.drainBudgetMs), this.options.shutdownBoundMs ?? Number.POSITIVE_INFINITY);
    const work = (async () => {
      await Promise.allSettled([...this.starting]);
      await Promise.allSettled(host.activeWorkspaces().map(workspaceId => host.stop(workspaceId, "shutdown")));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, bound); timer.unref?.(); });
    return Promise.race([work, expired]).then(() => undefined, () => undefined).finally(() => { if (timer) clearTimeout(timer); this.closeEnvironment(); });
  }
  private closeEnvironment(): void { try { this.environmentInstance?.close?.(); } catch { /* closing is best effort */ } }
  /** Diagnostics and tests. */
  activeWorkspaces(): string[] { return this.hostInstance?.activeWorkspaces() ?? []; }
}

export function createCoworkNativeWiring(options: CoworkNativeWiringOptions): CoworkNativeWiring { return new CoworkNativeWiring(options); }
