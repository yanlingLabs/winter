// Winter for Chrome — what the toolbar button says: connected to Winter, or why not (the badge shows "!" whenever it is
// not connected, the tooltip and the popup the sentence).
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

export class StatusBoard {
  private current: ExtensionStatus = { state: "connecting" };

  constructor(private readonly chrome: ChromeApi) {}

  get(): ExtensionStatus {
    return this.current;
  }

  set(next: ExtensionStatus): void {
    this.current = next;
    const ok = next.state === "connected";
    // Best effort: the action may not be ready while the worker starts.
    void this.chrome.action.setBadgeText({ text: ok || next.state === "connecting" ? "" : "!" }).catch(() => undefined);
    void this.chrome.action.setBadgeBackgroundColor({ color: "#d9822b" }).catch(() => undefined);
    void this.chrome.action.setTitle({ title: `Winter for Chrome — ${statusSentence(next)}` }).catch(() => undefined);
  }
}
