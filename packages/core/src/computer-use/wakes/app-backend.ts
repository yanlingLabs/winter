// ComputerV2 — WAKE TRIGGERS on APPS: the `WakeBackend` for app targets, over the Winter Computer Use helper's watches
// (apple/ComputerUse/PROTOCOL.md §4.13: `watch.arm`, `watch.cancel`, the `watchEvent` notification).
//
// The registry (`wakes/registry.ts`) arms a trigger here for a bound APP target (a tab binding goes to the browser
// backend). This backend checks what only the daemon knows — the target is bound in that session and allowed for the
// SESSION or ALWAYS (a once-bound app can't be watched: it is released when its call ends) — and the helper does the
// rest: the target alive and readable, never a secure field, never Winter; the condition not already true; the watch
// itself, which outlives the script's binding (a reset, a worker restart or its idle end release the target; the watch
// holds on to the window by itself). The helper reports ONE `watchEvent` per watch; a helper that goes away (its
// connection closed: it quit or crashed) takes every armed watch with it — each is reported `lost`, "Winter
// Computer Use quit".
//
// "Only the user's action counts" on an app (the controller's ruling): `clicked` fires on the user's HARDWARE click on
// the element (the helper's listen-only mouse-down tap — never a synthetic event, never Winter's own input); `changed`
// needs the user's input too, but the helper can't see keys without Input Monitoring (which is never asked for), so a
// change counts as theirs when the field holds the keyboard focus in the frontmost app, or their own hardware click
// went to it; the STATE kinds (`appeared`, `gone`, `titled`) fire on any false→true transition Winter's own input did
// not cause (in flight, or within 500 ms after). A condition already true at arming is refused (`already_met`).
//
// Every sentence this backend throws is the daemon's own — app names and the model's own words only, never a window
// title or an element's name (those come back in `WakeArmed` and the event's `detail`, which the registry fences).
import { familyForBundleId } from "../browser/families";
import { AutomationFailure } from "../errors";
import type { HelperClient } from "../helper-client";
import {
  HELPER_WATCH_VERSION, HelperRpcError, HelperUnavailableError, helperVersionAtLeast,
  type HelperNotification, type WatchArmResult, type WatchConditionWire,
} from "../protocol";
import { TAB_ONLY_WAKE_KINDS, type WakeArmed, type WakeArmRequest, type WakeBackend, type WakeBackendEvent, type WakeCondition } from "./types";

/** The service's view of a bound app target (`ComputerV2Service.appTarget`). */
export interface AppWakeTarget { bundleId: string; name: string; pid: number; lost?: string }

export interface AppWakeBackendDeps {
  helper: Pick<HelperClient, "request" | "tell" | "ensure" | "version">;
  /** The app target `targetId` as bound in that session, or undefined when it is not (`service.appTarget`). */
  target(sessionId: string, targetId: string): AppWakeTarget | undefined;
  /** "Allow for this session" or "Always allow" (`policy.persistentlyAllowed`): a once-allowed app is not watched. */
  persistentlyAllowed(sessionId: string, bundleId: string): boolean;
  now?(): number;
  log?(line: string): void;
  /** How long `watch.arm` may take (default 15 s). */
  armTimeoutMs?: number;
}

/** What a lost helper connection says to the model. */
export const HELPER_GONE_REASON = "Winter Computer Use quit";
/** How long `watch.arm` may take (it reads the window once). */
const ARM_TIMEOUT_MS = 15_000;

interface Armed {
  sessionId: string;
  app: string;
  onEvent: (e: WakeBackendEvent) => void;
  /** Still waiting for `watch.arm`'s answer: an event that arrives first waits for it. */
  arming: boolean;
  early?: WakeBackendEvent;
}

export class AppWakeBackend implements WakeBackend {
  private readonly armed = new Map<string, Armed>();

  constructor(private readonly deps: AppWakeBackendDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** How many app watches are armed (tests, status). */
  get armedCount(): number { return this.armed.size; }

  async arm(req: WakeArmRequest, onEvent: (e: WakeBackendEvent) => void): Promise<WakeArmed> {
    const t = this.deps.target(req.sessionId, req.targetId);
    if (t === undefined) throw new AutomationFailure("TargetLost", "that app is no longer bound — bind it again with apps.open(), then arm the trigger");
    if (t.lost !== undefined) throw new AutomationFailure("TargetLost", lostWords(t.name, t.lost));
    if (TAB_ONLY_WAKE_KINDS.has(req.condition.kind)) {
      throw new AutomationFailure("NotAllowed", `${req.condition.kind === "submitted" ? "submitted" : "navigated and url"} are for browser tabs only — an app can't be watched for it`);
    }
    // A browser Winter drives tab by tab is watched on its TABS (the ruling, review L4): its page is the tab backend's,
    // with its own floors. Safari, which has no tab backend, stays an app.
    const family = familyForBundleId(t.bundleId);
    if (family !== undefined && family.bundleIds.length > 0) {
      throw new AutomationFailure("NotAllowed", `${t.name} is a browser Winter drives tab by tab — wait on the tab instead: bind it with browsers.tab(…) and call tab.wakeWhen(…)`);
    }
    if (!this.deps.persistentlyAllowed(req.sessionId, t.bundleId)) {
      throw new AutomationFailure("NotAllowed", `${t.name} was allowed for one call only — a wake trigger needs it allowed for this session`);
    }
    const condition = wireCondition(req.condition);
    if (this.armed.has(req.wakeId)) throw new TypeError(`${req.wakeId} is already armed`);
    try {
      await this.deps.helper.ensure();
    } catch (err) {
      throw failure(err, t, req.condition);
    }
    if (!helperVersionAtLeast(this.deps.helper.version, HELPER_WATCH_VERSION)) {
      const v = this.deps.helper.version;
      throw new AutomationFailure("HelperUnavailable", `Winter Computer Use${v === undefined ? "" : ` ${v}`} is too old to wait on an app (it needs ${HELPER_WATCH_VERSION} or later) — update Winter`);
    }
    const entry: Armed = { sessionId: req.sessionId, app: t.name, onEvent, arming: true };
    this.armed.set(req.wakeId, entry);
    let r: WatchArmResult;
    try {
      r = await this.deps.helper.request<WatchArmResult>("watch.arm", {
        targetId: req.targetId, watchId: req.wakeId, condition, expiresAt: req.expiresAt,
      }, { timeoutMs: this.deps.armTimeoutMs ?? ARM_TIMEOUT_MS });
    } catch (err) {
      if (this.armed.get(req.wakeId) === entry) this.armed.delete(req.wakeId);
      // Whatever went wrong — a timeout above all, when the helper may have armed it after all — its watch goes too
      // (`watch.cancel` is idempotent): nothing is left watching with no trigger to end (review M1).
      this.deps.helper.tell("watch.cancel", { watchId: req.wakeId });
      throw failure(err, t, req.condition);
    }
    if (this.armed.get(req.wakeId) !== entry) {
      // Disarmed while it was being armed: the helper's watch goes too.
      this.deps.helper.tell("watch.cancel", { watchId: req.wakeId });
      throw new AutomationFailure("Cancelled", "the wake trigger was cancelled while it was being armed");
    }
    entry.arming = false;
    if (entry.early !== undefined) {
      // The event came before the answer (the helper's notification overtook it): delivered once the registry has
      // the trigger, never before.
      const early = entry.early;
      this.armed.delete(req.wakeId);
      setTimeout(() => { try { onEvent(early); } catch { /* the registry's own problem */ } }, 0);
    }
    this.deps.log?.(`computer-use: wake ${req.wakeId} armed on ${t.name} (${req.condition.kind})`);
    const element = r?.element;
    return {
      ...(element !== undefined && typeof element?.role === "string" && typeof element?.name === "string"
        ? { element: { role: element.role.slice(0, 200), name: element.name.slice(0, 200) } } : {}),
      targetLabel: typeof r?.targetLabel === "string" && r.targetLabel.length > 0 ? r.targetLabel.slice(0, 200) : t.name,
      rebind: `apps.open(${JSON.stringify(t.bundleId)})`,
    };
  }

  disarm(wakeId: string): void {
    const entry = this.armed.get(wakeId);
    if (entry === undefined) return;
    this.armed.delete(wakeId);
    if (!entry.arming) this.deps.helper.tell("watch.cancel", { watchId: wakeId });
  }

  /** The helper's notifications (wired beside the service's): a `watchEvent` ends its trigger, once. */
  handleNotification(n: HelperNotification): void {
    if (n.method !== "watchEvent") return;
    const p = n.params as Partial<{ watchId: unknown; outcome: unknown; at: unknown; detail: unknown; reason: unknown }> | undefined;
    if (p === undefined || typeof p.watchId !== "string" || (p.outcome !== "fired" && p.outcome !== "lost")) return;
    const entry = this.armed.get(p.watchId);
    if (entry === undefined || entry.early !== undefined) return; // ended already (disarmed, or its one event delivered)
    const event: WakeBackendEvent = {
      wakeId: p.watchId,
      outcome: p.outcome,
      at: typeof p.at === "number" && Number.isFinite(p.at) ? p.at : this.now(),
      ...(p.outcome === "fired" && typeof p.detail === "string" && p.detail.length > 0 ? { detail: p.detail.slice(0, 200) } : {}),
      ...(p.outcome === "lost" ? { reason: typeof p.reason === "string" && p.reason.length > 0 ? p.reason.slice(0, 200) : "the app's window went away" } : {}),
    };
    if (entry.arming) { entry.early = event; return; }
    this.armed.delete(p.watchId);
    entry.onEvent(event);
  }

  /** The daemon is stopping (the registry calls it before the engine and the helper go): every watch is cancelled
   *  quietly and nothing is reported — the registry persists what was armed and reports it at the next boot. */
  stop(): void {
    for (const [wakeId, entry] of [...this.armed]) {
      this.armed.delete(wakeId);
      if (!entry.arming) this.deps.helper.tell("watch.cancel", { watchId: wakeId });
    }
  }

  /** The helper's connection closed: it quit or crashed, and every watch it held went with it. */
  helperDisconnected(): void {
    const at = this.now();
    for (const [wakeId, entry] of [...this.armed]) {
      if (entry.arming) continue; // its `watch.arm` fails (HelperUnavailable) and arms nothing
      this.armed.delete(wakeId);
      try { entry.onEvent({ wakeId, outcome: "lost", at, reason: HELPER_GONE_REASON }); } catch { /* the registry's own problem */ }
    }
  }
}

/** The pinned condition as the helper's wire: an app's ref is a number from state(). Tab-only kinds never get here. */
export function wireCondition(c: WakeCondition): WatchConditionWire {
  const ref = (r: string | undefined): number => {
    if (r === undefined || !/^[1-9]\d{0,8}$/.test(r.trim())) throw new TypeError(`a ref in an app is a number from state(), like 12 — got ${JSON.stringify(r ?? null).slice(0, 40)}`);
    return Number(r.trim());
  };
  switch (c.kind) {
    case "clicked": return { kind: "clicked", ref: ref(c.ref) };
    case "appeared": return { kind: "appeared", text: c.text };
    case "gone":
      if (c.ref !== undefined) return { kind: "gone", ref: ref(c.ref) };
      return { kind: "gone", text: c.text ?? "" };
    case "changed": return { kind: "changed", ref: ref(c.ref), settleMs: c.settleMs };
    case "titled": return { kind: "titled", title: c.title };
    default: throw new TypeError(`${(c as { kind: string }).kind} can't be watched in an app`);
  }
}

/** A bound app gone, in the words of what happened to it (the service's `targetLostMessage`, kept here so this module
 *  never imports the service). */
export function lostWords(name: string, reason: string): string {
  switch (reason) {
    case "app_quit": return `${name} quit — open it again with apps.open(), then arm the trigger`;
    case "window_closed": return `${name}'s window closed — call apps.open or useWindow to pick another, then arm the trigger`;
    case "helper_restart": return `Winter Computer Use restarted, so ${name} is no longer bound — bind it again with apps.open()`;
    case "once": return `${name} was allowed for one call only — a wake trigger needs it allowed for this session`;
    default: return `${name} is no longer bound — bind it again with apps.open()`;
  }
}

const quoted = (s: string): string => `“${s.replace(/\s+/g, " ").trim().slice(0, 80)}”`;

/** The daemon's sentence for an arm the helper refused because the condition already holds (the controller's ruling). */
export function alreadyMetSentence(c: WakeCondition, app: string): string {
  switch (c.kind) {
    case "appeared": return `${quoted(c.text)} is already shown in ${app} — nothing to wait for; check state()`;
    case "gone": return c.ref !== undefined
      ? `[${c.ref}] is already gone from ${app} — nothing to wait for; check state()`
      : `${quoted(c.text ?? "")} is not shown in ${app} — nothing to wait for; check state()`;
    case "titled": return `${app}'s window title already contains ${quoted(c.title)} — nothing to wait for; check state()`;
    default: return `that is already the case in ${app} — nothing to wait for; check state()`;
  }
}

/** A refusal of `watch.arm` (or of reaching the helper) as the typed failure the script sees, in the daemon's words. */
function failure(err: unknown, t: AppWakeTarget, c: WakeCondition): Error {
  if (err instanceof AutomationFailure || err instanceof TypeError) return err;
  if (err instanceof HelperUnavailableError) {
    return new AutomationFailure("HelperUnavailable", `${err.message}${err.retryable ? " — try again; if it keeps failing, ask the user to check Settings → Computer Use" : ""}`, err.retryable);
  }
  if (!(err instanceof HelperRpcError)) return new AutomationFailure("HelperUnavailable", "Winter Computer Use could not arm the trigger — try again");
  const reason = typeof err.data.reason === "string" ? err.data.reason : "";
  switch (err.code) {
    case "stale_ref": return new AutomationFailure("StaleRef", `${typeof err.data.ref === "number" ? `[${err.data.ref}]` : "that element"} is gone — call state()`);
    case "target_lost": return new AutomationFailure("TargetLost", lostWords(t.name, reason || "unknown"));
    case "not_allowed":
      if (reason === "already_met") return new AutomationFailure("NotAllowed", alreadyMetSentence(c, t.name));
      return new AutomationFailure("NotAllowed", `Winter can't watch ${t.name} for that`);
    case "refused":
      switch (reason) {
        case "secure_field": return new AutomationFailure("Refused", "that is a password or payment field — Winter never watches one; ask the user to tell you when they are done");
        case "winter_itself": return new AutomationFailure("Refused", "Winter never watches itself");
        case "privacy_pane": return new AutomationFailure("Refused", "System Settings' Privacy & Security panes are off limits — ask the user to change them");
        case "auth_dialog": return new AutomationFailure("Refused", "that is a system authentication dialog — ask the user to handle it");
        default: return new AutomationFailure("Refused", `${t.name} can't be watched for that${reason ? ` (${reason})` : ""}`);
      }
    case "unsupported":
      // Three things answer `unsupported`: a window with no accessibility (the one the model can act on), a helper too
      // old to know `watch.arm`, and a helper whose engine is going away (review L6).
      if (reason === "no_accessibility") return new AutomationFailure("NotAllowed", `${t.name}'s window exposes no accessibility here, so Winter can't watch it — ask the user to show the window once on its desktop, then bind it again`);
      if (/^unknown method/i.test(err.message)) return new AutomationFailure("HelperUnavailable", `Winter Computer Use is too old to wait on an app (it needs ${HELPER_WATCH_VERSION} or later) — update Winter`);
      return new AutomationFailure("HelperUnavailable", "Winter Computer Use could not arm the trigger (it may be quitting) — try again", true);
    case "permission_missing": return new AutomationFailure("PermissionMissing", `Winter Computer Use needs the ${err.data.permission === "screenRecording" ? "Screen Recording" : "Accessibility"} permission — ask the user to grant it in Settings → Computer Use`);
    case "busy": return new AutomationFailure("TargetBusy", `${t.name} is busy, or Winter Computer Use holds too many watches — try again in a moment`);
    case "cancelled": return new AutomationFailure("Cancelled", "the call was cancelled");
    case "invalid_params": return new TypeError(err.message.slice(0, 300));
    default: return new AutomationFailure("HelperUnavailable", `Winter Computer Use could not arm the trigger (${err.code}) — try again`);
  }
}
