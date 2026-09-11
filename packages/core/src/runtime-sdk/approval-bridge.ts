import type { CanUseTool, PermissionResult, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import type { ApprovalOption, NewSessionEvent } from "@norma/protocol";
import { ApprovalBroker, approvalCardSummary, approvalOptionsFor } from "../agent/approvals";
import type { QuestionBroker } from "../agent/questions";
import type { PermissionGate, SessionApprovalPolicy } from "../agent/gate";
import { parseRule } from "../agent/permission-rules";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { gateToolNameFor, WINTER_OWN_TOOL_NAMES } from "./tool-names";
import { controlPlaneTargetForCall, controlPlaneDenialMessage } from "./control-plane";
import { askUserQuestionBridge, ASK_USER_QUESTION_TOOL } from "./question-bridge";
import { consoleBridgeLogger, NO_PARK_TIMEOUT_MS, type BridgeLogger } from "./bridge-common";

export { NO_PARK_TIMEOUT_MS, type BridgeLogger } from "./bridge-common";

/**
 * Everything a Winter permission request carries that Norma's `ApprovalBroker` has no field for.
 *
 * `WaitMeta` (`agent/approvals.ts`) holds only `{ toolName, summary, issuedAt, expiresAt, options }`
 * — the five things `approval.list` surfaces — and P8b-19 forbids changing it. So the bridge keeps
 * its OWN record per in-flight request, keyed the same way the broker is (`sessionId:callId`), and
 * carries the six Winter-side fields through: `toolUseID` (which IS the `callId`, so the card
 * correlates with the projector's `tool_call`), `requestId`, `agentID`, `suggestions`,
 * `decisionReason` and `blockedPath`. Nothing here is persisted and nothing here is logged.
 */
export interface BridgedApprovalRequest {
  sessionId: string;
  /** `ctx.toolUseID` — also the `callId` on the emitted events and the broker key. */
  callId: string;
  /** The name the MODEL called (Winter's spelling, e.g. `Bash`). */
  toolName: string;
  /** The name the gate classified (Norma's spelling, e.g. `bash`). */
  gateToolName: string;
  /** Winter's per-request id; distinct from `toolUseID` and re-minted on a policy re-evaluation. */
  requestId: string;
  /** Set when the caller is a Winter sub-agent inside this same session's child. Never changes
   *  routing — the card always surfaces on the OWNING Norma session (see `canUseToolFor`). */
  agentID?: string;
  suggestions?: readonly PermissionUpdate[];
  decisionReason?: string;
  blockedPath?: string;
  summary: string;
  options?: ApprovalOption[];
  issuedAt: number;
  expiresAt: number;
}

export interface CanUseToolDeps {
  /** The OWNING Norma session — every event the bridge emits lands here. */
  sessionId: string;
  /** Defaults to `"main"`, matching `daemon.ts`'s `buildLeasePolicy`, the other non-engine
   *  producer of these same two event variants. */
  threadId?: string;
  mode: SessionMode;
  /** `SessionMeta.origin` (`sessions/store.ts:70`, a bare `string`). `"dispatch-child"` is the one
   *  value this bridge reads: a dispatch child is an ordinary CODE session whose cards are mirrored
   *  into the dispatch stream, so P8b-26's never-prompt rule must catch it too. */
  origin?: string;
  /** The session's working directory, used to resolve a RELATIVE write target in the control-plane
   *  fence. An absent/empty cwd resolves relative paths against `/`, which is the conservative
   *  reading (a relative target then cannot accidentally miss a real `.norma` parent). */
  cwd?: string;
  /** Seven-valued (`gate.ts`'s `SessionApprovalPolicy`), not the six-valued wire `ApprovalPolicy`:
   *  `ipc/server.ts`'s create-time chat coercion persists the internal `"chat"` policy, and P8b-7
   *  makes that coercion the ONLY guard once the engine's turn-time re-assertion retires. A
   *  function is accepted so a `session.setPolicy` mid-session is seen by the NEXT call, exactly as
   *  the engine re-reads `meta.approvalPolicy` every iteration. */
  policy: SessionApprovalPolicy | (() => SessionApprovalPolicy);
  approvals: ApprovalBroker;
  questions: QuestionBroker;
  gate: PermissionGate;
  /** Appends + broadcasts one event on `sessionId` (in the daemon: `hub.append`). **Not in the
   *  Interfaces block** — added because nothing else in the deps can produce a `SessionEvent`, and
   *  an approval that emits no card is an approval nobody can answer. */
  emit: (event: NewSessionEvent) => void;
  log?: BridgeLogger;
  /** Test seam; defaults to `Date.now`. */
  now?: () => number;
}

/** The deny text a policy that never prompts hands back to the model. Copied VERBATIM from
 *  `engine.ts`'s `decision === "deny"` branch (the three mode-aware strings at `engine.ts:4359-4363`)
 *  so a Winter session's refusal reads identically to today's. */
function deniedByPolicyMessage(policy: SessionApprovalPolicy): string {
  if (policy === "dont-ask") {
    return "Denied automatically — you're in dont-ask mode, which declines every action that needs approval. Switch to ask or auto to be prompted, or add an allow-rule for this.";
  }
  if (policy === "chat") {
    return "Blocked — chat sessions never ask permissions and cannot run this action.";
  }
  return "Blocked in plan mode — you are researching and planning, so file changes and commands are disabled. Make no changes; when your plan is ready, call exit_plan_mode to present it for approval.";
}

/**
 * **The one deliberate divergence from today (P8b-7).** A case that would draw a card in a DISPATCH
 * or CHAT session becomes a typed deny with no event at all.
 *
 * Today a dispatch child's card is mirrored into the dispatch stream and a human can answer it;
 * the user's standing rule is that chat and dispatch never ask, so under the Winter leg the card is
 * not raised in the first place. Chat reaches this only from a stale row (a chat session created
 * before the create-time coercion, whose stored policy is still `auto` — the same case
 * `buildLeasePolicy` guards on `meta.mode === "chat"`); a chat session with its coerced `"chat"`
 * policy never resolves to `"ask"` at all, because `gate.evaluate`'s chat branch is allow-or-deny.
 *
 * CODE mode is untouched and prompts exactly as it does today.
 */
export function neverPromptsMessage(toolName: string, mode: string, policy: SessionApprovalPolicy): string {
  return `${toolName} requires approval and this ${mode} session never prompts (policy ${policy})`;
}

/** Splits a Norma/CC rule string (`Bash(git push:*)`, `Edit(/foo)`, bare `WebFetch`) back into the
 *  `PermissionRuleValue` halves Winter's `PermissionUpdate` wants. */
function ruleValueFor(rule: string): { toolName: string; ruleContent?: string } {
  const open = rule.indexOf("(");
  if (open > 0 && rule.endsWith(")")) {
    return { toolName: rule.slice(0, open), ruleContent: rule.slice(open + 1, -1) };
  }
  return { toolName: rule };
}

/**
 * The `updatedPermissions` carried back to the child when a human picked a rule-bearing "always
 * allow" option.
 *
 * **`destination: "session"`, always.** The rule's durable home is Norma's rules store, written by
 * the ONE existing writer — `approval.respond`'s `PermissionRules.append` (`ipc/server.ts`), which
 * already ran by the time the broker resolved. A settings-file destination here would make the
 * Winter child's own store a SECOND writer of the same decision, which P8b-19 forbids; `"session"`
 * tells the child "don't ask me again this session" and nothing more.
 */
function updatedPermissionsFor(option: ApprovalOption | undefined): PermissionUpdate[] | undefined {
  if (!option?.rule) return undefined;
  return [{ type: "addRules", rules: [ruleValueFor(option.rule)], behavior: "allow", destination: "session" }];
}

/** How many rule-bearing options a suggestion-derived card may offer. The whole event rides the
 *  phone's frame limit through `capEvent` (`sessions/remote-stream.ts`), so this is a bound, not a
 *  style choice. */
const MAX_SUGGESTED_OPTIONS = 4;

/**
 * Winter's `suggestions: PermissionUpdate[]` → the `ApprovalOption[]` the phone renders.
 *
 * Norma map §4.2 (digest item 46): the bridge-provided suggestions are the PREFERRED source of a
 * card's rule choices, and a host "MUST NOT reconstruct a weaker summary from `toolName`". Only
 * `addRules` updates with `behavior: "allow"` become options — a `deny`/`ask` suggestion, a
 * `setMode`, or a directory update is never something a human "remembers" on an approval card, and
 * minting an option for one would let answering a card change the session's mode.
 *
 * `destination` picks the scope Norma's rules store will write: `projectSettings`/`localSettings`
 * → `"project"`, `userSettings` → `"global"`. `session`/`cliArg` have no durable Norma equivalent,
 * so those suggestions are dropped rather than being silently persisted to disk.
 *
 * **Every minted rule is round-tripped through the rules store's own `parseRule` first.** Choosing
 * a rule-bearing option makes `approval.respond` APPEND that literal string to
 * `<root>/.norma/permissions.local.json`; a rule in a grammar Norma cannot parse would be written,
 * warned about once, and thereafter ignored — inert litter in the user's rules file, offered under
 * a label promising it would silence future calls. Winter's rule vocabulary is Norma's (both are
 * CC's), so this filter is a guard against drift, not a translation layer.
 */
export function approvalOptionsFromSuggestions(suggestions: readonly PermissionUpdate[] | undefined): ApprovalOption[] | undefined {
  if (!suggestions?.length) return undefined;
  const out: ApprovalOption[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (s.type !== "addRules" || s.behavior !== "allow") continue;
    const scope = s.destination === "userSettings" ? "global"
      : s.destination === "projectSettings" || s.destination === "localSettings" ? "project"
      : undefined;
    if (!scope) continue;
    for (const r of s.rules) {
      const rule = r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName;
      if (parseRule(rule) === null) continue;   // never offer a rule the store cannot honour
      const key = `${scope}:${rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= MAX_SUGGESTED_OPTIONS) break;
      out.push({
        id: scope === "global" ? `allow_global_${out.length}` : `allow_project_${out.length}`,
        label: scope === "global" ? `Allow "${rule}" everywhere` : `Allow "${rule}" in this project`,
        rule,
        scope,
      });
    }
    if (out.length >= MAX_SUGGESTED_OPTIONS) break;
  }
  if (!out.length) return undefined;
  return [{ id: "allow_once", label: "Allow once" }, ...out, { id: "deny", label: "Deny" }];
}

/**
 * **The `canUseTool` approval bridge** — a Winter child's permission requests over the daemon's
 * EXISTING `ApprovalBroker`, `approval_requested`/`approval_resolved` events and `approval.respond`
 * RPC. No new event variant, no new method (P8b-21).
 *
 * Order of business, per request:
 *  1. `AskUserQuestion` is routed to the question bridge FIRST — it is a question, not a
 *     permission, and Winter's own descriptor says so ("question prompting and permission are one
 *     protocol"; it is never auto-approved by any mode).
 *  2. an already-aborted signal denies immediately, with no event and no broker entry.
 *  3. `PermissionGate.evaluate` decides, on the NORMALIZED tool name (`tool-names.ts`).
 *  4. `dont-ask` converts a still-`"ask"` verdict to a deny — the flip that lives in `engine.ts`
 *     rather than the gate (`engine.ts:4341`).
 *  5. `"deny"` → a typed deny with today's mode-aware text; `"allow"` → allow, silently, no event;
 *     `"ask"` → a card in CODE mode, a typed deny in DISPATCH/CHAT (P8b-7).
 *
 * **Fail-closed everywhere** (SDK surface map §5.1: a `canUseTool` that throws is turned into a
 * typed deny by the runtime anyway — this bridge never relies on that, it returns the deny itself).
 * Never returns `null`: a `null` is legal only after an out-of-band `respondPermission`, and an
 * unaccompanied one is treated by the runtime as an accidental null and denied with a message the
 * user never chose.
 *
 * **What this bridge deliberately does NOT reproduce** — every one of these is engine-resident
 * policy that becomes per-mode `Options` in Task 9, and each is listed with its disposition in the
 * task report: the in-project write/edit silencing under `ask`; `controlPlaneFileTarget` and the
 * `~/.norma` grant denylist; the out-of-root `dirGrant` card; `web_fetch`'s and `browser`'s
 * dangerous-domain floors (which move with the capability tools, P8b-12); bash's always-card
 * escalation args; and the safety reviewer. It also performs no rules-store READ, so a standing
 * rule that silences a card today does not silence it here — Winter's own rule stages do that.
 */
export function canUseToolFor(deps: CanUseToolDeps): CanUseTool {
  const log = deps.log ?? consoleBridgeLogger;
  const now = deps.now ?? (() => Date.now());
  const threadId = deps.threadId ?? "main";
  const policyNow = (): SessionApprovalPolicy =>
    typeof deps.policy === "function" ? deps.policy() : deps.policy;

  const askQuestion = askUserQuestionBridge({
    sessionId: deps.sessionId,
    threadId,
    questions: deps.questions,
    emit: deps.emit,
    log,
    now,
  });

  return async (toolName, input, ctx): Promise<PermissionResult> => {
    // (1) A question, not a permission.
    if (toolName === ASK_USER_QUESTION_TOOL) {
      return await askQuestion(ctx.toolUseID, input, ctx);
    }

    // (2) THE CONTROL-PLANE FENCE (P8b-27b) — before the gate, under EVERY policy, `bypass`
    // included. The deny rules `buildWinterOptions` passes are the child's own first line, but a
    // deny rule under `bypassPermissions` REACHES `canUseTool` rather than auto-denying (surface
    // map §5.2), so this host-side check is the thing that actually holds. Without it a child under
    // `auto`/`acceptEdits` — the modes where no human ever sees the write — could edit
    // `<any>/.norma/permissions.local.json` and grant itself a standing rule.
    const fenced = controlPlaneTargetForCall(toolName, input, deps.cwd ?? "");
    if (fenced) {
      log.info(`canUseTool: deny session=${deps.sessionId} tool=${toolName} reason=control-plane`);
      return { behavior: "deny", message: controlPlaneDenialMessage(toolName, fenced.path) };
    }

    // (3) Winter's OWN four default tools are allowed silently in every mode (P8b-28). Checked
    // after the fence (they name no paths, so this is ordering hygiene, not a hole) and before the
    // gate, because two of the four — `ReadNotifications`, `advisor` — have no Norma name at all
    // and would otherwise fail closed to a card in code and a deny in dispatch/chat.
    if (WINTER_OWN_TOOL_NAMES.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // (4) Already aborted: deny without touching the broker or the event stream.
    if (ctx.signal.aborted) {
      return { behavior: "deny", message: `${toolName} was not run — the turn was aborted before the approval could be raised.` };
    }

    const policy = policyNow();
    const gateToolName = gateToolNameFor(toolName);
    let decision = deps.gate.evaluate(gateToolName, policy);

    // (5) engine.ts:4341 — dont-ask declines everything it would otherwise card, with no prompt.
    if (decision === "ask" && policy === "dont-ask") decision = "deny";

    // (5b) P8b-31 — THE SANDBOX-ESCAPE FLOOR. `engine.ts:4518`'s branch condition is
    //   `call.name === "bash" && bashEscalation.dangerouslyDisableSandbox
    //    && !unsandboxedRuleAllowed && meta.approvalPolicy !== "bypass"`
    // and its own comment enumerates the disposition: plan denied it (the deny branch), dont-ask
    // denied it (the ask→deny flip above), bypass ran it silently (the branch guard), and
    // auto/ask/accept-edits all CARD. The gate cannot see arguments, so it returns a flat `allow`
    // for `bash` under `auto` — which on the Winter leg would run a FULL SANDBOX ESCAPE with no
    // human in the loop, in code and dispatch alike. Re-asserted here because the bridge is the
    // only place left that can: Winter surfaces exactly this call at `canUseTool` in every mode.
    //
    // Placed AFTER the dont-ask flip so plan/dont-ask keep their denies, and gated on
    // `decision === "allow"` + `policy !== "bypass"` so it reproduces the engine's condition
    // exactly — `ask`/`accept-edits` already resolve to `"ask"` and are untouched, and `bypass`
    // keeps running it silently. `!unsandboxedRuleAllowed` has no analogue here: the bridge performs
    // no rules-store read at all, so a standing `BashUnsandboxed(...)` rule does NOT pre-clear an
    // escape on this leg — strictly more conservative than today, and recorded as such.
    if (decision === "allow" && policy !== "bypass" && isUnsandboxedBashEscape(gateToolName, input)) {
      decision = "ask";
    }

    // A POLICY deny is not a user rejection — today it is a plain `isError` tool result and the
    // turn continues (only `deniedByHuman` ends it, engine.ts:5876-5882). `decisionClassification`
    // is deliberately omitted on both policy paths: claiming `user_reject` for "plan mode forbids
    // this" would, if the runtime treats that class as turn-ending, kill a planning turn on the
    // model's first `Bash` attempt.
    if (decision === "deny") {
      log.info(`canUseTool: deny session=${deps.sessionId} tool=${toolName} policy=${policy} reason=gate`);
      return { behavior: "deny", message: deniedByPolicyMessage(policy) };
    }
    if (decision === "allow") {
      return { behavior: "allow", updatedInput: input };
    }

    // (6) "ask" — and a session that never prompts denies instead (P8b-7 / P8b-26).
    const never = neverPromptsAs(deps);
    if (never) {
      log.info(`canUseTool: deny session=${deps.sessionId} tool=${toolName} policy=${policy} reason=never-prompts mode=${deps.mode} origin=${deps.origin ?? "none"}`);
      return { behavior: "deny", message: neverPromptsMessage(toolName, never, policy) };
    }

    return await raiseCard(deps, { log, now, threadId, policy }, toolName, gateToolName, input, ctx);
  };
}

/**
 * **Does this session ever raise an approval card?** (P8b-26.)
 *
 * Returns the word the refusal names itself with, or `undefined` when the session DOES prompt.
 *
 * Two disjoint reasons, and the second is the one P8b-7 was actually written about. A dispatch
 * session's own turns run in `mode: "dispatch"` — but the work is done by its CHILDREN, which
 * `agent/dispatch-children.ts` spawns as ordinary CODE sessions (Norma map §2.3: "they are ordinary
 * Code sessions") distinguished only by `meta.origin === "dispatch-child"`, and whose cards are
 * MIRRORED into the dispatch stream. Keying only on `mode` would therefore have left exactly the
 * cards the ruling names still prompting, in a code-mode session nobody is watching.
 *
 * The returned word is what `<mode>` reads as in the message. A dispatch child is `mode: "code"`,
 * so naming it "this code session never prompts" would be simply false — it is a dispatch child,
 * and the message says so.
 */
/** A `bash` call asking for a full sandbox escape (`dangerouslyDisableSandbox: true`). Takes the
 *  NORMA tool name — the escape arg is Norma's own, and the Winter built-in that carries it arrives
 *  as `Bash`. Exported so the matrix test can pin the predicate as well as the verdict. */
export function isUnsandboxedBashEscape(gateToolName: string, input: unknown): boolean {
  if (gateToolName !== "bash") return false;
  if (typeof input !== "object" || input === null) return false;
  return (input as Record<string, unknown>).dangerouslyDisableSandbox === true;
}

export function neverPromptsAs(deps: { mode: SessionMode; origin?: string }): string | undefined {
  if (deps.origin === "dispatch-child") return "dispatch";
  if (deps.mode !== "code") return deps.mode;
  return undefined;
}

async function raiseCard(
  deps: CanUseToolDeps,
  env: { log: BridgeLogger; now: () => number; threadId: string; policy: SessionApprovalPolicy },
  toolName: string,
  gateToolName: string,
  input: Record<string, unknown>,
  ctx: Parameters<CanUseTool>[2],
): Promise<PermissionResult> {
  const { sessionId } = deps;
  // `callId` IS Winter's `toolUseID`: it is the id the projector stamps on this call's `tool_call`
  // event, so a client can line the card up with the tool row it belongs to — the same relationship
  // `call.callId` has in the engine. `requestId` is carried in the record instead; it is re-minted
  // whenever Winter re-evaluates against a newer `policyVersion`, so it is the wrong key for a card
  // a human may already be looking at.
  const callId = ctx.toolUseID;

  // A second request for the SAME toolUseID (Winter re-asking after a policy-version bump) would
  // otherwise orphan the first promise inside the broker's Map — `wait()` overwrites the entry,
  // and the overwritten `resolve` is never called and its timer never cleared. That is a leak, not
  // a fail-closed outcome, so the stale one is explicitly settled first.
  if (deps.approvals.pendingMeta(sessionId, callId)) {
    env.log.info(`canUseTool: superseding a pending approval session=${sessionId} call=${callId}`);
    deps.approvals.resolve(sessionId, callId, false, "superseded");
  }

  const argsJson = safeArgsJson(input);
  // Digest item 46: a bridge-provided description is the PREFERRED card text and a host must not
  // reconstruct a weaker summary from the tool name — so Norma's own composer is the FALLBACK.
  //
  // **`title` and `displayName` are deliberately NOT consulted.** Their per-call semantics cannot
  // be confirmed from the installed `.d.ts` (the descriptors live in the private runtime package),
  // and the likely reading is that they are the TOOL's names — per-tool, not per-call ("Bash",
  // "Bash command"). If either is populated on every request, using it would shadow
  // `approvalCardSummary` on EVERY card: the human would read "Bash" where today they read
  // "bash rm -rf x", i.e. approving a command they were never shown. `description` is the only one
  // of the three whose name promises per-call text. Revisit in Task 9/16 once the runtime's
  // population of `title`/`displayName` is observed on a live child.
  const summary = firstNonEmpty(ctx.description)
    ?? approvalCardSummary({ name: gateToolName, argsJson });
  const options = approvalOptionsFromSuggestions(ctx.suggestions)
    ?? approvalOptionsFor({ name: gateToolName, argsJson });

  const issuedAt = env.now();
  const expiresAt = issuedAt + NO_PARK_TIMEOUT_MS;
  const record: BridgedApprovalRequest = {
    sessionId, callId, toolName, gateToolName,
    requestId: ctx.requestId,
    agentID: ctx.agentID,
    suggestions: ctx.suggestions,
    decisionReason: ctx.decisionReason,
    blockedPath: ctx.blockedPath,
    summary, options, issuedAt, expiresAt,
  };

  // Register the wait BEFORE emitting: the append/broadcast is synchronous, so a watcher that
  // answers the instant it sees the event would otherwise race an unregistered wait into a lost
  // response (engine.ts's and buildLeasePolicy's identical wait-before-emit comments).
  const waiting = deps.approvals.wait(sessionId, callId, NO_PARK_TIMEOUT_MS, {
    toolName: record.gateToolName, summary, issuedAt, expiresAt, options,
  });

  try {
    deps.emit({
      type: "approval_requested", sessionId, threadId: env.threadId, callId,
      toolName: record.gateToolName, summary, issuedAt, expiresAt, options,
    });
  } catch (err) {
    // Emit failed (e.g. disk): settle the registered waiter now rather than leaving it parked for
    // ~24.8 days, and deny — the engine rethrows here, but a `canUseTool` that throws is turned
    // into an opaque deny by the runtime, so the bridge returns the explainable one itself.
    deps.approvals.resolve(sessionId, callId, false, "emit-failure");
    await waiting;
    env.log.error(`canUseTool: failed to emit approval_requested session=${sessionId} call=${callId}: ${(err as Error).message}`);
    return { behavior: "deny", message: `${toolName} was not run — this session could not raise an approval request.` };
  }

  // Abort withdraws the card: the broker is settled with `approved:false`, which makes the
  // `approval_resolved` below the withdraw event. There is no separate turn-end withdraw in the
  // engine today — `approval_resolved{approved:false, by:<reason>}` is the only shape it ever
  // emits for an unapproved card (`by:"timeout"`, `by:"emit-failure"`), and `by` is an open string.
  const onAbort = () => { deps.approvals.resolve(sessionId, callId, false, "aborted"); };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  let res: Awaited<typeof waiting> | null | undefined;
  try {
    res = await waiting;
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }

  // Fail closed on a broker that answered with nothing at all (P8b-19): `null`/`undefined` is
  // never a silent allow.
  const approved = !!res && typeof res === "object" && res.approved === true;
  const by = (res && typeof res === "object" && typeof res.by === "string" && res.by) || "unknown";
  const optionId = res && typeof res === "object" ? res.optionId : undefined;

  deps.emit({ type: "approval_resolved", sessionId, threadId: env.threadId, callId, approved, by });

  if (!approved) {
    env.log.info(`canUseTool: resolved deny session=${sessionId} call=${callId} by=${by}`);
    // `user_reject` is claimed ONLY for an actual human answer. A timeout, an abort, a supersede or
    // an emit failure is "nobody answered", not "the user refused" — and the classification is a
    // signal the runtime may act on, so mislabelling a machine outcome as a rejection risks
    // turn-ending behaviour on a case today's engine simply reports as an `isError` tool result.
    const machine = by === "timeout" || by === "aborted" || by === "superseded" || by === "emit-failure" || by === "unknown";
    // `interrupt: true` on a HUMAN denial only (`PermissionResult`'s deny arm,
    // `permissions/types.d.ts:64`). Today an explicit human "no" ENDS the turn
    // (`engine.ts:5876-5882`), and the comment there states the reason: without it the model
    // re-submits the same command and the AI reviewer re-approves it in-turn with no second human
    // confirmation — "a real gate bypass". A machine outcome must NOT interrupt: nobody refused, so
    // ending the turn would turn a timeout into a dead session.
    return {
      behavior: "deny",
      ...(machine ? {} : { interrupt: true as const }),
      message: by === "timeout"
        ? `${toolName} was not run — nobody answered the approval request.`
        : by === "aborted"
        ? `${toolName} was not run — the turn was aborted while the approval was pending.`
        : by === "superseded"
        ? `${toolName} approval was re-requested under a newer policy; this request is void. Nobody refused it.`
        : by === "emit-failure" || by === "unknown"
        ? `${toolName} was not run — the approval request could not be completed. Nobody refused it.`
        : `The user denied this ${toolName} action — it was NOT run. Stop here and wait for the user to tell you how to proceed. Do not retry it, rephrase it, or attempt a workaround; the user will give further instructions.`,
      ...(machine ? {} : { decisionClassification: "user_reject" as const }),
    };
  }

  const chosen = optionId ? record.options?.find((o) => o.id === optionId) : undefined;
  env.log.info(`canUseTool: resolved allow session=${sessionId} call=${callId} by=${by} option=${optionId ?? "none"}`);
  const updatedPermissions = updatedPermissionsFor(chosen);
  return {
    behavior: "allow",
    updatedInput: input,
    ...(updatedPermissions ? { updatedPermissions } : {}),
    decisionClassification: updatedPermissions ? "user_permanent" : "user_temporary",
  };
}

function firstNonEmpty(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim() !== "") return v;
  return undefined;
}

/** `JSON.stringify` that can never throw on a cyclic/unserializable input — the card composers take
 *  a raw args string, and an approval must not die because a tool's input had a cycle in it. */
function safeArgsJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}
