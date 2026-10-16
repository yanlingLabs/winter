import { createHash, randomUUID } from "node:crypto";
import { CoworkScheduleDefinition, type CoworkSchedule, type CoworkScheduleOccurrence, type CoworkScheduleView } from "@yanlinglabs/winter-protocol";
import { parseSpec, type CronField } from "../routines/spec";
import { CoworkAuthority, intersectCeilings, type CoworkGrantResolver } from "./authority";
import type { CoworkRepository } from "./repository";
import type { CoworkScheduleDispatchOutcome, CoworkScheduleDispatchPort, CoworkScheduleDispatchReceipt, CoworkScheduleDispatchInput } from "./schedule-dispatch";
import { CoworkError, type CapabilityCeiling } from "./types";

type Row = Record<string, any>;
type Reason = NonNullable<CoworkScheduleOccurrence["reason"]>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const schedule = (row: Row): CoworkSchedule => {
  if (typeof row.definition_json !== "string" || Buffer.byteLength(row.definition_json) > 32 * 1024) throw new CoworkError("invalid_request");
  const definition = CoworkScheduleDefinition.parse(JSON.parse(row.definition_json));
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: definition.timezone });
    if (definition.timing.kind === "recurring") {
      const parsed = parseSpec(definition.timing.spec);
      if (parsed.kind === "interval" && (!Number.isSafeInteger(parsed.ms) || parsed.ms <= 0 || parsed.ms > 8640000000000000)) throw new CoworkError("invalid_request");
    }
  }
  catch { throw new CoworkError("invalid_request"); }
  return { scheduleId: row.schedule_id, workspaceId: row.workspace_id, definition, state: row.state, revision: row.revision, nextDue: row.next_due, createdAt: row.created_at };
};
const occurrence = (row: Row): CoworkScheduleOccurrence => ({ occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, dueAt: row.due_at, latestDueAt: row.latest_due_at, missedCount: row.missed_count, state: row.state, reason: row.reason });
const matches = (field: CronField, value: number) => field.any || field.values.has(value);

export const MAX_COWORK_SCHEDULES_PER_WORKSPACE = 100;
export const MAX_COWORK_CRON_FORMATS = 4096;
export const MAX_COWORK_CALENDAR_STEPS_PER_PASS = 256;
export class CoworkCalendarBudgetExhausted extends CoworkError {
  constructor() { super("schedule_budget_exhausted"); }
}
/** Host-only test seam; limits can narrow, never raise the production pass ceilings. */
export interface CoworkCalendarLimits { formats?: number; steps?: number; observeFormat?: () => void }
export class CoworkCalendarBudget {
  private formats: number;
  private steps: number;
  constructor(private readonly limits: CoworkCalendarLimits = {}) {
    this.formats = limits.formats ?? MAX_COWORK_CRON_FORMATS;
    this.steps = limits.steps ?? MAX_COWORK_CALENDAR_STEPS_PER_PASS;
    if (![this.formats, this.steps].every(value => Number.isSafeInteger(value) && value > 0) || this.formats > MAX_COWORK_CRON_FORMATS || this.steps > MAX_COWORK_CALENDAR_STEPS_PER_PASS) throw new CoworkError("invalid_request");
  }
  step(): void { if (this.steps <= 0) throw new CoworkCalendarBudgetExhausted(); this.steps--; }
  format(): void { if (this.formats <= 0) throw new CoworkCalendarBudgetExhausted(); this.formats--; this.limits.observeFormat?.(); }
}
/** Saved timezone cron fires each local date/hour/minute tuple once across a fold. */
export function nextCoworkScheduleTime(specText: string, timezone: string, from: number, observeFormat?: () => void, passBudget?: CoworkCalendarBudget): number {
  try {
    if (!Number.isSafeInteger(from) || from < 0 || from > 8640000000000000) throw new CoworkError("invalid_request");
    const spec = parseSpec(specText);
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    if (spec.kind === "interval") {
      const next = from + spec.ms;
      if (!Number.isSafeInteger(next) || next > 8640000000000000) throw new CoworkError("invalid_request");
      return next;
    }
    // With unrestricted weekday, impossible month/day combinations cannot ever match.
    // A leap-year calendar covers every possible day-of-month without scanning timezones.
    const domValues = spec.dom.any ? undefined : spec.dom.values;
    if (spec.dow.any && domValues && !Array.from({ length: 12 }, (_, i) => i + 1).some(month => matches(spec.mon, month) && [...domValues].some(day => day <= new Date(Date.UTC(2000, month, 0)).getUTCDate()))) throw new CoworkError("invalid_request");
    let formats = 0;
    const partsAt = (at: number) => {
      if (++formats > MAX_COWORK_CRON_FORMATS) throw new CoworkCalendarBudgetExhausted();
      passBudget?.format();
      observeFormat?.(); return Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, Number(part.value)]));
    };
    const wall = (parts: Record<string, number>) => Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
    const firstWall = wall(partsAt(from)), deadline = Math.min(8640000000000000, from + 2922 * 86400000);
    // Estimate the next local boundary and correct using both timezone offsets. Taking the
    // earliest candidate avoids skipping valid minutes when a midnight lies in a DST gap/fold.
    const boundary = (at: number, parts: Record<string, number>, month: boolean) => {
      const target = month ? Date.UTC(parts.year!, parts.month!, 1) : Date.UTC(parts.year!, parts.month! - 1, parts.day! + 1);
      let candidate = target - (wall(parts) - at), earliest = candidate;
      for (let pass = 0; pass < 2 && candidate <= deadline; pass++) {
        const offset = wall(partsAt(candidate)) - candidate;
        candidate = target - offset; earliest = Math.min(earliest, candidate);
      }
      return earliest > at ? earliest : at + (60 - parts.minute!) * 60000;
    };
    for (let at = Math.floor(from / 60000) * 60000 + 60000; at <= deadline;) {
      const parts = partsAt(at), dom = matches(spec.dom, parts.day!), dow = matches(spec.dow, new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay());
      const day = spec.dom.any ? dow : spec.dow.any ? dom : dom || dow;
      if (!matches(spec.mon, parts.month!)) { at = boundary(at, parts, true); continue; }
      if (!day) { at = boundary(at, parts, false); continue; }
      if (matches(spec.h, parts.hour!)) {
        if (matches(spec.m, parts.minute!) && wall(parts) > firstWall) return at;
        at += 60000;
      } else at += (60 - parts.minute!) * 60000;
    }
  } catch (error) { if (error instanceof CoworkError) throw error; }
  throw new CoworkError("invalid_request");
}

const RUN_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The port's acknowledgement, or undefined when it is not a well-formed receipt echoing exactly this claim. */
function ackedRunRef(result: unknown, occurrenceId: string, token: string): string | undefined {
  if (!result || typeof result !== "object" || (result as { kind?: unknown }).kind !== "started") return undefined;
  const receipt = (result as { receipt?: Record<string, unknown> }).receipt;
  if (!receipt || typeof receipt !== "object" || receipt.occurrenceId !== occurrenceId || receipt.token !== token) return undefined;
  return typeof receipt.runRef === "string" && RUN_REF.test(receipt.runRef) ? receipt.runRef : undefined;
}

/**
 * Canonical host state only. No runtime session creation, guest cwd or Code runner dependency. Execution is
 * reachable only through an injected CoworkScheduleDispatchPort; without one `beginDispatch` stays refused.
 */
export class CoworkSchedules {
  private closed = false;
  private readonly authority: CoworkAuthority;
  /** In-memory proof, per instance and never persisted, that THIS process's port acknowledged a claim: the only thing `handled` accepts. */
  private readonly receipts = new WeakMap<object, { occurrenceId: string; token: string }>();
  constructor(readonly records: CoworkRepository, grants: CoworkGrantResolver, private readonly now = () => Date.now(), private readonly branch?: (workspaceId: string, sourceId: string) => string | undefined, private readonly calendarLimits?: CoworkCalendarLimits, private readonly port?: CoworkScheduleDispatchPort) {
    this.authority = new CoworkAuthority(records, grants);
  }
  private one(sql: string, ...values: any[]): Row | null { return this.records.rs.db.query(sql).get(...values) as Row | null; }
  private all(sql: string, ...values: any[]): Row[] { return this.records.rs.db.query(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: any[]) { return this.records.rs.db.query(sql).run(...values); }
  private tx<T>(body: () => T): T { return this.records.rs.transaction(body, { mode: "immediate" }); }
  private raw(workspaceId: string, scheduleId: string): Row {
    const row = this.one("SELECT * FROM cowork_schedules WHERE workspace_id=? AND schedule_id=?", workspaceId, scheduleId);
    if (!row) throw new CoworkError("not_found"); return row;
  }
  private quarantined(scheduleId: string): boolean { return !!this.one("SELECT 1 FROM cowork_schedule_quarantines WHERE schedule_id=?", scheduleId); }
  private quarantine(row: Row): void {
    this.tx(() => {
      this.run("INSERT OR IGNORE INTO cowork_schedule_quarantines VALUES(?,'invalid_schedule',?)", row.schedule_id, this.now());
      this.run("UPDATE cowork_schedule_occurrences SET reason='invalid_schedule' WHERE schedule_id=? AND state IN ('pending','claimed')", row.schedule_id);
    });
  }
  private view(row: Row): CoworkScheduleView {
    if (this.quarantined(row.schedule_id)) return { scheduleId: row.schedule_id, workspaceId: row.workspace_id, state: "quarantined", revision: row.revision, createdAt: row.created_at, nextDue: null, reason: "invalid_schedule", cancelled: row.state === "cancelled" };
    try { return schedule(row); } catch { this.quarantine(row); return this.view(row); }
  }
  get(workspaceId: string, scheduleId: string): CoworkSchedule {
    const value = this.view(this.raw(workspaceId, scheduleId));
    if (value.state === "quarantined") throw new CoworkError("recovery_required"); return value;
  }
  list(workspaceId: string, cursor?: string, limit = 100): { schedules: CoworkScheduleView[]; nextCursor: string | null } {
    this.records.get(workspaceId);
    if (cursor) this.raw(workspaceId, cursor);
    const values = this.all("SELECT * FROM cowork_schedules WHERE workspace_id=? AND schedule_id>? ORDER BY schedule_id LIMIT ?", workspaceId, cursor ?? "", limit + 1).map(row => this.view(row));
    const schedules: CoworkScheduleView[] = [];
    for (const value of values.slice(0, limit)) {
      if (Buffer.byteLength(JSON.stringify({ schedules: [...schedules, value], nextCursor: value.scheduleId })) > 128 * 1024) break;
      schedules.push(value);
    }
    return { schedules, nextCursor: schedules.length < values.length ? schedules.at(-1)!.scheduleId : null };
  }
  status(workspaceId: string, scheduleId: string) {
    return { schedule: this.view(this.raw(workspaceId, scheduleId)), occurrences: this.all("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? ORDER BY due_at DESC LIMIT 100", scheduleId).map(occurrence), execution: "unavailable" as const };
  }
  private target(workspaceId: string, definition: CoworkScheduleDefinition): CapabilityCeiling {
    const workspace = this.records.get(workspaceId);
    if (workspace.state !== "retained") throw new CoworkError("authority_denied");
    if (definition.target.kind === "project") {
      if (workspace.ownership !== "project" || workspace.ownerId !== definition.target.projectId) throw new CoworkError("authority_denied");
      return this.records.policy(workspaceId).ceiling;
    }
    const binding = this.records.binding(definition.target.sessionId);
    if (binding.workspaceId !== workspaceId || binding.sourceId !== definition.sourceId || binding.state !== "active") throw new CoworkError("authority_denied");
    return this.authority.effectiveCapabilities(binding.sessionId);
  }
  create(principalId: string, workspaceId: string, requestId: string, raw: unknown): CoworkSchedule {
    const definition = CoworkScheduleDefinition.parse(raw);
    if (Buffer.byteLength(JSON.stringify(definition)) > 32 * 1024) throw new CoworkError("response_too_large");
    try { new Intl.DateTimeFormat("en-US", { timeZone: definition.timezone }); } catch { throw new CoworkError("invalid_request"); }
    if (definition.timing.kind === "recurring") try { parseSpec(definition.timing.spec); } catch { throw new CoworkError("invalid_request"); }
    const digest = createHash("sha256").update(canonical(definition)).digest("hex");
    return this.tx(() => {
      if (this.closed) throw new CoworkError("authority_denied");
      // Reauthorize even a replay; neither old grants nor a persisted user principal mint authority.
      const current = this.target(workspaceId, definition), source = this.records.source(workspaceId, definition.sourceId);
      if (source.desired !== "present" || source.trust === "revoked" || ["unavailable", "removing", "detached"].includes(source.state)) throw new CoworkError("source_unavailable");
      this.authority.requireSelection({ kind: "local-user", id: principalId }, source);
      const previous = this.one("SELECT * FROM cowork_schedules WHERE workspace_id=? AND principal_id=? AND request_id=?", workspaceId, principalId, requestId);
      if (previous) { if (this.quarantined(previous.schedule_id)) throw new CoworkError("recovery_required"); if (previous.request_digest !== digest) throw new CoworkError("request_conflict"); return schedule(previous); }
      if (canonical(intersectCeilings(current, definition.savedCeiling)) !== canonical(intersectCeilings(definition.savedCeiling, definition.savedCeiling))) throw new CoworkError("authority_denied");
      const expectedPolicy = definition.target.kind === "conversation" ? this.records.binding(definition.target.sessionId).policy : this.records.policy(workspaceId).defaultPolicy;
      // Policies are not ranked; no client can save an escalation as a scheduled default.
      if (definition.policy !== expectedPolicy) throw new CoworkError("authority_denied");
      if ((this.one("SELECT count(*) AS n FROM cowork_schedules s WHERE workspace_id=? AND state='enabled' AND NOT EXISTS (SELECT 1 FROM cowork_schedule_quarantines q WHERE q.schedule_id=s.schedule_id)", workspaceId)?.n ?? 0) >= MAX_COWORK_SCHEDULES_PER_WORKSPACE) throw new CoworkError("schedule_limit");
      const at = this.now(), next = definition.timing.kind === "once" ? definition.timing.at : nextCoworkScheduleTime(definition.timing.spec, definition.timezone, at);
      const scheduleId = `schedule_${randomUUID()}`;
      this.run("INSERT INTO cowork_schedules VALUES(?,?,?,?,?,?,?,'enabled',1,?)", scheduleId, workspaceId, principalId, requestId, digest, canonical(definition), next, at);
      return this.get(workspaceId, scheduleId);
    });
  }
  cancel(workspaceId: string, scheduleId: string, revision: number): CoworkScheduleView {
    return this.tx(() => {
      const raw = this.raw(workspaceId, scheduleId), value = this.view(raw);
      if (raw.state === "cancelled" && value.revision === revision + 1) return value;
      if (value.revision !== revision) throw new CoworkError("revision_conflict", value.revision);
      this.run("UPDATE cowork_schedules SET state='cancelled',next_due=NULL,revision=revision+1 WHERE schedule_id=?", scheduleId);
      this.run("UPDATE cowork_schedule_occurrences SET state='cancelled',claim_token=NULL WHERE schedule_id=? AND state IN ('pending','claimed')", scheduleId);
      // Already dispatched effects require recovery, never cancellation masquerading as completion.
      this.run("UPDATE cowork_schedule_occurrences SET state='uncertain',reason='recovery_required' WHERE schedule_id=? AND state='dispatching'", scheduleId);
      return this.view(this.raw(workspaceId, scheduleId));
    });
  }
  /** Materialize one durable pending record and accumulate all missed occurrences. */
  reconcileDue(): void {
    if (this.closed) return;
    const at = this.now(), budget = new CoworkCalendarBudget(this.calendarLimits);
    const rows = this.all("SELECT * FROM cowork_schedules s WHERE state='enabled' AND next_due<=? AND NOT EXISTS (SELECT 1 FROM cowork_schedule_quarantines q WHERE q.schedule_id=s.schedule_id) ORDER BY next_due,schedule_id", at);
    for (const row of rows) {
      try {
        // Calendar planning consumes one pass-wide budget OUTSIDE the write transaction.
        // Every computed successor permits committing that occurrence exactly once; an
        // exhausted search leaves the first unprocessed cursor intact for a later tick.
        const value = schedule(row), definition = value.definition;
        const due = row.next_due as number;
        let latest = due, count = 1, next: number | null = null;
        if (definition.timing.kind === "recurring") {
          const parsed = parseSpec(definition.timing.spec);
          if (parsed.kind === "interval") { count = Math.floor((at - due) / parsed.ms) + 1; latest = due + (count - 1) * parsed.ms; next = latest + parsed.ms; }
          else {
            count = 0; next = due;
            try {
              while (next <= at) {
                budget.step();
                const successor = nextCoworkScheduleTime(definition.timing.spec, definition.timezone, next, undefined, budget);
                latest = next; next = successor; count++;
              }
            } catch (error) { if (!(error instanceof CoworkCalendarBudgetExhausted)) throw error; }
            if (!count) continue; // Retryable resource debt, never invalid-schedule quarantine.
          }
        }
        this.tx(() => {
          if (this.closed || this.quarantined(row.schedule_id)) return;
          // Recheck the exact planned definition/cursor: cancellation or another timer may
          // commit on another handle after planning, and never gains duplicate accounting.
          const current = this.raw(row.workspace_id, row.schedule_id);
          if (current.state !== "enabled" || current.next_due !== due || current.definition_json !== row.definition_json) return;
          const pending = this.one("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? AND state='pending'", value.scheduleId);
          if (pending) this.run("UPDATE cowork_schedule_occurrences SET latest_due_at=?,missed_count=missed_count+? WHERE occurrence_id=?", latest, count, pending.occurrence_id);
          else this.run("INSERT INTO cowork_schedule_occurrences VALUES(?,?,?,?,?,'pending',NULL,NULL)", `occurrence_${randomUUID()}`, value.scheduleId, due, latest, count - 1);
          this.run("UPDATE cowork_schedules SET next_due=? WHERE schedule_id=?", next, value.scheduleId);
        });
      } catch (error) {
        if (error instanceof CoworkCalendarBudgetExhausted) continue;
        if (error instanceof SyntaxError || (error instanceof CoworkError && error.code === "invalid_request") || (error instanceof Error && error.name === "ZodError")) this.quarantine(row);
        else throw error; // Store failure is not a bad schedule, and must not invent quarantine.
      }
    }
  }
  claim(workspaceId: string, scheduleId: string, occurrenceId: string): string | undefined {
    return this.tx(() => {
      if (this.closed || this.quarantined(scheduleId)) return undefined;
      const value = this.get(workspaceId, scheduleId);
      if (value.state !== "enabled") return undefined;
      const reason = this.blockedReason(value);
      if (reason !== "execution_unavailable") {
        this.run("UPDATE cowork_schedule_occurrences SET reason=? WHERE occurrence_id=? AND schedule_id=? AND state='pending'", reason, occurrenceId, scheduleId);
        return undefined;
      }
      if (this.one("SELECT 1 FROM cowork_schedule_occurrences WHERE schedule_id=? AND state IN ('claimed','dispatching','uncertain')", scheduleId)) return undefined;
      const token = randomUUID();
      return this.run("UPDATE cowork_schedule_occurrences SET state='claimed',claim_token=?,reason=NULL WHERE schedule_id=? AND occurrence_id=? AND state='pending'", token, scheduleId, occurrenceId).changes ? token : undefined;
    });
  }
  /** Return a claimed or dispatching occurrence to pending, folding any coalesced pending interval into it first. `reason` undefined leaves the stored reason alone. */
  private release(row: Row, reason?: Reason): void {
    const pending = this.one("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? AND state='pending'", row.schedule_id);
    if (pending) {
      this.run("UPDATE cowork_schedule_occurrences SET latest_due_at=?,missed_count=? WHERE occurrence_id=?", pending.latest_due_at, row.missed_count + pending.missed_count + 1, row.occurrence_id);
      this.run("DELETE FROM cowork_schedule_occurrences WHERE occurrence_id=?", pending.occurrence_id);
    }
    this.run("UPDATE cowork_schedule_occurrences SET state='pending',claim_token=NULL WHERE occurrence_id=?", row.occurrence_id);
    if (reason) this.run("UPDATE cowork_schedule_occurrences SET reason=? WHERE occurrence_id=?", reason, row.occurrence_id);
  }
  private dispatching(occurrenceId: string, token: string): Row | null {
    return this.one("SELECT * FROM cowork_schedule_occurrences WHERE occurrence_id=? AND state='dispatching' AND claim_token=?", occurrenceId, token);
  }
  private markUncertain(occurrenceId: string): void {
    this.run("UPDATE cowork_schedule_occurrences SET state='uncertain',reason='recovery_required' WHERE occurrence_id=? AND state='dispatching'", occurrenceId);
  }
  /**
   * claimed -> dispatching (durable, rechecked) -> port.start -> acknowledged. Without an injected port this
   * refuses with `unsupported_topology` before any write, exactly as before. The synchronous part throws
   * `request_conflict` for an unknown, reused or wrong-token claim; after it, nothing is held open across the
   * port call and the returned promise settles to an outcome (it rejects only on a store failure, which leaves
   * the row `dispatching` for `recover()` to mark uncertain). `dispatching` is committed BEFORE `start` runs,
   * so a crash at any later point can only produce `uncertain`, never a replay.
   */
  beginDispatch(occurrenceId: string, token: string): Promise<CoworkScheduleDispatchOutcome> {
    const port = this.port;
    if (!port) throw new CoworkError("unsupported_topology");
    const begun = this.tx((): { blocked: Reason } | { input: CoworkScheduleDispatchInput } => {
      const row = this.one("SELECT * FROM cowork_schedule_occurrences WHERE occurrence_id=? AND state='claimed'", occurrenceId);
      if (!row || row.claim_token !== token) throw new CoworkError("request_conflict");
      const parent = this.one("SELECT * FROM cowork_schedules WHERE schedule_id=?", row.schedule_id);
      if (!parent || parent.state !== "enabled") throw new CoworkError("request_conflict");
      const refuse = (reason: Reason) => { this.release(row, reason); return { blocked: reason }; };
      if (this.quarantined(row.schedule_id)) return refuse("invalid_schedule");
      let value: CoworkSchedule;
      try { value = schedule(parent); } catch { this.quarantine(parent); return refuse("invalid_schedule"); }
      // A claim is not authority: archive, grants, policy, source and branch are re-decided at the instant of flip.
      const reason = this.blockedReason(value);
      if (reason !== "execution_unavailable") return refuse(reason);
      const effective = this.effective(value.workspaceId, value.scheduleId);
      if (!this.run("UPDATE cowork_schedule_occurrences SET state='dispatching',reason=NULL WHERE occurrence_id=? AND state='claimed'", occurrenceId).changes) throw new CoworkError("request_conflict");
      return { input: Object.freeze({ schedule: value, occurrence: occurrence({ ...row, state: "dispatching", reason: null }), effective }) };
    });
    return "blocked" in begun ? Promise.resolve({ status: "blocked", reason: begun.blocked }) : this.launch(port, begun.input, token);
  }
  private async launch(port: CoworkScheduleDispatchPort, input: CoworkScheduleDispatchInput, token: string): Promise<CoworkScheduleDispatchOutcome> {
    const occurrenceId = input.occurrence.occurrenceId;
    let result: unknown;
    try { result = await port.start(input, token); }
    catch {
      // A throw asserts nothing launched (see the port contract). Guarded on state AND token: a cancel() or
      // recover() that already recorded recovery_required is never clobbered back to pending.
      return this.tx((): CoworkScheduleDispatchOutcome => {
        const row = this.dispatching(occurrenceId, token);
        if (!row) return { status: "uncertain" };
        this.release(row, "execution_unavailable");
        return { status: "not_started" };
      });
    }
    return this.tx((): CoworkScheduleDispatchOutcome => {
      const row = this.dispatching(occurrenceId, token);
      if (!row) return { status: "uncertain" }; // cancel()/recover() got there first and recorded it durably
      const runRef = ackedRunRef(result, occurrenceId, token);
      if (runRef === undefined) { this.markUncertain(occurrenceId); return { status: "uncertain" }; } // an ack that cannot be trusted may still have launched
      const receipt: CoworkScheduleDispatchReceipt = Object.freeze({ occurrenceId, runRef });
      this.receipts.set(receipt, { occurrenceId, token });
      return { status: "started", receipt };
    });
  }
  /** dispatching -> handled, only with the receipt this instance's port issued for exactly this claim. A one-shot is never handled without one. */
  handled(occurrenceId: string, token: string, receipt: CoworkScheduleDispatchReceipt): void {
    this.tx(() => {
      const proof = this.receipts.get(receipt);
      if (!proof || proof.occurrenceId !== occurrenceId || proof.token !== token) throw new CoworkError("request_conflict");
      const row = this.one("SELECT * FROM cowork_schedule_occurrences WHERE occurrence_id=? AND state='dispatching' AND claim_token=?", occurrenceId, token);
      if (!row) throw new CoworkError("request_conflict");
      this.run("UPDATE cowork_schedule_occurrences SET state='handled',claim_token=NULL WHERE occurrence_id=?", occurrenceId);
      const parent = this.one("SELECT * FROM cowork_schedules WHERE schedule_id=?", row.schedule_id)!;
      if (schedule(parent).definition.timing.kind === "once" && parent.state === "enabled") this.run("UPDATE cowork_schedules SET state='handled',revision=revision+1 WHERE schedule_id=?", row.schedule_id);
    });
    this.receipts.delete(receipt);
  }
  /** dispatching -> uncertain for the execution owner reporting that it can no longer vouch for the work. Needs the claim token, never a receipt, and is never replayed. */
  uncertain(occurrenceId: string, token: string): void {
    this.tx(() => {
      if (!this.dispatching(occurrenceId, token)) throw new CoworkError("request_conflict");
      this.markUncertain(occurrenceId);
    });
  }
  /** Only call once after host ownership is established, never upon opening a second DB handle. */
  recover(): void {
    this.tx(() => {
      if (this.closed) return;
      for (const row of this.all("SELECT * FROM cowork_schedule_occurrences WHERE state='claimed'")) this.release(row);
      this.run("UPDATE cowork_schedule_occurrences SET state='uncertain',reason='recovery_required' WHERE state='dispatching'");
    });
  }
  effective(workspaceId: string, scheduleId: string): CapabilityCeiling {
    const value = this.get(workspaceId, scheduleId);
    const currentPolicy = value.definition.target.kind === "conversation" ? this.records.binding(value.definition.target.sessionId).policy : this.records.policy(workspaceId).defaultPolicy;
    if (currentPolicy !== value.definition.policy) throw new CoworkError("authority_denied");
    return intersectCeilings(this.target(workspaceId, value.definition), value.definition.savedCeiling);
  }
  private blockedReason(value: CoworkSchedule): Reason {
    if (this.closed) return "shutdown";
    const workspace = this.records.get(value.workspaceId);
    if (workspace.state === "archived") return "archived";
    try {
      if (value.definition.target.kind === "conversation" && this.records.binding(value.definition.target.sessionId).state === "archived") return "archived";
      this.effective(value.workspaceId, value.scheduleId);
      const source = this.records.source(value.workspaceId, value.definition.sourceId);
      if (source.desired !== "present" || source.trust === "revoked" || ["unavailable", "removing", "detached"].includes(source.state)) return "source_unavailable";
      this.authority.requireSelection({ kind: "local-user", id: "host-schedule-recheck" }, source);
    } catch (error) { if (error instanceof CoworkError) return error.code === "source_unavailable" ? "source_unavailable" : "authority_denied"; throw error; }
    if (value.definition.branchPrecondition) {
      const current = this.branch?.(value.workspaceId, value.definition.sourceId);
      if (current === undefined) return "branch_state_unavailable";
      if (current !== value.definition.branchPrecondition) return "branch_mismatch";
    }
    return "execution_unavailable";
  }
  /** Source-only bridge: never creates a host Code session or reports a successful wakeup. */
  tick(): void {
    if (this.closed) return;
    this.reconcileDue();
    for (const row of this.all("SELECT o.occurrence_id,s.* FROM cowork_schedule_occurrences o JOIN cowork_schedules s USING(schedule_id) WHERE o.state='pending' AND s.state='enabled' AND NOT EXISTS (SELECT 1 FROM cowork_schedule_quarantines q WHERE q.schedule_id=s.schedule_id)")) {
      let value: CoworkSchedule;
      try { value = schedule(row); } catch { this.quarantine(row); continue; }
      const reason = this.blockedReason(value);
      this.run("UPDATE cowork_schedule_occurrences SET reason=? WHERE occurrence_id=? AND state='pending' AND reason IS NOT ?", reason, row.occurrence_id, reason);
    }
  }
  beginShutdown(): void { this.closed = true; }
}
