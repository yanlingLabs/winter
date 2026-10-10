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
    void this.chrome.action.setBadgeText({ text: ok || this.current.state === "connecting" ? "" : "!" }).catch(() => undefined);
    void this.chrome.action.setBadgeBackgroundColor({ color: "#d9822b" }).catch(() => undefined);
    void this.chrome.action.setTitle({ title: `Winter for Chrome — ${statusSentence(this.current)}` }).catch(() => undefined);
  }
}
