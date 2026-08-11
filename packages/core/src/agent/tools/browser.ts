import { z } from "zod";
import { PanelOpenTabParams } from "@norma/protocol";
import type { ToolRegistry } from "./registry";
import type { PanelCommandAction, PanelCommandOutcome } from "../../panel/commands";
import type { PanelTabState } from "../../panel/store";
import type { PanelTabMint } from "../../panel/open-tab";
import { TERMINAL_CLIENT_PREFIXES } from "../../sessions/activity-enforcement";
import { checkDangerousDomain, dangerousDomainRefusal } from "./page-core";

/**
 * `browser` (b2-agent-browser T4, spec `docs/superpowers/specs/2026-08-11-b2-agent-browser-design.md`)
 * — the agent's hands on the panel's real, logged-in Chromium browsers.
 *
 * ONE multi-verb tool (the `lsp` precedent), reaching the panel by TWO different routes, and the
 * split is the whole shape of this file:
 *
 *  - `tabs` and `open` are answered by the DAEMON, from its own state. `tabs` folds the session's
 *    persisted panel events (`foldPanelTabs`, the same replay `panel.list` serves) and `open` mints
 *    through `mintPanelTab` — the same function `panel.openTab`'s RPC handler runs. Neither needs a
 *    Mac app to be running, and `tabs` is therefore also the drivability probe (spec §2).
 *  - `navigate`/`back`/`read`/`screenshot` — and, from Task 5, the interaction verbs — are COMMANDS.
 *    They ride `PanelCommandRegistry.dispatch` (packages/core/src/panel/commands.ts): a
 *    `panel_command` transient fanned out to whoever is attached, a pending entry keyed by
 *    `commandId`, and a promise that ALWAYS settles as a result or a timeout.
 *
 * ## What this tool does NOT do, with owners
 *
 * **Approvals are Task 6's.** Nothing here consults the per-domain rules the spec's §4 puts this tool
 * on (the same web floor `fetch`/`web_fetch` ride). When Task 6 lands, its gate belongs AHEAD of
 * `dispatchVerb` below — beside the dangerous-domain check, which is deliberately NOT the same thing
 * (see `refuseDangerous`).
 *
 * **URL SCHEME policy is the app's**, at the consumer (`PanelCommandConsumer.navigate`, the fifth
 * door — spec §3 puts policy there because the consumer is the last place before a real web view).
 * `open`'s url is the exception and it is not an exception to that rule: it goes through
 * `PanelOpenTabParams`, whose `superRefine` is the daemon's own long-standing http/https guard on a
 * `web` tab, so the agent's `open` inherits exactly the door `panel.openTab` already had rather than
 * growing a second policy (methods.ts's own comment on that schema says so, and this is what makes
 * it true).
 *
 * **The interaction verbs are not implemented anywhere yet.** They are in this tool's code/dispatch
 * schema (see `registerBrowserTool`) and they DISPATCH for real; the Mac app answers them
 * `ok:false, "not implemented in this version of the Mac app yet"` (`PanelCommandConsumer`'s own
 * INTERACT arm, built in Task 3 for exactly this window). Task 5 builds them — and, stated plainly
 * because the task brief assumed otherwise: **Task 5 is not daemon-side only.** These verbs are
 * currently operand-less; `click` needs a selector, `type` needs text, `wait` needs a predicate, and
 * none of those fields exist on this schema. Task 5 must add them here as well as in the app.
 */

// ================================================================================================
// The verb sets
// ================================================================================================

/** The READ set — what CHAT may ever reach, and what every other mode gets too. `tabs` and `open`
 *  are in it despite never travelling the command channel: from the model's side they are verbs of
 *  the same tool, and the mode split is about what the agent may DO, not about which wire carries it.
 *
 *  **The spec disagrees with itself about `back`, and this follows §2.** §1's prose lists chat's
 *  read-only set as "open, navigate, tabs, read, screenshot" — five verbs, no `back` — while §2's
 *  verb table puts `navigate` / `back` on one row and marks it `read`. §2 is taken as the better
 *  reading on two grounds: it is the normative table (§1 is a summary sentence, and it also omits
 *  `back` from the code/cowork/dispatch list where nobody disputes it belongs), and `back` is the
 *  strict inverse of `navigate` — a mode allowed to move a tab forward but not to undo it would be
 *  a strange capability boundary, and `back` reaches nothing `navigate` did not already reach. Six
 *  verbs, therefore; recorded here so the divergence is a decision rather than a typo. */
export const BROWSER_READ_VERBS = ["tabs", "open", "navigate", "back", "read", "screenshot"] as const;

/** Spec §1's INTERACT set — code and dispatch only, never chat. Every member is a
 * `PANEL_COMMAND_ACTIONS` value (events.ts holds the flat union; this is one half of its documented
 *  split). */
export const BROWSER_INTERACT_VERBS = ["click", "type", "scroll", "submit", "wait"] as const;

type ReadVerb = (typeof BROWSER_READ_VERBS)[number];
type InteractVerb = (typeof BROWSER_INTERACT_VERBS)[number];
type BrowserVerb = ReadVerb | InteractVerb;

/** The verbs that travel the command channel — every verb except the two the daemon answers itself.
 *  Typed as `PanelCommandAction` so a verb that is not on the wire's own enum fails to compile here
 *  rather than at runtime in the app. */
const COMMAND_VERBS = [
  "navigate", "back", "read", "screenshot", ...BROWSER_INTERACT_VERBS,
] as const satisfies readonly PanelCommandAction[];

function isCommandVerb(v: BrowserVerb): v is (typeof COMMAND_VERBS)[number] {
  return (COMMAND_VERBS as readonly string[]).includes(v);
}

/**
 * Per-verb deadlines, in milliseconds — how long the tool waits for the Mac app's answer before the
 * registry's own timer fires and the agent is told nothing is known.
 *
 * These bound the WHOLE round trip: a socket hop, a hub fan-out, the app's own scheduling, the CEF
 * work, and the answer's return trip. Sized by what the verb has to WAIT ON, which for half of them
 * is a network the daemon does not control:
 *
 *  - `navigate` **30s** — a real page load on a real network, including redirects and a slow first
 *    byte. The panel's own address bar has no bound at all (a person watches and gives up), so this
 *    is the agent's patience, not the browser's. It is deliberately the most generous.
 *  - `wait` **30s** — a bounded poll for load/idle; the same "waiting on a page" shape as navigate.
 *  - `back` **15s** — history navigation, usually served from the back/forward cache, but still a
 *    load and still able to hit the network.
 *  - `read` **20s** — one `Runtime.evaluate` over `innerText`. Fast once the page is settled, but it
 *    is routinely issued straight after a `navigate` on a page still painting, and the honest cost of
 *    being stingy here is "timed out" for a page that was one tick from readable.
 *  - `screenshot` **20s** — `Page.captureScreenshot` is quick; the variable part is the up-to-3 MiB
 *    base64 payload crossing back over the socket.
 *  - the interaction verbs **15s** — a CDP input dispatch is local to the renderer and does not wait
 *    on the network. (They cannot actually run yet; the number is chosen for the verb, not for
 *    today's refusal, so Task 5 inherits a considered value rather than a placeholder.)
 *
 * Not settings. Nothing here is a knob a user would turn, and a setting would drag in the
 * hot-reload obligation (CLAUDE.md) for no gain — the same call `AUTO_BACKGROUND_GRACE_MS` records.
 */
export const BROWSER_DEADLINES_MS: Record<(typeof COMMAND_VERBS)[number], number> = {
  navigate: 30_000,
  wait: 30_000,
  back: 15_000,
  read: 20_000,
  screenshot: 20_000,
  click: 15_000,
  type: 15_000,
  scroll: 15_000,
  submit: 15_000,
};

// ================================================================================================
// Args
// ================================================================================================

/** Fields shared by every verb. All optional at the schema level and checked per-verb in `run`,
 *  deliberately: a `superRefine` would make this a `ZodEffects`, and `argsByMode`'s two schemas are
 *  rendered with `z.toJSONSchema` and swapped per mode — one object shape per mode keeps that
 *  rendering plain, and a missing operand is a far better error message from `run` ("navigate needs
 *  a url") than from zod's issue paths. */
const SHARED = {
  tabId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
};

/** CHAT's schema — and, because `argsByMode` is fail-closed, the schema for any caller whose mode is
 *  unknown. Read verbs only: spec §1, "No interaction verbs, ever". */
const BrowserReadArgs = z.object({ verb: z.enum(BROWSER_READ_VERBS), ...SHARED });
/** code/dispatch: the full set. */
const BrowserFullArgs = z.object({
  verb: z.enum([...BROWSER_READ_VERBS, ...BROWSER_INTERACT_VERBS]),
  ...SHARED,
});

type BrowserArgs = z.infer<typeof BrowserFullArgs>;

// ================================================================================================
// Deps
// ================================================================================================

export interface BrowserToolDeps {
  /** The session's tab fold — `foldPanelTabs(store.read(sessionId))`, i.e. exactly what `panel.list`
   *  serves. THROWS for an unknown session (the store does); `run` turns that into a tool error. */
  tabs(sessionId: string): PanelTabState;
  /** `mintPanelTab` (panel/open-tab.ts) — the SAME function `panel.openTab`'s handler runs, which is
   *  what keeps an agent-opened tab indistinguishable from a user-opened one. Returns the
   *  daemon-minted tabId. */
  openTab(p: PanelTabMint): string;
  /** `PanelCommandRegistry.dispatch`. The returned promise ALWAYS settles (result or timeout) and
   *  never rejects — this tool's whole outcome mapping rests on that contract. */
  dispatch(cmd: {
    sessionId: string;
    action: PanelCommandAction;
    tabId?: string;
    url?: string;
    args?: Record<string, unknown>;
    deadlineMs: number;
  }): { commandId: string; settled: Promise<PanelCommandOutcome> };
  /** `SessionHub.attachedHarnesses` — who currently holds this session open. The availability gate's
   *  only input; see `panelReach`. */
  harnesses(sessionId: string): ReadonlyArray<{ clientName: string; role?: string | null }>;
  /** The user-added half of the dangerous-domain list, resolved per project and hot — the SAME
   *  getter ReadPage, Search and the research runner already share (daemon.ts wires one function
   *  reference to all of them). Absent → the shipped list alone still applies. */
  dangerousDomainsAdded?(cwd?: string): string[] | undefined;
}

// ================================================================================================
// Availability (spec §3) — "honest and fast"
// ================================================================================================

/**
 * Could this attached client be hosting a panel, i.e. is it a plausible destination for a
 * `panel_command`?
 *
 * A DENYLIST of the two kinds that provably cannot, rather than an allowlist of the one that can:
 *
 *  - `role === "remote"` — the phone, through the pairing gateway. It has no panel, no CEF, and
 *    `PanelCommandResultParams` is not even remote-allowed, so it could not answer if it wanted to.
 *    Checked first and by ROLE, not by name, for the same reason `harnessKindOf` checks it first:
 *    role is the daemon's own record of how the connection authenticated, and it outranks whatever
 *    a gateway calls itself.
 *  - a `TERMINAL_CLIENT_PREFIXES` name (`cli-…`) — the CLI. Reused from `activity-enforcement.ts`
 *    rather than re-spelled so there is ONE list of terminal prefixes in the daemon; that file's own
 *    doc explains why it is a prefix rule and not a literal list.
 *
 * Everything else passes, which is the deliberately loose half: `orb` (the Mac app) passes, and so
 * does `norma-probe` (NormaKit's debug streamer), which has no panel either. That direction of error
 * is the cheap one — a false "available" costs one deadline, a false "unavailable" would refuse a
 * command the app could have served — and the alternative, matching the literal name `orb`, would
 * silently disable the whole tool the day the app renames its client.
 */
export function canHostPanel(h: { clientName: string; role?: string | null }): boolean {
  if (h.role === "remote") return false;
  return !TERMINAL_CLIENT_PREFIXES.some((p) => h.clientName.startsWith(p));
}

/** What the availability gate concluded, and enough of why to say it out loud. */
type PanelReach =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * The gate itself, and **the exact fact it checks: can a `panel_command` be DELIVERED to a client
 * that could run it.**
 *
 * The input is `SessionHub.attachedHarnesses`, because delivery is attachment-scoped and nothing
 * else: `PanelCommandRegistry.dispatch` emits through `hub.broadcastTransient`, which calls
 * `fanOut(sessionId, …)`, which iterates `attachments.get(sessionId)` and nothing else. A session
 * with no attachment cannot be reached at all; a session held only by the phone or a terminal can be
 * reached only by clients that cannot act.
 *
 * **What this gate CANNOT see, stated here rather than left to be discovered.** A DETACHED WINDOW
 * attaches on its own socket (`AppModel.makeDetachedFeed` → `SessionFeed.start` → `client.attach`)
 * under the SAME client name as the shell (`AppModel.ownClientName == "orb"`), and only the shell
 * runs the `panel_command` consumer (Task 3's report §2 names this gap and hands it here). So a
 * session held ONLY by a detached window passes this gate and its commands then expire on their
 * deadlines. That is not a bug in this predicate — it is the honest limit of what the daemon knows:
 * no wire fact distinguishes the two attachments, and inventing one would be a protocol change. The
 * agent is told "the Mac app did not answer", which for that case is exactly true.
 */
function panelReach(deps: BrowserToolDeps, sessionId: string): PanelReach {
  const attached = deps.harnesses(sessionId);
  const usable = attached.filter(canHostPanel);
  if (usable.length > 0) return { ok: true };
  if (attached.length === 0) {
    return {
      ok: false,
      reason: "browser unavailable — the Mac app isn't showing this session, so nothing can run the "
        + "command (it may be closed, or open on a different session). Nothing was sent. "
        + "`verb:\"tabs\"` still answers from the daemon's own record, and `verb:\"open\"` still adds "
        + "a tab the user will see when the app comes back.",
    };
  }
  const names = [...new Set(attached.map((h) => h.clientName))].sort().join(", ");
  return {
    ok: false,
    reason: `browser unavailable — the Mac app isn't showing this session. The only clients attached `
      + `right now are: ${names} — a phone or a terminal has no browser to drive. Nothing was sent.`,
  };
}

// ================================================================================================
// The dangerous-domain hard block (spec §4)
// ================================================================================================

/**
 * **This is NOT an approval, which is why it is here and not in Task 6.**
 *
 * Spec §4 splits into two halves that read alike and behave nothing alike. The first is the per-domain
 * approval mechanism the browser shares with `fetch` — a card, a remembered rule, a user decision.
 * That is Task 6's, and nothing in this file consults it. The second is the dangerous-domains
 * HARD-BLOCK, which exists precisely BECAUSE no approval is available to ask for: it is unconditional
 * in every mode, over the SAME list ReadPage and the research runner use (`checkDangerousDomain` in
 * page-core.ts, whose own doc carries the full rationale, and spec §7's "the dangerous-domains list
 * is shared").
 *
 * **The LIST is shared with ReadPage; the ENFORCEMENT DEPTH is not, and the difference is
 * structural — do not read "same as ReadPage" as "same coverage".**
 *
 * ReadPage checks TWICE: once on the caller-supplied url, and again on the RESOLVED, post-redirect
 * host inside `fetchCleanPage` (page-core.ts's `dangerousAdded` option, added for exactly this — "a
 * url that merely redirects INTO a dangerous host"). It can, because it owns the fetch.
 *
 * This tool checks ONCE, on the FIRST HOP — the model-supplied string, before anything is sent. After
 * that the daemon is blind by construction:
 *   - CEF follows redirects itself; no `panel.commandResult` reports a redirect chain, and the only
 *     navigation fact that comes back at all is `panel.reportNavigation`'s COMMITTED top-level url,
 *     which arrives after the load, as a report, with nothing awaiting it;
 *   - in-page navigation (a link, a `location.href` assignment, a meta refresh) never crosses this
 *     daemon at any point;
 *   - the app holds NO domain list. `PanelURLPolicy.isAllowed` is scheme-only (http/https), by
 *     design — the fifth door is a SCHEME door, not a domain one — so nothing downstream re-applies
 *     this check on the daemon's behalf.
 * So this is an INTENT-level block, not a fetch-level one: it stops the agent from *aiming* at a
 * listed host, on the surface where the user is logged in. Stated rather than implied because the
 * gap is inherited: Task 5's `click` is a whole navigation door the daemon never sees, and Task 6's
 * approval gate will sit beside this one with the identical first-hop-only reach.
 *
 * Taken by this task rather than deferred, deliberately, on three grounds: the tool ships to CHAT by
 * default and chat NEVER prompts, so deferring would ship the read set with an open hole in the one
 * mode that has no other gate; the agent browses the user's own logged-in profile (spec §4 states
 * this as the reason the gate exists at all); and the mechanism is already built and already wired
 * into this daemon, so taking it costs one dep and two call sites.
 *
 * Both URL doors are gated — `navigate` AND `open`. `open` matters as much: its url is persisted onto
 * the tab and the app loads it (the panel's restore door), so an ungated `open` would be a `navigate`
 * with an extra step.
 */
function refuseDangerous(url: string, deps: BrowserToolDeps, cwd: string | undefined): string | null {
  const match = checkDangerousDomain(url, deps.dangerousDomainsAdded?.(cwd));
  if (!match) return null;
  return dangerousDomainRefusal(
    url, match,
    "the browser tool has no approval flow to ask for one, so navigations to known "
      + "exfiltration/tunnel-provider hosts are blocked outright",
  );
}

// ================================================================================================
// The command round trip
// ================================================================================================

/** Sentinel for "the turn was interrupted while we were waiting" — see `settleOrAbort`. */
const ABORTED = Symbol("browser-command-aborted");

/**
 * Await a dispatched command, or give up the moment the turn is aborted. (An ALREADY-aborted turn is
 * caught one step earlier, in `run`, so nothing is dispatched at all in that case.)
 *
 * **The registry has no cancel path, and this does not add one.** `PanelCommandRegistry` exposes
 * `dispatch` and `resolve` only; a pending entry ends when the app answers or when its own
 * `setTimeout` fires, and nothing can withdraw it in between. That is fine, and is why this function
 * is an abandonment rather than a cancellation: the entry is LEFT TO EXPIRE on its own timer, at which
 * point it resolves a promise nobody is holding, deletes itself and records the id as settled — so a
 * late answer is `dropped` with a log line instead of `unknown`. Nothing leaks and nothing is
 * double-answered; the whole cost of an aborted command is one map entry living out at most one
 * deadline.
 *
 * What this function actually buys is that the ENGINE's turn teardown does not have to wait for it.
 * A user pressing ESC during a 30-second `navigate` should not sit through the rest of it.
 *
 * The listener is removed on the normal path, not only on the aborted one: a browsing turn issues an
 * unbounded number of commands against ONE long-lived `AbortSignal`, so leaving one listener per
 * command attached is a genuine accumulation, not a theoretical one.
 */
async function settleOrAbort(
  settled: Promise<PanelCommandOutcome>,
  signal: AbortSignal | undefined,
): Promise<PanelCommandOutcome | typeof ABORTED> {
  if (!signal) return await settled;
  // Belt for a signal that went down between `run`'s pre-check and here.
  if (signal.aborted) return ABORTED;
  return await new Promise<PanelCommandOutcome | typeof ABORTED>((resolve) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    // `settled` never rejects — the registry's own contract ("the promise NEVER rejects: it settles
    // as a result or as a timeout"), which is why there is no `.catch` here to swallow anything.
    void settled.then((outcome) => {
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    });
  });
}

/** How long we waited, for a message. Whole seconds — the deadlines are all multiples of 1000. */
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

// ================================================================================================
// Registration
// ================================================================================================

export function registerBrowserTool(r: ToolRegistry, deps: BrowserToolDeps): void {
  r.register({
    name: "browser",
    description:
      "Drive the user's real browser — the tabs in Norma's side panel, in the user's own logged-in "
      + "profile, visible to them live. Pick a verb:\n"
      + "• tabs — list this session's open tabs (tabId, url, title, which is active). Answered by "
      + "Norma itself, so it works even when the Mac app is closed. Start here when you don't have a tabId.\n"
      + "• open — open a new tab on a url (http/https). Returns its tabId. Works with the app closed; "
      + "the tab appears in the user's strip.\n"
      + "• navigate — point a tab at a url.\n"
      + "• back — go back in a tab's history.\n"
      + "• read — the page's rendered text, as a reader sees it. Prefer this over ReadPage when the "
      + "page needs JavaScript or the user's login; ReadPage is still better for plain articles.\n"
      + "• screenshot — a PNG of the tab, returned to you as an image.\n"
      + "tabId is optional on the tab-driving verbs and defaults to the session's ACTIVE tab. "
      + "Verbs other than tabs/open need the Mac app to be showing this session; if it isn't, you are "
      + "told so immediately rather than left waiting.\n"
      // The description is MODE-INVARIANT — `ToolDefinition.description` has no per-mode seam, only
      // `argsByMode` does — so this sentence is written to be true in every mode. In chat the
      // interaction verbs are absent from the enum and the sentence is simply inert; in code and
      // dispatch it is what stops the model spending a guaranteed-terminal round trip discovering
      // that `click` is not built yet. Delete this line when Task 5 implements them.
      + "The interaction verbs (click, type, scroll, submit, wait), where offered, are accepted by "
      + "the schema but NOT yet implemented by the Mac app — calling one only returns 'not "
      + "implemented'. Don't plan around them.",
    // Spec §1: every mode may browse. `modes` is the DECLARATION site the per-mode registry replaced
    // the old hand-written allowlists with (registry.ts) — listing "chat" here is what makes this a
    // default tool there.
    //
    // "cowork" is absent because the registry has no such mode: `Mode` is code|dispatch|chat and
    // `engine.ts`'s `resolveMode` folds a cowork session into "chat" (its own comment records that
    // choice and why it is the right analogue). The spec's `deferred: ["code","cowork","dispatch"]`
    // therefore cannot be written literally, and the honest consequence is stated rather than hidden:
    // the day cowork ships, a cowork session gets CHAT's read-only browser until someone widens
    // `Mode` — a change with its own blast radius that this task deliberately did not make.
    modes: ["code", "dispatch", "chat"],
    // Deferred in code and dispatch (ToolSearch-loaded there), IMMEDIATE in chat — spec §1's
    // "default tool in chat where it is the primary web surface". The asymmetry is also forced:
    // chat's derived toolset has no ToolSearch member unless something chat-eligible is itself
    // deferred, so a chat-deferred `browser` would be permanently uncallable there (the same trap
    // `AskQuestion` and `ReadPage` both record).
    deferred: ["code", "dispatch"],
    // The per-mode schema (registry.ts's `argsByMode`). `args` is the READ set: it is what chat sees
    // AND the fail-closed answer for any caller whose mode is unknown. Spec §1's "the per-mode
    // registry makes wrong-mode exposure structurally impossible" is true because BOTH `specs()` and
    // `execute()` resolve through the registry's single `argsFor` — a chat session that called
    // `verb:"click"` regardless is rejected at argument validation, not merely un-advertised.
    args: BrowserReadArgs,
    argsByMode: { code: BrowserFullArgs, dispatch: BrowserFullArgs },
    // Typed as the FULL args: the registry hands `run` whatever the mode's schema parsed, and in
    // chat that can only ever be a read verb (the line above is what guarantees it).
    async run(a: BrowserArgs, ctx) {
      const sessionId = ctx.sessionId;

      // ---- tabs: always answers, from the daemon's own fold. No app, no gate, no deadline. -------
      if (a.verb === "tabs") return renderTabs(deps, sessionId);

      // ---- open: the daemon mints; the app is not consulted. ------------------------------------
      if (a.verb === "open") {
        if (!a.url) throw new Error('open needs a url (http or https) — e.g. verb:"open", url:"https://example.com".');
        const refusal = refuseDangerous(a.url, deps, ctx.cwd);
        if (refusal) throw new Error(refusal);
        // Through `PanelOpenTabParams`, not around it: that schema's `superRefine` is the daemon's
        // existing http/https guard for a `web` tab and its url/title caps, and parsing here is what
        // makes methods.ts's claim that "B2's agent-facing browser tool reaches this same door, so it
        // inherits the guard without a second policy of its own" actually true.
        const parsed = PanelOpenTabParams.safeParse({ sessionId, kind: "web", url: a.url, title: a.title });
        if (!parsed.success) {
          throw new Error(`cannot open that tab: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
        }
        let tabId: string;
        try {
          tabId = deps.openTab(parsed.data);
        } catch (e) {
          throw new Error(`could not open a tab in this session: ${(e as Error).message}`);
        }
        const reach = panelReach(deps, sessionId);
        // Not a failure: the tab is real, persisted and active, and the user will see it the moment
        // the app shows this session. Said out loud so the model does not read a silent success as
        // "the page is loaded and ready to read".
        const note = reach.ok
          ? ""
          : "\nNote: the Mac app isn't showing this session right now, so nothing has loaded the page yet.";
        return `opened tab ${tabId} on ${a.url}${note}`;
      }

      // ---- the command verbs -------------------------------------------------------------------
      if (!isCommandVerb(a.verb)) {
        // Unreachable: `BrowserVerb` is exactly the two sets and both are handled. Kept as a typed
        // exhaustiveness stop rather than a cast, so a verb added to either constant without a
        // branch here fails to compile.
        const never: never = a.verb;
        throw new Error(`unknown browser verb: ${String(never)}`);
      }

      // REFUSAL PRECEDENCE, most permanent first, so a given call always produces the same message:
      //   1. missing/invalid operands  — the call is malformed however the world looks
      //   2. dangerous domain          — a permanent policy refusal (Task 6's approvals land beside it)
      //   3. vision capability         — a permanent fact about this SESSION's model, not about the
      //                                  world: a model that cannot see images gains nothing from a
      //                                  screenshot however healthy the app is. Belongs among the
      //                                  permanent rungs and ABOVE availability for that reason —
      //                                  moving it below would answer "the app isn't showing this
      //                                  session" to a call that could never have worked anyway
      //   4. tab ownership             — a permanent fact about this session's tabs
      //   5. availability              — the only TRANSIENT one, so it is checked last of the five
      //   6. dispatch
      // Deciding transient-last also means a model that fixes its call gets the same complaint until
      // the call is actually right, instead of being told the app is missing and then, on retry, that
      // the tab is foreign.

      if (a.verb === "navigate") {
        if (!a.url) throw new Error('navigate needs a url — e.g. verb:"navigate", url:"https://example.com".');
        const refusal = refuseDangerous(a.url, deps, ctx.cwd);
        if (refusal) throw new Error(refusal);
      }

      // Rung 3, the vision gate (see the ladder above for why it sits here and not lower): a model
      // that cannot see images has nothing to gain from a screenshot, and the payload is up to 3 MiB.
      // Mirrors the `computer` tool's own screenshot check exactly — `undefined` means "unknown",
      // which is NOT a refusal.
      if (a.verb === "screenshot" && ctx.visionCapable === false) {
        throw new Error("this session's model cannot accept images, so a screenshot would be discarded — use verb:\"read\" for the page's text instead.");
      }

      const tabId = resolveTabId(deps, sessionId, a);

      const reach = panelReach(deps, sessionId);
      if (!reach.ok) throw new Error(reach.reason);

      // Already interrupted before we even sent it: nothing is gained by pushing a command at the
      // app that no one will read the answer to, and this is the ordinary shape after an ESC (the
      // engine keeps draining a round's remaining tool calls with the signal already down).
      if (ctx.signal?.aborted) return `browser ${a.verb} was not sent — the turn was interrupted first.`;

      const deadlineMs = BROWSER_DEADLINES_MS[a.verb];
      const { settled } = deps.dispatch({
        sessionId,
        action: a.verb,
        tabId,
        ...(a.verb === "navigate" && a.url !== undefined ? { url: a.url } : {}),
        deadlineMs,
      });

      const outcome = await settleOrAbort(settled, ctx.signal);

      if (outcome === ABORTED) {
        // The turn is being torn down; the registry entry is left to run out (see `settleOrAbort`).
        // Returned rather than thrown: an interruption is not this tool failing.
        return `browser ${a.verb} was interrupted before the Mac app answered.`;
      }

      // THE THREE OUTCOMES. `dropped` — the registry's third verdict — is deliberately not one of
      // them, and cannot be: `dropped` is what `PanelCommandRegistry.resolve` reports to the APP when
      // a result arrives for an already-settled command. It is a verdict about a second answer, never
      // about the promise this tool holds, which is delete-then-resolved exactly once as either a
      // result or a timeout. There is no fourth case to handle and no silent fall-through.
      if (outcome.kind === "timeout") {
        // Worded to claim nothing that is not known. The Mac app may be gone, may be busy, may have
        // performed the verb perfectly and lost the race home (`PanelCommandOutcome`'s own doc
        // enumerates all three, and Task 3 added two more shapes that produce a timeout deliberately).
        // In particular it must not read as "the page failed" — the page may be fine.
        throw new Error(
          `the Mac app did not answer the browser ${a.verb} within ${seconds(outcome.deadlineMs)}. `
          + "Nothing is known about whether it ran — the app may be busy, or may have answered too "
          + "late. The page itself may be perfectly fine. Check with verb:\"tabs\" before retrying.",
        );
      }

      if (!outcome.ok) {
        // The APP's verdict that the verb ran and failed — a different axis from the timeout above,
        // and the reason `PanelCommandOutcome` keeps them as separate kinds. The reason string is the
        // app's own ("no live browser for that tab", "only http and https urls…", "not implemented in
        // this version of the Mac app yet") and is passed through untouched.
        throw new Error(outcome.result ?? `the browser could not ${a.verb} in tab ${tabId}`);
      }

      if (outcome.imageBase64 !== undefined) {
        // The image rides ctx.attachImage (the engine appends it to the turn's input as a real image
        // item) rather than the return string — the same side channel the `computer` tool's
        // screenshots and the `read` tool's images use, and what keeps a 3 MiB payload from being
        // truncated to nothing by the registry's MAX_OUTPUT. The wire field carries bare base64 with
        // no prefix (`PanelCommandResultParams`), so the data-URL prefix is added here.
        ctx.attachImage?.(`data:image/png;base64,${outcome.imageBase64}`);
        const note = ctx.attachImage ? "" : " (this session cannot display images, so it was dropped)";
        return `${outcome.result ?? `captured a screenshot of tab ${tabId}`}${note}`;
      }

      return outcome.result ?? `browser ${a.verb} completed in tab ${tabId}`;
    },
  });
}

// ================================================================================================
// Helpers that need the deps
// ================================================================================================

function readTabs(deps: BrowserToolDeps, sessionId: string): PanelTabState {
  try {
    return deps.tabs(sessionId);
  } catch (e) {
    // `SessionStore.read` throws for a session it has no row for. Surfaced as a tool error naming
    // the session rather than a bare store message.
    throw new Error(`could not read this session's tabs: ${(e as Error).message}`);
  }
}

function renderTabs(deps: BrowserToolDeps, sessionId: string): string {
  const state = readTabs(deps, sessionId);
  if (state.tabs.length === 0) return 'no tabs are open in this session — open one with verb:"open", url:"…".';
  return state.tabs
    .map((t) => {
      const active = t.tabId === state.activeTabId ? " (active)" : "";
      const title = t.title ? ` — ${t.title}` : "";
      return `${t.tabId}${active} [${t.kind}] ${t.url ?? "(no url)"}${title}`;
    })
    .join("\n");
}

/**
 * Resolve the tab a command is aimed at, and **own the tab↔session check** (Task 3's review
 * Important-2, which named this function's owner before it existed).
 *
 * The app CANNOT do this. `PanelCommandConsumer` resolves a `tabId` against `BrowserRuntime`'s
 * container registry, which is keyed by tabId across every folded session and keeps no tab→session
 * map — so from the consumer's side another session's tab is indistinguishable from this one's. The
 * daemon holds the per-session tab list (the fold `panel.list` serves) and is therefore the only
 * place the question can be answered. Today the model is the first producer of a tabId this daemon
 * did not itself choose, which is exactly why the check lands with this tool.
 *
 * A foreign tabId is refused WITHOUT dispatching: no `panel_command` is emitted, no pending entry is
 * created, no deadline is burned.
 *
 * The default is the session's ACTIVE tab, which is what the user is looking at in the strip. The
 * resolved id is named in every result string, so a defaulted command is never silent about which
 * tab it drove.
 */
function resolveTabId(deps: BrowserToolDeps, sessionId: string, a: BrowserArgs): string {
  const state = readTabs(deps, sessionId);
  const tabId = a.tabId ?? state.activeTabId;
  if (!tabId) {
    throw new Error(
      state.tabs.length === 0
        ? `${a.verb} needs a tab, and this session has none open — open one with verb:"open", url:"…".`
        : `${a.verb} needs a tabId, and this session has no ACTIVE tab — name one from verb:"tabs".`,
    );
  }
  if (!state.tabs.some((t) => t.tabId === tabId)) {
    throw new Error(
      `tab ${tabId} does not belong to this session — the browser only drives tabs in this session's `
      + `own tab list, and nothing was sent to the Mac app. Use verb:"tabs" to see them.`,
    );
  }
  return tabId;
}
