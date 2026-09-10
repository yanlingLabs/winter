// WS-16 §11's per-product-session runtime lease: the thing that makes "refuse two writers per
// backend session" true across daemon restarts, crashes and PID reuse.
//
// THE ONE RULE THIS FILE EXISTS FOR: "stale leases break only after process identity AND start time
// revalidate — never merely because a PID is missing from a cached list." A PID is not an identity;
// the kernel hands the same number to an unrelated process minutes later, and a lease broken on a
// PID alone is how two writers end up on one transcript. So every lease carries the holder's start
// time alongside its pid, and a lease whose start identity cannot be established (`"unknown"`) is
// NEVER broken — it is reported and left alone (recovery step 5's "live-but-unknown identity → left,
// reported").
//
// The lease lives in the four `lease_*` columns of `runtime_generations` — the row that already
// describes the live attach a lease belongs to. This class writes ONLY those four columns; every
// other column on that table belongs to `RuntimeSessionRecords` (records.ts). Neither side ever
// rewrites a whole row, so a renewal cannot clobber an end reason and closing a generation cannot
// drop a holder.
import { readFileSync } from "node:fs";
import type { RuntimeStateDb } from "./db";

/** The honest answer when the OS will not tell us when a process started. Never equal to itself:
 *  two unknowns are not evidence of the same process (see `identityMatches`). */
const UNKNOWN = "unknown";

/** Linux `starttime` is in clock ticks; `sysconf(_SC_CLK_TCK)` is 100 on every Linux this daemon
 *  targets and there is no syscall door for it from JS. Only ever used to turn ticks into seconds. */
const LINUX_CLK_TCK = 100;

export interface ProcessIdentity {
  pid: number;
  /** ISO-8601 process start time, or `"unknown"` when the OS would not say. */
  startedAt: string;
}

/** How a lease's recorded holder is checked against the live machine. Injectable so tests can
 *  describe a dead or reused pid without spawning one. */
export interface LeaseProbe {
  alive: (pid: number) => boolean;
  startedAt: (pid: number) => string;
}

export interface LeaseRow {
  winterSessionId: string;
  generation: number;
  holder: ProcessIdentity;
  renewedAt: string;
  releasedAt?: string;
}

export class LeaseHeldError extends Error {
  constructor(public readonly winterSessionId: string, public readonly holder: ProcessIdentity) {
    super(`runtime lease for ${winterSessionId} is held by pid ${holder.pid} (started ${holder.startedAt})`);
    this.name = "LeaseHeldError";
  }
}

/** No leasable generation row: either the generation was never recorded (`bumpGeneration` writes
 *  it), or the lease this process was renewing is no longer live. A lease can only ever sit on a
 *  generation row that already exists — this class never creates one, because every other column on
 *  that row belongs to `RuntimeSessionRecords`. */
export class UnknownRuntimeGenerationError extends Error {
  constructor(public readonly winterSessionId: string, public readonly generation: number, message?: string) {
    super(message ?? `runtime generation ${generation} of ${winterSessionId} does not exist`);
    this.name = "UnknownRuntimeGenerationError";
  }
}

/**
 * The process's start time as the OS reports it, or `"unknown"`.
 *
 * macOS has no cheap "when did pid N start" syscall from JS, so `ps -o lstart=` is the identity
 * signal (the same door `plugins/supervisor.ts` already uses for orphan reclamation). Linux reads
 * field 22 of `/proc/<pid>/stat` (ticks since boot) against `/proc/stat`'s `btime`. Anything else —
 * or any failure at all — is `"unknown"`, which callers must read as "no identity", never as "gone".
 */
export function processStartedAt(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return UNKNOWN;
  try {
    if (process.platform === "darwin") {
      // `lstart` is a WALL-CLOCK rendering in the child's timezone, so the child is pinned to UTC
      // and parsed as UTC. Reading it in whatever timezone the reader happens to have is the one
      // way this identity could drift between the process that recorded a lease and the process
      // revalidating it (Bun's own test runner, for instance, runs at UTC while the daemon runs
      // local) — and a drifted start time reads as "different process", i.e. a live lease that
      // looks stale, which is precisely the two-writer outcome §11 exists to prevent.
      const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC" } });
      if (result.exitCode !== 0) return UNKNOWN;
      const text = result.stdout.toString().trim();
      if (!text) return UNKNOWN;
      const at = new Date(`${text} UTC`);
      return Number.isNaN(at.getTime()) ? UNKNOWN : at.toISOString();
    }
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The comm field (2) is parenthesised and may itself contain spaces and parens, so the fields
      // are only unambiguous after the LAST ')': the first token there is field 3.
      const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ticks = Number(tail[19]); // field 22 = starttime
      const btime = Number(/^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
      if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return UNKNOWN;
      return new Date((btime + ticks / LINUX_CLK_TCK) * 1000).toISOString();
    }
  } catch {
    return UNKNOWN;
  }
  return UNKNOWN;
}

/** Signal 0: "does this pid exist and may we look at it". `EPERM` means it exists but is not ours —
 *  which is liveness, not absence, and reading it as absence is exactly the PID-alone mistake. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Same pid AND two KNOWN, equal start times. An `"unknown"` start time never matches — not even
 *  another `"unknown"` — so no decision that consumes this can be reached by a PID alone. */
export function identityMatches(recorded: ProcessIdentity, live: ProcessIdentity): boolean {
  if (recorded.pid !== live.pid) return false;
  if (recorded.startedAt === UNKNOWN || live.startedAt === UNKNOWN) return false;
  return recorded.startedAt === live.startedAt;
}

/** "Is this the row I wrote" — deliberately NOT `identityMatches`: renew/release are asking about
 *  bookkeeping (did this same process record this lease), not about staleness, so a process whose
 *  own start time is `"unknown"` must still be able to renew and release its own lease. */
function sameHolder(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

const LIVE_PROBE: LeaseProbe = { alive: processIsAlive, startedAt: processStartedAt };

interface LeaseDbRow {
  winter_session_id: string;
  generation: number;
  lease_holder_pid: number | null;
  lease_holder_started_at: string | null;
  lease_renewed_at: string | null;
  lease_released_at: string | null;
}

const LEASE_COLUMNS = "winter_session_id, generation, lease_holder_pid, lease_holder_started_at, lease_renewed_at, lease_released_at";

function leaseFromRow(row: LeaseDbRow): LeaseRow | undefined {
  if (row.lease_holder_pid === null) return undefined;
  return {
    winterSessionId: row.winter_session_id,
    generation: row.generation,
    holder: { pid: row.lease_holder_pid, startedAt: row.lease_holder_started_at ?? UNKNOWN },
    renewedAt: row.lease_renewed_at ?? "",
    releasedAt: row.lease_released_at ?? undefined,
  };
}

export class RuntimeLeases {
  constructor(
    private readonly rs: RuntimeStateDb,
    private readonly self: ProcessIdentity,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Take the session's lease for one generation.
   *
   * Refuses whenever the session already has a live lease — including one held by another instance
   * in this very process: two writers are two writers. The single exception is a lease that
   * REVALIDATES AS STALE (holder gone, or the pid demonstrably belongs to a different process), and
   * that is the same proof `breakStale` demands; a lease whose identity cannot be established
   * (`"unknown"`) is not stale and is never taken.
   */
  acquire(winterSessionId: string, generation: number): LeaseRow {
    return this.rs.transaction(() => {
      const held = this.holder(winterSessionId);
      if (held && this.revalidate(held) !== "stale") throw new LeaseHeldError(winterSessionId, held.holder);
      const at = this.now();
      this.rs.db
        .query(
          `UPDATE runtime_generations SET lease_holder_pid = ?, lease_holder_started_at = ?, lease_renewed_at = ?, lease_released_at = NULL
           WHERE winter_session_id = ? AND generation = ?`,
        )
        .run(this.self.pid, this.self.startedAt, at, winterSessionId, generation);
      const lease = this.leaseAt(winterSessionId, generation);
      if (!lease) throw new UnknownRuntimeGenerationError(winterSessionId, generation);
      return lease;
    });
  }

  /** Heartbeat: "still live". Only the process that recorded the lease may renew it. */
  renew(winterSessionId: string, generation: number): void {
    this.rs.transaction(() => {
      const lease = this.leaseAt(winterSessionId, generation);
      if (!lease)
        throw new UnknownRuntimeGenerationError(
          winterSessionId,
          generation,
          `no live runtime lease for ${winterSessionId} generation ${generation}`,
        );
      if (!sameHolder(lease.holder, this.self)) throw new LeaseHeldError(winterSessionId, lease.holder);
      this.rs.db
        .query(`UPDATE runtime_generations SET lease_renewed_at = ? WHERE winter_session_id = ? AND generation = ?`)
        .run(this.now(), winterSessionId, generation);
    });
  }

  /** Hand the lease back. Releasing a lease this process does not hold is a no-op, never a theft —
   *  taking someone else's lease is `breakStale`'s job, and it demands proof. */
  release(winterSessionId: string, generation: number): void {
    this.rs.transaction(() => {
      const lease = this.leaseAt(winterSessionId, generation);
      if (!lease || !sameHolder(lease.holder, this.self)) return;
      this.rs.db
        .query(`UPDATE runtime_generations SET lease_released_at = ? WHERE winter_session_id = ? AND generation = ?`)
        .run(this.now(), winterSessionId, generation);
    });
  }

  /** The session's live lease, whichever generation holds it (the lease is per SESSION — WS-16 §11
   *  "refuse two writers per backend session"), newest generation first. */
  holder(winterSessionId: string): LeaseRow | undefined {
    const row = this.rs.db
      .query(
        `SELECT ${LEASE_COLUMNS} FROM runtime_generations
         WHERE winter_session_id = ? AND lease_holder_pid IS NOT NULL AND lease_released_at IS NULL
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(winterSessionId) as LeaseDbRow | null;
    return row ? leaseFromRow(row) : undefined;
  }

  /**
   * WS-16 §11: a lease is stale only after pid AND start identity revalidate as gone/different.
   *
   * `"unknown"` is the third answer and it is load-bearing: the process is alive but its start
   * identity could not be established, so the lease is neither proven live nor proven stale and
   * nothing may break it.
   */
  revalidate(lease: LeaseRow, probe: LeaseProbe = LIVE_PROBE): "live" | "stale" | "unknown" {
    if (!probe.alive(lease.holder.pid)) return "stale";
    const live: ProcessIdentity = { pid: lease.holder.pid, startedAt: probe.startedAt(lease.holder.pid) };
    if (lease.holder.startedAt === UNKNOWN || live.startedAt === UNKNOWN) return "unknown";
    return identityMatches(lease.holder, live) ? "live" : "stale";
  }

  /**
   * Break a lease whose holder is provably gone. Returns false — never throws — when there is
   * nothing to break or when the holder is live or unidentifiable.
   *
   * `reason` is not persisted here: the lease row has no reason column by design, and the audit
   * trail for a break belongs to the caller (startup recovery writes it into
   * `runtime_recovery_attempts`, WS-16 §13 step 12). It is a required argument so that no call site
   * can break a lease without having named a reason to record.
   */
  breakStale(winterSessionId: string, generation: number, reason: string): boolean {
    void reason;
    return this.rs.transaction(() => {
      const lease = this.leaseAt(winterSessionId, generation);
      if (!lease || this.revalidate(lease) !== "stale") return false;
      this.rs.db
        .query(`UPDATE runtime_generations SET lease_released_at = ? WHERE winter_session_id = ? AND generation = ?`)
        .run(this.now(), winterSessionId, generation);
      return true;
    });
  }

  /** The live (unreleased) lease on exactly one generation. */
  private leaseAt(winterSessionId: string, generation: number): LeaseRow | undefined {
    const row = this.rs.db
      .query(
        `SELECT ${LEASE_COLUMNS} FROM runtime_generations
         WHERE winter_session_id = ? AND generation = ? AND lease_holder_pid IS NOT NULL AND lease_released_at IS NULL`,
      )
      .get(winterSessionId, generation) as LeaseDbRow | null;
    return row ? leaseFromRow(row) : undefined;
  }
}
