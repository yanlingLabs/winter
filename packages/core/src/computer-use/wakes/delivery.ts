// ComputerV2 wake triggers — THE WAKE (spine §4): how a session is told that a trigger it armed has ended, in one
// daemon-written message under `clientName: "computer-wake"`.
//
// DOOR RULES — SendMessage's (`agent/session-messaging.ts`'s `deliverInto`): a session RUNNING a turn on a child that
// folds is STEERED (the message joins the running turn after its current tool call); one with sends already held
// behind its turn gets this one queued behind them; an idle or finished one gets it through `send` — resumed through
// its own driver if need be (`get ?? ensure`). A daemon that began stopping delivers nothing: the trigger's record
// stays in `wakes.json`, and the next boot says what happened.
//
// COALESCING: everything that ends for one session within `WAKE_LIMITS.coalesceMs` of the first goes out as ONE
// message. A failed delivery is retried a bounded number of times (Dispatch's wake delays), then left for the next boot.
//
// THE TEXT is pinned (spine §4): a `<computer-wake>` block, one line per trigger, every screen-derived part (the
// element and target labels, a fired trigger's `detail`) inside the SAME random-tag fence ComputerV2 results use
// (`result.ts`), with its one-line preamble. The model's own note and the daemon's own words stay outside it.
import { COMPUTER_WAKE_CLIENT_NAME } from "@yanlinglabs/winter-protocol";
import { deliverInto, type MessagingDriverHandle } from "../../agent/session-messaging";
import { withReplacementRetry } from "../../runtime-sdk/session-replaced";
import { fenceInline, newFenceTag, screenDataPreamble } from "../result";
import { WAKE_LIMITS, type WakeConditionKind } from "./types";

/** What one ended trigger tells its session. */
export interface WakeNews {
  wakeId: string;
  outcome: "fired" | "lost" | "expired" | "restart";
  /** Epoch ms of the ending (for `restart`, of the boot that found it). */
  at: number;
  armedAt: number;
  kind: WakeConditionKind;
  /** Screen-derived: fenced. */
  targetLabel: string;
  /** Screen-derived (or the model's own text for a text/url/title condition): fenced. A quoted name — `“Submit”`. */
  elementLabel?: string;
  /** The element's role, said before its label in the model's text ("button “Submit”"). */
  elementRole?: string;
  /** fired: the backend's few words — screen-derived, fenced. */
  detail?: string;
  /** lost: the backend's own reason, in its words. */
  reason?: string;
  /** The model's own reminder (never shown on the user's screen). */
  note?: string;
  /** Daemon-written: how to get the target back. */
  rebind?: string;
  /** Armed in a turn Dispatch followed: the wake turn is followed too. */
  followed?: boolean;
}

/** "12:41", local time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "45 s", "60 min", "2 h 5 min". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m <= 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** The element as the model reads it: `button “Submit”`, `“Submit”`, `button`, or undefined. */
function elementWords(n: Pick<WakeNews, "elementLabel" | "elementRole">): string | undefined {
  const role = n.elementRole?.trim();
  if (n.elementLabel !== undefined && n.elementLabel.length > 0) return role ? `${role} ${n.elementLabel}` : n.elementLabel;
  return role || undefined;
}

/** What the trigger waited for, in plain words — the screen-derived whole inside one fence. */
export function waitingForWords(n: Pick<WakeNews, "kind" | "targetLabel" | "elementLabel" | "elementRole">): string {
  const el = elementWords(n);
  const t = n.targetLabel;
  switch (n.kind) {
    case "clicked": return `the user to click ${el ?? "an element"} in ${t}`;
    case "submitted": return `the user to submit ${el ?? "a form"} in ${t}`;
    case "changed": return `the user to change ${el ?? "a field"} in ${t}`;
    case "navigated": return n.elementLabel === undefined ? `${t} to move to another page` : `${t} to reach ${n.elementLabel}`;
    case "appeared": return `${n.elementLabel ?? "the text"} to appear in ${t}`;
    case "gone": return `${el ?? "an element"} to go away in ${t}`;
    case "titled": return `${t}'s title to contain ${n.elementLabel ?? "the text"}`;
  }
}

/** What happened, for a fired trigger. Input conditions name the user; state conditions say what changed. */
function firedWords(n: WakeNews, fence: (s: string) => string): string {
  const el = elementWords(n);
  const t = n.targetLabel;
  const detail = n.detail?.trim();
  switch (n.kind) {
    case "clicked": return `the user ${fence(`clicked ${el ?? "it"} in ${t}`)}`;
    case "submitted": return `the user ${fence(`submitted ${el ?? "a form"} in ${t}`)}`;
    case "changed": return `the user ${fence(`changed ${el ?? "the field"} in ${t}`)}`;
    case "navigated": return fence(`${t}: ${detail || "a new page"}`);
    case "appeared": return fence(`${n.elementLabel ?? "the text"} appeared in ${t}`);
    case "gone": return fence(`${el ?? "it"} is gone from ${t}`);
    case "titled": return fence(`${t}: ${detail || `the title contains ${n.elementLabel ?? "the text"}`}`);
  }
}

/** One line of the message (and its note and rebind lines). */
function newsLines(n: WakeNews, fence: (s: string) => string, clock: (at: number) => string): string[] {
  const waited = fence(waitingForWords(n));
  let head: string;
  switch (n.outcome) {
    case "fired": head = `- ${n.wakeId} fired at ${clock(n.at)}: ${firedWords(n, fence)}.`; break;
    case "lost": head = `- ${n.wakeId} can no longer fire (${clock(n.at)}): ${n.reason?.trim() || "its target is gone"} — it was waiting for ${waited}.`; break;
    case "expired": head = `- ${n.wakeId} expired at ${clock(n.at)}, after ${durationWords(n.at - n.armedAt)} — it was waiting for ${waited}.`; break;
    case "restart": head = `- ${n.wakeId} (armed at ${clock(n.armedAt)}) ended when Winter restarted — it was waiting for ${waited}.`; break;
  }
  const lines = [head];
  if (n.note !== undefined && n.note.length > 0) lines.push(`  Your note: ${n.note}`);
  if (n.rebind !== undefined && n.rebind.length > 0) {
    lines.push(n.outcome === "lost"
      ? `  If you still need it, bind it again with ${n.rebind}.`
      : `  Get the target back with ${n.rebind} if your handle is gone — refs read before this are stale; call state().`);
  }
  return lines;
}

/** The pinned `<computer-wake>` block for `news`, fenced with `tag`. */
export function renderWakeMessage(news: readonly WakeNews[], opts: { tag?: string; clock?: (at: number) => string } = {}): string {
  const tag = opts.tag ?? newFenceTag();
  const clock = opts.clock ?? clockTime;
  const fence = (s: string): string => fenceInline(tag, s);
  const allRestart = news.every((n) => n.outcome === "restart");
  const header = allRestart
    ? `Winter restarted, so ${news.length === 1 ? "this wait" : "these waits"} ended — arm ${news.length === 1 ? "it" : "them"} again with wakeWhen() if you still need ${news.length === 1 ? "it" : "them"}.`
    : news.length === 1 ? "A wake trigger you set has ended." : `${news.length} wake triggers you set have ended.`;
  const body = news.flatMap((n) => newsLines(n, fence, clock));
  return ["<computer-wake>", header, screenDataPreamble(tag), ...body, "</computer-wake>"].join("\n");
}

/** A session's state for a delivery: gone (deleted) and archived sessions are never woken. */
export type WakeSessionState = "live" | "gone" | "archived";

export interface WakeDeliveryDeps {
  /** The driver table (late-bound: built after the computer-use runtime). Absent: not ready — retried. */
  sessions(): { get(sessionId: string): MessagingDriverHandle | undefined; ensure(sessionId: string): Promise<MessagingDriverHandle | undefined> } | undefined;
  sessionState(sessionId: string): WakeSessionState;
  /** Dispatch: the child's wake turn is followed (`DispatchChildren.expectWake`); returns the undo for a failed send. */
  followWake?(sessionId: string, text: string): (() => void) | undefined;
  /** The session was told: its records go. */
  onDelivered(sessionId: string, wakeIds: readonly string[]): void;
  /** Never to be told (the session is gone or archived): its records go. */
  onDropped(sessionId: string, wakeIds: readonly string[]): void;
  /** The daemon began stopping: nothing is delivered (the records stay for the next boot). */
  draining(): boolean;
  coalesceMs?: number;
  retryDelaysMs?: readonly number[];
  schedule?(fn: () => void, ms: number): () => void;
  tag?(): string;
  clock?(at: number): string;
  log?(line: string): void;
}

/** Dispatch's wake delays: a failed delivery is retried after each, then left for the next boot. */
export const WAKE_DELIVERY_RETRY_MS: readonly number[] = [2_000, 10_000, 30_000];

interface Pending { news: WakeNews[]; cancel?: () => void; attempt: number; flushing: boolean }

export class WakeDelivery {
  private readonly pending = new Map<string, Pending>();
  private stopped = false;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: WakeDeliveryDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return () => clearTimeout(t);
    });
    this.log = deps.log ?? (() => {});
  }

  /** One ended trigger to tell its session about — coalesced with the others of that session for `coalesceMs`. */
  enqueue(sessionId: string, news: WakeNews): void {
    if (this.stopped) return;
    let p = this.pending.get(sessionId);
    if (p === undefined) { p = { news: [], attempt: 0, flushing: false }; this.pending.set(sessionId, p); }
    if (p.news.some((n) => n.wakeId === news.wakeId)) return;
    p.news.push(news);
    if (p.cancel === undefined && !p.flushing) this.arm(sessionId, p, this.deps.coalesceMs ?? WAKE_LIMITS.coalesceMs);
  }

  /** How many endings wait to be told, for `sessionId` (tests and diagnostics). */
  waiting(sessionId: string): number { return this.pending.get(sessionId)?.news.length ?? 0; }

  /** Daemon stop: no timer outlives it (the undelivered records stay in `wakes.json`). */
  stop(): void {
    this.stopped = true;
    for (const p of this.pending.values()) p.cancel?.();
    this.pending.clear();
  }

  private arm(sessionId: string, p: Pending, ms: number): void {
    p.cancel = this.schedule(() => { p.cancel = undefined; void this.flush(sessionId); }, ms);
  }

  private async flush(sessionId: string): Promise<void> {
    const p = this.pending.get(sessionId);
    if (p === undefined || p.flushing || p.news.length === 0 || this.stopped) return;
    if (this.deps.draining()) return; // kept in `wakes.json` for the next boot
    const state = this.deps.sessionState(sessionId);
    if (state !== "live") {
      const ids = p.news.map((n) => n.wakeId);
      this.pending.delete(sessionId);
      this.deps.onDropped(sessionId, ids);
      return;
    }
    p.flushing = true;
    const batch = p.news.splice(0);
    const text = renderWakeMessage(batch, { ...(this.deps.tag === undefined ? {} : { tag: this.deps.tag() }), ...(this.deps.clock === undefined ? {} : { clock: this.deps.clock }) });
    let undo: (() => void) | undefined;
    try {
      const sessions = this.deps.sessions();
      if (sessions === undefined) throw new Error("the session drivers are not ready yet");
      const next = async (): Promise<MessagingDriverHandle | undefined> => sessions.get(sessionId) ?? await sessions.ensure(sessionId);
      const driver = await next();
      if (driver === undefined) throw new Error("the session has no runtime to resume");
      // Re-checked after the (possibly long) resume: nothing goes in once the daemon began stopping.
      if (this.deps.draining() || this.stopped) { p.news.unshift(...batch); return; }
      if (batch.some((n) => n.followed === true)) undo = this.deps.followWake?.(sessionId, text);
      await withReplacementRetry(driver, next, (d) => deliverInto(d, text, COMPUTER_WAKE_CLIENT_NAME));
      p.attempt = 0;
      this.deps.onDelivered(sessionId, batch.map((n) => n.wakeId));
    } catch (err) {
      undo?.();
      p.news.unshift(...batch);
      const delays = this.deps.retryDelaysMs ?? WAKE_DELIVERY_RETRY_MS;
      const delay = delays[p.attempt];
      if (delay === undefined) {
        this.log(`computer-use: waking ${sessionId} for ${batch.length} wake trigger(s) failed (${err instanceof Error ? err.message : "error"}) — left for the next boot`);
        p.attempt = 0;
        p.news.splice(0);
        this.pending.delete(sessionId);
        return;
      }
      p.attempt++;
      this.log(`computer-use: waking ${sessionId} failed (${err instanceof Error ? err.message : "error"}) — retrying in ${delay} ms`);
      if (p.cancel === undefined) this.arm(sessionId, p, delay);
      return;
    } finally {
      p.flushing = false;
    }
    // Endings that arrived while this one was being delivered: their own coalescing window.
    if (p.news.length > 0 && p.cancel === undefined) this.arm(sessionId, p, this.deps.coalesceMs ?? WAKE_LIMITS.coalesceMs);
    else if (p.news.length === 0 && p.cancel === undefined) this.pending.delete(sessionId);
  }
}
