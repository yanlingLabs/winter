/** N2 S6 (UNWIRED): the reactive disk-pressure guard for Cowork's backing filesystems.
 *
 * docs/cowork-execution-contracts.md: begin with a tunable 5 GiB free-space reserve; at the threshold refuse
 * new write-producing work, publish `resource_blocked`, halt active writers, NEVER delete anything to regain
 * space, and resume only after pressure and uncertain operations are revalidated.
 *
 * What this guard does and does not do:
 *  - It samples the filesystems the host `watch`es, on the host's schedule (no timer lives here).
 *  - `free < reserve` blocks. `free == reserve` does not: the reserve is the floor to keep free, and at the
 *    floor nothing has been taken from it yet. The boundary is pinned by tests at reserve-1 / reserve / reserve+1.
 *  - Blocking calls the injected `WriterHaltPort`. That port has NO delete, truncate or resume member by
 *    construction: the guard cannot remove data and cannot restart a writer.
 *  - HYSTERESIS: a blocked key clears only when free >= reserve + resume margin AND the halt for that blocked
 *    episode is confirmed. A failed or timed-out halt is retried on every evaluation and keeps the key blocked.
 *  - An unreadable filesystem blocks (fail closed) and clears only on a good reading above the resume line.
 *  - A watched target that starts answering for a DIFFERENT filesystem (`f_fsid` changed since its first sample,
 *    for example a closed fd number reused) blocks with `free_space_filesystem_changed` and does not clear until the
 *    host re-`watch`es the key. The caller owns any fd target for the guard's lifetime and must not close it while
 *    watched; path targets avoid the hazard. The check is a tripwire, not a substitute for that ownership.
 *  - "Clear" means the guard stops refusing new work. Restarting a halted writer is the CALLER's step after it
 *    revalidates pressure and uncertain operations; the guard never resumes anything.
 *  - It is a reactive guard, not a quota. Writes that land between a sample and the halt overshoot the reserve;
 *    the margins below are PROVISIONAL and are measured at live gate G5 (docs/research/2026-10-16-cowork-n2-pressure.md). */
import { COWORK_FREE_SPACE_RESERVE_BYTES, readSpaceSafely, type FilesystemSpace, type FilesystemSpaceReader, type PressureView, type ResourceBlocked, type ResourceBlockedReason, type SpaceTarget } from "./free-space";

/** PROVISIONAL: distance above the reserve a blocked key must reach before it clears. G5 replaces this with a
 * measured value (it must at least cover the overshoot seen under multi-guest and many-small-file stress). */
export const COWORK_PRESSURE_RESUME_MARGIN_BYTES = 1 * 1024 ** 3;
/** PROVISIONAL: a halt that has not answered by then counts as failed, so one hung writer cannot stall the
 * sampling of every other filesystem. */
export const COWORK_PRESSURE_HALT_TIMEOUT_MS = 10_000;

export type WriterHaltReason = Extract<ResourceBlockedReason, "free_space_below_reserve" | "free_space_unavailable" | "free_space_filesystem_changed">;
export interface WriterHaltRequest {
  readonly key: string;
  /** GUARD-WIDE and strictly increasing: one fresh number per blocked episode of any key, never reused, even when a key
   * is unwatched and watched again. `(key, episode)` therefore names exactly one episode for the guard's lifetime.
   * Repeated unchanged for every retry within that episode. */
  readonly episode: number;
  readonly reason: WriterHaltReason;
  readonly availableBytes: number | null;
  readonly reserveBytes: number;
}
export interface WriterHaltOutcome { readonly halted: boolean }
/** Halt only. No delete, truncate or resume member exists here on purpose. A throw, a rejection, a timeout or
 * `halted !== true` all mean "writers may still be running".
 *
 * The port MUST be idempotent per `(key, episode)` AND re-entrant: a call that times out is not cancelled, and the
 * guard re-issues the same `(key, episode)` on its next evaluation while the earlier call may still be pending. */
export interface WriterHaltPort { haltWriters(request: WriterHaltRequest): WriterHaltOutcome | Promise<WriterHaltOutcome> }

export interface PressureEntry {
  readonly key: string;
  readonly state: "clear" | "blocked";
  /** 0 until this key's first block, then the guard-wide number of its latest blocked episode. */
  readonly episode: number;
  readonly reason: WriterHaltReason | null;
  readonly availableBytes: number | null;
  readonly filesystemId: string | null;
  readonly haltConfirmed: boolean;
  /** False until the first evaluation: an unobserved key never admits work. */
  readonly observed: boolean;
}
export interface PressureSnapshot { readonly evaluatedAt: number | null; readonly entries: readonly PressureEntry[] }
export interface PressureTransition {
  readonly key: string;
  readonly from: "clear" | "blocked";
  readonly to: "clear" | "blocked";
  readonly episode: number;
  readonly reason: WriterHaltReason | null;
  readonly availableBytes: number | null;
}
export interface PressureReport {
  readonly evaluatedAt: number;
  /** One structured `resource_blocked` per currently blocked key. */
  readonly blocked: readonly ResourceBlocked[];
  readonly transitions: readonly PressureTransition[];
  /** Keys whose current episode has no confirmed halt after this evaluation. */
  readonly haltUnconfirmed: readonly string[];
}
export interface PressureGuardOptions {
  readonly space: FilesystemSpaceReader;
  readonly writers: WriterHaltPort;
  readonly reserveBytes?: number;
  readonly resumeMarginBytes?: number;
  readonly haltTimeoutMs?: number;
  readonly now?: () => number;
  /** Publication hook for `resource_blocked` / cleared. A throw here never affects the guard. */
  readonly onTransition?: (transition: PressureTransition) => void;
}
interface Entry {
  key: string; target: SpaceTarget; state: "clear" | "blocked"; episode: number; reason: WriterHaltReason | null;
  availableBytes: number | null; filesystemId: string | null; haltConfirmed: boolean; observed: boolean;
}
const KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export class CoworkPressureGuard implements PressureView {
  private readonly entries = new Map<string, Entry>();
  private readonly reserve: number;
  private readonly margin: number;
  private readonly haltTimeoutMs: number;
  private readonly now: () => number;
  private evaluatedAt: number | null = null;
  /** Survives unwatch/watch so a re-watched key can never repeat an earlier `(key, episode)`. */
  private lastEpisode = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: PressureGuardOptions) {
    if (!options || typeof options.space?.read !== "function" || typeof options.writers?.haltWriters !== "function") throw new TypeError("pressure_guard_ports");
    this.reserve = options.reserveBytes ?? COWORK_FREE_SPACE_RESERVE_BYTES;
    this.margin = options.resumeMarginBytes ?? COWORK_PRESSURE_RESUME_MARGIN_BYTES;
    this.haltTimeoutMs = options.haltTimeoutMs ?? COWORK_PRESSURE_HALT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.reserve) || this.reserve < 1 || !Number.isSafeInteger(this.margin) || this.margin < 1 || !Number.isSafeInteger(this.reserve + this.margin) || !Number.isSafeInteger(this.haltTimeoutMs) || this.haltTimeoutMs < 1 || this.haltTimeoutMs > 600_000) throw new RangeError("pressure_guard_options");
  }
  /** Register (or retarget) a backing filesystem. Retargeting keeps the key's blocked state, episode and confirmed halt,
   * but the new target is UNOBSERVED until the next evaluation (so `admitsNewWork()` is false until then) and its
   * filesystem identity is learned afresh. */
  watch(key: string, target: SpaceTarget): void {
    if (typeof key !== "string" || !KEY.test(key) || !target) throw new TypeError("pressure_guard_target");
    const existing = this.entries.get(key);
    if (existing) { existing.target = target; existing.observed = false; existing.filesystemId = null; return; }
    this.entries.set(key, { key, target, state: "clear", episode: 0, reason: null, availableBytes: null, filesystemId: null, haltConfirmed: false, observed: false });
  }
  /** The host decides when a filesystem is no longer its concern (for example the workspace is gone). The
   * result says whether it was blocked so the host can keep any halted writer halted. */
  unwatch(key: string): { wasBlocked: boolean } {
    const existing = this.entries.get(key);
    this.entries.delete(key);
    return { wasBlocked: existing?.state === "blocked" };
  }
  /** Fail closed: nothing watched, or any key unobserved, blocked or unreadable, refuses all new work. */
  admitsNewWork(): boolean {
    if (this.entries.size === 0) return false;
    for (const entry of this.entries.values()) if (!entry.observed || entry.state !== "clear") return false;
    return true;
  }
  snapshot(): PressureSnapshot {
    return { evaluatedAt: this.evaluatedAt, entries: [...this.entries.values()].map(entry => this.view(entry)) };
  }
  /** Evaluations are serialized, so a slow halt never interleaves with the next sample. */
  evaluate(): Promise<PressureReport> {
    const run = this.tail.then(() => this.run(), () => this.run());
    this.tail = run.catch(() => undefined);
    return run;
  }
  private view(entry: Entry): PressureEntry {
    return Object.freeze({ key: entry.key, state: entry.state, episode: entry.episode, reason: entry.reason, availableBytes: entry.availableBytes, filesystemId: entry.filesystemId, haltConfirmed: entry.haltConfirmed, observed: entry.observed });
  }
  private sample(target: SpaceTarget): FilesystemSpace | null { return readSpaceSafely(this.options.space, target); }
  private emit(transition: PressureTransition): void {
    try { this.options.onTransition?.(transition); } catch { /* publication failure never changes guard state */ }
  }
  private async run(): Promise<PressureReport> {
    const at = this.now();
    // Take every sample before acting on any: one instant, however slow a halt is.
    const sampled = [...this.entries.values()].map(entry => ({ entry, space: this.sample(entry.target) }));
    const transitions: PressureTransition[] = [];
    for (const { entry, space } of sampled) {
      if (this.entries.get(entry.key) !== entry) continue;
      // The first good sample fixes the key's filesystem. A later sample that answers for another one is untrusted.
      const changed = space !== null && entry.filesystemId !== null && space.filesystemId !== entry.filesystemId;
      const available = space === null || changed ? null : space.availableBytes;
      if (entry.filesystemId === null && space !== null) entry.filesystemId = space.filesystemId;
      entry.observed = true; entry.availableBytes = available;
      if (entry.state === "clear") {
        const reason: WriterHaltReason | null = available === null ? (changed ? "free_space_filesystem_changed" : "free_space_unavailable") : available < this.reserve ? "free_space_below_reserve" : null;
        if (reason === null) continue;
        entry.state = "blocked"; entry.episode = ++this.lastEpisode; entry.reason = reason; entry.haltConfirmed = false;
        const blocked: PressureTransition = { key: entry.key, from: "clear", to: "blocked", episode: entry.episode, reason, availableBytes: available };
        transitions.push(blocked); this.emit(blocked);
      }
      if (!entry.haltConfirmed) entry.haltConfirmed = await this.halt(entry);
      if (this.entries.get(entry.key) !== entry) continue;
      // Clear needs BOTH a good reading above the resume line AND a confirmed halt for this episode.
      if (entry.haltConfirmed && available !== null && available >= this.reserve + this.margin) {
        const cleared: PressureTransition = { key: entry.key, from: "blocked", to: "clear", episode: entry.episode, reason: null, availableBytes: available };
        entry.state = "clear"; entry.reason = null; entry.haltConfirmed = false;
        transitions.push(cleared); this.emit(cleared);
      }
    }
    this.evaluatedAt = at;
    const blocked: ResourceBlocked[] = [], unconfirmed: string[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state !== "blocked") continue;
      blocked.push({ outcome: "resource_blocked", reason: entry.reason!, requiredBytes: null, availableBytes: entry.availableBytes, reserveBytes: this.reserve, filesystemId: entry.filesystemId });
      if (!entry.haltConfirmed) unconfirmed.push(entry.key);
    }
    return { evaluatedAt: at, blocked, transitions, haltUnconfirmed: unconfirmed };
  }
  private async halt(entry: Entry): Promise<boolean> {
    const request: WriterHaltRequest = { key: entry.key, episode: entry.episode, reason: entry.reason!, availableBytes: entry.availableBytes, reserveBytes: this.reserve };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => this.options.writers.haltWriters(request)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("halt_timeout")), this.haltTimeoutMs); }),
      ]);
      return outcome?.halted === true;
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
