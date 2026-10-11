// ComputerV2 (2026-10-08) — WHO may do WHAT to which app. The daemon is the single point of policy (spec §2.1);
// the helper enforces only its hard floors, and those are enforced here as well, so a bug in one does not open
// them. Rulings R16/R17/R19, spec §13, spine §5:
//
//   policy                 bind (apps.open, screen.appAt)                   act (click, type, key, …)       rung 4
//   plan                   the per-APP card (then observe only)             NotAllowed                     refused
//   ask / accept-edits /   the per-APP card                                 the same card, if the app      its own card
//   auto                   (once / this session / always; deny = refuse)    holds no grant for this call   (attended only)
//   bypass                 no card                                          no card                        no card
//   dont-ask               only an "Always allow" app (no card)             only an "Always allow" app     refused
//
// (the controller's rulings after the daemon review: per-app consent covers BINDING, not only acting.) Observing
// an app this call may already use (state, find, screenshot, waits) needs no second card. And, under EVERY
// policy (bypass included): the floors (Winter never controls itself; the system's authentication dialogs, the
// login window and Keychain Access are refused) and the app's EFFECTIVE access — `deny` (never bound), `view`
// (observe only), `click` (click, scroll and AX actions only), `full`. Effective access is the user ruling's
// "master switch plus exceptions" (`effectiveAppAccess`): the user's own exception for the app; else, if they
// REMOVED its built-in default, the master switch; else the built-in default exception (`DEFAULT_APP_EXCEPTIONS`:
// password managers `deny`, terminals and System Settings `click`); else the master switch
// (`computerUse.allowAllApps`, default on: `full`; off: `deny`). The helper enforces none of this; the daemon does.
//
// The card is DAEMON-RAISED mid-script, not a `canUseTool` card: `buildLeasePolicy`'s wait-before-emit shape
// with a `cu_<hex>` call id, `toolName: "ComputerV2"`, a summary that names the BUNDLE ID (a look-alike app
// cannot borrow a trusted name), options with no `rule` (so `approval.respond` persists nothing — `always` is
// this module's own `computerUse.apps.<id>.grant` write). A dispatch child's card rides the existing mirror to
// its coordinator, bounded like every relayed card (`dispatchChildCardTimeoutMs`). A Dispatch COORDINATOR raises
// these cards too — an exception to "Dispatch never prompts", like a connector's card.
//
// RUNG 4 (the foreground: the user's real pointer) needs its own card under `ask`/`accept-edits`/`auto` —
// "Winter needs to bring <App> to the front and use your mouse for a moment" — and a session nobody is watching
// from the Mac (`attended`: a Mac or terminal harness on the session itself — never the phone, never the Dispatch
// pill alone) is refused it. `bypass` shows NO computer-use prompt at all (the user ruling at the live gate,
// reversing the earlier controller ruling): rung 4 is allowed at once, attended or not. `dont-ask` (which never
// cards) and `plan` (which never acts) refuse it. The app restrictions, the default exceptions and the floors
// still hold under `bypass` — they are checked before any action reaches rung 4.
//
// THE DESKTOP SWITCH (user ruling 2026-10-10): when an act, or a LIVE picture (`screenshot({ live: true, reason })`),
// cannot be had without moving the user to the window's desktop (Space) — the helper says so (`needs_desktop_visit`)
// only after every background route — EVERY policy (plan, dont-ask, ask, accept-edits, auto, bypass; a Dispatch
// coordinator too) asks first, in two places at once: the session's card (`approval_requested` with
// `onTimeout: "allow"`) and the helper's own on-screen panel on the user's current desktop. The first answer from
// either resolves both. It lasts `DESKTOP_VISIT_PROMPT_MS` (60 s): refused → `NeedsForeground`; no answer →
// ALLOWED (default-allow, attended or not; the resolution says `by: "timeout"`). A dispatch child's card rides the
// mirror like its other cards. The floors and the app's effective access still apply first (a `deny` app is never
// bound; a `view`/`click` app never reaches the act that would need it — a live read under `view` may ask).
import { randomBytes } from "node:crypto";
import type { ApprovalOption, NewSessionEvent } from "@yanlinglabs/winter-protocol";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { ApprovalBroker } from "../agent/approvals";
import { dispatchChildCardTimeoutMs } from "../runtime-sdk/approval-bridge";
import { NO_PARK_TIMEOUT_MS } from "../runtime-sdk/bridge-common";
import type { SessionMode } from "../runtime-sdk/create";
import { computerUseAllowAllAppsFrom, computerUseAppsFrom, type ComputerUseAccess, type ComputerUseAppSetting, type Settings } from "../settings";
import { AutomationFailure } from "./errors";
import { WINTER_OWN_BUNDLE_IDS } from "./protocol";

export const COMPUTER_V2_TOOL_NAME = "ComputerV2";

/** The primitives that ACT on an app (everything else observes). */
export const ACT_PRIMITIVES: ReadonlySet<string> = new Set(["click", "setValue", "type", "paste", "key", "scroll", "drag", "select", "action", "menu", "hover", "applescript",
  "goto", "upload", "back", "forward", "reload", "keep", "handoff", "close"]);
/** What a `click`-only app still permits (R17): clicks, scrolls and accessibility actions — and, on a browser's tab,
 *  its history moves, a reload, keeping, handing over or closing a tab Winter opened. */
export const CLICK_ONLY_PRIMITIVES: ReadonlySet<string> = new Set(["click", "scroll", "action", "hover", "back", "forward", "reload", "keep", "handoff", "close"]);

/** The system's authentication surfaces — refused as targets (spec §13.3; the helper refuses them too). */
export const AUTH_DIALOG_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.SecurityAgent", "com.apple.loginwindow", "com.apple.keychainaccess", "com.apple.UserNotificationCenter",
  "com.apple.coreservices.uiagent", "com.apple.authorizationhost",
]);

/** Password managers (spine §5, after the Swift review): a built-in `deny` exception (spec §13.3 — the helper does
 *  not enforce this; the daemon does). Bundle id → name. */
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

/** Terminals: a built-in `click` exception — a script may click and scroll in one but never type a command into
 *  it. Bundle id → name. */
export const TERMINALS: Readonly<Record<string, string>> = {
  "com.apple.Terminal": "Terminal",
  "com.googlecode.iterm2": "iTerm",
  "dev.warp.Warp-Stable": "Warp",
  "com.mitchellh.ghostty": "Ghostty",
  "net.kovidgoyal.kitty": "kitty",
  "org.alacritty": "Alacritty",
  "com.github.wez.wezterm": "WezTerm",
};

/**
 * The BUILT-IN per-app exceptions (the user ruling at the live gate): they apply whatever the master switch says,
 * until the user changes one (`computerUse.apps.<id>.access`) or removes it (`computerUse.apps.<id>.removed`).
 * Password managers `deny`, terminals and System Settings `click`. Bundle id → its default access and name.
 */
export const DEFAULT_APP_EXCEPTIONS: Readonly<Record<string, { access: ComputerUseAccess; name: string }>> = Object.freeze({
  ...Object.fromEntries(Object.entries(PASSWORD_MANAGERS).map(([id, name]) => [id, { access: "deny" as const, name }])),
  ...Object.fromEntries(Object.entries(TERMINALS).map(([id, name]) => [id, { access: "click" as const, name }])),
  "com.apple.systempreferences": { access: "click", name: "System Settings" },
});

/** The built-in default exception for an app, if it has one (own keys only — a bundle id is user input). */
export function defaultAppException(bundleId: string): { access: ComputerUseAccess; name: string } | undefined {
  return Object.hasOwn(DEFAULT_APP_EXCEPTIONS, bundleId) ? DEFAULT_APP_EXCEPTIONS[bundleId] : undefined;
}

/** The user's own row for an app (own keys only), normalized by `computerUseAppsFrom`. */
export function appSettingFor(settings: Settings | null | undefined, bundleId: string): ComputerUseAppSetting | undefined {
  const apps = computerUseAppsFrom(settings);
  return Object.hasOwn(apps, bundleId) ? apps[bundleId] : undefined;
}

/** Where an app's effective access comes from: the user's exception, a built-in default exception, or the master
 *  switch (`computerUse.allowAllApps`). */
export type AccessSource = "user" | "default" | "switch";

/**
 * The app's EFFECTIVE access (the user ruling): the user row's access, if set; else, if the row has `removed: true`,
 * the global default; else the built-in default exception, if one exists; else the global default — `full` when
 * `computerUse.allowAllApps` is on (the default), `deny` when it is off. The ONE decision the policy, the
 * whole-screen exclusion and `computerUse.apps.list` share.
 */
export function effectiveAppAccess(settings: Settings | null | undefined, bundleId: string): { access: ComputerUseAccess; source: AccessSource } {
  const row = appSettingFor(settings, bundleId);
  if (row?.access !== undefined) return { access: row.access, source: "user" };
  const global: ComputerUseAccess = computerUseAllowAllAppsFrom(settings) ? "full" : "deny";
  if (row?.removed === true) return { access: global, source: "switch" };
  const builtIn = defaultAppException(bundleId);
  if (builtIn !== undefined) return { access: builtIn.access, source: "default" };
  return { access: global, source: "switch" };
}

export const APP_CARD_OPTIONS: readonly ApprovalOption[] = [
  { id: "once", label: "Allow once" },
  { id: "session", label: "Allow for this session" },
  { id: "always", label: "Always allow" },
];
export const FOREGROUND_CARD_OPTIONS: readonly ApprovalOption[] = [{ id: "once", label: "Allow once" }];
/** The desktop-switch card's one option — its primary button ("Switch now"; the deny reads "Don't switch"). A
 *  refusal is the plain `approved: false`, never an option (clients answer every option `approved: true`). */
export const DESKTOP_VISIT_OPTION_ID = "switch";
export const DESKTOP_VISIT_CARD_OPTIONS: readonly ApprovalOption[] = [{ id: DESKTOP_VISIT_OPTION_ID, label: "Switch now" }];
/** How long the desktop-switch prompt waits before it ALLOWS (the ruling: one minute). */
export const DESKTOP_VISIT_PROMPT_MS = 60_000;
/** After the prompt's deadline, how long an answer already on its way (a click racing the countdown) still counts
 *  as the user's before the daemon's own timer allows. The card and the panel show the deadline itself. */
export const DESKTOP_VISIT_GRACE_MS = 1_000;
/** The `by` of a desktop-switch card answered on the helper's on-screen panel. */
export const DESKTOP_PROMPT_BY = "desktop-prompt";

/** "Allow Winter to use Notes (com.apple.Notes)?" — the bundle id is part of the question (the ruling). */
export function appCardSummary(app: AppRef): string {
  return `Allow Winter to use ${cardName(app.name)} (${app.bundleId})?`;
}

/** An app's NAME as a card shows it: it comes from the app's own bundle, so it is cleaned like the model's reason —
 *  one line, no control or bidirectional-override characters, at most 80 characters. */
export function cardName(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  const capped = line.length <= 80 ? line : `${line.slice(0, 79)}…`;
  return capped.length > 0 ? capped : "this app";
}

/** The rung-4 card's question; with a `reason` (the script's `requestForeground`), for the rest of the script. Both
 *  are about THIS desktop: a window on another one is the desktop-switch prompt's (`desktopVisitCardSummary`). */
export function foregroundCardSummary(app: AppRef, reason?: string): string {
  const name = cardName(app.name);
  if (reason === undefined) return `Winter needs to bring ${name} (${app.bundleId}) to the front and use your mouse for a moment`;
  return `Winter asks to bring ${name} (${app.bundleId}) to the front and keep it there until this step ends: ${reason}`;
}

/** What needs the visit: an act (the primitive), or a live picture. */
export type DesktopVisitPurpose = { kind: "act"; primitive: string } | { kind: "live" };

/** The desktop-switch question. It names the app, its bundle id (a look-alike cannot borrow a trusted name), the
 *  KIND of thing needed and the reason — never screen text (a window title or an element name is data, and a
 *  permission prompt is the last place for it). `reason` is already one sanitized line (`cardReason`). */
export function desktopVisitCardSummary(app: AppRef, reason: string): string {
  const name = cardName(app.name);
  return `Switch to ${name}'s desktop for a moment? ${name} (${app.bundleId}) — ${reason}. `
    + "Winter brings you back right after; with no answer within a minute, it switches.";
}

/** The words an act's prompt gives as its reason: what it does and where (the script's `title`, when it has one, is
 *  the model's own words for the step). One line, at most 200 characters. */
export function desktopVisitActReason(app: AppRef, primitive: string, title?: string): string {
  const verb = ACT_VERBS[primitive] ?? "act";
  const why = title === undefined || title.trim().length === 0 ? "" : ` (${title})`;
  return cardReason(`to ${verb} in ${cardName(app.name)}, which it accepts only with its window on screen${why}`);
}

const ACT_VERBS: Readonly<Record<string, string>> = {
  click: "click", setValue: "set a value", type: "type", paste: "paste", key: "press keys", scroll: "scroll", drag: "drag",
  select: "select text", action: "use a control", menu: "choose a menu command", hover: "point at something",
};

/**
 * How a desktop-switch prompt ended: `allow`/`refuse` — a person answered (`via`: the session's `card`, or the
 * helper's on-screen `panel`); `timeout-allow` — nobody answered within the minute (allowed); `aborted` — the call was
 * cancelled (an interrupt, Esc); `unavailable` — the card could not be raised, so nobody was asked (never worded as
 * a refusal). `allowed` is the verdict.
 */
export interface DesktopVisitOutcome {
  allowed: boolean;
  answer: "allow" | "refuse" | "timeout-allow" | "aborted" | "unavailable";
  via: "card" | "panel" | "timeout" | "none";
}

/** The helper's on-screen half of the prompt (`prompt.desktopVisit`, wired in `wiring.ts`). `answer` settles with
 *  the panel's answer — `undefined` when it closed without one (cancelled, or the helper could not show it). */
export interface DesktopVisitPanel {
  show(p: { promptId: string; sessionId: string; app: string; bundleId: string; reason: string; timeoutMs: number; expiresAt: number }): {
    answer: Promise<"switch" | "refuse" | "expired" | undefined>;
    close(): void;
  };
}

/** The model's reason as a card shows it: one line, no control characters, at most 200 characters. */
export function cardReason(reason: string): string {
  const line = reason.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
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
  /** The helper's on-screen desktop-switch panel; absent → the card alone asks (tests, a helper not reachable). */
  desktopPanel?: DesktopVisitPanel;
  /** TEST SEAM: the desktop-switch prompt's wait (default `DESKTOP_VISIT_PROMPT_MS`, the ruling's minute). */
  desktopVisitPromptMs?: number;
  /** TEST SEAM: the grace past it (default `DESKTOP_VISIT_GRACE_MS`). */
  desktopVisitGraceMs?: number;
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
  /**
   * THE DESKTOP SWITCH, refused (user ruling 2026-10-10, 5a): a person's "Don't switch" for an app holds for that app
   * in that session until the USER next sends the session a message (a human-origin `user_message` — never
   * `messaging`, `dispatch` or `dispatch-wake`); for a dispatch child, the user's next message to the child OR to its
   * coordinator lifts it. A timeout-allow is not a refusal. In memory only: a daemon restart forgets them (fine —
   * the next visit simply asks again). Session id → bundle id → the coordinator whose message also lifts it.
   */
  private readonly desktopRefusals = new Map<string, Map<string, { coordinator?: string }>>();

  constructor(private readonly deps: ComputerPolicyDeps) {}

  /** The app's effective access (`effectiveAppAccess`, read live). */
  accessFor(bundleId: string): ComputerUseAccess {
    return effectiveAppAccess(this.deps.settings(), bundleId).access;
  }

  hasAlwaysGrant(bundleId: string): boolean {
    return appSettingFor(this.deps.settings(), bundleId)?.grant === "always";
  }

  hasSessionGrant(sessionId: string, bundleId: string): boolean {
    return this.sessionGrants.get(sessionId)?.has(bundleId) === true;
  }

  /** The session is GONE (deleted, or the daemon stops): its "Allow for this session" grants go with it. A
   *  worker's idle end does not call this — the grants live as long as the session. */
  clearSession(sessionId: string): void {
    this.sessionGrants.delete(sessionId);
    this.desktopRefusals.delete(sessionId);
  }

  /** The user refused (a person's "Don't switch", on the card or the on-screen panel) to be moved to `bundleId`'s
   *  desktop in this session: held until their next message (`liftDesktopRefusals`). */
  noteDesktopRefusal(sessionId: string, bundleId: string): void {
    let facts: SessionFacts | undefined;
    try { facts = this.deps.session(sessionId); } catch { facts = undefined; }
    let m = this.desktopRefusals.get(sessionId);
    if (m === undefined) { m = new Map(); this.desktopRefusals.set(sessionId, m); }
    m.set(bundleId, facts?.origin === "dispatch-child" && facts.parentSessionId !== undefined ? { coordinator: facts.parentSessionId } : {});
  }

  /** Does a refusal still hold for this app in this session? */
  desktopRefused(sessionId: string, bundleId: string): boolean {
    return this.desktopRefusals.get(sessionId)?.has(bundleId) === true;
  }

  /** The user sent `sessionId` a message (a HUMAN-origin one — the caller decides): every desktop-switch refusal of
   *  that session lifts, and every one of a dispatch child whose coordinator it is. */
  liftDesktopRefusals(sessionId: string): void {
    this.desktopRefusals.delete(sessionId);
    for (const [child, m] of this.desktopRefusals) {
      for (const [bundleId, r] of m) if (r.coordinator === sessionId) m.delete(bundleId);
      if (m.size === 0) this.desktopRefusals.delete(child);
    }
  }

  /** The user removed an app's "Always allow": no session keeps the grant its card left behind either. */
  forgetGrant(bundleId: string): void {
    for (const grants of this.sessionGrants.values()) grants.delete(bundleId);
  }

  /** Must the app stay off a whole-screen read (a shot, `screen.windows`)? The system's authentication surfaces,
   *  and every app whose effective access is `deny` — never Winter's own windows (the user ruling: a whole-screen
   *  read is only for seeing; acting needs a bind, and binding Winter stays refused by `checkFloors`). */
  hiddenFromScreen(bundleId: string): boolean {
    if (WINTER_OWN_BUNDLE_IDS.includes(bundleId)) return false;
    return AUTH_DIALOG_BUNDLE_IDS.has(bundleId) || this.accessFor(bundleId) === "deny";
  }

  /**
   * The bundle ids a whole-screen shot must black out: the system's authentication surfaces and every app whose
   * effective access is `deny` — the user's rows, the built-in defaults and, since an app with no row is `deny`
   * while the master switch is OFF, every RUNNING app (`running`, from the helper's `apps.list`) without an
   * allowing exception. With the switch on, an app with no row is `full`, so `running` adds nothing and the caller
   * need not ask the helper for it. Winter's own apps are NEVER on it (the user ruling: they are shown, not
   * controlled — binding them is refused).
   */
  excludedFromScreen(running: readonly string[] = []): string[] {
    const settings = this.deps.settings();
    const out = new Set<string>(AUTH_DIALOG_BUNDLE_IDS);
    const candidates = new Set<string>([...Object.keys(computerUseAppsFrom(settings)), ...Object.keys(DEFAULT_APP_EXCEPTIONS), ...running]);
    for (const id of candidates) if (!WINTER_OWN_BUNDLE_IDS.includes(id) && effectiveAppAccess(settings, id).access === "deny") out.add(id);
    return [...out];
  }

  /** Is the master switch on (an app with no exception is usable)? */
  allowAllApps(): boolean {
    return computerUseAllowAllAppsFrom(this.deps.settings());
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
  async authorize(run: RunGrants, app: AppRef, purpose: { kind: "bind" } | { kind: "act"; primitive: string; access?: "click" | "full" } | { kind: "observe" }, signal?: AbortSignal): Promise<void> {
    this.checkFloors(app);
    const { access, source } = effectiveAppAccess(this.deps.settings(), app.bundleId);
    if (access === "deny") {
      throw new AutomationFailure("NotAllowed", source === "switch"
        ? `${app.name} is not allowed: "Allow all apps" is off in Settings → Computer Use and ${app.name} is not one of its exceptions — ask the user if you need it`
        : `${app.name} is set to Don't allow in Settings → Computer Use — ask the user if you need it`);
    }
    const facts = this.deps.session(run.sessionId);
    if (facts.mode === "chat" || facts.policy === "chat") throw new AutomationFailure("NotAllowed", "computer use is not available in chat");
    if (purpose.kind === "observe") return;
    if (purpose.kind === "act") {
      if (access === "view") throw new AutomationFailure("NotAllowed", `${app.name} is set to view only in Settings → Computer Use — you can look but not act`);
      // An app adapter's function states its own class (`access`), which replaces the primitive lookup.
      if (access === "click" && (purpose.access !== undefined ? purpose.access !== "click" : !CLICK_ONLY_PRIMITIVES.has(purpose.primitive))) {
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
   * "refuse with `NeedsForeground`" (the caller words it). On THIS desktop only — a window on another desktop is
   * `askDesktopVisit`'s.
   */
  async allowForeground(run: RunGrants, app: AppRef, signal?: AbortSignal, reason?: string): Promise<boolean> {
    const facts = this.deps.session(run.sessionId);
    // `dont-ask` never cards and `plan` never acts; chat has no computer use.
    if (facts.policy === "dont-ask" || facts.policy === "plan" || facts.policy === "chat" || facts.mode === "chat") return false;
    // `bypass` shows no computer-use prompt at all (the user ruling): the pointer is taken at once, attended or not.
    if (facts.policy === "bypass") return true;
    if (!this.deps.attended(run.sessionId)) return false;
    const res = await this.card(run, foregroundCardSummary(app, reason === undefined ? undefined : cardReason(reason)), FOREGROUND_CARD_OPTIONS, signal);
    return res.approved;
  }

  /**
   * THE DESKTOP SWITCH (the ruling, 2026-10-10): may Winter move the user to `app`'s desktop for a moment? Asked under
   * EVERY policy — the session's card and the helper's on-screen panel at once, the first answer resolving both —
   * for `DESKTOP_VISIT_PROMPT_MS`; no answer ALLOWS. Chat has no computer use. The caller has already applied the
   * floors and the app's access (`authorize`), and scopes the answer to the script run.
   */
  async askDesktopVisit(run: RunGrants, app: AppRef, reason: string, signal?: AbortSignal): Promise<DesktopVisitOutcome> {
    const facts = this.deps.session(run.sessionId);
    if (facts.policy === "chat" || facts.mode === "chat") return { allowed: false, answer: "refuse", via: "none" };
    this.checkFloors(app);
    if (signal?.aborted) return { allowed: false, answer: "aborted", via: "none" };
    const { sessionId } = run;
    const callId = `cu_${randomBytes(6).toString("hex")}`;
    const summary = desktopVisitCardSummary(app, reason);
    const issuedAt = (this.deps.now ?? Date.now)();
    const promptMs = this.deps.desktopVisitPromptMs ?? DESKTOP_VISIT_PROMPT_MS;
    const expiresAt = issuedAt + promptMs;
    const options = DESKTOP_VISIT_CARD_OPTIONS.map((o) => ({ ...o }));
    // Wait before emit (the append is synchronous): an answer can never arrive before the broker knows the card.
    // The broker's own clock runs a grace past the deadline the card and the panel show: an answer racing the
    // countdown still counts as the user's; past it, no answer allows.
    const waiting = this.deps.approvals.wait(sessionId, callId, promptMs + (this.deps.desktopVisitGraceMs ?? DESKTOP_VISIT_GRACE_MS), {
      toolName: COMPUTER_V2_TOOL_NAME, summary, issuedAt, expiresAt, options, onTimeout: "allow",
    });
    try {
      this.deps.emit(sessionId, {
        type: "approval_requested", sessionId, threadId: "main", callId, toolName: COMPUTER_V2_TOOL_NAME, summary, issuedAt, expiresAt,
        options, onTimeout: "allow",
      } as NewSessionEvent);
    } catch (err) {
      this.deps.approvals.resolve(sessionId, callId, false, "emit-failure");
      await waiting;
      this.deps.log?.(`computer-use: could not raise the desktop-switch card for ${sessionId}: ${err instanceof Error ? err.message : "error"}`);
      return { allowed: false, answer: "unavailable", via: "none" };
    }
    // The helper's on-screen panel on the user's current desktop: its answer resolves the card (first wins — the
    // broker ignores a second); the card's resolution, from anywhere, closes the panel.
    let panel: ReturnType<DesktopVisitPanel["show"]> | undefined;
    try {
      // The panel counts down to the card's own deadline (absolute), never from when it happens to appear.
      panel = this.deps.desktopPanel?.show({ promptId: callId, sessionId, app: cardName(app.name), bundleId: app.bundleId, reason, timeoutMs: promptMs, expiresAt });
    } catch (err) {
      this.deps.log?.(`computer-use: the on-screen desktop-switch prompt could not be shown (${err instanceof Error ? err.message : "error"}) — the card alone asks`);
    }
    void panel?.answer.then((a) => {
      if (a === "switch") this.deps.approvals.resolve(sessionId, callId, true, DESKTOP_PROMPT_BY, DESKTOP_VISIT_OPTION_ID);
      else if (a === "refuse") this.deps.approvals.resolve(sessionId, callId, false, DESKTOP_PROMPT_BY);
      // `expired` (the panel's countdown reached the deadline) decides nothing: the daemon's own clock does, after
      // its grace — a card answer racing the deadline still wins.
    }, () => { /* the panel failed: the card still asks */ });
    const onAbort = (): void => { this.deps.approvals.resolve(sessionId, callId, false, "aborted"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    // The prompt never counts against the script's timeout (the card rule).
    run.onCardWait?.(true);
    let res: { approved: boolean; by: string; optionId?: string };
    try {
      res = await waiting;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      run.onCardWait?.(false);
      try { panel?.close(); } catch { /* already gone */ }
    }
    try {
      this.deps.emit(sessionId, { type: "approval_resolved", sessionId, threadId: "main", callId, approved: res.approved, by: res.by } as NewSessionEvent);
    } catch { /* the outcome stands */ }
    let outcome: DesktopVisitOutcome;
    if (res.by === "timeout") outcome = { allowed: res.approved, answer: res.approved ? "timeout-allow" : "refuse", via: "timeout" };
    else if (res.by === "aborted" || res.by === "emit-failure" || res.by === "superseded") outcome = { allowed: false, answer: "aborted", via: "none" };
    else outcome = { allowed: res.approved, answer: res.approved ? "allow" : "refuse", via: res.by === DESKTOP_PROMPT_BY ? "panel" : "card" };
    // A PERSON's "Don't switch" holds until their next message (5a); a timeout-allow, an abort or a failure never does.
    if (outcome.answer === "refuse" && (outcome.via === "card" || outcome.via === "panel")) this.noteDesktopRefusal(sessionId, app.bundleId);
    this.deps.log?.(`computer-use: desktop switch to ${app.bundleId} for ${sessionId}: ${outcome.answer} (${outcome.via})`);
    return outcome;
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

  // ── browsers (Phase 2): the browser engine's two doors into this policy ──────────────────────────

  /** The session's facts, for the browser engine (the built-in browser has no per-app card, so it applies `plan`'s
   *  observe-only rule and the dangerous-domain floor's rows itself). */
  sessionFacts(sessionId: string): SessionFacts { return this.deps.session(sessionId); }

  /** The dangerous-domain site card (a daemon-raised card like the per-app one: `once` / `session`, relayed and
   *  bounded for a dispatch child). The caller decides when the session's policy may ask. */
  async siteCard(run: RunGrants, summary: string, signal?: AbortSignal): Promise<{ approved: boolean; optionId?: string; human: boolean }> {
    return await this.card(run, summary, SITE_CARD_OPTIONS, signal);
  }
}

/** The dangerous-domain site card's options: this call, or this session (no "always" — the escape hatch for a host
 *  is the user's own `WebFetch(domain:…)` rule or the dangerous-domains list itself). */
export const SITE_CARD_OPTIONS: readonly ApprovalOption[] = [
  { id: "once", label: "Allow once" },
  { id: "session", label: "Allow for this session" },
];
