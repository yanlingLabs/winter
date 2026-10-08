// ComputerV2 (2026-10-08) — WHO may do WHAT to which app. The daemon is the single point of policy (spec §2.1);
// the helper enforces only its hard floors, and those are enforced here as well, so a bug in one does not open
// them. Rulings R16/R17/R19, spec §13, spine §5:
//
//   policy                 bind (apps.open, screen.appAt)                   act (click, type, key, …)
//   plan                   the per-APP card (then observe only)             NotAllowed
//   ask / accept-edits /   the per-APP card                                 the same card, if the app holds no
//   auto                   (once / this session / always; deny = refuse)    grant for this call
//   bypass                 no card                                          no card
//   dont-ask               only an "Always allow" app (no card)             only an "Always allow" app
//
// (the controller's rulings after the daemon review: per-app consent covers BINDING, not only acting.) Observing
// an app this call may already use (state, find, screenshot, waits) needs no second card. And, under EVERY
// policy (bypass included): the floors (Winter never controls itself; the system's authentication dialogs, the
// login window and Keychain Access are refused) and the user's per-app setting — `deny` (never bound), `view`
// (observe only), `click` (click, scroll and AX actions only), `full`. A known password manager with no setting
// reads as `deny` (spine §5 — the helper does not enforce this; the daemon does).
//
// The card is DAEMON-RAISED mid-script, not a `canUseTool` card: `buildLeasePolicy`'s wait-before-emit shape
// with a `cu_<hex>` call id, `toolName: "ComputerV2"`, a summary that names the BUNDLE ID (a look-alike app
// cannot borrow a trusted name), options with no `rule` (so `approval.respond` persists nothing — `always` is
// this module's own `computerUse.apps.<id>.grant` write). A dispatch child's card rides the existing mirror to
// its coordinator, bounded like every relayed card (`dispatchChildCardTimeoutMs`). A Dispatch COORDINATOR raises
// these cards too — an exception to "Dispatch never prompts", like a connector's card.
//
// RUNG 4 (the foreground: the user's real pointer) ALWAYS needs its own card — "Winter needs to bring <App> to
// the front and use your mouse for a moment" — under every policy that can card, `bypass` included; `dont-ask`
// (which never cards) and `plan` (which never acts) refuse it, and so does a session nobody is watching from
// the Mac (`attended`: a Mac or terminal harness on the session itself — never the phone, never the Dispatch
// pill alone).
import { randomBytes } from "node:crypto";
import type { ApprovalOption, NewSessionEvent } from "@yanlinglabs/winter-protocol";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { ApprovalBroker } from "../agent/approvals";
import { dispatchChildCardTimeoutMs } from "../runtime-sdk/approval-bridge";
import { NO_PARK_TIMEOUT_MS } from "../runtime-sdk/bridge-common";
import type { SessionMode } from "../runtime-sdk/create";
import { computerUseAppsFrom, type ComputerUseAccess, type Settings } from "../settings";
import { AutomationFailure } from "./errors";
import { WINTER_OWN_BUNDLE_IDS } from "./protocol";

export const COMPUTER_V2_TOOL_NAME = "ComputerV2";

/** The primitives that ACT on an app (everything else observes). */
export const ACT_PRIMITIVES: ReadonlySet<string> = new Set(["click", "setValue", "type", "paste", "key", "scroll", "drag", "select", "action", "menu"]);
/** What a `click`-only app still permits (R17): clicks, scrolls and accessibility actions. */
export const CLICK_ONLY_PRIMITIVES: ReadonlySet<string> = new Set(["click", "scroll", "action"]);

/** The system's authentication surfaces — refused as targets (spec §13.3; the helper refuses them too). */
export const AUTH_DIALOG_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.keychainaccess", "com.apple.UserNotificationCenter",
  "com.apple.coreservices.uiagent", "com.apple.authorizationhost",
]);

/** Password managers (spine §5, after the Swift review): `access: "deny"` until the user sets an access for one
 *  in `computerUse.apps` (spec §13.3 — the helper does not enforce this; the daemon does). Bundle id → name. */
export const PASSWORD_MANAGERS: Readonly<Record<string, string>> = {
  "com.1password.1password": "1Password",
  "com.agilebits.onepassword7": "1Password 7",
  "com.bitwarden.desktop": "Bitwarden",
  "com.dashlane.dashlanephonefinal": "Dashlane",
  "com.dashlane.Dashlane": "Dashlane",
  "com.lastpass.LastPass": "LastPass",
  "org.keepassxc.keepassxc": "KeePassXC",
  "me.proton.pass.electron": "Proton Pass",
  "in.sinew.Enpass-Desktop": "Enpass",
  "com.apple.Passwords": "Passwords",
};
export const PASSWORD_MANAGER_BUNDLE_IDS: ReadonlySet<string> = new Set(Object.keys(PASSWORD_MANAGERS));

export const APP_CARD_OPTIONS: readonly ApprovalOption[] = [
  { id: "once", label: "Allow once" },
  { id: "session", label: "Allow for this session" },
  { id: "always", label: "Always allow" },
];
export const FOREGROUND_CARD_OPTIONS: readonly ApprovalOption[] = [{ id: "once", label: "Allow once" }];

/** "Allow Winter to use Notes (com.apple.Notes)?" — the bundle id is part of the question (the ruling). */
export function appCardSummary(app: AppRef): string {
  return `Allow Winter to use ${app.name} (${app.bundleId})?`;
}

/** The rung-4 card's question. */
export function foregroundCardSummary(app: AppRef): string {
  return `Winter needs to bring ${app.name} (${app.bundleId}) to the front and use your mouse for a moment`;
}

export interface SessionFacts {
  policy: SessionApprovalPolicy;
  mode: SessionMode;
  origin?: string;
  parentSessionId?: string;
}

export interface ComputerPolicyDeps {
  /** The live settings (with a just-written grant already applied — the service's `noteWritten` overlay). */
  settings(): Settings | null | undefined;
  /** Persist `computerUse.apps.<bundleId>.grant = "always"` (and the app's name). */
  saveAlwaysGrant(bundleId: string, name: string): void;
  approvals: ApprovalBroker;
  emit(sessionId: string, event: NewSessionEvent): void;
  session(sessionId: string): SessionFacts;
  /** Who started the running turn (a dispatch child's relayed card is bounded unless a human did). */
  turnOrigin?(sessionId: string): string | undefined;
  /** Is someone at the Mac looking at THIS session — a Mac window or a terminal attached to it? The phone does
   *  not count, and neither does the Dispatch pill alone (`wiring.ts`). */
  attended(sessionId: string): boolean;
  now?(): number;
  log?(line: string): void;
}

export interface AppRef { bundleId: string; name: string }

/** Per-SCRIPT grant state: an "Allow once" covers exactly this one ComputerV2 call. */
export interface RunGrants {
  sessionId: string;
  once: Set<string>;
  denied: Set<string>;
  /** A card already on screen for an app (concurrent primitives of one script share it). */
  cards: Map<string, Promise<boolean>>;
  /** Called with `true` while a card waits for a human (the service pauses the script's timeout). */
  onCardWait?(waiting: boolean): void;
}

export function newRunGrants(sessionId: string, onCardWait?: (waiting: boolean) => void): RunGrants {
  return { sessionId, once: new Set(), denied: new Set(), cards: new Map(), ...(onCardWait === undefined ? {} : { onCardWait }) };
}

export class ComputerPolicy {
  /** "Allow for this session" grants, in memory, per session. */
  private readonly sessionGrants = new Map<string, Set<string>>();

  constructor(private readonly deps: ComputerPolicyDeps) {}

  /** The user's restriction for an app: their setting, else `deny` for a password manager, else `full`. */
  accessFor(bundleId: string): ComputerUseAccess {
    const row = computerUseAppsFrom(this.deps.settings())[bundleId];
    if (row?.access !== undefined) return row.access;
    return PASSWORD_MANAGER_BUNDLE_IDS.has(bundleId) ? "deny" : "full";
  }

  hasAlwaysGrant(bundleId: string): boolean {
    return computerUseAppsFrom(this.deps.settings())[bundleId]?.grant === "always";
  }

  hasSessionGrant(sessionId: string, bundleId: string): boolean {
    return this.sessionGrants.get(sessionId)?.has(bundleId) === true;
  }

  /** The session is GONE (deleted, or the daemon stops): its "Allow for this session" grants go with it. A
   *  worker's idle end does not call this — the grants live as long as the session. */
  clearSession(sessionId: string): void { this.sessionGrants.delete(sessionId); }

  /** The user removed an app's "Always allow": no session keeps the grant its card left behind either. */
  forgetGrant(bundleId: string): void {
    for (const grants of this.sessionGrants.values()) grants.delete(bundleId);
  }

  /** The bundle ids a whole-screen shot must black out: Winter's own apps and every `deny` app. */
  excludedFromScreen(): string[] {
    const out = new Set<string>(WINTER_OWN_BUNDLE_IDS);
    for (const [id, row] of Object.entries(computerUseAppsFrom(this.deps.settings()))) if (row.access === "deny") out.add(id);
    for (const id of PASSWORD_MANAGER_BUNDLE_IDS) if (this.accessFor(id) === "deny") out.add(id);
    return [...out];
  }

  /** The floors — the same under every policy and every setting. Throws `Refused`. */
  checkFloors(app: AppRef): void {
    if (WINTER_OWN_BUNDLE_IDS.includes(app.bundleId)) {
      throw new AutomationFailure("Refused", "Winter never controls itself (Winter and Winter Computer Use are off limits)");
    }
    if (AUTH_DIALOG_BUNDLE_IDS.has(app.bundleId)) {
      throw new AutomationFailure("Refused", `${app.name} is a system authentication surface — Winter never controls it; ask the user to handle it`);
    }
  }

  /**
   * May this script `bind` the app, or `act` on it with `primitive`? Raises the per-app card when the policy
   * asks for one. Throws `NotAllowed` / `Refused`; resolves when allowed.
   */
  async authorize(run: RunGrants, app: AppRef, purpose: { kind: "bind" } | { kind: "act"; primitive: string } | { kind: "observe" }, signal?: AbortSignal): Promise<void> {
    this.checkFloors(app);
    const access = this.accessFor(app.bundleId);
    if (access === "deny") {
      throw new AutomationFailure("NotAllowed", `${app.name} is set to Don't allow in Settings → Computer Use — ask the user if you need it`);
    }
    const facts = this.deps.session(run.sessionId);
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    if (purpose.kind === "observe") return;
    if (purpose.kind === "act") {
      if (access === "view") throw new AutomationFailure("NotAllowed", `${app.name} is set to view only in Settings → Computer Use — you can look but not act`);
      if (access === "click" && !CLICK_ONLY_PRIMITIVES.has(purpose.primitive)) {
        throw new AutomationFailure("NotAllowed", `${app.name} is set to click only in Settings → Computer Use — clicks, scrolls and element actions work, ${purpose.primitive} does not`);
      }
    }
    switch (facts.policy) {
      case "bypass":
        return;
      case "plan":
        if (purpose.kind === "act") throw new AutomationFailure("NotAllowed", "this session is in plan mode — ComputerV2 can look but not act");
        break; // binding still asks: per-app consent covers binding (the controller's ruling)
      case "dont-ask":
        if (!this.hasAlwaysGrant(app.bundleId)) {
          throw new AutomationFailure("NotAllowed", `${app.name} has no "Always allow" grant, and this session never asks (don't ask) — the user can allow it in Settings → Computer Use`);
        }
        return;
      default:
        break;
    }
    // plan (bind) / ask / accept-edits / auto: one card per app (R16, and under auto too — R19).
    if (this.hasAlwaysGrant(app.bundleId) || this.hasSessionGrant(run.sessionId, app.bundleId) || run.once.has(app.bundleId)) return;
    if (run.denied.has(app.bundleId)) throw this.declined(app);
    let card = run.cards.get(app.bundleId);
    if (card === undefined) {
      card = this.appCard(run, app, signal).finally(() => run.cards.delete(app.bundleId));
      run.cards.set(app.bundleId, card);
    }
    if (!(await card)) throw this.declined(app);
  }

  /**
   * Does the app stay usable AFTER this call (`once` covers the call — the controller's ruling)? True under
   * `bypass`, for an "Always allow" app and for one granted for this session; false for an app this call used on
   * an "Allow once" answer, whose targets the service releases when the call ends.
   */
  persistentlyAllowed(sessionId: string, bundleId: string): boolean {
    let policy: SessionFacts["policy"];
    try { policy = this.deps.session(sessionId).policy; } catch { return false; }
    return policy === "bypass" || this.hasAlwaysGrant(bundleId) || this.hasSessionGrant(sessionId, bundleId);
  }

  private declined(app: AppRef): AutomationFailure {
    return new AutomationFailure("NotAllowed", `The user did not allow Winter to use ${app.name}. Don't retry — ask the user what to do instead.`);
  }

  /** The per-app card. Resolves `true` when allowed (recording the grant), `false` otherwise. */
  private async appCard(run: RunGrants, app: AppRef, signal?: AbortSignal): Promise<boolean> {
    // The bundle id is part of the question: a look-alike app cannot borrow a trusted name (the ruling).
    const res = await this.card(run, appCardSummary(app), APP_CARD_OPTIONS, signal);
    if (!res.approved) {
      if (res.human) run.denied.add(app.bundleId);
      return false;
    }
    switch (res.optionId) {
      case "always":
        try { this.deps.saveAlwaysGrant(app.bundleId, app.name); } catch (err) {
          // The answer still holds for this session; only its persistence failed.
          this.deps.log?.(`computer-use: the "Always allow" grant for ${app.bundleId} was not saved (${err instanceof Error ? err.message : "error"}) — kept for this session`);
        }
        this.grantSession(run.sessionId, app.bundleId);
        break;
      case "session":
        this.grantSession(run.sessionId, app.bundleId);
        break;
      default:
        // "once", or a plain approve with no option (a client that does not render options): this call only.
        run.once.add(app.bundleId);
    }
    return true;
  }

  private grantSession(sessionId: string, bundleId: string): void {
    let s = this.sessionGrants.get(sessionId);
    if (s === undefined) { s = new Set(); this.sessionGrants.set(sessionId, s); }
    s.add(bundleId);
  }

  /**
   * RUNG 4: may Winter bring the app to the front and use the real pointer for this action? `false` means
   * "refuse with `NeedsForeground`" (the caller words it).
   */
  async allowForeground(run: RunGrants, app: AppRef, signal?: AbortSignal): Promise<boolean> {
    const facts = this.deps.session(run.sessionId);
    // Taking the user's real pointer ALWAYS needs explicit consent — a card under every policy that can card,
    // `bypass` included (the controller's ruling). `dont-ask` never cards and `plan` never acts.
    if (facts.policy === "dont-ask" || facts.policy === "plan" || facts.policy === "chat" || facts.mode === "chat") return false;
    if (!this.deps.attended(run.sessionId)) return false;
    const res = await this.card(run, foregroundCardSummary(app), FOREGROUND_CARD_OPTIONS, signal);
    return res.approved;
  }

  /** Raise one daemon-side approval card and wait for it (wait-before-emit, like `buildLeasePolicy`). */
  private async card(run: RunGrants, summary: string, options: readonly ApprovalOption[], signal?: AbortSignal): Promise<{ approved: boolean; optionId?: string; human: boolean }> {
    const { sessionId } = run;
    if (signal?.aborted) return { approved: false, human: false };
    const facts = this.deps.session(sessionId);
    const callId = `cu_${randomBytes(6).toString("hex")}`;
    // A relayed dispatch child's card is bounded (its coordinator's prompt promises the user an auto-deny),
    // unless the user started the turn in the child; every other card waits for its human (P8b-19).
    const parkMs = dispatchChildCardTimeoutMs({
      mode: facts.mode, ...(facts.origin === undefined ? {} : { origin: facts.origin }),
      turnOrigin: () => this.deps.turnOrigin?.(sessionId),
    }) ?? NO_PARK_TIMEOUT_MS;
    const issuedAt = (this.deps.now ?? Date.now)();
    const expiresAt = issuedAt + parkMs;
    const opts = options.map((o) => ({ ...o }));
    const waiting = this.deps.approvals.wait(sessionId, callId, parkMs, { toolName: COMPUTER_V2_TOOL_NAME, summary, issuedAt, expiresAt, options: opts });
    try {
      this.deps.emit(sessionId, { type: "approval_requested", sessionId, threadId: "main", callId, toolName: COMPUTER_V2_TOOL_NAME, summary, issuedAt, expiresAt, options: opts } as NewSessionEvent);
    } catch (err) {
      this.deps.approvals.resolve(sessionId, callId, false, "emit-failure");
      await waiting;
      this.deps.log?.(`computer-use: could not raise a card for ${sessionId}: ${err instanceof Error ? err.message : "error"}`);
      return { approved: false, human: false };
    }
    const onAbort = (): void => { this.deps.approvals.resolve(sessionId, callId, false, "aborted"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    run.onCardWait?.(true);
    let res: { approved: boolean; by: string; optionId?: string };
    try {
      res = await waiting;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      run.onCardWait?.(false);
    }
    try {
      this.deps.emit(sessionId, { type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by } as NewSessionEvent);
    } catch { /* the outcome stands */ }
    const machine = res.by === "timeout" || res.by === "aborted" || res.by === "emit-failure" || res.by === "superseded";
    return { approved: res.approved, ...(res.optionId === undefined ? {} : { optionId: res.optionId }), human: !machine };
  }
}
