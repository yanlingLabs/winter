import { createHash, randomUUID } from "node:crypto";
import { CoworkScheduleDefinition, type CoworkSchedule, type CoworkScheduleOccurrence } from "@yanlinglabs/winter-protocol";
import { parseSpec, type CronField } from "../routines/spec";
import { CoworkAuthority, intersectCeilings, type CoworkGrantResolver } from "./authority";
import type { CoworkRepository } from "./repository";
import { CoworkError, type CapabilityCeiling } from "./types";

type Row = Record<string, any>;
type Reason = NonNullable<CoworkScheduleOccurrence["reason"]>;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const schedule = (row: Row): CoworkSchedule => ({ scheduleId: row.schedule_id, workspaceId: row.workspace_id, definition: JSON.parse(row.definition_json), state: row.state, revision: row.revision, nextDue: row.next_due, createdAt: row.created_at });
const occurrence = (row: Row): CoworkScheduleOccurrence => ({ occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, dueAt: row.due_at, latestDueAt: row.latest_due_at, missedCount: row.missed_count, state: row.state, reason: row.reason });
const matches = (field: CronField, value: number) => field.any || field.values.has(value);

/** Existing routine grammar, but a schedule's saved timezone never follows host TZ changes.
 * UTC minute iteration preserves DST gaps/folds; skipping only to the next local hour cannot
 * skip a matching minute on an applicable day. Historical Code math is untouched. */
export function nextCoworkScheduleTime(specText: string, timezone: string, from: number): number {
  const spec = parseSpec(specText);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  if (spec.kind === "interval") {
    const next = from + spec.ms;
    if (!Number.isSafeInteger(next) || next > 8640000000000000) throw new CoworkError("invalid_request");
    return next;
  }
  const deadline = from + 2922 * 86400000;
  for (let at = Math.floor(from / 60000) * 60000 + 60000; at <= deadline;) {
    const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, Number(part.value)]));
    const dom = matches(spec.dom, parts.day!), dow = matches(spec.dow, new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!)).getUTCDay());
    const day = spec.dom.any ? dow : spec.dow.any ? dom : dom || dow;
    if (matches(spec.mon, parts.month!) && day && matches(spec.h, parts.hour!)) {
      if (matches(spec.m, parts.minute!)) return at;
      at += 60000;
    } else at += (60 - parts.minute!) * 60000;
  }
  throw new CoworkError("invalid_request");
}

/** Canonical host state only. No runtime session creation, guest cwd or Code runner dependency. */
export class CoworkSchedules {
  private closed = false;
  private readonly authority: CoworkAuthority;
  constructor(readonly records: CoworkRepository, grants: CoworkGrantResolver, private readonly now = () => Date.now(), private readonly branch?: (workspaceId: string, sourceId: string) => string | undefined) {
    this.authority = new CoworkAuthority(records, grants);
  }
  private one(sql: string, ...values: any[]): Row | null { return this.records.rs.db.query(sql).get(...values) as Row | null; }
  private all(sql: string, ...values: any[]): Row[] { return this.records.rs.db.query(sql).all(...values) as Row[]; }
  private run(sql: string, ...values: any[]) { return this.records.rs.db.query(sql).run(...values); }
  private tx<T>(body: () => T): T { return this.records.rs.transaction(body, { mode: "immediate" }); }
  get(workspaceId: string, scheduleId: string): CoworkSchedule {
    const row = this.one("SELECT * FROM cowork_schedules WHERE workspace_id=? AND schedule_id=?", workspaceId, scheduleId);
    if (!row) throw new CoworkError("not_found"); return schedule(row);
  }
  list(workspaceId: string, cursor?: string, limit = 100): { schedules: CoworkSchedule[]; nextCursor: string | null } {
    this.records.get(workspaceId);
    if (cursor) this.get(workspaceId, cursor);
    const values = this.all("SELECT * FROM cowork_schedules WHERE workspace_id=? AND schedule_id>? ORDER BY schedule_id LIMIT ?", workspaceId, cursor ?? "", limit + 1).map(schedule);
    const schedules: CoworkSchedule[] = [];
    for (const value of values.slice(0, limit)) {
      if (Buffer.byteLength(JSON.stringify({ schedules: [...schedules, value], nextCursor: value.scheduleId })) > 128 * 1024) break;
      schedules.push(value);
    }
    return { schedules, nextCursor: schedules.length < values.length ? schedules.at(-1)!.scheduleId : null };
  }
  status(workspaceId: string, scheduleId: string) {
    return { schedule: this.get(workspaceId, scheduleId), occurrences: this.all("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? ORDER BY due_at DESC LIMIT 100", scheduleId).map(occurrence), execution: "unavailable" as const };
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
      if (previous) { if (previous.request_digest !== digest) throw new CoworkError("request_conflict"); return schedule(previous); }
      if (canonical(intersectCeilings(current, definition.savedCeiling)) !== canonical(intersectCeilings(definition.savedCeiling, definition.savedCeiling))) throw new CoworkError("authority_denied");
      const expectedPolicy = definition.target.kind === "conversation" ? this.records.binding(definition.target.sessionId).policy : this.records.policy(workspaceId).defaultPolicy;
      // Policies are not ranked; no client can save an escalation as a scheduled default.
      if (definition.policy !== expectedPolicy) throw new CoworkError("authority_denied");
      const at = this.now(), next = definition.timing.kind === "once" ? definition.timing.at : nextCoworkScheduleTime(definition.timing.spec, definition.timezone, at);
      const scheduleId = `schedule_${randomUUID()}`;
      this.run("INSERT INTO cowork_schedules VALUES(?,?,?,?,?,?,?,'enabled',1,?)", scheduleId, workspaceId, principalId, requestId, digest, canonical(definition), next, at);
      return this.get(workspaceId, scheduleId);
    });
  }
  cancel(workspaceId: string, scheduleId: string, revision: number): CoworkSchedule {
    return this.tx(() => {
      const value = this.get(workspaceId, scheduleId);
      if (value.state === "cancelled" && value.revision === revision + 1) return value;
      if (value.revision !== revision) throw new CoworkError("revision_conflict", value.revision);
      this.run("UPDATE cowork_schedules SET state='cancelled',next_due=NULL,revision=revision+1 WHERE schedule_id=?", scheduleId);
      this.run("UPDATE cowork_schedule_occurrences SET state='cancelled',claim_token=NULL WHERE schedule_id=? AND state IN ('pending','claimed')", scheduleId);
      // Already dispatched effects require recovery, never cancellation masquerading as completion.
      this.run("UPDATE cowork_schedule_occurrences SET state='uncertain',reason='recovery_required' WHERE schedule_id=? AND state='dispatching'", scheduleId);
      return this.get(workspaceId, scheduleId);
    });
  }
  /** Materialize one durable pending record and accumulate all missed occurrences. */
  reconcileDue(): void {
    this.tx(() => {
      if (this.closed) return;
      const at = this.now();
      for (const row of this.all("SELECT * FROM cowork_schedules WHERE state='enabled' AND next_due<=? ORDER BY next_due,schedule_id", at)) {
        const value = schedule(row), definition = value.definition;
        let due = row.next_due as number, latest = due, count = 1, next: number | null = null;
        if (definition.timing.kind === "recurring") {
          const parsed = parseSpec(definition.timing.spec);
          if (parsed.kind === "interval") { count = Math.floor((at - due) / parsed.ms) + 1; latest = due + (count - 1) * parsed.ms; next = latest + parsed.ms; }
          else {
            next = nextCoworkScheduleTime(definition.timing.spec, definition.timezone, due);
            // Bound each timer pass, preserving the unprocessed cursor for the next pass.
            while (next <= at && count < 1000) { latest = next; count++; next = nextCoworkScheduleTime(definition.timing.spec, definition.timezone, next); }
          }
        }
        const pending = this.one("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? AND state='pending'", value.scheduleId);
        if (pending) this.run("UPDATE cowork_schedule_occurrences SET latest_due_at=?,missed_count=missed_count+? WHERE occurrence_id=?", latest, count, pending.occurrence_id);
        else this.run("INSERT INTO cowork_schedule_occurrences VALUES(?,?,?,?,?,'pending',NULL,NULL)", `occurrence_${randomUUID()}`, value.scheduleId, due, latest, count - 1);
        this.run("UPDATE cowork_schedules SET next_due=? WHERE schedule_id=?", next, value.scheduleId);
      }
    });
  }
  claim(workspaceId: string, scheduleId: string, occurrenceId: string): string | undefined {
    return this.tx(() => {
      const value = this.get(workspaceId, scheduleId);
      if (this.closed || value.state !== "enabled") return undefined;
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
  /** No execution owner is admitted in this slice. A durable claim is not dispatch proof. */
  beginDispatch(_occurrenceId: string, _token: string): never {
    throw new CoworkError("unsupported_topology");
  }
  handled(occurrenceId: string, token: string): void {
    this.tx(() => {
      const row = this.one("SELECT * FROM cowork_schedule_occurrences WHERE occurrence_id=? AND state='dispatching' AND claim_token=?", occurrenceId, token);
      if (!row) throw new CoworkError("request_conflict");
      this.run("UPDATE cowork_schedule_occurrences SET state='handled',claim_token=NULL WHERE occurrence_id=?", occurrenceId);
      const parent = this.one("SELECT * FROM cowork_schedules WHERE schedule_id=?", row.schedule_id)!;
      if (schedule(parent).definition.timing.kind === "once" && parent.state === "enabled") this.run("UPDATE cowork_schedules SET state='handled',revision=revision+1 WHERE schedule_id=?", row.schedule_id);
    });
  }
  /** Only call once after host ownership is established, never upon opening a second DB handle. */
  recover(): void {
    this.tx(() => {
      if (this.closed) return;
      for (const row of this.all("SELECT * FROM cowork_schedule_occurrences WHERE state='claimed'")) {
        const pending = this.one("SELECT * FROM cowork_schedule_occurrences WHERE schedule_id=? AND state='pending'", row.schedule_id);
        if (pending) {
          this.run("UPDATE cowork_schedule_occurrences SET latest_due_at=?,missed_count=missed_count+? WHERE occurrence_id=?", pending.latest_due_at, pending.missed_count + 1, row.occurrence_id);
          this.run("DELETE FROM cowork_schedule_occurrences WHERE occurrence_id=?", pending.occurrence_id);
        }
        this.run("UPDATE cowork_schedule_occurrences SET state='pending',claim_token=NULL WHERE occurrence_id=?", row.occurrence_id);
      }
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
    for (const row of this.all("SELECT o.occurrence_id,s.* FROM cowork_schedule_occurrences o JOIN cowork_schedules s USING(schedule_id) WHERE o.state='pending' AND s.state='enabled'")) {
      const value = schedule(row), reason = this.blockedReason(value);
      this.run("UPDATE cowork_schedule_occurrences SET reason=? WHERE occurrence_id=? AND state='pending' AND reason IS NOT ?", reason, row.occurrence_id, reason);
    }
  }
  beginShutdown(): void { this.closed = true; }
}
