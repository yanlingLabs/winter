import type { AdmissionOwner, CoworkAdmissionLedger } from "./admission";
import type { CoworkGuestStartPort } from "./service";
import { CoworkImagePins, type CoworkImageDigests } from "./images";
import type { CoworkRepository } from "./repository";
import type { RuntimeStateDb } from "../runtime-state/db";
import { CoworkVolumes } from "./volumes";
import type { CoworkVolumeBackup } from "./volume-backup";
import { CoworkNativeAuthority } from "./native/authority";
import { CoworkNativeHost, type CoworkLauncherPort, type CoworkNativeHostDeps, type CoworkNativeImagePins } from "./native/host";
import { CoworkNativePower } from "./native/power";
import { COWORK_NATIVE_LIMITS, coworkNativeHostStopWaitMs } from "./native/protocol";
import { CoworkNativeRecovery, describeNativeError, type CoworkNativeDurableReceiptPort, type CoworkNativeOwnerRecoverPort, type CoworkNativeRecoveryReport } from "./native/recovery";
import { CoworkNativeStopRegistry, type CoworkNativeHostBoot, type CoworkNativeLaunchJournalPort, type CoworkNativeRecoverGuards } from "./native/stop-proof";

/*
 * N2 S7: the daemon's one door to the native worker host (S1), and the only module outside `cowork/native/` that may import it.
 *
 * INERT BY CONSTRUCTION. Creating a wiring builds nothing: no host, no volumes object, no ledger, no launcher, no process, no socket,
 * no timer, no file. The host is built the first time a workspace start asks for it, from an ENVIRONMENT that the daemon's caller
 * injects. Production injects none: every host fact the environment holds (the launcher, the admission ledger's installation id,
 * the home binding, the backup port, the retained-receipt store) is still an undecided owner point or an unmerged slice, so in
 * production `start` refuses with `native_unavailable` and nothing else happens. No setting, environment variable or flag reads
 * this: the only way in is the `environment` option of `startDaemon`, which only code can pass.
 *
 * D1 is binding here, and this module decides nothing about it. A disk is released only by what the host's recovery accepts as
 * proof (an orderly receipt, a changed host boot, an owner recover after two checks). `reconcileAtBoot` is record-and-refuse:
 * with an environment it runs the host's own recovery (which never releases on weaker evidence); without one it reads the records
 * and writes NOTHING.
 */

export type CoworkNativeUnavailableCode = "native_unavailable" | "native_closing";
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
  readonly guards?: CoworkNativeRecoverGuards;
  readonly journal?: CoworkNativeLaunchJournalPort;
  /** Timers, clocks, checkpoints and the conversation source: everything of the host's own that is not one of the structural ports above. */
  readonly hostOptions?: Partial<Omit<CoworkNativeHostDeps, "records" | "volumes" | "admission" | "authority" | "power" | "recovery" | "registry" | "hostBoot" | "launcher" | "images" | "journal" | "daemon">>;
}
export interface CoworkNativeWiringOptions {
  readonly db: RuntimeStateDb; readonly records: CoworkRepository; readonly home: string;
  /** Called at most once, lazily. Absent in production. A throw is treated as "unavailable" and is retried on the next ask. */
  readonly environment?: () => CoworkNativeEnvironment;
  /** Overrides the image-pin source (tests). The default is a read-only view of the stored pins. */
  readonly imagePins?: Pick<CoworkImagePins, "get" | "assertPinned">;
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
function readOnlyImagePins(db: RuntimeStateDb): CoworkImagePins {
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
  constructor(private readonly options: CoworkNativeWiringOptions) {}

  /** True once the host has been built (never at construction). */
  get built(): boolean { return this.hostInstance !== undefined; }

  /** Build the host from the environment, once. Throws `native_unavailable` when there is none. */
  private host(): CoworkNativeHost {
    if (this.hostInstance) return this.hostInstance;
    const make = this.options.environment;
    if (!make) throw new CoworkNativeUnavailableError("native_unavailable");
    let environment: CoworkNativeEnvironment;
    try { environment = make(); } catch { throw new CoworkNativeUnavailableError("native_unavailable"); }
    const { db, records, home } = this.options;
    const registry = new CoworkNativeStopRegistry();
    const authority = new CoworkNativeAuthority({ records, hostBoot: environment.hostBoot, registry });
    const volumes = new CoworkVolumes(db, home, authority.volumes, environment.backup, undefined, authority.filesystem);
    const power = new CoworkNativePower(db);
    const recovery = new CoworkNativeRecovery({ records, volumes, admission: environment.admission, power, registry, hostBoot: environment.hostBoot,
      receipts: environment.receipts, ownerRecover: environment.ownerRecover, guards: environment.guards, journal: environment.journal, now: environment.hostOptions?.now });
    const images = bindCoworkImagePins(this.options.imagePins ?? readOnlyImagePins(db));
    this.drainBudgetMs = environment.hostOptions?.timeouts?.drainBudgetMs ?? COWORK_NATIVE_LIMITS.drainBudgetMs;
    this.hostInstance = new CoworkNativeHost({ ...environment.hostOptions, records, volumes, admission: environment.admission, authority, power, recovery, registry, hostBoot: environment.hostBoot,
      launcher: environment.launcher, images, journal: environment.journal, daemon: environment.daemon });
    return this.hostInstance;
  }

  /** The service's door. Refused once shutdown began. */
  async start(workspaceId: string): Promise<unknown> {
    if (this.closing) throw new CoworkNativeUnavailableError("native_closing");
    const started = this.host().start(workspaceId);
    this.starting.add(started);
    try { return await started; } finally { this.starting.delete(started); }
  }

  /** Daemon start. Record-and-refuse: nothing is released here on weaker evidence than the host's recovery accepts, and without an
   * environment nothing is written at all. Never throws. */
  reconcileAtBoot(): CoworkNativeBootReport {
    const { records } = this.options;
    // The cheap, read-only scan first. The release order in the host's recovery (volumes, then the admission row, then `power`, and `power`
    // refuses `stopped` while an owner is held) means a workspace whose power is `stopped` holds no owner and no live admission row, so
    // only a workspace that is NOT stopped can need settling. When none does, nothing is built, opened or asked of the environment.
    const pending: CoworkNativeRecoveryReport[] = [];
    try {
      for (const workspace of records.list()) {
        if (workspace.state !== "retained" || workspace.power === "stopped") continue;
        pending.push({ workspaceId: workspace.workspaceId, action: "retained", evidence: null, power: workspace.power, ownerRetained: true, admission: "none", reason: "native host unavailable; ownership kept" });
      }
    } catch (error) { console.error(`cowork: native boot scan failed (${describeNativeError(error)})`); return { source: "records", reports: [] }; }
    if (pending.length === 0 || !this.options.environment) return { source: "records", reports: pending };
    try { return { source: "host", reports: this.host().bootReconcile() }; }
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
    if (!host || (host.activeWorkspaces().length === 0 && this.starting.size === 0)) return undefined;
    const bound = Math.min(coworkNativeHostStopWaitMs(this.drainBudgetMs), this.options.shutdownBoundMs ?? Number.POSITIVE_INFINITY);
    const work = (async () => {
      await Promise.allSettled([...this.starting]);
      await Promise.allSettled(host.activeWorkspaces().map(workspaceId => host.stop(workspaceId, "shutdown")));
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, bound); timer.unref?.(); });
    return Promise.race([work, expired]).then(() => undefined, () => undefined).finally(() => { if (timer) clearTimeout(timer); });
  }
  /** Diagnostics and tests. */
  activeWorkspaces(): string[] { return this.hostInstance?.activeWorkspaces() ?? []; }
}

export function createCoworkNativeWiring(options: CoworkNativeWiringOptions): CoworkNativeWiring { return new CoworkNativeWiring(options); }
