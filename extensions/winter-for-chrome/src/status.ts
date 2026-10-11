// Winter for Chrome — what the toolbar button says and does. Idle: whether Winter can use this browser (a "!" badge
// whenever it cannot; the popup and the tooltip say why). While Winter is driving any tab: the button IS Stop — a red
// "STOP" badge, no popup, and a click stops Winter in every driven tab (the controller's `stopDriven`). Stop lives here,
// in the browser's own toolbar, because nothing a page shows can be trusted to be Winter's.
import type { ChromeApi } from "./chrome-api";

export type ExtensionStatus =
  | { state: "connecting" }
  | { state: "connected"; backend: { id: string; name: string } }
  | { state: "host-missing"; detail?: string }
  | { state: "no-daemon" }
  | { state: "unverified" }
  | { state: "refused"; message: string }
  | { state: "mismatch"; message: string }
  | { state: "unavailable"; message: string };

export function statusSentence(s: ExtensionStatus): string {
  switch (s.state) {
    case "connecting": return "Connecting to Winter…";
    case "connected": return `Connected to Winter (${s.backend.name}).`;
    case "host-missing": return "Winter isn't installed on this Mac, or this browser can't find it yet. Install Winter, then restart the browser.";
    case "no-daemon": return "Winter isn't running.";
    case "unverified": return "The Winter on this Mac could not be verified, so Winter for Chrome is not talking to it.";
    case "refused": return s.message;
    case "mismatch": return s.message === "update Winter" ? "This Winter is older than Winter for Chrome — update Winter." : "Winter for Chrome is too old for this Winter — update Winter for Chrome.";
    case "unavailable": return s.message;
  }
}

export const STOP_BADGE = "STOP";

export class StatusBoard {
  private current: ExtensionStatus = { state: "connecting" };
  private driven = 0;
  private waiting = 0;
  private needs = 0;

  constructor(private readonly chrome: ChromeApi) {}

  get(): ExtensionStatus {
    return this.current;
  }

  drivenTabs(): number {
    return this.driven;
  }

  set(next: ExtensionStatus): void {
    this.current = next;
    this.render();
  }

  /** How many tabs Winter is driving now. More than none turns the toolbar button into Stop. */
  setDriven(count: number): void {
    if (count === this.driven) return;
    this.driven = count;
    this.render();
  }

  /** How many tabs Winter handed to the user and waits on (a blue "!" badge; the popup offers Done). */
  setWaiting(count: number): void {
    if (count === this.waiting) return;
    this.waiting = count;
    this.render();
  }

  /** How many optional permissions Winter asked for and lacks (a "!" until the user decides in the popup). */
  setNeeds(count: number): void {
    if (count === this.needs) return;
    this.needs = count;
    this.render();
  }

  private render(): void {
    // Best effort throughout: the action may not be ready while the worker starts.
    if (this.driven > 0) {
      void this.chrome.action.setPopup({ popup: "" }).catch(() => undefined);
      void this.chrome.action.setBadgeText({ text: STOP_BADGE }).catch(() => undefined);
      void this.chrome.action.setBadgeBackgroundColor({ color: "#c62828" }).catch(() => undefined);
      void this.chrome.action.setTitle({ title: `Stop Winter — it is working in ${this.driven === 1 ? "a tab" : `${this.driven} tabs`} of this browser` }).catch(() => undefined);
      return;
    }
    const ok = this.current.state === "connected";
    void this.chrome.action.setPopup({ popup: "popup.html" }).catch(() => undefined);
    if (this.waiting > 0) {
      void this.chrome.action.setBadgeText({ text: "!" }).catch(() => undefined);
      void this.chrome.action.setBadgeBackgroundColor({ color: "#3b6fd8" }).catch(() => undefined);
      void this.chrome.action.setTitle({ title: "Winter is waiting for you — open this menu when you're done" }).catch(() => undefined);
      return;
    }
    void this.chrome.action.setBadgeText({ text: (ok || this.current.state === "connecting") && this.needs === 0 ? "" : "!" }).catch(() => undefined);
    void this.chrome.action.setBadgeBackgroundColor({ color: "#d9822b" }).catch(() => undefined);
    void this.chrome.action.setTitle({ title: this.needs > 0 && ok
      ? "Winter for Chrome — Winter asked for something this browser hasn't allowed yet: open this menu"
      : `Winter for Chrome — ${statusSentence(this.current)}` }).catch(() => undefined);
  }
}
