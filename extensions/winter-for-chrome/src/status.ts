// Winter for Chrome — what the toolbar button says and does. Idle: whether Winter can use this browser (a "!" badge
// whenever it cannot; the popup and the tooltip say why). While Winter is driving any tab: the button IS Stop — a red
// "STOP" badge, no popup, and a click stops Winter in every driven tab (the controller's `stopDriven`). Stop lives here,
// in the browser's own toolbar, because nothing a page shows can be trusted to be Winter's. While Winter WAITS on a tab
// it handed to the user (a sign-in), the button stays the popup — its Done for that tab first, and Stop as a button
// there when Winter is also driving other tabs — so the user's click never stops another task instead of answering.
import type { ChromeApi } from "./chrome-api";
import { PRODUCT_NAME } from "./product";

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
    case "unverified": return `The Winter on this Mac could not be verified, so ${PRODUCT_NAME} is not talking to it.`;
    case "refused": return s.message;
    case "mismatch": return s.message === "update Winter" ? `This Winter is older than ${PRODUCT_NAME} — update Winter.` : `${PRODUCT_NAME} is too old for this Winter — update ${PRODUCT_NAME}.`;
    case "unavailable": return s.message;
  }
}

export const STOP_BADGE = "STOP";

/** A second client's link (opensky): what the popup shows under its switch. It never touches the toolbar badge, which
 *  stays Winter's — except for Stop, which `StatusBoard.setDriven` counts for every client. */
export class ClientLink {
  private current: ExtensionStatus | undefined;

  constructor(readonly name: string) {}

  /** Undefined while the user has not allowed the client (its port is never opened). */
  get(): ExtensionStatus | undefined {
    return this.current;
  }

  set(next: ExtensionStatus): void {
    this.current = next;
  }

  clear(): void {
    this.current = undefined;
  }

  /** One sentence for the popup. */
  sentence(): string {
    const s = this.current;
    if (s === undefined) return `Off — ${this.name} can't use this browser.`;
    switch (s.state) {
      case "connecting": return `Connecting to ${this.name}…`;
      case "connected": return `Connected to ${this.name}.`;
      case "host-missing": return `${this.name} isn't installed on this Mac, or this browser can't find it yet.`;
      case "no-daemon": return `${this.name} isn't running.`;
      case "unverified": return `The ${this.name} on this Mac could not be verified, so ${PRODUCT_NAME} is not talking to it.`;
      case "mismatch": return `${this.name} and ${PRODUCT_NAME} don't speak the same version — update the older one.`;
      case "refused": case "unavailable": return s.message;
    }
  }
}

export class StatusBoard {
  private current: ExtensionStatus = { state: "connecting" };
  private driven = 0;
  /** Driven tabs per client ("Winter", and opensky when it is allowed): the toolbar's Stop names who it stops. */
  private drivenBy = new Map<string, number>();
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

  /** How many tabs a client (Winter by default) is driving now. More than none, from any client, turns the toolbar
   *  button into Stop — and its click stops every client's driven tabs. */
  setDriven(count: number, client = "Winter"): void {
    if ((this.drivenBy.get(client) ?? 0) === count) return;
    if (count === 0) this.drivenBy.delete(client);
    else this.drivenBy.set(client, count);
    this.driven = [...this.drivenBy.values()].reduce((a, b) => a + b, 0);
    this.render();
  }

  /** Who is driving now, in the order they started ("Winter", "Winter and opensky"). */
  drivers(): string {
    const names = [...this.drivenBy.keys()];
    return names.length === 0 ? "Winter" : names.join(" and ");
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
    if (this.driven > 0 && this.waiting === 0) {
      void this.chrome.action.setPopup({ popup: "" }).catch(() => undefined);
      void this.chrome.action.setBadgeText({ text: STOP_BADGE }).catch(() => undefined);
      void this.chrome.action.setBadgeBackgroundColor({ color: "#c62828" }).catch(() => undefined);
      const who = this.drivers();
      const pronoun = this.drivenBy.size > 1 ? "they are" : "it is";
      void this.chrome.action.setTitle({ title: `Stop ${who} — ${pronoun} working in ${this.driven === 1 ? "a tab" : `${this.driven} tabs`} of this browser` }).catch(() => undefined);
      return;
    }
    const ok = this.current.state === "connected";
    void this.chrome.action.setPopup({ popup: "popup.html" }).catch(() => undefined);
    if (this.waiting > 0) {
      void this.chrome.action.setBadgeText({ text: "!" }).catch(() => undefined);
      void this.chrome.action.setBadgeBackgroundColor({ color: "#3b6fd8" }).catch(() => undefined);
      void this.chrome.action.setTitle({ title: this.driven > 0
        ? "Winter is waiting for you — open this menu when you're done (Stop Winter is there too)"
        : "Winter is waiting for you — open this menu when you're done" }).catch(() => undefined);
      return;
    }
    void this.chrome.action.setBadgeText({ text: (ok || this.current.state === "connecting") && this.needs === 0 ? "" : "!" }).catch(() => undefined);
    void this.chrome.action.setBadgeBackgroundColor({ color: "#d9822b" }).catch(() => undefined);
    void this.chrome.action.setTitle({ title: this.needs > 0 && ok
      ? `${PRODUCT_NAME} — Winter asked for something this browser hasn't allowed yet: open this menu`
      : `${PRODUCT_NAME} — ${statusSentence(this.current)}` }).catch(() => undefined);
  }
}
