// FAKE wake backends (`computer-use/wakes/types.ts`'s `WakeBackend`) for the registry's unit tests and the e2e that
// drives a trigger through a real daemon. Lanes B and C deliver the real ones; this one arms whatever it is asked,
// answers with fixed labels, and lets a test fire or lose a trigger — or refuse an arm, as a backend would for a
// condition already true, a secure field, a headless tab.
import { AutomationFailure } from "../../src/computer-use/errors";
import type { WakeBackendHelperHooks } from "../../src/computer-use/wakes/registry";
import type { WakeArmed, WakeArmRequest, WakeBackend, WakeBackendEvent } from "../../src/computer-use/wakes/types";
import type { HelperNotification } from "../../src/computer-use/protocol";

export interface FakeArmed { req: WakeArmRequest; onEvent: (e: WakeBackendEvent) => void }

export class FakeWakeBackend implements WakeBackend, WakeBackendHelperHooks {
  readonly armed = new Map<string, FakeArmed>();
  readonly requests: WakeArmRequest[] = [];
  readonly disarmed: string[] = [];
  readonly notifications: HelperNotification[] = [];
  disconnects = 0;
  /** What `arm` answers (a test may replace it). */
  answer: (req: WakeArmRequest) => WakeArmed = () => ({
    element: { role: "button", name: "Submit for review" },
    targetLabel: "Chrome — Developer Dashboard",
    rebind: 'browsers.tab("chrome:7")',
  });
  /** Thrown by the next arms (a backend's refusal: the condition is already true, a secure field, …). */
  refuse: AutomationFailure | undefined;
  /** Fire the trigger before `arm` resolves (a backend whose event races its own answer). */
  fireDuringArm = false;
  /** Arms that do not answer until `releaseHung()` (a backend that stopped answering). */
  hang = false;
  private readonly hung: Array<() => void> = [];

  async arm(req: WakeArmRequest, onEvent: (e: WakeBackendEvent) => void): Promise<WakeArmed> {
    this.requests.push(req);
    if (this.hang) await new Promise<void>((resolve) => this.hung.push(resolve));
    if (this.refuse !== undefined) throw this.refuse;
    this.armed.set(req.wakeId, { req, onEvent });
    if (this.fireDuringArm) this.fire(req.wakeId, "clicked");
    return this.answer(req);
  }

  disarm(wakeId: string): void {
    this.disarmed.push(wakeId);
    this.armed.delete(wakeId);
  }

  handleNotification(n: HelperNotification): void { this.notifications.push(n); }
  helperDisconnected(): void { this.disconnects++; }

  /** The armed trigger most recently armed (or the named one). */
  private take(wakeId?: string): FakeArmed {
    const id = wakeId ?? [...this.armed.keys()].at(-1);
    const a = id === undefined ? undefined : this.armed.get(id);
    if (a === undefined) throw new Error(`no armed trigger ${wakeId ?? ""}`);
    this.armed.delete(a.req.wakeId);
    return a;
  }

  /** The user did it. */
  fire(wakeId?: string, detail?: string): string {
    const a = this.take(wakeId);
    a.onEvent({ wakeId: a.req.wakeId, outcome: "fired", at: Date.now(), ...(detail === undefined ? {} : { detail }) });
    return a.req.wakeId;
  }

  /** The target went. */
  lose(wakeId?: string, reason = "the tab was closed"): string {
    const a = this.take(wakeId);
    a.onEvent({ wakeId: a.req.wakeId, outcome: "lost", at: Date.now(), reason });
    return a.req.wakeId;
  }

  /** The session's tabs closed: every trigger of it still armed HERE reports `lost` (as a real tab backend does when the
   *  engine closes the tab it watches). Returns the ids it reported. */
  loseSession(sessionId: string, reason = "the tab was closed"): string[] {
    return [...this.armed.values()].filter((a) => a.req.sessionId === sessionId).map((a) => this.lose(a.req.wakeId, reason));
  }

  /** Let every hung arm answer now (late: the registry may have given up on it). */
  releaseHung(): void { for (const r of this.hung.splice(0)) r(); }
}

/** A backend's refusal of a STATE condition already true at arm (the controller's ruling, 2026-10-12). */
export const alreadyTrue = (what: string): AutomationFailure =>
  new AutomationFailure("NotAllowed", `${what} — nothing to wait for; check state()`);
