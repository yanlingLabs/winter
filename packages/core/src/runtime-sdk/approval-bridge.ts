import { resolve, sep } from "node:path";
import type { CanUseTool, PermissionResult, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";
import type { ApprovalOption, NewSessionEvent } from "@norma/protocol";
import { ApprovalBroker, approvalCardSummary, approvalOptionsFor } from "../agent/approvals";
import type { QuestionBroker } from "../agent/questions";
import type { PermissionGate, SessionApprovalPolicy } from "../agent/gate";
import { parseRule } from "../agent/permission-rules";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { gateClassFor, gateToolNameFor, WINTER_OWN_TOOL_NAMES } from "./tool-names";
import { controlPlaneTargetForCall, controlPlaneDenialMessage } from "./control-plane";
import { outdirPath } from "../sessions/outdir";
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
  /** NORMA_HOME. Used ONLY to recognise this session's own `$OUTDIR` as a blessed write target
   *  (see `isBlessedOutputPath`); absent means every Winter escalation is escalated, the
   *  conservative answer. */
  home?: string;
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
  /**
   * P8c-14 (integration round 2): lane 2's `planBridgeFor(...)` (`runtime-sdk/plan-bridge.ts`),
   * consulted here BEFORE the generic gate/never-prompt logic whenever the incoming call is
   * `ExitPlanMode` (Winter's own spelling — `tool-names.ts`'s `WINTER_NORMA_TOOL_PAIRS` maps it to
   * `exit_plan_mode`, but the dispatch switch below sees the WIRE name). Typed as the Interfaces
   * block's original `(req: BridgedApprovalRequest) => Promise<PermissionResult>` — the concrete
   * `PlanBridge.onExitPlanMode` actually takes `BridgedPlanRequest` (`BridgedApprovalRequest` plus
   * a `plan: string` field plan-bridge.ts's own header comment explains at length); a real
   * `PlanBridge` still satisfies this narrower method-shorthand type (bivariant method checking,
   * the same trick `WinterLegDeps.planBridge` uses), and `planRequestFor` below always builds the
   * WIDER `BridgedPlanRequest`-shaped object so the concrete bridge gets its `plan` field regardless
   * of what this deps type says. Absent ⇒ `ExitPlanMode` falls through to the ordinary gate path
   * (today: an unclassified tool name, `"ask"`-shaped) — never a crash, matching every other
   * optional dep in this file. */
  planBridge?: { onExitPlanMode(req: BridgedApprovalRequest): Promise<PermissionResult> };
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

/**
 * Is `blockedPath` this session's OWN `$OUTDIR`, `<home>/outputs/<sessionId>`?
 *
 * Winter's protected-write check flags it only because it carries a `.norma` segment
 * (`permissions/protected.ts:154-194` matches `brand.homeDirName`), but Norma blessed that exact
 * directory as agent-writable for this session and folded it into the session's own write fence
 * (`sessions/outdir.ts`). The blessing is keyed by sessionId, never by the bare `~/.norma/outputs/`
 * prefix, so one session can never reach another's — and that is preserved here by building the
 * prefix from `deps.sessionId`.
 *
 * `false` whenever `home` is not wired (the conservative answer: escalate), and for any path that is
 * not under this session's own outputs directory.
 */
export function isBlessedOutputPath(deps: { home?: string; sessionId: string }, blockedPath: string): boolean {
  if (!deps.home || !blockedPath) return false;
  let prefix: string;
  try {
    prefix = outdirPath(deps.home, deps.sessionId);   // throws on a sessionId that is not a safe segment
  } catch {
    return false;
  }
  const p = resolve(blockedPath);
  return p === prefix || p.startsWith(prefix + sep);
}

/** A `bash` call asking for a full sandbox escape (`dangerouslyDisableSandbox: true`). Takes the
 *  NORMA tool name — the escape arg is Norma's own, and the Winter built-in that carries it arrives
 *  as `Bash`. Exported so the matrix test can pin the predicate as well as the verdict. */
export function isUnsandboxedBashEscape(gateToolName: string, input: unknown): boolean {
  if (gateToolName !== "bash") return false;
  if (typeof input !== "object" || input === null) return false;
  return (input as Record<string, unknown>).dangerouslyDisableSandbox === true;
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

/**
 * `ExitPlanMode`'s `canUseTool` request → the `BridgedApprovalRequest`-shaped object
 * `deps.planBridge.onExitPlanMode` needs, WIDENED with `plan` (`BridgedPlanRequest`,
 * `plan-bridge.ts`) so the concrete `planBridgeFor(...)` bridge — which reads `sessionId`,
 * `callId` and `plan` and nothing else — gets its plan text regardless of what `CanUseToolDeps`'s
 * own (narrower) method type says. Building a typed variable rather than passing an object literal
 * is what lets the extra `plan` field through with no cast (an object literal assigned straight
 * into a call would fail TS's excess-property check; a variable reference structurally satisfying
 * the narrower type does not, per plan-bridge.ts's own header comment). Every other field mirrors
 * `raiseCard`'s own record for parity, even though the plan bridge does not read them.
 */
function planRequestFor(
  deps: CanUseToolDeps,
  toolName: string,
  gateToolName: string,
  input: Record<string, unknown>,
  ctx: Parameters<CanUseTool>[2],
  now: () => number,
): BridgedApprovalRequest & { plan: string } {
  const argsJson = safeArgsJson(input);
  const summary = approvalCardSummary({ name: gateToolName, argsJson });
  const issuedAt = now();
  const expiresAt = issuedAt + NO_PARK_TIMEOUT_MS;
  const plan = typeof input.plan === "string" ? input.plan : "";
  return {
    sessionId: deps.sessionId, callId: ctx.toolUseID, toolName, gateToolName,
    requestId: ctx.requestId, agentID: ctx.agentID, suggestions: ctx.suggestions,
    decisionReason: ctx.decisionReason, blockedPath: ctx.blockedPath,
    summary, issuedAt, expiresAt, plan,
  };
}

export function canUseToolFor(deps: CanUseToolDeps): CanUseTool {
  const log = deps.log ?? consoleBridgeLogger;
  const now = deps.now ?? (() => Date.now());
  const threadId = deps.threadId ?? "main";
  const policyNow = (): SessionApprovalPolicy =>
    typeof deps.policy === "function" ? deps.policy() : deps.policy;
  // Per-callId suppression counts for the supersede path — see `raiseCard`'s supersede branch.
  const state: BridgeState = { supersededEmits: new Map() };

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
    // included.
    //
    // NOT because Winter's own deny rules are weak — the opposite. A matched stage-2 managed deny
    // returns `decision: "deny"` OUTRIGHT (`permissions/evaluator.ts:1350-1364` at `v0.0.3`) and
    // runs BEFORE the mode stage (`:1008`), so it binds under `bypassPermissions` too and **never
    // reaches `canUseTool`**. (An earlier revision of this comment claimed the reverse; it was
    // wrong, and the same wrong sentence was fixed in `control-plane.ts` first.)
    //
    // This fence exists to cover what Winter's rules do NOT: it is Norma's own invariant, enforced
    // in Norma's own vocabulary, on BOTH tool-name spellings, over every path-bearing field
    // including `MultiEdit`'s nested `edits[]` — and it does not depend on Winter's rule grammar
    // continuing to mean what it means today (the anchor semantics that made 16 of those 28 rules
    // inert are exactly the kind of thing that can move under an SDK bump). Two independent layers
    // over one invariant, which is the right number for a self-grant.
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

    // (4b) P8c-14 (integration round 2): `ExitPlanMode` — Winter's OWN wire name (`tool-names.ts`'s
    // `WINTER_NORMA_TOOL_PAIRS` maps it to `exit_plan_mode`, but `toolName` here is what the CHILD
    // called) — is answered through the plan bridge BEFORE the generic gate/never-prompt logic
    // below: a plan presentation is not a permission decision the mode-based never-prompt rule or
    // the approval policy should ever see (dispatch/chat never enter plan mode in the first place,
    // and CODE mode's plan/ask/auto verdicts have nothing to do with "should this plan be shown").
    // Absent `deps.planBridge` falls straight through to the ordinary path below, unchanged.
    if (toolName === "ExitPlanMode" && deps.planBridge) {
      return await deps.planBridge.onExitPlanMode(planRequestFor(deps, toolName, gateToolNameFor(toolName), input, ctx, now));
    }

    const policy = policyNow();
    // TWO names, deliberately (review F5). `gateToolName` is what the CARD and the EVENT say — the
    // display name. `classificationName` is what the GATE is asked about, which for a tool with an
    // explicit gate class is a different Norma name entirely: `Monitor` displays as itself but is
    // classified as `bash`, because its command half uses the Bash permission family and a
    // display-derived `bash_output` would be a silent allow under every policy.
    const gateToolName = gateToolNameFor(toolName);
    const classificationName = gateClassFor(toolName);
    let decision = deps.gate.evaluate(classificationName, policy);

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
    if (decision === "allow" && policy !== "bypass" && isUnsandboxedBashEscape(classificationName, input)) {
      decision = "ask";
    }

    // (5c) WINTER'S OWN ESCALATIONS must never be answered by a blanket allow — and must never be
    // turned into a refusal either. Checked BEFORE the verdict is acted on; placing this after the
    // `allow` return would make it dead code, which is the failure mode it exists to prevent.
    //
    // **`blockedPath` is Winter asking, not Winter refusing** (review F1 — the correction). Its one
    // producer in the pinned runtime is the protected-write standing exception
    // (`permissions/evaluator.ts:946-953`), whose message reads *"Denied: protected path write
    // requires approval (WS-07 §6.7)"* and which resolves to `mustPrompt` — i.e. *route this to the
    // human*. Treating it as an unconditional deny meant a session could never edit `package.json`,
    // a lockfile, anything under `.git/`, or **write to `$OUTDIR`** — even with a human sitting in
    // front of the card. So it gets exactly the `matchedAskRule` treatment: escalate to `"ask"`.
    //
    //  - `blockedPath` / `matchedAskRule` → an `allow` becomes `"ask"`: a card in code, the
    //    never-prompt deny in dispatch/chat. A gate `deny` STAYS a deny — an escalation may never
    //    WIDEN a verdict, only narrow it.
    //  - the ONE exception is `$OUTDIR`, `<home>/outputs/<sessionId>`: a path Winter's protected
    //    check flags only because it contains a `.norma` segment, and which Norma has explicitly
    //    blessed as agent-writable for this session (`sessions/outdir.ts` — "a blessed,
    //    agent-writable exception under `~/.norma`", folded into the session's own write fence).
    //    The host DOES have standing there, so the gate's verdict stands unescalated. Without this a
    //    dispatch session could not write its own deliverable at all.
    //  - the control plane is NOT reached by any of this: `controlPlaneTargetForCall` above already
    //    returned a hard deny for it, independently and under every policy.
    //
    // `decisionReason` is deliberately NOT acted on — informational only, logged. It is a free-form
    // string attached to decisions of every kind, its vocabulary lives in the private runtime, and
    // treating its mere presence as a block would card or deny calls the child was happy with.
    if (ctx.decisionReason) {
      log.info(`canUseTool: winter reason session=${deps.sessionId} tool=${toolName} code=${ctx.decisionReason.slice(0, 64)}`);
    }
    // TWO flags, not one (review n2). The `$OUTDIR` blessing answers the PROTECTED-PATH signal and
    // nothing else; folding both signals into a single flag made a blessed path also suppress a
    // co-occurring `matchedAskRule`, which reads as if the carve-out were scoped to `blockedPath`
    // when it was not. Unreachable at `v0.0.3` (the two come from mutually exclusive stages), but
    // the scoping should be true in the code, not only in practice.
    const protectedPathEscalates = ctx.blockedPath !== undefined
      && !isBlessedOutputPath(deps, ctx.blockedPath);
    const askRuleEscalates = ctx.matchedAskRule !== undefined;
    if (decision === "allow" && (protectedPathEscalates || askRuleEscalates)) {
      log.info(`canUseTool: escalate session=${deps.sessionId} tool=${toolName} reason=${protectedPathEscalates ? "winter-protected-path" : "winter-ask-rule"}`);
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
      // Named as the MODEL called it: this message is a tool result the model reads, and naming a
      // tool it did not call would be confusing. The EVENT surface uses the Norma name (P8b-25).
      return { behavior: "deny", message: neverPromptsMessage(toolName, never, policy) };
    }

    return await raiseCard(deps, { log, now, threadId, policy, state }, toolName, gateToolName, input, ctx);
  };
}

/** Per-`canUseToolFor` mutable state. Only the supersede path needs any. */
interface BridgeState {
  /** `callId` → how many stale invocations must SKIP their own `approval_resolved` emit, because
   *  the superseding invocation already emitted it synchronously and in the right order. */
  supersededEmits: Map<string, number>;
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
export function neverPromptsAs(deps: { mode: SessionMode; origin?: string }): string | undefined {
  if (deps.origin === "dispatch-child") return "dispatch";
  if (deps.mode !== "code") return deps.mode;
  return undefined;
}

async function raiseCard(
  deps: CanUseToolDeps,
  env: { log: BridgeLogger; now: () => number; threadId: string; policy: SessionApprovalPolicy; state: BridgeState },
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
  //
  // **THE ORDERING IS LOAD-BEARING, and it is why the emit happens HERE rather than in the stale
  // invocation.** `resolve()` settles the stale promise, but that invocation's own
  // `approval_resolved` would be emitted from a MICROTASK continuation — i.e. after this invocation
  // has already synchronously emitted the replacement `approval_requested` for the SAME `callId`.
  // Every client resolves pending cards by `callId` alone (`SessionModel.swift`'s
  // `resolvePending(s, callId:)`), so the stale resolution would dismiss the LIVE card, and with no
  // park timeout the child would then wait ~24.8 days on a card nobody can answer — strictly worse
  // than the orphaned timer this guard was written for. Emitting the withdrawal here, before the
  // new request, makes the order structural rather than a matter of scheduling; the stale
  // invocation skips its own emit via the suppression count.
  if (deps.approvals.pendingMeta(sessionId, callId)) {
    env.log.info(`canUseTool: superseding a pending approval session=${sessionId} call=${callId}`);
    env.state.supersededEmits.set(callId, (env.state.supersededEmits.get(callId) ?? 0) + 1);
    deps.approvals.resolve(sessionId, callId, false, "superseded");
    deps.emit({ type: "approval_resolved", sessionId, threadId: env.threadId, callId, approved: false, by: "superseded" });
  }

  const argsJson = safeArgsJson(input);
  // **`approvalCardSummary` is the ONLY source of card text.** `ctx.title`, `ctx.displayName` and
  // `ctx.description` are all deliberately ignored.
  //
  // Digest item 46 says a bridge-provided description is the PREFERRED text and a host "MUST NOT
  // reconstruct a weaker summary from `toolName`" — but the pinned runtime settles what these three
  // actually are, and it is not per-call text. At `v0.0.3`,
  // `packages/runtime/src/permissions/prompt-stage.ts:38-42` states they are "NOT part of this wire
  // payload at all — title/displayName/description need a tool registry (WS-06, P3) this runtime
  // doesn't have yet". So today they are never populated, and when a later SDK does populate them
  // from that registry they will be the TOOL's text, not the CALL's. Preferring any of them would
  // then shadow the composer on EVERY card: the human would read "Bash" where they read
  // "bash rm -rf x" today — approving a command they were never shown.
  //
  // Revisit only when a per-call semantic is observed on a live child, never on the field name.
  const summary = approvalCardSummary({ name: gateToolName, argsJson });
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
    return { behavior: "deny", message: `${gateToolName} was not run — this session could not raise an approval request.` };
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
  } catch (err) {
    // A REJECTING broker. Unreachable with the real one (`wait` only ever resolves), but this is a
    // boundary whose entire job is "never leave a pending card": letting the rejection propagate
    // would fail closed for the MODEL (the runtime converts a throw to a typed deny) while leaving
    // the phone's card and `approval.list` entry uncleared forever. Settle, withdraw, then deny.
    deps.approvals.resolve(sessionId, callId, false, "broker-error");
    deps.emit({ type: "approval_resolved", sessionId, threadId: env.threadId, callId, approved: false, by: "broker-error" });
    env.log.error(`canUseTool: approval broker rejected session=${sessionId} call=${callId}: ${(err as Error).message}`);
    return { behavior: "deny", message: `${gateToolName} was not run — the approval request could not be completed. Nobody refused it.` };
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }

  // Fail closed on a broker that answered with nothing at all (P8b-19): `null`/`undefined` is
  // never a silent allow.
  const approved = !!res && typeof res === "object" && res.approved === true;
  const by = (res && typeof res === "object" && typeof res.by === "string" && res.by) || "unknown";
  const optionId = res && typeof res === "object" ? res.optionId : undefined;

  // A stale invocation whose card was already withdrawn by the SUPERSEDING one must not emit a
  // second `approval_resolved` — the withdrawal was emitted in the right order up in the supersede
  // branch, and a duplicate arriving here (after the replacement request) would dismiss the live
  // card, which is the whole defect that ordering fixes.
  const suppressions = env.state.supersededEmits.get(callId) ?? 0;
  if (by === "superseded" && suppressions > 0) {
    if (suppressions > 1) env.state.supersededEmits.set(callId, suppressions - 1);
    else env.state.supersededEmits.delete(callId);
  } else {
    deps.emit({ type: "approval_resolved", sessionId, threadId: env.threadId, callId, approved, by });
  }

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
        ? `${gateToolName} was not run — nobody answered the approval request.`
        : by === "aborted"
        ? `${gateToolName} was not run — the turn was aborted while the approval was pending.`
        : by === "superseded"
        ? `${gateToolName} approval was re-requested under a newer policy; this request is void. Nobody refused it.`
        : by === "emit-failure" || by === "unknown"
        ? `${gateToolName} was not run — the approval request could not be completed. Nobody refused it.`
        : `The user denied this ${gateToolName} action — it was NOT run. Stop here and wait for the user to tell you how to proceed. Do not retry it, rephrase it, or attempt a workaround; the user will give further instructions.`,
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

/** `JSON.stringify` that can never throw on a cyclic/unserializable input — the card composers take
 *  a raw args string, and an approval must not die because a tool's input had a cycle in it. */
function safeArgsJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input ?? {}) ?? "{}";
  } catch {
    return "{}";
  }
}
