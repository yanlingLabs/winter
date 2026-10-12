// ComputerV2 wake triggers — the minimal record kept on disk so a daemon restart can tell each waiting session what
// happened (spine §5): `<home>/computer-use/wakes.json`, 0600, written atomically (a temp file renamed over it). Under
// the sandbox's write-deny (`selfGrantDenyWrite` names `<home>/computer-use`), so no session's shell or write tool can
// forge a record — a forged one would put daemon-worded text into another session's turn.
//
// One record per trigger, from its arming until the session has been TOLD how it ended: an armed record (no `ended`)
// becomes a `restart` at the next boot; an ended one whose message could not be delivered (a wake that fired while the
// daemon was stopping) is delivered at the next boot as what it was. Nothing screen-derived beyond the two labels the
// session log already holds (`wake_armed`), the backend's `detail`, and the model's own note.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { WAKE_ID_PATTERN, WAKE_LABEL_MAX } from "@yanlinglabs/winter-protocol";
import { WAKE_LIMITS, type WakeConditionKind } from "./types";

const KINDS: ReadonlySet<string> = new Set<WakeConditionKind>(["clicked", "submitted", "navigated", "appeared", "gone", "changed", "titled"]);
const ENDED: ReadonlySet<string> = new Set(["fired", "lost", "expired"]);
const DETAIL_MAX = 300;
const REBIND_MAX = 300;
const SESSION_ID = /^s_[0-9a-z]+$/i;
/** At most this many records are kept (the daemon never arms more than `perDaemon`; ended ones wait for delivery). */
const RECORDS_MAX = 256;

/** How an ended trigger's message still owed reads (fired / lost / an expiry the model asked to hear about). */
export interface WakeRecordEnded {
  outcome: "fired" | "lost" | "expired";
  at: number;
  /** fired: the backend's few words ("clicked", "now at …") — screen-derived, fenced when shown. */
  detail?: string;
  /** lost: the backend's own reason ("the tab was closed"). */
  reason?: string;
}

export interface WakeRecord {
  sessionId: string;
  wakeId: string;
  kind: WakeConditionKind;
  targetLabel: string;
  elementLabel?: string;
  /** The element's role ("button"), said before its label in the model's text. */
  elementRole?: string;
  armedAt: number;
  expiresAt: number;
  note?: string;
  notifyOnTimeout?: true;
  /** How the model gets the target back (`WakeArmed.rebind`, daemon-written). */
  rebind?: string;
  /** Armed in a turn Dispatch followed (the wake turn is followed too). */
  followed?: true;
  ended?: WakeRecordEnded;
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** One record read back, checked field by field (a hand-edited or torn file never puts a bad shape in play). */
export function parseWakeRecord(v: unknown): WakeRecord | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const sessionId = str(o.sessionId, 128);
  const wakeId = str(o.wakeId, 32);
  const kind = typeof o.kind === "string" && KINDS.has(o.kind) ? o.kind as WakeConditionKind : undefined;
  const targetLabel = str(o.targetLabel, WAKE_LABEL_MAX);
  const armedAt = int(o.armedAt);
  const expiresAt = int(o.expiresAt);
  if (sessionId === undefined || !SESSION_ID.test(sessionId) || wakeId === undefined || !WAKE_ID_PATTERN.test(wakeId)) return undefined;
  if (kind === undefined || targetLabel === undefined || armedAt === undefined || expiresAt === undefined) return undefined;
  const r: WakeRecord = { sessionId, wakeId, kind, targetLabel, armedAt, expiresAt };
  const elementLabel = str(o.elementLabel, WAKE_LABEL_MAX);
  if (elementLabel !== undefined) r.elementLabel = elementLabel;
  const elementRole = str(o.elementRole, 64);
  if (elementRole !== undefined && elementRole.length > 0) r.elementRole = elementRole;
  const note = str(o.note, WAKE_LIMITS.noteMaxChars);
  if (note !== undefined && note.length > 0) r.note = note;
  if (o.notifyOnTimeout === true) r.notifyOnTimeout = true;
  if (o.followed === true) r.followed = true;
  const rebind = str(o.rebind, REBIND_MAX);
  if (rebind !== undefined && rebind.length > 0) r.rebind = rebind;
  const e = o.ended;
  if (e !== null && typeof e === "object" && !Array.isArray(e)) {
    const eo = e as Record<string, unknown>;
    const at = int(eo.at);
    if (typeof eo.outcome === "string" && ENDED.has(eo.outcome) && at !== undefined) {
      r.ended = { outcome: eo.outcome as WakeRecordEnded["outcome"], at };
      const detail = str(eo.detail, DETAIL_MAX);
      if (detail !== undefined && detail.length > 0) r.ended.detail = detail;
      const reason = str(eo.reason, DETAIL_MAX);
      if (reason !== undefined && reason.length > 0) r.ended.reason = reason;
    }
  }
  return r;
}

/** The file of records. Every failure is logged and swallowed: a lost record only costs a restart notice. */
export class WakeStore {
  readonly path: string;
  private records = new Map<string, WakeRecord>();

  constructor(home: string, private readonly log: (line: string) => void = () => {}) {
    this.path = join(home, "computer-use", "wakes.json");
  }

  /** The records on disk (read once, at boot). A missing or unreadable file reads as none. */
  load(): WakeRecord[] {
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); } catch { return []; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { this.log("computer-use: wakes.json could not be read — its records are dropped"); return []; }
    const list = json !== null && typeof json === "object" && Array.isArray((json as { wakes?: unknown }).wakes) ? (json as { wakes: unknown[] }).wakes : [];
    const out: WakeRecord[] = [];
    for (const v of list.slice(0, RECORDS_MAX)) {
      const r = parseWakeRecord(v);
      if (r !== undefined) out.push(r);
    }
    this.records = new Map(out.map((r) => [r.wakeId, r]));
    return out;
  }

  get(wakeId: string): WakeRecord | undefined { return this.records.get(wakeId); }

  put(record: WakeRecord): void {
    this.records.set(record.wakeId, record);
    while (this.records.size > RECORDS_MAX) this.records.delete(this.records.keys().next().value!);
    this.flush();
  }

  remove(wakeIds: readonly string[]): void {
    let changed = false;
    for (const id of wakeIds) changed = this.records.delete(id) || changed;
    if (changed) this.flush();
  }

  all(): WakeRecord[] { return [...this.records.values()]; }

  private flush(): void {
    try {
      if (this.records.size === 0) { rmSync(this.path, { force: true }); return; }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, wakes: [...this.records.values()] }, null, 1)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      this.log(`computer-use: wakes.json could not be written (${err instanceof Error ? err.message : "error"})`);
    }
  }
}
