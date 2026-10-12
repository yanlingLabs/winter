// ComputerV2 wake triggers — the minimal record kept on disk so a daemon restart can tell each waiting session what
// happened (spine §5): `<home>/computer-use/wakes.json`, 0600, written atomically (a temp file renamed over it). Under
// the sandbox's write-deny (`selfGrantDenyWrite` names `<home>/computer-use`), so no session's shell or write tool can
// forge a record — a forged one would put daemon-worded text into another session's turn.
//
// One record per trigger, from its arming until the session has been TOLD how it ended: an armed record (no `ended`)
// becomes a `restart` at the next boot — stored as ended `restart` at once, so a boot whose wake could not be delivered
// is never ended twice; an ended one is a wake still owed (`woken: true` on its `wake_ended`) and is delivered at the
// next boot as what it was. A trigger that ends without waking anyone (cancelled, disabled, a silent expiry) leaves no
// record.
//
// THE FIELDS (nothing screen-derived beyond the two labels the session log already holds in `wake_armed`):
//   sessionId, wakeId             whose trigger, which one (`s_…`, `wk_<12 hex>`)
//   kind                          the condition's kind (`clicked`, `navigated`, …) — never its ref or value
//   targetLabel, elementLabel?    the labels `wake_armed` carries (≤ 200, well-formed)
//   armedAt, expiresAt            epoch ms
//   note?                         the model's own reminder (≤ 500) — read back to the MODEL only, in its wake
//   notifyOnTimeout?              an expiry wakes the session (else it is dropped silently)
//   rebind?                       how the model gets the target back (`WakeArmed.rebind`, daemon-written)
//   followed?                     armed in a turn Dispatch followed (its wake turn is followed too)
//   ended? {outcome, at}          `fired` / `lost` / `expired` / `restart`: the wake still owed. Only the outcome and
//                                 its time — never the backend's detail or loss reason, nor the element's role (the
//                                 boot's message reads without them).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { WAKE_ID_PATTERN, WAKE_LABEL_MAX } from "@yanlinglabs/winter-protocol";
import { cutUtf16, wellFormed } from "./text";
import { WAKE_LIMITS, type WakeConditionKind } from "./types";

const KINDS: ReadonlySet<string> = new Set<WakeConditionKind>(["clicked", "submitted", "navigated", "appeared", "gone", "changed", "titled"]);
const ENDED: ReadonlySet<string> = new Set(["fired", "lost", "expired", "restart"]);
const REBIND_MAX = 300;
const SESSION_ID = /^s_[0-9a-z]+$/i;
/** At most this many records are kept (the daemon never arms more than `perDaemon`; ended ones wait for delivery). */
const RECORDS_MAX = 256;

/** How an ended trigger whose wake is still owed ended (fired / lost / an expiry the model asked to hear about / the
 *  restart that ended it). */
export interface WakeRecordEnded {
  outcome: "fired" | "lost" | "expired" | "restart";
  at: number;
}

export interface WakeRecord {
  sessionId: string;
  wakeId: string;
  kind: WakeConditionKind;
  targetLabel: string;
  elementLabel?: string;
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

/** A string field read back: well-formed and cut without splitting a pair. */
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? cutUtf16(wellFormed(v), max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);

/** One record read back, checked field by field (a hand-edited or torn file never puts a bad shape in play). Fields
 *  outside the list above are ignored. */
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
    if (typeof eo.outcome === "string" && ENDED.has(eo.outcome) && at !== undefined) r.ended = { outcome: eo.outcome as WakeRecordEnded["outcome"], at };
  }
  return r;
}

/** The file of records. Every failure is logged and swallowed: a lost record only costs a restart notice. The file is
 *  read LAZILY, before anything is first read or written — so a trigger armed before the boot sweep (`start()`) can
 *  never overwrite what the last daemon left. */
export class WakeStore {
  readonly path: string;
  private records = new Map<string, WakeRecord>();
  private loaded = false;
  /** What the last daemon left, as first read (the boot sweep's input). */
  private previous: WakeRecord[] = [];

  constructor(home: string, private readonly log: (line: string) => void = () => {}) {
    this.path = join(home, "computer-use", "wakes.json");
  }

  /** The records the LAST daemon left on disk (read once; a missing or unreadable file reads as none) — never one
   *  this daemon put since. */
  load(): WakeRecord[] {
    this.ensureLoaded();
    return [...this.previous];
  }

  get(wakeId: string): WakeRecord | undefined { this.ensureLoaded(); return this.records.get(wakeId); }

  put(record: WakeRecord): void {
    this.ensureLoaded();
    this.records.set(record.wakeId, record);
    while (this.records.size > RECORDS_MAX) this.records.delete(this.records.keys().next().value!);
    this.flush();
  }

  remove(wakeIds: readonly string[]): void {
    this.ensureLoaded();
    let changed = false;
    for (const id of wakeIds) changed = this.records.delete(id) || changed;
    if (changed) this.flush();
  }

  all(): WakeRecord[] { this.ensureLoaded(); return [...this.records.values()]; }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try { raw = readFileSync(this.path, "utf8"); } catch { return; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch { this.log("computer-use: wakes.json could not be read — its records are dropped"); return; }
    const list = json !== null && typeof json === "object" && Array.isArray((json as { wakes?: unknown }).wakes) ? (json as { wakes: unknown[] }).wakes : [];
    const out: WakeRecord[] = [];
    for (const v of list.slice(0, RECORDS_MAX)) {
      const r = parseWakeRecord(v);
      if (r !== undefined) out.push(r);
    }
    this.previous = out;
    for (const r of out) if (!this.records.has(r.wakeId)) this.records.set(r.wakeId, r);
  }

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
