// Phase 8c Lane 3, Tasks 3.2-3.4 — the Winter-leg `Options.hooks` wiring, gated on the P8c-7
// measurement (`test/runtime-sdk/hooks-measure.e2e.test.ts`: measured = YES — a real spawned
// `winter` child round-trips `PreToolUse`/`PostToolUse` callbacks through the wrapper's stdio
// "hook" control request, and a `PreToolUse` deny genuinely blocks the call). This module is the
// ONE place that builds the four features the retired engine ran through its own `cfg.hooks`
// facade + dispatch-loop call sites, re-expressed as SDK `HookCallback`s:
//
//   1. Plugin manifest hooks (`plugins/hook-runner.ts` + `hook-registry.ts`'s `HookFacade`) — a
//      `PreToolUse` group with no matcher (fires for every tool) that can DENY, a `PostToolUse`
//      group (also unmatched) that observes every COMPLETED call, and a `PostToolUseFailure` group
//      (review r1 MAJOR 2) that observes every FAILED one — the SDK routes failures to a separate
//      event rather than `PostToolUse` with `is_error` set, and the retired engine's own
//      `firePostTool` ran on both. Every `HookFacade.runFor` call here is wrapped so a throwing
//      facade (review r1 MAJOR 1) degrades to "no verdict" rather than propagating into the child.
//   2. The bash-safety reviewer (`agent/reviewer.ts`'s `BashReviewer`) — a `PreToolUse` group
//      matched on `"Bash"`, gated to Winter's `auto` policy exactly as the retired engine gated it
//      (`meta.approvalPolicy === "auto" && reviewerReady`, engine.ts:4547-4548): the reviewer is a
//      GATE for auto-policy calls, never a second opinion layered under `ask`/`accept-edits`, whose
//      human card already exists on this leg through the approval bridge.
//   3. Diagnostics-after-edit (`agent/lsp/auto-diagnostics.ts`, ported to Winter's own tool
//      names/shapes at Task 3.2) — a `PostToolUse` group per file-mutating tool that appends the
//      diagnostics block as `additionalContext`.
//   4a. The DANGEROUS-DOMAIN FLOOR on the two web built-ins (2026-09-18, user ruling; §5 below) —
//      a `PreToolUse` group per web tool: `WebFetch` on a floor host is DENIED with one fixed
//      refusal, and `WebSearch` carries the floor into the call itself through `updatedInput`. Not a
//      port of anything the retired engine had: defence in depth over the child's own executor-level
//      `blockedDomains`, earlier and read live (§5 below says why that earns its place).
//   4. The `fileDiff` producer (Task 3.3) — a `PreToolUse` group per file-mutating tool that
//      snapshots the file (bounded by `DIFF_PATCH_MAX_BYTES`; over the bound, or unreadable, or
//      outside the session's fence: no diff, never an error) and a `PostToolUse` group that diffs,
//      persists via `diffs/store.writeDiff`, and hands the summary to the projector through the
//      controller-owned `runtime-sdk/diff-attach.ts` seam (`attachFileDiff`/`takeFileDiff`).
//
// **`sessionHooksFor` is called ONCE PER SESSION**, at the same point `mode-options.ts`'s
// `buildWinterOptions` builds that session's `Options` — mirroring how `WinterOptionsInput` itself
// is a one-shot, per-session builder input, not a daemon-wide facade re-consulted with a
// `sessionId` parameter the way the retired engine's `cfg.hooks` was. `deps.sessionId`/`cwd`/
// `roots`/`tmpDir`/`home` are therefore fixed for the life of the session; the settings-derived
// fields (`reviewerEnabled`, `reviewerAllow`, `policy`, `autoDiagnosticsEnabled`) are LIVE getters
// re-read on every call — the callbacks these build persist for the session's whole life and are
// invoked on every matching tool call, so a hot settings change (CLAUDE.md's "no setting may ever
// require a daemon restart") takes effect on this session's very next matching call, not just on
// the next session.
//
// **One leg (WS-23).** This builder used to return the same groups twice — `winter` and `official`
// (fix wave M4, ruling P8c-19: the router's official leg merged them after its own containment
// matchers). With the official `claude` leg retired the return value carries `winter` alone; the
// `{ winter }` shape is kept so `session-driver.ts`'s `hooksFor(session).winter` wiring does not move.
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type {
  HookCallback, HookCallbackMatcher, HookJSONOutput, Options,
  PostToolUseFailureHookInput, PostToolUseHookInput, PreToolUseHookInput,
} from "@yanlinglabs/winter-agent-sdk";
import type { FileDiffSummary } from "@yanlinglabs/winter-protocol";
import { SHIPPED_DANGEROUS_DOMAINS, dangerousHostMatch, dangerousUrlMatch, normalizeDangerousDomain } from "../agent/dangerous-domains";
import { BashReviewer, ReviewerNoRunnableModel, bashLooksSafe } from "../agent/reviewer";
import type { SessionApprovalPolicy } from "../agent/gate";
import { AUTO_DIAG_TOOL_NAMES, autoDiagnosticsSuffix } from "../agent/lsp/auto-diagnostics";
import type { LspManager } from "../agent/lsp/manager";
import { resolveWithinAny } from "../agent/paths";
import { computeLineDiff } from "../diffs/myers";
import { DIFF_PATCH_MAX_BYTES, mintDiffId, writeDiff } from "../diffs/store";
import type { HookResult } from "../plugins/hook-runner";
import { attachFileDiff } from "./diff-attach";
import { REVIEWER_ESCALATION_REASON, noteReviewerCleared } from "./bridge-common";
import { ESCAPE_FENCED_FILENAMES, PROJECT_FENCED_SEGMENTS, homeFenceFor, homeFencedDirs, homeFencedFiles, isHomeWriteOnly } from "./home-fence";
import { controlPlaneDenialMessage, controlPlaneTargetForCall } from "./control-plane";
import { protectedPathsFor, protectedReadDenial, protectedWriteDecision, storeWriteDenial } from "./protected-paths";
import { baseName, COMMAND_PREFIXES, inPlaceFiles, nestedCommandStrings, quotedOperatorsAsText, shellSegments, shellWords } from "./shell-words";
export { shellSegments } from "./shell-words";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { connectorAskReason, connectorDenialMessage, connectorFactsFor, connectorVerdict, statedServerFromHookInput, type ConnectorPermissionSource } from "../agent/mcp/connector-permissions";

/** The subset of `plugins/hook-registry.ts`'s `HookFacade` this module depends on — injected
 *  rather than imported concretely so a fake can stand in for tests with no real plugin process
 *  spawned (mirrors that file's own `HookRunnerLike` seam one level up). */
export interface HookFacadeLike {
  runFor(
    event: string,
    extra: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Array<{ pluginId: string; result: HookResult }>>;
}

export interface SessionHooksDeps {
  /** Winter's own session id — what a produced `fileDiff` is filed under (`diffs/store.ts`'s
   *  `<home>/diffs/<sessionId>/` and `diff-attach.ts`'s pending map). */
  sessionId: string;
  /** WINTER_HOME. Absent ⇒ the `fileDiff` producer is skipped entirely (mirrors the retired
   *  engine's `diffSink`-absent fast path in `diff-report.ts`'s `withFileDiff`) — there is nowhere
   *  to persist a patch without it. */
  home?: string;
  /** Fence roots (session cwd first, then any grants) — the SAME roots a file-mutating tool call
   *  itself is resolved against, reused for the diff snapshot read and the diagnostics read. */
  roots: string[];
  tmpDir?: string;

  /** Plugin manifest hooks. Absent ⇒ no plugin-hook wiring (no PreToolUse-deny path, no
   *  PostToolUse observation) — every existing test/daemon wiring without a facade behaves as if
   *  this module did not exist for that concern. */
  hookFacade?: HookFacadeLike;

  /** The bash-safety reviewer. Absent ⇒ the Bash-matched PreToolUse group is never even
   *  registered (no wasted round trip on every Bash call for a daemon that never configured one). */
  reviewer?: BashReviewer;
  /** Hot per-call reads — mirror the retired engine's own `reviewerEnabled`/`reviewerAllow`/
   *  `reviewClassEnabled("bash", …)` cfg getters (default true when absent, same convention). */
  reviewerEnabled?: () => boolean | undefined;
  reviewerAllow?: () => string[] | undefined;
  /** THIS session's live approval policy. The reviewer is an `auto`-ONLY gate — engine.ts:4547-
   *  4548's rule, carried verbatim: under `ask`/`accept-edits`/`plan`/`dont-ask`/`bypass`/`chat`
   *  the human-card/bridge path is the safety net, and layering a second, silent AI opinion under
   *  it was never the design. Absent ⇒ never runs (the conservative default: no reviewer gate
   *  where the caller hasn't wired a way to know the policy). */
  policy?: () => SessionApprovalPolicy | undefined;

  /** Lazy per-session LSP manager accessor — mirrors `capabilities/lsp.ts`'s own `deps.lsp()`
   *  shape. Absent ⇒ the diagnostics-after-edit PostToolUse group is never registered; present but
   *  returning `undefined` at call time (settings.lsp.enabled flipped off) ⇒ that call's suffix is
   *  silently "" (auto-diagnostics' own never-fail contract). */
  lsp?: () => LspManager | undefined;
  /** Hot; default true when absent (mirrors `settings.lsp.autoDiagnostics`'s own default). */
  autoDiagnosticsEnabled?: () => boolean | undefined;

  /**
   * THIS session's project-resolved `settings.permissions.dangerousDomains.added`, read LIVE — the
   * daemon's own `dangerousDomainsAdded(cwd)` getter (project-overlay aware) with this session's cwd
   * already bound, so the floor hook below never has to know how to read settings or which project
   * this session is in. Re-read on every matching web call, so an entry the user adds to
   * `settings.json` is enforced on this session's very NEXT `WebFetch`, with no daemon restart and
   * no new incarnation — the `Options.web.blockedDomains` the child was spawned with cannot do that
   * (a spawned child keeps its own `Options` until it next incarnates), which is one more reason the
   * host-side floor is not merely a duplicate of it.
   *
   * ABSENT IS SAFE, NOT OPEN: the floor hook unions `SHIPPED_DANGEROUS_DOMAINS` itself, so a caller
   * that never wires this still gets the whole shipped floor — only the USER-added half depends on
   * the wiring. A getter that THROWS reads as "no additions" (never propagates into the child).
   */
  dangerousDomainsAdded?: () => readonly string[] | undefined;

  /**
   * WS-21 (spec §7.1, §7.2) — the path fence (`pathFenceHook`). THIS session's mode (a protected write
   * is a card in code and a typed deny in chat and dispatch), its working directory (a relative target
   * resolves against it) and, read LIVE per call, its TRUSTED project root (`projectScopeRootFor(cwd)` — the
   * root the run home loads the project tier from, R.3 I-1 — when `projectScopeTrusted(cwd)`, else `null`:
   * an untrusted project has no project tier to protect). Absent `mode`:
   * the hook treats the session as code, the answer that raises a card rather than none.
   */
  mode?: SessionMode;
  cwd?: string;
  trustedProjectRoot?: () => string | null;

  /**
   * WS-26: the connector permissions — the user's stored allow/ask/deny per connector action and the
   * probe's read-only answers, both read LIVE per call (`agent/mcp/connector-permissions.ts`). Absent ⇒ the
   * connector-permission hook is not registered (every existing test wiring, unchanged).
   */
  connectors?: ConnectorPermissionSource;
  /**
   * The capability server KEYS this incarnation built (`approval-bridge.ts`'s `CanUseToolDeps.capabilityKeys`
   * has the rule): only their `mcp__winter__<key>__*` names are exempt from the connector-permission floor.
   * Absent: every key counts.
   */
  capabilityKeys?: () => ReadonlySet<string> | undefined;
  /**
   * The daemon's audit sink (`<home>/audit.jsonl`). `Search` writes one line per completed call through it,
   * `{kind:"network", tool:"Search", query, outcome}` — the line the daemon's own `Search` wrote before it
   * moved into the agent SDK (see `searchAuditHook`). The query only: never a key, never the answer.
   */
  audit?: (line: Record<string, unknown>) => void;
}

function readRootsOf(roots: string[], tmpDir?: string): string[] {
  return tmpDir ? [...roots, tmpDir] : roots;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

function allow(): HookJSONOutput { return {}; }

function deny(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function ask(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
}

/** An EXPLICIT allow — unlike `allow()` above, which is no opinion at all. The child's hook reducer ranks it
 *  below every deny/defer/ask, so it can never un-deny a floor; what it adds is that the runtime allows the
 *  call before its mode stage (WS-26: a `dont-ask` child denies an unresolved MCP call without ever calling
 *  `canUseTool`, so this is the only way a stored allow or a read-only default reaches one). */
function allowExplicitly(reason: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: reason } };
}

/** A `PreToolUse` INPUT TRANSFORM and NOTHING ELSE — deliberately with no `permissionDecision` at
 *  all. Measured in the pinned agent SDK's hook reducer (`hooks/reducer.ts`, WS-08 §4 rules 2-3): a
 *  hook that proposes a decision contributes its transform only when its own decision's rank EQUALS
 *  the final winning rank across every hook for that event, while a NO-OPINION hook's transform
 *  "always chains (they proposed no decision, so nothing of theirs was ever overridden)". So a bare
 *  `allow` here would have silently dropped the floor's injected `blocked_domains` the moment any
 *  OTHER PreToolUse hook (a plugin's) answered `ask` or `defer` for the same call. */
function transformInput(next: Record<string, unknown>): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: next } };
}

/** Review r1 MAJOR 1: `deps.hookFacade.runFor(...)` is a call into another subsystem (a plugin's
 *  own process, over its RPC) and must never be allowed to kill a hook callback outright — an
 *  uncaught throw here would propagate out of the `HookCallback` itself, which the wrapper's own
 *  `makeHookHandler` turns into a transport-level `hook_threw` failure rather than a clean
 *  allow/deny (`index.js`'s own `console.error("winter: hook callback threw ...")` path) — the
 *  WRONG failure mode for what is supposed to be an F2 fail-open observer/gate. Every call site
 *  below wraps its `runFor` in this so a facade crash degrades to "no plugin verdict" instead of
 *  wedging or erroring the tool call. Logs the error NAME only (never a message that could carry a
 *  plugin's own output) — matches this file's existing "never print a secret value" discipline. */
function logFacadeThrow(where: string, err: unknown): void {
  console.error(`hooks: ${where} threw: ${err instanceof Error ? err.name : String(err)}`);
}

function additionalContext(text: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
}

// ── WS-23: the floors FAIL CLOSED ──────────────────────────────────────────────────────────────
//
// A floor callback that THROWS used to fail OPEN: the child's wrapper answered `hook_threw`, the
// SDK runner recorded a non-blocking error, and the call went ahead -- and under `bypass`, or with a
// matching allow rule, the approval bridge's own fence is never consulted, so nothing else stopped it
// (inv-hooks-mcp A4, "the hole"). Two independent layers close it:
//
//  1. `failClosed(name, hook)` below: a throw inside the callback becomes a DENY, here, before it
//     ever reaches the wire. It covers every runtime -- including one whose SDK predates layer 2.
//  2. `failClosed: true` on the floors' matcher GROUPS (`FailClosedMatcher`): agent SDK WS-23's
//     per-matcher opt-in, under which a floor that TIMES OUT, returns a malformed answer, or never
//     answers because the bridge failed is also a deny, decided by the child's own hook runner.
//     Layer 1 cannot see those cases: they happen outside the callback.
//
// The reason names the floor and says nothing about the failure beyond its error NAME (logged, not
// returned): a floor's input is model-controlled text, and an exception message built from it is
// not something to echo into the model's context or the daemon log verbatim.
function failClosed(name: string, hook: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await hook(input, toolUseID, options);
    } catch (err) {
      console.error(`hooks: the ${name} threw (${err instanceof Error ? err.name : typeof err}); denying the call`);
      return deny(`Denied: Winter's ${name} could not evaluate this call, and it fails closed -- the call was not allowed without its answer.`);
    }
  };
}

/** WS-23: a matcher group carrying the agent SDK's `failClosed` opt-in. Since the pin reached 0.0.27 the
 *  SDK's own `HookCallbackMatcher` declares the identical field and its wrapper serialises it, so this
 *  widening is now a no-op kept for readability (it was a structural widening while the pin was 0.0.24,
 *  whose types did not declare the field). */
type FailClosedMatcher = HookCallbackMatcher & { failClosed?: boolean };

// ── 1. Plugin manifest hooks ───────────────────────────────────────────────────────────────────

/** `PreToolUse`, no matcher (every tool) — mirrors the retired engine's "Site 2" pre-tool fire:
 *  runs every plugin's `pre-tool` hook in registry order and, on the FIRST `blocked` verdict,
 *  denies with the same message shape `hookBlockOutcome` used (`engine.ts:1986-1988`). Fail-open
 *  for `error`/`timeout`/non-blocked `ok` — those are simply not `blocked`, no extra code needed.
 *  Review r1 MAJOR 1: a THROWING facade (a bug in a plugin hook's own process bridge, not a
 *  `blocked`/`error`/`timeout` `HookResult` — those are already handled data, not exceptions) is
 *  caught and treated the same as "no verdict" — never denies, never propagates into the child. */
function pluginPreToolUseHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.hookFacade) return allow();
    const pre = input as PreToolUseHookInput;
    try {
      const results = await deps.hookFacade.runFor(
        "pre-tool",
        { toolName: pre.tool_name, argsJson: safeJson(pre.tool_input), threadId: pre.agent_id ?? "main" },
        pre.session_id,
        signal,
      );
      const blocked = results.find((r) => r.result.status === "blocked");
      if (!blocked) return allow();
      return deny(`blocked by plugin hook ${blocked.pluginId}: ${blocked.result.reason ?? "no reason given"}`);
    } catch (err) {
      logFacadeThrow("the plugin pre-tool hook facade", err);
      return allow();
    }
  };
}

/** `PostToolUse`, no matcher — observe-only (F2 fail-open: results are never consulted). Skipped
 *  entirely for a call the PreToolUse group already denied — Winter never runs the tool in that
 *  case, so `PostToolUse` never fires for it either (unlike the retired engine, which had to track
 *  `blockedCallIds` itself because ONE dispatch loop handled both ends; the SDK's own event
 *  ordering makes that bookkeeping unnecessary here). Fires only for a call that COMPLETED — a
 *  failed call routes to `PostToolUseFailure` instead (below), which is why `isError` is always
 *  `false` here (mirrors the retired engine's `firePostTool`, which only ever saw one branch or the
 *  other per call, never both). Review r1 MAJOR 1: a throwing facade is caught, never propagated. */
function pluginPostToolUseHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.hookFacade) return allow();
    const post = input as PostToolUseHookInput;
    try {
      await deps.hookFacade.runFor(
        "post-tool",
        { toolName: post.tool_name, argsJson: safeJson(post.tool_input), output: safeJson(post.tool_response), isError: false, threadId: post.agent_id ?? "main" },
        post.session_id,
        signal,
      );
    } catch (err) {
      logFacadeThrow("the plugin post-tool hook facade", err);
    }
    return allow();
  };
}

/** `PostToolUseFailure`, no matcher — review r1 MAJOR 2: the retired engine's `firePostTool` ran
 *  on EVERY completed call with the real `isError` (`engine.ts:1972-1988`'s own doc: "observe a
 *  completed call's outcome (both success and isError)"). The SDK routes a failed call to this
 *  SEPARATE event rather than `PostToolUse` with `is_error` set — `sessionHooksFor` previously
 *  registered no handler for it at all, so a plugin's post-tool hook silently never saw a failed
 *  call. `isError: true` and `output` built from the failure's own `error` string (falling back to
 *  the whole input if it is ever absent/malformed) restore that parity. Same never-throw guard as
 *  the success path. */
function pluginPostToolUseFailureHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.hookFacade) return allow();
    const post = input as PostToolUseFailureHookInput;
    try {
      await deps.hookFacade.runFor(
        "post-tool",
        { toolName: post.tool_name, argsJson: safeJson(post.tool_input), output: safeJson(post.error ?? post), isError: true, threadId: post.agent_id ?? "main" },
        post.session_id,
        signal,
      );
    } catch (err) {
      logFacadeThrow("the plugin post-tool-failure hook facade", err);
    }
    return allow();
  };
}

// ── 2a. The control-plane floor for a SANDBOX ESCAPE (every policy, bypass included) ────────────
//
// 2026-09-22 (C3 round 3, lane C). An escape (`dangerouslyDisableSandbox: true`) leaves the seatbelt
// behind, and the seatbelt WAS the bash half of two floors: the control-plane write fence
// (`permissions.local.json` / `settings.json` / `settings.local.json`, where writing one is a
// self-grant — the bridge's own fence at `approval-bridge.ts` (2) reads write-class tool inputs only)
// and the daemon's own state under its home — `run`, `runtimes` (credentials, the socket, the `winter`
// binary `resolveWinterExecutable`'s rung 4 would run), `plugins`, `permissions` (the approved-rules
// store), `cache` (the skill-plugin views), `agents`, `trust.json`: `home-fence.ts`, derived from the
// sandbox's own `denyWrite` so one edit reaches all three fences. Claude keeps its equivalent floor
// bypass-immune (`utils/permissions/permissions.ts` ~1252-1260, `filesystem.ts` ~643-650) and denies
// rather than prompts, so this does the same: a DETERMINISTIC deny, before any reviewer call, under
// every policy (`sessionHooksFor` feeds every session). A PreToolUse deny is terminal ahead of
// every permission mode (agent SDK 0.0.17 `permissions/evaluator.ts` ~1657).
//
// Conservative on purpose: a substring match on the control-plane filenames (plus `trust.json`), on
// any `.winter/agents`, and on every spelling of every fenced home path this file can predict — the
// literal home (and its realpath), `~`/`$HOME`/`${HOME}` for a home under the user's own,
// `$WINTER_HOME`/`${WINTER_HOME}`, `<home basename>/…`, and a relative path after a `cd` into the home —
// over a normalised command (case, quotes, `//`, `/./`). R.3 C-1: and the variables WS-21 exports into
// every child — `$WINTER_STORE_HOME` (`<home>/sdk`), `$WINTER_PLUGIN_CACHE_DIR`/`$CLAUDE_CODE_PLUGIN_CACHE_DIR`
// (`<home>/sdk/plugins`), `$CLAUDE_CONFIG_DIR` and the Winter child's own `$WINTER_HOME` (a run folder
// under `<home>/cache`), braced or not. R.3 re-review B-1: and every command is also read with those variables (and
// `$OUTDIR`) replaced by their absolute values, so a `..` after one — any depth, or through a `cd` chain —
// lands on the literal path it names (`childPathVariableReadings`). `cache` and `plugins` are refused only in a
// write-shaped position (review N1): the model reads and runs plugin skill content there. A false
// positive costs a typed deny the model can route around by running the command sandboxed; a false
// negative costs the floor. A command that builds the path at run time (`$(…)`, variables of its
// own) is beyond any static check — the reviewer still judges what is left.

/**
 * The command as the floor reads it (whole-branch review N2): lowercased (a default macOS volume is
 * case-insensitive), quotes stripped (`~/".winter"/…` is `~/.winter/…` to the shell), and `//`, `/./`
 * and `<seg>/..` collapsed. Static on purpose — a path the command BUILDS at run time is beyond it.
 */
export function normaliseEscapeCommand(command: string): string {
  let c = command.toLowerCase().replace(/["']/g, "");
  let prev: string;
  do {
    prev = c;
    c = c.replace(/\/{2,}/g, "/")
      .replace(/\/\.(?=\/|\s|$)/g, "")
      .replace(/\/(?!\.\.(?:\/|\s|$))[^/\s]+\/\.\.(?=\/|\s|$)/g, "");
  } while (c !== prev);
  return c;
}

/**
 * Every spelling of the home this check can predict, lowercased: the literal home and its realpath,
 * `~`/`$HOME`/`${HOME}` for a home under the user's own, `$WINTER_HOME`/`${WINTER_HOME}`, and the
 * home's basename (a command that `cd`s to its parent first).
 */
function homePrefixes(home: string, opts: { basename?: boolean } = {}): string[] {
  const homes = new Set<string>([home]);
  try { homes.add(realpathSync(home).replace(/\/+$/, "")); } catch { /* not created yet: the literal spelling is the one a command could name */ }
  const prefixes = new Set<string>(["$winter_home", "${winter_home}"]);
  const userHome = homedir().replace(/\/+$/, "");
  for (const h of homes) {
    prefixes.add(h.toLowerCase());
    if (userHome.length > 0 && h.startsWith(`${userHome}/`)) {
      const rest = h.slice(userHome.length);
      for (const tilde of ["~", "$home", "${home}"]) prefixes.add(`${tilde}${rest}`.toLowerCase());
    }
    const base = basename(h);
    if (opts.basename !== false && base.length > 0) prefixes.add(base.toLowerCase());
  }
  return [...prefixes];
}

/** Does a word start at `at` in the normalised command (optionally after a leading `./`)? */
function startsWord(c: string, at: number): boolean {
  const boundary = (i: number): boolean => i <= 0 || /[\s;&|()<>=]/.test(c.charAt(i - 1));
  return boundary(at) || (c.slice(at - 2, at) === "./" && boundary(at - 2));
}

/** Is `cwd` the home's parent directory (literally or through a link) — where the home's bare basename IS
 *  the home? `false` when either side is unknown. */
function isHomeParent(cwd: string | undefined, home: string): boolean {
  if (cwd === undefined || cwd.length === 0) return false;
  const real = (p: string): string => { try { return realpathSync(p).replace(/\/+$/, ""); } catch { return p.replace(/\/+$/, ""); } };
  return real(cwd) === real(dirname(home));
}

/** One fenced target as the floor matches it. `writeOnly` — the model is POINTED at content under it
 *  to read and run (plugin skills), so only a write-shaped use is refused (review N1). */
interface FloorNeedle { needle: string; writeOnly: boolean }

/**
 * R.3 C-1: the variables WS-21 exports into every child, which a child's Bash hands to its shell (the
 * whole `process.env`), lowercased as the floor reads them. `$WINTER_STORE_HOME` is `<home>/sdk` — the
 * shared runtime home, so a fenced `sdk/<x>` is also `$winter_store_home/<x>` (`floorNeedles`, and the
 * protected-kind and transcript-store passes in `escapeFloorHit`).
 */
const STORE_HOME_VARIABLES: readonly string[] = ["$winter_store_home", "${winter_store_home}"];
/**
 * …and the variables that name a WRITE-ONLY fenced directory as a whole, refused in a write-shaped
 * position and readable otherwise (plugin skills are read and run there): both plugin-cache variables
 * (`<home>/sdk/plugins`), `CLAUDE_CONFIG_DIR` (a run folder under `<home>/cache` whose `skills/` entries link
 * into `sdk/skills` and the trusted project's skills — the retired official child's variable, still refused
 * because a write through it costs nothing to stop), and the child's `WINTER_HOME` — which under a run home is ITS run folder,
 * not the daemon's home (the router sets it to `runHome.dir`); every other `$winter_home` spelling above still
 * reads it as the daemon's home, too.
 */
const WRITE_ONLY_DIR_VARIABLES: readonly string[] = [
  "$winter_plugin_cache_dir", "${winter_plugin_cache_dir}",
  "$claude_code_plugin_cache_dir", "${claude_code_plugin_cache_dir}",
  "$claude_config_dir", "${claude_config_dir}",
  "$winter_home", "${winter_home}",
];

/**
 * Every fenced `<home>` path, spelled under every home prefix — the fenced dirs and files come from
 * `home-fence.ts`, i.e. from the SAME list the Bash sandbox's `denyWrite` carries (whole-branch review
 * 2026-09-23). A path lying outside the home is matched by its own absolute spelling; one under
 * `<home>/sdk` also under the store variable (R.3 C-1).
 */
function floorNeedles(home: string): FloorNeedle[] {
  const prefixes = homePrefixes(home);
  const out = new Map<string, boolean>();
  for (const p of [...homeFencedDirs(home), ...homeFencedFiles(home)]) {
    const r = relative(home, p);
    const writeOnly = isHomeWriteOnly(r);
    const spellings = r.length === 0 || r.startsWith("..") || isAbsolute(r)
      ? [p.toLowerCase()]
      : prefixes.map((pre) => `${pre}/${r}`.toLowerCase());
    // R.3 C-1: `$WINTER_STORE_HOME` already points at `<home>/sdk` — its spelling drops that segment.
    if (r === "sdk" || r.startsWith("sdk/")) {
      const storeRel = r.slice("sdk".length);
      for (const pre of STORE_HOME_VARIABLES) spellings.push(`${pre}${storeRel}`.toLowerCase());
    }
    for (const n of spellings) out.set(n, (out.get(n) ?? true) && writeOnly);
  }
  return [...out].map(([needle, writeOnly]) => ({ needle, writeOnly }));
}

/** Is the path text right after a home or store spelling (`/projects/<key>/memory…`, optionally under
 *  `/sdk`) inside a project's MEMDIR — the one part of the transcript store the model maintains itself? */
function isMemoryPathRest(rest: string, underSdk: boolean): boolean {
  return (underSdk ? /^\/sdk\/projects\/[^/]+\/memory(\/|$)/ : /^\/projects\/[^/]+\/memory(\/|$)/).test(rest);
}

/**
 * Relative words after a `cd`/`pushd`, rewritten against the directory the command moved to (review
 * N2: `cd ~/.winter && cp x permissions/projects.json`). A `cd` to an absolute-looking target
 * (`/`, `~`, `$…`) sets it; a relative one extends it; flags and `k=v` words are left alone. Conservative
 * rather than exact: the command words themselves get the prefix too, which can only ADD matches.
 */
function expandAfterCd(c: string): string {
  const parts = c.split(/(\s+|&&|\|\||;|\||&|\(|\))/);
  let cwd: string | undefined;
  let expectArg = false;
  const out: string[] = [];
  for (const part of parts) {
    if (part === undefined || part.length === 0) continue;
    if (/^\s+$/.test(part) || /^(&&|\|\||;|\||&|\(|\))$/.test(part)) { out.push(part); continue; }
    if (expectArg) {
      expectArg = false;
      const arg = part.replace(/\/+$/, "");
      cwd = /^[/~$]/.test(arg) || cwd === undefined ? arg : `${cwd}/${arg.replace(/^\.\//, "")}`;
      out.push(part);
      continue;
    }
    if (part === "cd" || part === "pushd") { expectArg = true; out.push(part); continue; }
    if (cwd !== undefined && !/^[/~$-]/.test(part) && !part.includes("=")) {
      out.push(`${cwd}/${part.replace(/^\.\//, "")}`);
      continue;
    }
    out.push(part);
  }
  return normaliseEscapeCommand(out.join(""));
}

/** Programs that WRITE a path they are given (review N1) — conservative: `git`/`curl`/`tar` can write
 *  into a directory they are pointed at, so they count too. Matched on a word's basename. */
const ESCAPE_WRITE_VERBS: ReadonlySet<string> = new Set([
  "cp", "mv", "ln", "rm", "rmdir", "unlink", "tee", "mkdir", "touch", "install", "rsync", "truncate", "dd",
  "chmod", "chown", "curl", "wget", "git", "tar", "unzip", "ditto", "patch",
]);

/** Where the command's WRITE-shaped part begins: the first redirect operator, or the first word that
 *  is a write verb — whichever comes first. `Infinity` for a command with neither. */
function writeContextStart(c: string): number {
  let start = c.indexOf(">");
  if (start < 0) start = Infinity;
  const words = /[^\s;&|()]+/g;
  let m: RegExpExecArray | null;
  while ((m = words.exec(c)) !== null) {
    if (m.index >= start) break;
    const word = m[0].slice(m[0].lastIndexOf("/") + 1);
    if (ESCAPE_WRITE_VERBS.has(word)) { start = m.index; break; }
    // Fix round 2: an IN-PLACE editor writes the file it names — `sed -i`/`sed --in-place`, `perl -i`/`-pi`
    // — judged within this command segment (up to the next `;`, `&` or `|`) only.
    if (word === "sed" || word === "perl") {
      const rest = c.slice(m.index + m[0].length).split(/[;&|]/, 1)[0] ?? "";
      if (/(?:^|\s)(?:-[a-z]*i[^\s]*|--in-place\S*)(?=\s|$)/.test(rest)) { start = m.index; break; }
    }
  }
  return start;
}

/**
 * Fix round 2 (controller ruling on SPEC CONCERN D): the protected item directories and agent definitions
 * of ANY project, at ANY depth and whatever its trust — `.winter/{skills,commands,rules,output-styles,
 * agents}` — as the TARGET of a write in a Bash command, sandboxed or not. A later session in a sibling
 * package loads them. Returns the segment named, or `undefined`. (R.3 I-4: the child's sandbox now fences
 * them at any depth under every working directory too — `childSandboxConfigFor`'s glob-shaped any-depth
 * `.winter/<kind>` entries — which covers the writes this static detector cannot see; this card stays for
 * everything the seatbelt does not bind: an escape, and a directory outside the working directories.)
 *
 * Round 3, minor 10 — JUDGED PER SHELL SEGMENT (split on `;`, `&&`, `||`, `|`, `&` and newlines on the RAW
 * text, never inside quotes; a `cd`/`pushd` carried across segments), so a read after a redirect or a write
 * elsewhere in the line is no longer taken for a write. In a segment, a write target is:
 *   * the target of an output redirect (`>`, `>>`, `>|`, `&>`; never an fd dup like `2>&1`);
 *   * for `ln`, EVERY operand (WS-24 fix round 1: a link to a protected path is itself the write);
 *   * for `cp`/`mv`/`install`/`rsync`, ONLY the destination — the last operand, or the `-t`/
 *     `--target-directory` value (a copy's SOURCE is read; `mv`'s removal of it loads nothing new); round 4:
 *     `-t` inside a short-flag cluster and `--target-directory <dir>` too, and every operand after the first
 *     once an option follows an operand;
 *   * round 4: the command a `find -exec`/`-execdir` runs, as a segment of its own;
 *   * for `git`, nothing when the subcommand only reads (status, log, diff, show, blame, ls-files, grep),
 *     every later word otherwise;
 *   * for an in-place editor (`sed -i`, `perl -i`, gawk's `-i inplace`) and every other write verb, every
 *     later word;
 *   * for an interpreter one-liner (`python`/`python3`/`node`/`bun`/`ruby`/`perl`/`deno` with `-c`, `-e`,
 *     `--eval`; `deno eval`), any protected segment its code names (round 3, minor 9).
 *
 * LINKS (WS-24). A write target is ALSO judged after resolving the links that already exist on its path —
 * relative targets against the session's `cwd` (`opts.cwd`; the hook input's own), `~` against the user's
 * home — so a link planted earlier (`ln -s ../.winter/skills s`, then later `echo … > s/x/SKILL.md`) no
 * longer carries a write past the match. Component by component, the way the kernel walks it: each
 * existing component is realpathed (a `..` after a link climbs out of the link's TARGET), the first one
 * that does not exist yet ends the walk and the rest is appended as written. Both spellings are walked: the
 * normalised one and the shell's own, uncollapsed (`./s/x/../../rules` must climb out of `s`'s target, not
 * be folded to `./rules` first). With no `cwd` only absolute and `~` targets are resolved. And `ln` itself is
 * judged: a link whose SOURCE is (or resolves under) a protected path is a card, so `ln -s .winter/skills t
 * && echo x > t/y.md` is caught at the `ln`; so are `cp -l`/`--link`/`-al`'s sources (hard links). Fix round 2:
 * a target that already exists as a HARD link (`nlink > 1`) is compared by inode against the files under the
 * protected directories (`ProtectedInodes`); a `cd` that could fail is judged both ways (a real shell stays
 * put); `$PWD`/`${PWD}` and `$HOME`/`${HOME}` at the start of a target are expanded.
 *
 * BOUNDS, EVERY ONE FAIL-CLOSED (fix round 3) — reaching one answers `BASH_WRITE_CHECK_BOUND.*`, a card (a
 * deny where nobody can answer), never a pass: 64 candidate working directories (six `cd`s in full; the
 * session's own cwd and the all-took chain are always kept), 2,000 judgments per call across every nested
 * `bash -c`/`eval` level (nesting itself stops at four), and the hard-link scan's budget (`ProtectedInodes`).
 *
 * THE LIMITATION, the escape floor's own: a static match on the normalised text (case folded, quotes
 * stripped, `//`/`/./`/`..` collapsed, `cd` tracked), plus the links that exist on disk WHEN THE CALL IS
 * JUDGED. A path the command ASSEMBLES at run time (`$(…)`, its own variables — `d=.winter; touch
 * $d/rules/x` —, a script it writes and then runs, an interpreter that joins the path from pieces) is beyond
 * its reach — `$(pwd)` included; so is a MULTI-HOP chain the same command builds (`ln -s s a && ln -s a b &&
 * echo x > b/y`, where `s` exists but `a` does not yet — the first `ln`'s source is judged, not what a later
 * hop resolves to), a hard link to a protected file living outside the walked directories (the inode scan
 * covers the cwd's walk, the target's own, and the store's `sdk/` kinds, bounded), an interpreter one-liner
 * that names its path THROUGH a link (`python3 -c "open('s/y.md','w')"`: only a literal `.winter/<kind>` in
 * the code is seen), a `cd` into a link whose target the command itself changes, and a write whose path is
 * not in the command at all — `git apply x.patch`, `patch < x.diff`. The child's sandbox fence and the
 * path-fence hook bind what this cannot see.
 */
export function bashProtectedWriteHit(command: string, opts: { cwd?: string; home?: string } = {}): string | undefined {
  const ctx: HitContext = { sessionCwd: opts.cwd, inodes: new ProtectedInodes(opts.cwd, opts.home), work: 0 };
  return protectedWriteHitIn(command, ctx, 0, [{ norm: undefined, raw: undefined }]);
}

/** `cd`/`pushd`'s next working directory, from its argument, relative to the one carried so far. */
function nextCwd(cwd: string | undefined, arg0: string | undefined): string | undefined {
  const arg = arg0?.replace(/\/+$/, "");
  return arg === undefined || arg === "" ? "~" : arg === "-" ? undefined : /^[/~$]/.test(arg) || cwd === undefined ? arg : `${cwd}/${arg.replace(/^\.\//, "")}`;
}

/** WS-24 fix round 1 (I-1): a segment's text as the SHELL will walk it — case folded and quotes stripped like
 *  `normaliseEscapeCommand`, but with no `.`/`..` collapsed: the kernel resolves `s/x/../..` from the link
 *  `s`'s TARGET, so collapsing it textually first (`./s/x/../../rules` → `./rules`) hid the link. */
function rawSpelling(command: string): string {
  // A backslash escapes the next character (`s\/y.md` is `s/y.md` to the shell); a literal `\\` stays one.
  return command.toLowerCase().replace(/["']/g, "").replace(/\\(.)/g, "$1").replace(/\/{2,}/g, "/");
}

/** WS-24 fix round 2 (N-1): one place the shell may be standing — the normalised and the raw spelling of a
 *  cwd carried from the command's `cd`s (`undefined` = the session's own cwd). */
interface CwdCandidate { norm: string | undefined; raw: string | undefined }
/** At most this many candidate working directories are carried through a command's `cd`s (6 `cd`s in full). */
const MAX_CWD_CANDIDATES = 64;
/** At most this many target judgments (and nested-command parses) per call, across every `bash -c` level. */
const MAX_JUDGMENTS = 2_000;

/** WS-24 fix round 3: the answers the check gives when it reaches one of its bounds — FAIL CLOSED, a card (a
 *  deny where nobody can answer), never a silent pass. Phrased to read after "Bash writes under …". */
export const BASH_WRITE_CHECK_BOUND = {
  cwds: "a path this check cannot pin down (too many working directories to judge)",
  work: "a path this check cannot pin down (too much to judge in one command)",
  inodes: "a hard-linked file this check could not rule out (too many protected files to compare)",
} as const;

/** One call's shared state, across its nested `bash -c`/`eval` levels (fix round 3, minor 1): the work budget
 *  and ONE inode index. */
interface HitContext { sessionCwd: string | undefined; inodes: ProtectedInodes; work: number }

function protectedWriteHitIn(command: string, ctx: HitContext, depth: number, start: CwdCandidate[]): string | undefined {
  // WS-24 fix round 2 (N-1): a `cd` can FAIL, and a real shell then stays where it was — `cd nope; cd s; echo x
  // > y.md` writes under `s`. So every place the shell could be standing is carried (each `cd` either took or
  // did not), and a target is judged from each of them. Fix round 3: BOUNDED FAIL-CLOSED — the session's own
  // cwd and the chain where every `cd` took are always kept; once any OTHER candidate had to be dropped, a
  // write is answered with a card (`BASH_WRITE_CHECK_BOUND.cwds`), never judged from a partial set.
  const sessionCwd = ctx.sessionCwd;
  let cwds: CwdCandidate[] = start;
  let allTook: CwdCandidate = start[0] ?? { norm: undefined, raw: undefined };
  let overflowed = false;
  for (const raw of shellSegments(command)) {
    if (++ctx.work > MAX_JUDGMENTS) return BASH_WRITE_CHECK_BOUND.work;
    // Round 5: a shell's `-c` string, `eval`'s argument and the same inside `find -exec` are COMMANDS — each
    // judged as one of its own, from EVERY place the shell may be standing (the whole set, passed once —
    // fix round 3: not one recursion per candidate).
    if (depth < 4) {
      for (const nested of nestedCommandStrings(shellWords(raw))) {
        const hit = protectedWriteHitIn(nested, ctx, depth + 1, cwds);
        if (hit !== undefined) return hit;
      }
    }
    const trimmed = (t: string): string => t.replace(/^[\s({]+/, "").replace(/[\s)}]+$/, "");
    const seg = trimmed(normaliseEscapeCommand(quotedOperatorsAsText(raw)));
    const rawSeg = trimmed(rawSpelling(quotedOperatorsAsText(raw)));
    if (seg.length === 0) continue;
    const words = seg.split(/\s+/);
    if (words[0] === "cd" || words[0] === "pushd") {
      const rawArg = rawSeg.split(/\s+/)[1];
      const took = (c: CwdCandidate): CwdCandidate => ({ norm: nextCwd(c.norm, words[1]), raw: nextCwd(c.raw, rawArg) });
      allTook = took(allTook);
      const next: CwdCandidate[] = [];
      const seen = new Set<string>();
      const add = (c: CwdCandidate, mustKeep = false): void => {
        const key = `${c.norm ?? "\0"}|${c.raw ?? "\0"}`;
        if (seen.has(key)) return;
        if (!mustKeep && next.length >= MAX_CWD_CANDIDATES - 2) { overflowed = true; return; }
        seen.add(key);
        next.push(c);
      };
      add(allTook, true);                                   // the chain where every cd took
      add({ norm: undefined, raw: undefined }, true);       // the session's own cwd (every cd failed)
      for (const c of cwds) add(took(c));                   // this cd took…
      for (const c of cwds) add(c);                         // …or it failed
      cwds = next;
      continue;
    }
    const under = (at: string | undefined, target: string): string => {
      const t = expandShellVars(target, at, sessionCwd);
      return at === undefined || /^[/~$]/.test(t) ? t : `${at}/${t.replace(/^\.\//, "")}`;
    };
    const judge = (path: string, raw: boolean): string | undefined => {
      if (++ctx.work > MAX_JUDGMENTS) return BASH_WRITE_CHECK_BOUND.work;
      if (!raw) {
        const m = PROTECTED_BASH_TARGET.exec(path);
        if (m !== null) return m[0];
      }
      // WS-24: the same target once the links already on its path are resolved (see the doc above).
      const physical = physicalPath(path, sessionCwd);
      const r = physical === undefined ? null : PROTECTED_BASH_TARGET.exec(physical.toLowerCase());
      if (r !== null) return r[0];
      // WS-24 fix round 2 (N-2): a HARD link to a protected file — the same inode under another name.
      return physical === undefined ? undefined : ctx.inodes.hit(physical);
    };
    // WS-24 fix round 2 (N-2): `cp -l`/`--link` (and `-al`) makes hard links to its SOURCES — judged like `ln`'s.
    const linkSources = cpLinkOperands(raw);
    const normTargets = [...segmentWriteTargets(seg), ...linkSources.norm];
    const rawTargets = [...segmentWriteTargets(rawSeg), ...linkSources.raw];
    // Past the cap only the two kept candidates are exact: judge them (a real hit names its directory), then
    // answer the bound for the ones that were dropped.
    const judged = overflowed ? cwds.slice(0, 2) : cwds;
    for (const c of judged) {
      for (const target of normTargets) {
        const hit = judge(under(c.norm, target), false);
        if (hit !== undefined) return hit;
      }
      // WS-24 fix round 1 (I-1): and each target as the shell spells it, its `..` walked physically from the
      // links it climbs out of (`rawSpelling`).
      for (const target of rawTargets) {
        const hit = judge(under(c.raw, target), true);
        if (hit !== undefined) return hit;
      }
    }
    if (overflowed && (normTargets.length > 0 || rawTargets.length > 0)) return BASH_WRITE_CHECK_BOUND.cwds;
  }
  return undefined;
}

/** WS-24 fix round 2 (minor 2): `$PWD`/`${PWD}` → the cwd the shell stands in (the tracked one, anchored at the
 *  session's), `$HOME`/`${HOME}` → the user's home — at the START of a target only. `$(pwd)` and every other
 *  variable stay unexpanded (a documented limit). Text arrives case-folded. */
function expandShellVars(target: string, at: string | undefined, sessionCwd: string | undefined): string {
  const pwd = /^\$(?:\{pwd\}|pwd)(?=\/|$)/;
  if (pwd.test(target)) {
    const here = at === undefined ? sessionCwd : /^[/~]/.test(at) ? at : sessionCwd === undefined ? undefined : `${sessionCwd}/${at}`;
    return here === undefined ? target : target.replace(pwd, here);
  }
  return target.replace(/^\$(?:\{home\}|home)(?=\/|$)/, homedir());
}

/** WS-24 fix round 2 (N-2): the operands of a `cp` that makes HARD links (`-l`, `--link`, or `l` in a short
 *  cluster such as `-al`) — every one of them, the sources included. Read from the command's own CASE (`-L`,
 *  dereference, is not `-l`), then case-folded for judging like everything else. */
function cpLinkOperands(raw: string): { norm: string[]; raw: string[] } {
  const words = shellWords(raw);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || COMMAND_PREFIXES.has(baseName(words[i]!)))) i += 1;
  if (baseName(words[i] ?? "") !== "cp") return { norm: [], raw: [] };
  const rest = words.slice(i + 1);
  if (!rest.some((w) => w === "--link" || /^-[A-Za-z]*l[A-Za-z]*$/.test(w))) return { norm: [], raw: [] };
  const operands = rest.filter((w) => !w.startsWith("-"));
  return { norm: operands.map((w) => normaliseEscapeCommand(w)), raw: operands.map((w) => rawSpelling(w)) };
}

/**
 * WS-24 fix round 2 (N-2): the inodes of the files under the protected directories — every `.winter/{skills,
 * commands,rules,output-styles,agents}` on the walk from the session's cwd (and from a target's own
 * directory) up to the user's home or the filesystem root, plus the store's `sdk/{skills,commands,rules,
 * output-styles}` when the Winter home is known — so a write to a file that is the SAME INODE as one of them
 * (a hard link, `hard.md`) is judged as a write there. Only consulted for a target that exists as a regular
 * file with more than one link (`nlink > 1`), so an ordinary write never scans anything; a hard-linked file
 * that matches nothing protected (node_modules' own) stays quiet. Built lazily, once per command (shared by
 * its nested `bash -c` levels). BOUNDED FAIL-CLOSED (fix round 3): the store's `sdk/` kinds are scanned
 * first; 50,000 entries, 0.5 s and a depth of 12 bound the rest, and a scan a bound cut short answers an
 * unmatched hard link with a card (`BASH_WRITE_CHECK_BOUND.inodes`) rather than a pass.
 */
let inodeScanBudget = 50_000;
/** Test seam: the hard-link scan's entry budget (a >50,000-file tree is too slow to build in a unit test). */
export function _setInodeScanBudgetForTests(n: number | undefined): void { inodeScanBudget = n ?? 50_000; }

class ProtectedInodes {
  private readonly byInode = new Map<string, string>();
  private readonly scanned = new Set<string>();
  /** Entries left to visit — 50,000 stats is ~0.1 s — and a wall-clock bound beside it (a slow volume). */
  private budget = inodeScanBudget;
  private deadline: number | undefined;
  /** Set when a bound cut a scan short: an unmatched hard link can then not be ruled out. */
  private exhausted = false;
  constructor(private readonly sessionCwd: string | undefined, private readonly home: string | undefined) {}

  hit(physical: string): string | undefined {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(physical); } catch { return undefined; }
    if (!st.isFile() || st.nlink < 2) return undefined;
    this.deadline ??= Date.now() + 500;
    // Fix round 3 (F-2): the store's small, fixed kinds FIRST, so a huge project tree cannot spend the budget
    // before them; then the walks.
    if (this.home !== undefined) {
      for (const kind of ["skills", "commands", "rules", "output-styles"]) this.scanDir(join(this.home, "sdk", kind), `sdk/${kind}`, 0);
    }
    if (this.sessionCwd !== undefined) this.scanWalk(this.sessionCwd);
    this.scanWalk(dirname(physical));
    // FAIL CLOSED: a bound reached with no match means this link could still be one of the files not visited.
    return this.byInode.get(`${st.dev}:${st.ino}`) ?? (this.exhausted ? BASH_WRITE_CHECK_BOUND.inodes : undefined);
  }

  private scanWalk(from: string): void {
    const userHome = homedir();
    let dir = from;
    for (let i = 0; i < 64; i += 1) {
      for (const kind of ["skills", "commands", "rules", "output-styles", "agents"]) this.scanDir(join(dir, ".winter", kind), `.winter/${kind}`, 0);
      if (dir === userHome) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  private scanDir(dir: string, label: string, depth: number): void {
    if (this.scanned.has(dir)) return;
    if (depth > 12 || this.budget <= 0 || Date.now() > (this.deadline ?? Infinity)) { this.exhausted = true; return; }
    this.scanned.add(dir);
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (--this.budget <= 0) { this.exhausted = true; return; }
      const p = join(dir, e.name);
      if (e.isDirectory()) { this.scanDir(p, label, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = statSync(p); this.byInode.set(`${st.dev}:${st.ino}`, label); } catch { /* vanished */ }
    }
  }
}

/**
 * WS-24: `path` (one write target, as `protectedWriteHitIn` spells it — lowercased by the normaliser) with
 * every link that EXISTS on it resolved — in the volume's own case, lowercased by the caller for the match
 * (the inode check needs the real path); `undefined` when it cannot be
 * anchored (a `$VAR` path, or a relative one with no session cwd). Walks from the root like the kernel:
 * an existing component is realpathed before the next is looked up (so a `..` after a link climbs from
 * the link's TARGET); a DANGLING link is followed by its text (writing through it creates its target);
 * the first missing component ends the walk and the rest is appended verbatim. A component is looked up
 * as spelled and then case-insensitively (the text was case-folded; a case-sensitive volume still
 * resolves). Bounded (40 link hops, like the kernel's ELOOP). Never throws.
 */
function physicalPath(path: string, sessionCwd: string | undefined): string | undefined {
  let abs: string;
  if (path.startsWith("/")) abs = path;
  else if (path === "~" || path.startsWith("~/")) abs = `${homedir()}${path.slice(1)}`;
  else if (path.startsWith("$") || sessionCwd === undefined) return undefined;
  else abs = `${sessionCwd}/${path}`;
  let parts = abs.split("/").filter((p) => p !== "" && p !== ".");
  let cur = "/";
  let hops = 0;
  while (parts.length > 0) {
    const part = parts[0]!;
    if (part === "..") { cur = dirname(cur); parts = parts.slice(1); continue; }
    const entry = existingEntry(cur, part);
    if (entry === undefined) break;
    let real: string | undefined;
    try { real = realpathSync(entry); } catch { real = undefined; }
    if (real !== undefined) { cur = real; parts = parts.slice(1); continue; }
    // Exists but does not resolve: a dangling link (or a loop). Follow its text once more, bounded.
    let text: string;
    try { text = readlinkSync(entry); } catch { break; }
    if (++hops > 40) break;
    const target = text.startsWith("/") ? text : `${cur}/${text}`;
    parts = [...target.split("/").filter((p) => p !== "" && p !== "."), ...parts.slice(1)];
    cur = "/";
  }
  return parts.length === 0 ? cur : `${cur.replace(/\/+$/, "")}/${parts.join("/")}`;
}

/** `dir/name` when it exists (a dangling link included — it still names where the write lands), else a
 *  case-insensitive match among `dir`'s entries. */
function existingEntry(dir: string, name: string): string | undefined {
  const direct = join(dir, name);
  try { lstatSync(direct); return direct; } catch { /* not as spelled */ }
  try {
    const hit = readdirSync(dir).find((e) => e.toLowerCase() === name);
    return hit === undefined ? undefined : join(dir, hit);
  } catch { return undefined; }
}

/** A protected segment inside ONE write target (a single word). */
const PROTECTED_BASH_TARGET = /\.winter\/(?:skills|commands|rules|output-styles|agents)(?=\/|$)/;

/** Round 3, minor 9: the interpreters whose one-liners count, their code flags, and a protected segment as
 *  code names it. */
const INTERPRETERS = /^(?:python(?:\d+(?:\.\d+)?)?|node|bun|ruby|perl|deno)$/;
const ONE_LINER_FLAG = /^(?:-[a-z]*[ce]|--eval|--print|-p)$/;
const PROTECTED_IN_CODE = /\.winter\/(?:skills|commands|rules|output-styles|agents)(?![a-z0-9_.-])/;

/** git's subcommands that only read (round 3, minor 10). */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "log", "diff", "show", "blame", "ls-files", "grep"]);
/** Verbs whose only write target is the destination (round 3, minor 10). */
const DESTINATION_VERBS: ReadonlySet<string> = new Set(["cp", "mv", "ln", "install", "rsync"]);

/** One normalised segment's write targets (words), per `bashProtectedWriteHit`'s rules. */
function segmentWriteTargets(seg: string): string[] {
  const targets: string[] = [];
  // Output redirects: the word after the operator; an fd dup (`>&1`, `>&-`) names no file.
  const redirect = /(?:\d*|&)>{1,2}\|?(&?)\s*([^\s<>&|;()]*)/g;
  for (const m of seg.matchAll(redirect)) {
    if (m[1] === "&" && /^(\d+|-)?$/.test(m[2] ?? "")) continue;
    if (m[2] !== undefined && m[2].length > 0) targets.push(m[2]);
  }
  const words = seg.replace(redirect, " ").replace(/<\s*[^\s<>&|;()]*/g, " ").split(/\s+/).filter((w) => w.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    const verb = words[i]!.slice(words[i]!.lastIndexOf("/") + 1);
    const rest = words.slice(i + 1);
    // Round 3, minor 9: an interpreter ONE-LINER writes whatever its code names — any protected segment in
    // it is the target (its own boundary: the code's `'…/rules',` punctuation is no path character).
    if (INTERPRETERS.test(verb) && (rest.some((w) => ONE_LINER_FLAG.test(w)) || (verb === "deno" && rest[0] === "eval"))) {
      const named = PROTECTED_IN_CODE.exec(rest.join(" "));
      return named === null ? targets : [...targets, named[0]];
    }
    // …and gawk's in-place edit, `-i inplace`, writes the files it names.
    if ((verb === "awk" || verb === "gawk") && rest.some((w, j) => w === "-iinplace" || w === "--include=inplace" || ((w === "-i" || w === "--include") && rest[j + 1] === "inplace"))) {
      return [...targets, ...rest];
    }
    if (verb === "git") {
      // R.3 I-4: `--output=<file>`/`--output <file>` writes that file whatever the subcommand (`git show`,
      // `log` and `diff` read otherwise) — judged before the read-subcommand exemption below.
      const outputs: string[] = [];
      for (let j = 0; j < rest.length; j += 1) {
        const w = rest[j]!;
        if (w.startsWith("--output=")) outputs.push(w.slice("--output=".length));
        else if (w === "--output" && rest[j + 1] !== undefined) outputs.push(rest[j + 1]!);
      }
      let j = 0;
      while (j < rest.length && rest[j]!.startsWith("-")) j += /^-[cC]$/.test(rest[j]!) ? 2 : 1;   // `-C dir`, `-c k=v`
      if (GIT_READ_SUBCOMMANDS.has(rest[j] ?? "")) return [...targets, ...outputs];
      return [...targets, ...rest];
    }
    // WS-24 fix round 1 (I-2): `ln` CREATES a name for its source — a symlink or hard link whose source is
    // (or resolves under) a protected directory makes a later write through that name land there, so every
    // operand counts, the sources as well as the link's own name. (A symlink's relative source is judged
    // from the cwd, not the link's directory — an approximation; `ln -s ../.winter/…` names the segment
    // outright anyway.)
    if (verb === "ln") return [...targets, ...rest.filter((w) => !w.startsWith("-"))];
    if (DESTINATION_VERBS.has(verb)) {
      const operands: string[] = [];
      let optionAfterOperand = false;
      for (const w of rest) {
        if (w.startsWith("-")) { if (operands.length > 0) optionAfterOperand = true; } else operands.push(w);
      }
      const last = operands.length === 0 ? [] : [operands[operands.length - 1]!];
      for (let j = 0; j < rest.length; j += 1) {
        const w = rest[j]!;
        // Round 4, minor 2: `-t` inside a short-flag cluster (`-rt dir`) and the space-separated
        // `--target-directory dir` name the target as the NEXT word. (rsync has no `-t` target: its `-t`
        // keeps times.) The text is case-folded, so `-T` reads as `-t` too — hence the last operand as well.
        if (verb !== "rsync" && /^-[a-z]*t[a-z]*$/.test(w) && rest[j + 1] !== undefined) return [...targets, rest[j + 1]!, ...last];
        if (w === "--target-directory" && rest[j + 1] !== undefined) return [...targets, rest[j + 1]!];
        if (w.startsWith("--target-directory=")) return [...targets, w.slice("--target-directory=".length)];
      }
      // …and once an option follows an operand (an option's VALUE may then sit after the destination —
      // `rsync -a src/ dst/ --exclude tmp`), every operand after the first is a possible target.
      return optionAfterOperand ? [...targets, ...operands.slice(1)] : [...targets, ...last];
    }
    // Round 4, minor 2: `find … -exec CMD … +` (or `\;`) runs CMD — judged as a segment of its own; and
    // `-fprint`/`-fprintf`/`-fls` write the file they name.
    if (verb === "find") {
      for (let j = 0; j < rest.length; j += 1) {
        const w = rest[j]!;
        if (w === "-fprint" || w === "-fprintf" || w === "-fls") { if (rest[j + 1] !== undefined) targets.push(rest[j + 1]!); continue; }
        if (w !== "-exec" && w !== "-execdir" && w !== "-ok" && w !== "-okdir") continue;
        const sub: string[] = [];
        for (j += 1; j < rest.length && rest[j] !== "+" && rest[j] !== "\\;" && rest[j] !== ";"; j += 1) sub.push(rest[j]!);
        targets.push(...segmentWriteTargets(sub.join(" ")));
      }
      return targets;
    }
    if (verb === "sed" || verb === "perl") {
      if (rest.some((w) => /^(?:-[a-z]*i\S*|--in-place\S*)$/.test(w))) return [...targets, ...inPlaceFiles(verb, rest)];
      continue;
    }
    // WS-24 fix round 2: `dd` writes only its `of=` file (`if=` is read).
    if (verb === "dd") return [...targets, ...rest.filter((w) => w.startsWith("of=")).map((w) => w.slice("of=".length))];
    if (ESCAPE_WRITE_VERBS.has(verb)) return [...targets, ...rest];
  }
  return targets;
}

/** The ASK a protected-path Bash write gets (fix round 2) — a card in code; the bridge turns it into the
 *  typed deny wherever nobody can answer (dispatch, chat, a dispatch child). Every policy. */
function bashProtectedWriteHook(home?: string): HookCallback {
  return async (input) => {
    const { command } = bashEscapeInput(input);
    const hit = bashProtectedWriteHit(command, { cwd: hookCwd(input), ...(home !== undefined ? { home } : {}) });
    return hit === undefined
      ? allow()
      : ask(`Bash writes under ${hit} — skills, commands, rules, output styles and agent definitions load into every future session; the user decides.`);
  };
}

/**
 * What a sandbox escape's command names that the floor forbids, or `undefined`. Exported for the
 * tests; the hook below is its one production caller besides the reviewer's own skip.
 *
 * Two classes (review N1): paths the model may not even read (`run`, `runtimes`) and the self-grant
 * stores (`permissions`, `agents`, `trust.json`, the control-plane filenames, any `.winter/agents`) are
 * refused on ANY mention; `cache` and `plugins` — whose skill content the model is pointed at to read
 * and execute — only in a write-shaped position (after a redirect or a write verb).
 */
export function escapeFloorHit(command: string, home: string | undefined, cwd?: string): string | undefined {
  // R.3 re-review B-1: the command as written, and once per reading of the child's path variables with each
  // replaced by the absolute value the daemon knows — so `$WINTER_STORE_HOME/../agents`, `cd $OUTDIR &&
  // cd ../..` and every other depth collapse into the literal-path checks below (the normaliser folds
  // `<seg>/..` only after a `/`, which a variable lacks).
  const texts = home === undefined || home.length === 0
    ? [command]
    : [command, ...childPathVariableReadings(home.replace(/\/+$/, "")).map((values) => substitutePathVariables(command, values))];
  for (const text of new Set(texts)) {
    const hit = escapeFloorHitIn(text, home, cwd);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * R.3 re-review B-1: the absolute values of the path variables a child's shell has, as the daemon knows them.
 * Two readings of `WINTER_HOME` — under a run home it is the child's run folder (`<home>/cache/runs/
 * <run id>`; `CLAUDE_CONFIG_DIR` was the retired official child's), before one it was the daemon's home — and one of
 * everything else: `WINTER_STORE_HOME` = `<home>/sdk`, both plugin-cache variables = `<home>/sdk/plugins`,
 * `OUTDIR` = `<home>/outputs/<session id>` (the SDK's Bash has exported it since WS-12). A run id and a
 * session id are placeholders: only their DEPTH matters to a `..`. A run folder's `projects` is a link into
 * `sdk/projects` on the Winter leg, and the kernel resolves `..` physically, so `$WINTER_HOME/projects` reads
 * as the store's (whose MEMDIRs stay the model's own).
 */
function childPathVariableReadings(home: string): Array<ReadonlyArray<readonly [string, string]>> {
  const sdk = join(home, "sdk");
  const runFolder = join(home, "cache", "runs", "_run_");
  const common: Array<readonly [string, string]> = [
    ["WINTER_STORE_HOME", sdk],
    ["WINTER_PLUGIN_CACHE_DIR", join(sdk, "plugins")],
    ["CLAUDE_CODE_PLUGIN_CACHE_DIR", join(sdk, "plugins")],
    ["CLAUDE_CONFIG_DIR", runFolder],
    ["OUTDIR", join(home, "outputs", "_session_")],
  ];
  return [
    [["WINTER_HOME/projects", join(sdk, "projects")], ["WINTER_HOME", runFolder], ...common],
    [["WINTER_HOME", home], ...common],
  ];
}

/** Replace `$NAME` (not followed by another identifier character) and `${NAME}` — case-insensitively, as the
 *  floor reads the rest — with `value`. A `NAME/sub` entry replaces `$NAME/sub` and `${NAME}/sub`. */
function substitutePathVariables(command: string, values: ReadonlyArray<readonly [string, string]>): string {
  let out = command;
  for (const [name, value] of values) {
    const slash = name.indexOf("/");
    const variable = slash < 0 ? name : name.slice(0, slash);
    const tail = slash < 0 ? "" : name.slice(slash).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\$(?:\\{${variable}\\}|${variable}(?![A-Za-z0-9_]))${tail}${slash < 0 ? "" : "(?=/|$|[\\s;&|()<>\"'])"}`, "gi");
    out = out.replace(pattern, () => value);
  }
  return out;
}

/** The floor's checks on ONE spelling of the command (`escapeFloorHit` runs them on every reading). */
function escapeFloorHitIn(command: string, home: string | undefined, cwd?: string): string | undefined {
  const c = expandAfterCd(normaliseEscapeCommand(command));
  for (const name of ESCAPE_FENCED_FILENAMES) if (c.includes(name)) return name;
  for (const seg of PROJECT_FENCED_SEGMENTS) {
    const bare = seg.replace(/\/+$/, "");
    if (c.includes(bare)) return `a project's ${bare} directory`;
  }
  const writeStart = writeContextStart(c);
  // WS-21 (spec §7.1), write-shaped only: a project's `.winter/mcp.json` and any `.winter/settings*.json`
  // (the two claude tiers are already refused on any mention above), and a claude staging root.
  for (const re of PROJECT_WRITE_FENCED) {
    for (const m of c.matchAll(re)) if (m.index !== undefined && m.index > writeStart) return `a project's ${m[0]}`;
  }
  for (let at = c.indexOf(RESUME_STAGING_NEEDLE); at >= 0; at = c.indexOf(RESUME_STAGING_NEEDLE, at + 1)) {
    if (at > writeStart) return "a claude resume staging root";
  }
  if (home === undefined || home.length === 0) return undefined;
  const bareHome = home.replace(/\/+$/, "");
  for (const { needle, writeOnly } of floorNeedles(bareHome)) {
    let at = c.indexOf(needle);
    while (at >= 0) {
      if (!writeOnly || at > writeStart) return "Winter's own state under its home";
      at = c.indexOf(needle, at + 1);
    }
  }
  // R.3 C-1: a variable naming a write-only fenced directory as a whole (the plugin cache, a run folder) —
  // refused in a write-shaped position, wherever under it the write lands. `$WINTER_HOMEDIR` is another
  // variable (an unbraced name continues through `[a-z0-9_]`); the MEMDIR under the Winter child's run
  // folder (`$WINTER_HOME/projects/<key>/memory`, a link into the store) stays the model's own.
  for (const v of WRITE_ONLY_DIR_VARIABLES) {
    for (let at = c.indexOf(v); at >= 0; at = c.indexOf(v, at + 1)) {
      if (at <= writeStart) continue;
      if (!v.endsWith("}") && /[a-z0-9_]/.test(c.charAt(at + v.length))) continue;
      const rest = c.slice(at + v.length).split(/[\s;&|()<>]/, 1)[0] ?? "";
      if ((v === "$winter_home" || v === "${winter_home}") && (isMemoryPathRest(rest, false) || isMemoryPathRest(rest, true))) continue;
      return "Winter's own state under its home";
    }
  }
  // Review I7: the user tier's PROTECTED paths (spec §7.2), write-shaped — the shared runtime home's and
  // the old/compat spelling at the home's top level (a link into `sdk/` on a migrated home, the store
  // itself on router 0.0.11). A write tool gets a card for these; an unsandboxed command gets none.
  // Round 3, minor 4: the WINTER.md needle is the HOME's own — a project's `.winter/WINTER.md` is ordinary
  // (spec §7.2), and the home's bare basename (`.winter`) names a project's `.winter/` just as well. So the
  // bare spelling counts for WINTER.md only when the command runs from the home's parent directory.
  const fullPrefixes = new Set([...homePrefixes(bareHome, { basename: false }), ...STORE_HOME_VARIABLES]);
  const fromHomeParent = isHomeParent(cwd, bareHome);
  // R.3 C-1: the store variable already names `<home>/sdk`, so its one base is the variable itself.
  const protectedBases: Array<{ pre: string; bases: string[] }> = [
    ...homePrefixes(bareHome).map((pre) => ({ pre, bases: [`${pre}/sdk`, pre] })),
    ...STORE_HOME_VARIABLES.map((pre) => ({ pre, bases: [pre] })),
  ];
  for (const { pre, bases } of protectedBases) {
    const instructionsNeedleHere = fullPrefixes.has(pre) || fromHomeParent;
    for (const base of bases) {
      for (const needle of [...PROTECTED_KIND_NAMES.map((k) => `${base}/${k}`), ...(instructionsNeedleHere ? [`${base}/winter.md`] : [])]) {
        for (let at = c.indexOf(needle); at >= 0; at = c.indexOf(needle, at + 1)) {
          if (at <= writeStart) continue;
          // the bare basename names the home only as a word of its own (`proj/.winter/WINTER.md` is a project's)
          if (!fullPrefixes.has(pre) && needle.endsWith("/winter.md") && !startsWord(c, at)) continue;
          const next = c.charAt(at + needle.length);
          if (next === "" || next === "/" || /[\s;&|()<>]/.test(next)) return "a protected path (skills, commands, rules, output styles or WINTER.md)";
        }
      }
    }
  }
  // …and the runtimes' transcript store, `sdk/projects`, write-shaped and OUTSIDE each project's
  // `memory/` (the model's MEMDIR, which it maintains itself).
  // Review M2: and under its compat-link spelling `<home>/projects` (a link into `sdk/projects` on a
  // migrated home; the store itself on router 0.0.11). R.3 C-1: and `$WINTER_STORE_HOME/projects`.
  const storeNeedles: string[][] = [
    ...homePrefixes(bareHome).map((pre) => [`${pre}/sdk/projects`, `${pre}/projects`]),
    ...STORE_HOME_VARIABLES.map((pre) => [`${pre}/projects`]),
  ];
  for (const needles of storeNeedles) {
    for (const needle of needles) {
      for (let at = c.indexOf(needle); at >= 0; at = c.indexOf(needle, at + 1)) {
        if (at <= writeStart) continue;
        const rest = c.slice(at + needle.length).split(/[\s;&|()<>]/, 1)[0] ?? "";
        if (rest !== "" && !rest.startsWith("/")) continue; // `sdk/projectsx`: not this directory
        if (/^\/[^/]+\/memory(\/|$)/.test(rest)) continue;
        return "sdk/projects, the runtimes' own transcript store";
      }
    }
  }
  return undefined;
}

/** WS-21 (spec §7.1): project files the escape floor refuses in a write-shaped position, matched on the
 *  normalised command. */
const PROJECT_WRITE_FENCED: readonly RegExp[] = [
  /\.winter\/mcp\.json/g,
  /\.winter\/settings[^/\s;&|()<>]*\.json/g,
  // Review I7: any project's protected item directories, at any depth (review C1's shape).
  /\.winter\/(?:skills|commands|rules|output-styles)(?=\/|[\s;&|()<>]|$)/g,
];
/** The protected item directory names (spec §7.2), as the lowercased floor matches them. */
const PROTECTED_KIND_NAMES: readonly string[] = ["skills", "commands", "rules", "output-styles"];
const RESUME_STAGING_NEEDLE = "claude-resume-";

export function escapeFloorDenial(hit: string): string {
  return `Bash was not run — a command that asks to run outside the sandbox (dangerouslyDisableSandbox) may not touch ${hit}. ` +
    "Winter's control-plane files (permissions.local.json, settings.json, settings.local.json, trust.json, .winter.json, a project's .winter/mcp.json), agent definitions (.winter/agents) and its own state under its home (run, runtimes, plugins, permissions, cache, agents, and sdk/ — settings, MCP servers, agents, plugins and the transcript store outside memory/) are off-limits to unsandboxed commands under every approval mode. Run the command inside the sandbox, or ask the user to make this change.";
}

// ── 2b. The path fence (WS-21, spec §7.1 "hook" column, §7.2) ─────────────────────────────────
//
// One PreToolUse hook for the write- and read-class tools, under every policy (a
// PreToolUse answer is evaluated ahead of the permission mode — F16), in this order:
//  1. the control-plane fence the bridge already applies at (2) — the three control-plane filenames,
//     `mcp.json` and `settings*.json` under any `.winter/`, and every home-fenced path — as a hook too,
//     so it binds where the bridge is never consulted (a matching allow rule, bypass);
//  2. `sdk/projects/**` outside each project's `memory/` (`storeWriteDenial`) — deny;
//  3. the read row (`protectedReadDenial`) — deny;
//  4. a protected write (`protectedWriteDecision`) — ask in code, deny in chat and dispatch. The bridge
//     (5e) independently refuses to auto-allow one, and the router pins the same set as flag-layer ask
//     rules (a runtime's own sensitive-file check could otherwise swallow this hook's ask — F16).
function pathFenceHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const home = deps.home;
    if (!home) return allow();
    const pre = input as PreToolUseHookInput;
    const toolName = typeof pre.tool_name === "string" ? pre.tool_name : "";
    const toolInput = pre.tool_input as unknown;
    const cwd = deps.cwd ?? deps.roots[0] ?? "";
    const fenced = controlPlaneTargetForCall(toolName, toolInput, cwd, homeFenceFor(home));
    if (fenced) return deny(controlPlaneDenialMessage(toolName, fenced.path, fenced.home));
    const store = storeWriteDenial(toolName, toolInput, { home, cwd });
    if (store !== undefined) return deny(store);
    const read = protectedReadDenial(toolName, toolInput, { home, cwd });
    if (read !== undefined) return deny(read);
    let root: string | null = null;
    try { root = deps.trustedProjectRoot?.() ?? null; } catch { root = null; }
    const decision = protectedWriteDecision(toolName, toolInput, { mode: deps.mode ?? "code", protected: protectedPathsFor(home, root, { cwd }), cwd });
    if (decision === null) return allow();
    return decision.decision === "ask"
      ? ask(`${toolName} writes a protected path (skills, commands, rules, output styles and WINTER.md load into every future session) — the user decides.`)
      : deny(decision.reason);
  };
}

/**
 * WS-26 — THE CONNECTOR-PERMISSION FLOOR (`agent/mcp/connector-permissions.ts` has the store and the
 * matrix). Unmatched, like the path fence (one callback per call; a non-connector name is an immediate
 * no-opinion), and in EVERY mode. It answers `connectorVerdict`'s verdict to the child directly, because
 * the approval bridge only ever sees calls the child did not already decide:
 *  - `deny` — a stored "Always deny", and plan's refusal of a stored allow/ask on an action not marked
 *    read-only: denied here, ahead of every allow rule and under `bypass` (the hook stage runs first).
 *  - `allow` — a stored "Always allow" or an unset read-only action: an EXPLICIT allow, the only answer a
 *    `dont-ask` child accepts for an MCP call (it denies an unresolved one without asking the bridge).
 *  - `ask` — a stored "Always ask" (and an unset non-read-only action in chat/dispatch): forces the child to
 *    `canUseTool` ahead of a saved allow rule and of `bypass`'s mode stage; the bridge then cards it. Under
 *    `dont-ask` the child denies it with this hook's reason.
 *  - `gate` — no opinion: the child and the gate decide exactly as they did before WS-26.
 * The policy is read live (`deps.policy`), so a `session.setPolicy` reaches the next call; the table and the
 * read-only answers are read live too, so a flip in the settings page reaches the next call with no respawn.
 */
function connectorPermissionHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const source = deps.connectors;
    if (source === undefined) return allow();
    const pre = input as PreToolUseHookInput;
    const toolName = typeof pre.tool_name === "string" ? pre.tool_name : "";
    // WS-27: the runtime's own statement of the call's server (`winter_mcp_server`), when it makes one.
    let liveKeys: ReadonlySet<string> | undefined;
    try { liveKeys = deps.capabilityKeys?.(); } catch { liveKeys = new Set(); }
    const facts = connectorFactsFor(source, toolName, hookCwd(input) ?? deps.cwd, statedServerFromHookInput(input), liveKeys);
    if (facts === undefined) return allow();
    // An unwired policy reads as `ask`: the answer under which every stored value means what it says.
    const policy = deps.policy?.() ?? "ask";
    const verdict = connectorVerdict({ setting: facts.setting, readOnly: facts.readOnly, policy, mode: deps.mode ?? "code" });
    switch (verdict) {
      case "deny": return deny(connectorDenialMessage(facts.server, facts.tool, { setting: facts.setting, policy }));
      case "allow": return allowExplicitly(facts.setting === "allow"
        ? `${facts.tool} (the ${facts.server} connector) is set to "Always allow" in Winter's connector permissions.`
        : `${facts.tool} (the ${facts.server} connector) is marked read-only by its server.`);
      case "ask": return ask(connectorAskReason(facts.server, facts.tool, facts.setting));
      case "gate": return allow();
    }
  };
}

/** ComputerV2 (2026-10-08): the plain name and the MCP spelling of the script tool. */
export const COMPUTER_V2_TOOL = "ComputerV2";
const COMPUTER_V2_MCP_NAME = "mcp__winter__computer_v2__script";

/**
 * ComputerV2's EXPLICIT allow — every code/dispatch policy, `plan` and `dont-ask` included (R16: no card per
 * script). The policy is per APP and enforced inside the call (`computer-use/policy.ts`: plan observes only,
 * dont-ask acts only on an "Always allow" app, the per-app card, the user's restrictions); this hook only
 * makes sure the call REACHES it. Without it a `dont-ask` child denies the unresolved MCP call without ever
 * calling `canUseTool` ("dontAsk mode denies unmatched actions"), and `plan` routes it to a prompt. An explicit
 * allow ranks below every deny and ask in the hook reducer, so a user's deny rule on `ComputerV2` still wins.
 * The MCP spelling counts only when this incarnation built the `computer_v2` server; chat never has it.
 */
function computerV2AllowHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    if (deps.mode === "chat") return allow();
    const name = (input as PreToolUseHookInput).tool_name;
    let liveKeys: ReadonlySet<string> | undefined;
    try { liveKeys = deps.capabilityKeys?.(); } catch { liveKeys = new Set(); }
    if (liveKeys !== undefined && !liveKeys.has("computer_v2")) return allow();
    if (name !== COMPUTER_V2_TOOL && name !== COMPUTER_V2_MCP_NAME) return allow();
    return allowExplicitly("ComputerV2's policy is per app and is applied inside the call (Settings → Computer Use).");
  };
}

const bashEscapeInput = (input: unknown): { command: string; escape: boolean; description?: string } => {
  const ti = (input as PreToolUseHookInput).tool_input as { command?: unknown; dangerouslyDisableSandbox?: unknown; description?: unknown } | null | undefined;
  return {
    command: typeof ti?.command === "string" ? ti.command : "",
    escape: ti?.dangerouslyDisableSandbox === true,
    ...(typeof ti?.description === "string" && ti.description.trim().length > 0 ? { description: ti.description } : {}),
  };
};

/** The hook input's own `cwd` (every runtime's hook input carries the session's working directory). */
function hookCwd(input: unknown): string | undefined {
  const cwd = (input as { cwd?: unknown } | null | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function escapeFloorHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const { command, escape } = bashEscapeInput(input);
    if (!escape) return allow();
    const hit = escapeFloorHit(command, deps.home, hookCwd(input));
    return hit === undefined ? allow() : deny(escapeFloorDenial(hit));
  };
}

// ── 2. Bash safety reviewer ─────────────────────────────────────────────────────────────────────

/** `PreToolUse`, matched on `"Bash"` — the reviewer is the auto-policy GATE (see this file's own
 *  header and `deps.policy`'s doc comment). `bashLooksSafe` bypasses the review call entirely for
 *  an obviously-safe command (no shell metacharacters, read-only argv0, or an allow-listed entry) —
 *  identical to the retired engine's own bypass. A DEFINITE `unsafe` VERDICT still denies, with the
 *  reviewer's own reason. A reviewer that THROWS (timeout, malformed verdict, aborted — i.e. no
 *  verdict was ever reached, not a verdict of "unsafe") is a different case (review r1 Minor): it
 *  escalates with `permissionDecision: "ask"` — `PreToolUseHookSpecificOutput.permissionDecision`
 *  is typed `HookPermissionDecision = "allow" | "ask" | "deny" | "defer"` in the installed SDK
 *  (`permissions/types.d.ts`), so "ask" is wire-expressible — the same "let a human decide" answer
 *  the retired engine's `ask`/`accept-edits` branch gave via a card
 *  (`engine.ts:4564-4572`: "reviewer, when ready, ANNOTATES the card's reason rather than gating").
 *  **Unmeasured**: whether Winter's approval bridge actually surfaces an `ask` PreToolUse decision
 *  as a card on THIS leg (vs. e.g. auto-denying an ask it cannot route) is not yet proven against a
 *  real child — carry: measure `ask` end-to-end (a real approval_requested reaching the phone/CLI)
 *  before relying on it as the sole safety net for a reviewer outage. */
function bashReviewerHook(deps: SessionHooksDeps): HookCallback {
  return async (input, toolUseID, { signal }) => {
    if (!deps.reviewer) return allow();
    if (deps.policy?.() !== "auto") return allow();
    if (deps.reviewerEnabled?.() === false) return allow();
    const pre = input as PreToolUseHookInput;
    const command = typeof (pre.tool_input as { command?: unknown } | null | undefined)?.command === "string"
      ? (pre.tool_input as { command: string }).command
      : "";
    if (!command) return allow();
    // C3-1 (lane C, 2026-09-22): a SANDBOX ESCAPE is never waved through on its first word or an
    // allow-list entry — `bashLooksSafe` assumes the sandbox (a read-only `cat` is harmless inside it
    // and reads `~/.ssh` outside it) — and the reviewer is told the command runs WITHOUT the sandbox.
    // Only a `safe` verdict records the CLEARANCE the approval bridge requires before it runs an escape
    // under `auto`; every early `allow()` above (no reviewer, not `auto`, disabled, no command) and
    // every failure below records none, so the bridge cards it (`bridge-common.ts`'s
    // `noteReviewerCleared` — fail closed by construction).
    const escape = (pre.tool_input as { dangerouslyDisableSandbox?: unknown } | null | undefined)?.dangerouslyDisableSandbox === true;
    // §2a's floor denies this one on its own, whatever the order the hooks run in; never spend (or
    // record) a review on it.
    if (escape && escapeFloorHit(command, deps.home, hookCwd(input)) !== undefined) return allow();
    if (!escape && bashLooksSafe(command, deps.reviewerAllow?.() ?? [])) return allow();
    try {
      // C3 round 3: for an escape the reviewer also sees the session's cwd (what "outside the project"
      // means) and the call's own `description` as the JUSTIFICATION — DATA, never instructions, under
      // the same rule the reviewer applies to any justification. A sandboxed call's request is unchanged.
      const { description } = bashEscapeInput(input);
      const cwd = deps.roots[0];
      const verdict = await deps.reviewer.review({
        class: "bash", command,
        ...(escape ? { unsandboxed: true, ...(description !== undefined ? { justification: description } : {}), ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}) } : {}),
      }, signal); // WS-24: the runner aborts `signal` when it times this callback out; the review aborts its model call with it
      if (verdict.verdict === "unsafe") return deny(verdict.reason || "the safety reviewer judged this command unsafe");
      if (escape) noteReviewerCleared(deps.sessionId, toolUseID ?? (typeof (pre as { tool_use_id?: unknown }).tool_use_id === "string" ? (pre as { tool_use_id: string }).tool_use_id : undefined), command);
      return allow();
    } catch (err) {
      // 2026-09-19 (review): STRUCTURAL vs TRANSIENT — see `ReviewerNoRunnableModel`'s own doc for the
      // full argument. No provider Winter's own jobs can use is configured on this home, so there is no
      // review to be had and there never was one: `allow()`, exactly what this hook's own first line
      // answered when such a home had no `BashReviewer` at all. The reviewer has already logged the
      // state change once; nothing is logged per call here.
      if (err instanceof ReviewerNoRunnableModel) return allow();
      // C3 (2026-09-22) — traced in the SDK source, not yet measured on a live child: this `ask`
      // reaches `canUseTool`, where the gate's `auto` allow used to answer it, i.e. silently ran it.
      // For a PLAIN bash call the child keeps this reason and the bridge cards on it
      // (`reviewerCouldNotJudge`); for an escape the child replaces it, and the bridge cards because
      // no clearance was recorded above.
      return ask(REVIEWER_ESCALATION_REASON);
    }
  };
}

// ── 3 & 4. Diagnostics-after-edit + the fileDiff producer ──────────────────────────────────────
//
// Both ride the SAME three file-mutating tools (`Edit`/`Write`/`NotebookEdit` — Winter 0.0.4 has
// no `MultiEdit`, see `auto-diagnostics.ts`'s own port note) and the same file-path-arg mapping, so
// it is declared once here rather than re-derived per feature.
const DIFF_TOOL_FILE_PATH_ARG: Readonly<Record<string, string>> = { Edit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

interface PendingDiffSnapshot { path: string; before: string }

/** `PreToolUse`, matched per file-mutating tool — snapshots the file BEFORE the child mutates it.
 *  Bounded by `DIFF_PATCH_MAX_BYTES`: a file already at or over that size is never even read (a
 *  giant diff nobody asked to see costs a giant read for nothing) — no pending snapshot is
 *  recorded, so the matching `PostToolUse` hook below finds none and skips diffing for that call,
 *  same as if diffs were off entirely. A missing file (the common Write-to-a-new-path case) reads
 *  as `before: ""` — the all-added new-file diff, matching `withFileDiff`'s own forcing fact. Never
 *  denies, never blocks: a diff-bookkeeping failure must not touch the tool call it is observing. */
function fileDiffPreToolUseHook(deps: SessionHooksDeps, pending: Map<string, PendingDiffSnapshot>): HookCallback {
  return async (input) => {
    if (!deps.home) return allow();
    const pre = input as PreToolUseHookInput;
    const argKey = DIFF_TOOL_FILE_PATH_ARG[pre.tool_name];
    if (!argKey) return allow();
    const rawPath = (pre.tool_input as Record<string, unknown> | null | undefined)?.[argKey];
    if (typeof rawPath !== "string" || !rawPath || rawPath.length > 1024) return allow(); // FileDiffSummary.path cap (protocol/events.ts)
    pending.delete(pre.tool_use_id);
    try {
      const abs = resolveWithinAny(readRootsOf(deps.roots, deps.tmpDir), rawPath);
      let before = "";
      try {
        const st = statSync(abs);
        if (st.size > DIFF_PATCH_MAX_BYTES) return allow(); // too large to snapshot — no pending entry, no diff
        // Nit (review r1): inherited gap, not new here — this bounds SIZE only. A binary file under
        // the cap is still read as "utf8" and diffed as text (same as the retired engine's
        // `diff-report.ts`/`fs-write.ts` never special-cased binary content either); a genuinely
        // binary target just produces a noisy/garbled patch rather than a wrong one.
        before = readFileSync(abs, "utf8");
      } catch {
        before = ""; // missing/unreadable → "" (new-file Write, or a target that never resolves)
      }
      pending.set(pre.tool_use_id, { path: rawPath, before });
    } catch {
      // outside the fence, or some other resolution failure — no diff, never a denial (this hook
      // never gates; the tool's OWN fence check is what actually protects the write).
    }
    return allow();
  };
}

/** `PostToolUse`, matched per file-mutating tool — reads the file AFTER the child's mutation
 *  landed, diffs against the PreToolUse snapshot, persists via `diffs/store.writeDiff`, and hands
 *  the summary to the projector through `attachFileDiff` (`diff-attach.ts`, controller-owned; the
 *  projector's `takeFileDiff` consumes it when it emits the matching `tool_result`). A true no-op
 *  (before === after byte-for-byte) writes nothing — no chip, no patch file, matching
 *  `withFileDiff`'s own rule. ANYTHING that throws here is caught, logged, and swallowed: the
 *  mutation already happened by the time this runs, so a diff-bookkeeping failure can never turn a
 *  successful edit into a hook-reported error. */
function fileDiffPostToolUseHook(deps: SessionHooksDeps, pending: Map<string, PendingDiffSnapshot>): HookCallback {
  return async (input) => {
    const post = input as PostToolUseHookInput;
    const snapshot = pending.get(post.tool_use_id);
    pending.delete(post.tool_use_id); // one-shot regardless of outcome — never re-diffed on a replay
    if (!snapshot || !deps.home) return allow();
    try {
      const abs = resolveWithinAny(readRootsOf(deps.roots, deps.tmpDir), snapshot.path);
      const after = readFileSync(abs, "utf8");
      const { patch, added, removed } = computeLineDiff(snapshot.before, after);
      if (added === 0 && removed === 0) return allow(); // no-op — no chip, no patch file
      const diffId = mintDiffId();
      await writeDiff(deps.home, deps.sessionId, diffId, { path: snapshot.path, added, removed }, patch);
      const summary: FileDiffSummary = { path: snapshot.path, added, removed, diffId };
      attachFileDiff(deps.sessionId, post.tool_use_id, summary);
    } catch (err) {
      console.error(`hooks: failed to compute/persist a diff for ${snapshot.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return allow();
  };
}

/** `PostToolUse`, matched per file-mutating tool — the SAME diagnostics-after-edit CC parity the
 *  retired engine ran (ported to Winter's own tool names/shapes in `auto-diagnostics.ts`). Skipped
 *  entirely (no LSP round trip at all) when `deps.lsp` was never wired, or when
 *  `autoDiagnosticsEnabled()` reads `false`. */
function diagnosticsPostToolUseHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (deps.autoDiagnosticsEnabled?.() === false) return allow();
    const mgr = deps.lsp?.();
    if (!mgr) return allow();
    const post = input as PostToolUseHookInput;
    if (!AUTO_DIAG_TOOL_NAMES.has(post.tool_name)) return allow();
    const suffix = await autoDiagnosticsSuffix({
      lsp: mgr,
      toolName: post.tool_name,
      toolInput: post.tool_input,
      cwd: post.cwd,
      roots: readRootsOf(deps.roots, deps.tmpDir),
      signal,
    });
    if (!suffix) return allow();
    return additionalContext(suffix.trimStart());
  };
}

// ── 5. The dangerous-domain floor ──────────────────────────────────────────────────────────────
//
// **WHY THIS EXISTS AT ALL, given `Options.web.blockedDomains`.** Since agent SDK 0.0.17 the child
// enforces the floor inside its own executors: `WebFetch` refuses a listed host on the input url, on
// every redirect hop and on a cache hit, and `WebSearch` sends the list as the backend's exclusion
// filter AND re-filters the hits locally. (Until WS-23 this hook was also the ONLY enforcement on the
// official `claude` leg, whose native tools took no such option; that leg is retired.)
//
// So it is defence in depth, and it EARNS that on its own terms: it is the earlier refusal (before
// the executor, so the transcript carries a policy sentence instead of a tool error), and it reads
// `dangerousDomainsAdded` LIVE, where the child's `blockedDomains` is frozen at the spawn it was
// built for until that session next incarnates. Its failure mode is closed (`failClosed`, WS-23).
//
// **WHY DENY AND NEVER ASK.** The spine lane measured that a Winter child's executor-level
// `blockedDomains` refuses a listed host even after an approved `ask` — so an `ask` here would raise
// a card whose approval provably cannot take effect, and
// chat/dispatch never prompt in the first place. A floor hit is a hard refusal in every mode; that is
// the ruling ("dangerous domains are hard-blocked"), and `mode-options.ts`'s `webOptionsFor` says the
// same thing about the same list.

/** The two tool names this floor is keyed on — the runtime's own web built-ins
 *  (`mode-options.ts`'s `SDK_WEB_BUILTINS`), reported unchanged to a `PreToolUse` hook. */
export const WEB_FLOOR_FETCH_TOOL = "WebFetch";
export const WEB_FLOOR_SEARCH_TOOL = "WebSearch";

/**
 * The most entries a `WebSearch` domain list may carry before the injection below stands down rather
 * than widening it — the agent SDK's own `MAX_DOMAIN_LIST_ENTRIES` (`tools/impl/web-search.ts`),
 * which REFUSES the whole call with `Error: blocked_domains has N entries; at most 1,000 are
 * accepted`. Unioning the floor into a list the model had already filled to the brim would therefore
 * turn a working search into a hard error — the floor breaking a call it has no opinion about. See
 * `webSearchFloorHook` for what happens instead.
 */
export const WEB_SEARCH_DOMAIN_LIST_CAP = 1000;

/** THIS session's effective floor: the shipped constant ∪ the user's per-project additions, read
 *  live. The shipped half is unconditional — an unwired or throwing `dangerousDomainsAdded` costs
 *  only the user-added half, never the floor itself. */
function effectiveDangerousDomains(deps: SessionHooksDeps): string[] {
  let added: readonly string[] = [];
  try {
    added = deps.dangerousDomainsAdded?.() ?? [];
  } catch (err) {
    logFacadeThrow("the dangerousDomainsAdded getter", err);
  }
  return [...SHIPPED_DANGEROUS_DOMAINS, ...(Array.isArray(added) ? added.filter((d): d is string => typeof d === "string") : [])];
}

/**
 * The one refusal sentence, FIXED: the same text for every hit, in every mode. Names
 * the host and the matched list entry (so the model can tell a policy block from a network failure,
 * and a human reading the transcript can find the entry) and says plainly that nothing can approve
 * it, so the model re-plans instead of retrying or asking.
 *
 * Deliberately does NOT echo the requested URL. The host is a value this daemon DERIVED (`new URL`'s
 * own normalization); a raw url's path/query is attacker-supplied text from whatever page told the
 * model to fetch it, and a refusal string is read straight back into the model's context.
 */
export function dangerousDomainFloorRefusal(host: string, matchedEntry: string): string {
  return `refused by Winter's dangerous-domain safety floor: ${host} matches the blocked entry ${matchedEntry}. This is a hard block, not a permission prompt — no approval, policy or retry can allow it (the list is settings.permissions.dangerousDomains). Find another source, or ask the user to change that setting.`;
}

/** `PreToolUse`, matched on `WebFetch` — the floor on the fetch's own target host.
 *
 *  UNPARSEABLE OR HOSTLESS urls PASS THROUGH (`dangerousUrlMatch` answers `null`): nothing dangerous
 *  can be said about a url with no host, and the tool's own input refusal is both clearer and closer
 *  to the mistake. A non-string (or absent) `url` is the same case.
 *
 *  A CROSS-HOST REDIRECT IS NOT A HOLE: the child re-checks every redirect hop against its own
 *  `blockedDomains` inside the executor, and a same-host or bare-`www.` hop cannot cross a
 *  suffix-matched floor entry. */
function webFetchFloorHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== WEB_FLOOR_FETCH_TOOL) return allow();
    const record = plainRecord(pre.tool_input);
    const match = dangerousUrlMatch(record["url"], effectiveDangerousDomains(deps));
    if (match === null) return allow();
    return deny(dangerousDomainFloorRefusal(match.host, match.matchedEntry));
  };
}

/**
 * `PreToolUse`, matched on `WebSearch` — the floor as a FILTER ON THE CALL, through `updatedInput`.
 *
 * A search has no single target host to check before it runs, so the floor rides the call instead:
 *
 *   no domain list          `blocked_domains` = the floor.
 *   `blocked_domains` only  `blocked_domains` = the floor ∪ the model's own (deduped).
 *   `allowed_domains`       the two lists are MUTUALLY EXCLUSIVE — claude refuses a call carrying
 *                           both outright (`Error: Cannot specify both allowed_domains and
 *                           blocked_domains in the same request`, and the Winter executor carries the
 *                           identical rule), so `blocked_domains` is NOT added. Floor-listed entries
 *                           are removed from the allow-list instead, and an allow-list that is
 *                           NOTHING BUT floor entries is a search that may only return blocked
 *                           domains: denied, with the same fixed refusal.
 *
 * The transform is rebuilt from the three DECLARED input keys only, never spread from the raw input:
 * claude schema-validates a hook's `updatedInput` (`updatedInput failed schema for …`, then "falling
 * back to original tool input"), its first-party `WebSearch` schema carries
 * `additionalProperties: false`, and a silent fall-back to the original input is exactly the failure
 * mode a safety floor must not have. A key the model invented outside those three is dropped —
 * which is what claude's own schema would have done to it.
 *
 * WHAT IT DOES NOT COVER (stated, not silently accepted): an allow-list entry BROADER than a floor
 * entry — `example.com` when the floor lists `paste.example.com`, or a bare TLD — is kept, because
 * it is not itself a floor match; the child re-filters its own hits locally against `blockedDomains`,
 * so a blocked subdomain is not surfaced. The exfiltration itself cannot happen in any case:
 * FETCHING any surfaced link goes through `webFetchFloorHook` above.
 */
function webSearchFloorHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== WEB_FLOOR_SEARCH_TOOL) return allow();
    const floor = effectiveDangerousDomains(deps);
    if (floor.length === 0) return allow();
    const record = plainRecord(pre.tool_input);
    // A WRONG-TYPED domain list is the TOOL'S refusal to give, not this hook's to overwrite
    // (whole-branch review N6). `blocked_domains: "pastebin.com"` or `allowed_domains: [1,2]` used to
    // be read as "absent" here, and the `blocked_domains` branch below then wrote the floor OVER the
    // malformed value — so the executor's own wrong-type refusal (agent SDK 0.0.17: such a call used to
    // search UNFILTERED and is refused now) could never fire, and a wrong-typed `allowed_domains` got
    // an injected `blocked_domains` beside it and came back as "cannot specify both" instead. Passing
    // the call through untransformed gives the model the error that names what it actually got wrong.
    // Nothing is lost by standing down: the call cannot search at all, and FETCHING anything it could
    // have surfaced still goes through `webFetchFloorHook`.
    if (wrongTypedDomainList(record["allowed_domains"]) || wrongTypedDomainList(record["blocked_domains"])) return allow();
    // WS-23 (hooks fix round 2): the same stand-down for a MISSING or too-short `query`. The agent SDK
    // now validates a hook's `updatedInput` against the tool's schema and DENIES an invalid one
    // whatever the original was, and this floor copies `query` verbatim -- so a rewrite of
    // `{query: "x"}` would turn the model's own typo into a policy denial it cannot act on. With no
    // query there is no search to filter; the tool's own "Missing query" is the right answer.
    const query = record["query"];
    if (typeof query !== "string" || query.length < 2) return allow();
    const allowed = domainList(record["allowed_domains"]);

    if (allowed !== undefined) {
      const kept = allowed.filter((domain) => dangerousHostMatch(domain, floor) === null);
      if (kept.length === allowed.length) return allow(); // nothing of the floor is in the allow-list
      if (kept.length === 0) {
        // Named from the FIRST floor-matched entry, normalized the same way the matcher read it — an
        // allow-list entry is the one value in this path the model wrote itself, so it goes into a
        // model-readable refusal in its normalized form, never raw.
        const hit = allowed.map((domain) => ({ domain, entry: dangerousHostMatch(domain, floor) })).find((x) => x.entry !== null)!;
        return deny(dangerousDomainFloorRefusal(normalizeDangerousDomain(hit.domain), hit.entry!));
      }
      return transformInput(webSearchInput(record, { allowed_domains: kept }));
    }

    const own = domainList(record["blocked_domains"]) ?? [];
    const union = dedupeDomains([...floor, ...own]);
    // Over the SDK's own list cap the floor stands down rather than turning a working search into
    // `Error: blocked_domains has N entries` — the floor first, so what is dropped is the tail of a
    // model-supplied list of >962 domains (an absurd input, and a RESULT FILTER either way, never a
    // safety boundary: the fetch of anything it lets through is still floor-denied).
    const capped = union.length > WEB_SEARCH_DOMAIN_LIST_CAP ? union.slice(0, WEB_SEARCH_DOMAIN_LIST_CAP) : union;
    if (sameDomains(own, capped)) return allow(); // the model already asked for exactly this
    return transformInput(webSearchInput(record, { blocked_domains: capped }));
  };
}

/** `Search` — Exa ANSWER mode, the agent SDK's built-in since 2026-10-01 (it was the daemon's own tool). */
export const WEB_FLOOR_ANSWER_TOOL = "Search";

/**
 * `PreToolUse`, matched on `Search` — the LIVE floor on the citations it may show. The runtime's `Search`
 * withholds every cited url on the session's `web.blockedDomains`, which is the floor as it stood at SPAWN;
 * the daemon's own copy read `dangerousDomainsAdded` per call, so an entry the user adds mid-session was
 * enforced on the very next search. This hook keeps that: it hands the effective floor (shipped ∪ the
 * user's, read now) to the call as `blocked_domains` — an input the runtime's `Search` reads only to ADD
 * to its floor (never advertised to the model, never sent to Exa, capped at the same 1000 entries).
 *
 * The transform carries `query` verbatim and the list, nothing else (`Search` takes no other key). A
 * missing or blank `query` stands down: the tool's own "Missing query" is the right answer. Registered
 * LAST with the other floors, for the same last-writer-wins reason.
 */
function searchFloorHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== WEB_FLOOR_ANSWER_TOOL) return allow();
    const record = plainRecord(pre.tool_input);
    const query = record["query"];
    if (typeof query !== "string" || query.trim().length === 0) return allow();
    const floor = effectiveDangerousDomains(deps);
    if (floor.length === 0) return allow();
    const own = domainList(record["blocked_domains"]) ?? [];
    const union = dedupeDomains([...floor, ...own]).slice(0, WEB_SEARCH_DOMAIN_LIST_CAP);
    if (sameDomains(own, union)) return allow();
    return transformInput({ query, blocked_domains: union });
  };
}

/**
 * The audit line's `outcome` for one completed `Search`, read off the runtime's own result sentences
 * (`tools/impl/search.ts` in the agent SDK — stable for exactly this). The vocabulary is the one the
 * daemon's own `Search` wrote (`ok`, `no_key`, `timeout`, `network_error`, `unauthorized`,
 * `out_of_credits`, `rate_limited`, `http_error`, `parse_error`), plus what the runtime can say that the
 * daemon's copy could not (`interrupted`, `disabled`, `unavailable`, `invalid_input`, `key_unreadable`).
 * A failure whose text matches none of them is `error`, never `ok`.
 */
export function searchAuditOutcome(text: string, failed: boolean): string {
  if (!failed) return "ok";
  if (text.startsWith("Search needs an Exa API key")) return "no_key";
  if (text.startsWith("search failed: an Exa API key is configured but could not be used") || text.startsWith("search failed: the key resolver failed")) return "key_unreadable";
  if (text.startsWith("search timed out for")) return "timeout";
  if (text === "Search was interrupted.") return "interrupted";
  if (text.startsWith("search failed: could not reach the search service")) return "network_error";
  if (text.startsWith("search failed: the configured Exa API key was rejected")) return "unauthorized";
  if (text.startsWith("search failed: this Exa account is out of credits")) return "out_of_credits";
  if (text.startsWith("search failed: the search service is rate-limiting")) return "rate_limited";
  if (text.startsWith("search failed: the search service rejected the request") || text.startsWith("search failed: the search service is unavailable (HTTP")) return "http_error";
  if (text.startsWith("search failed: could not parse response") || text.startsWith("search failed: malformed response")) return "parse_error";
  if (text.startsWith("Error: Missing query")) return "invalid_input";
  if (text.startsWith("Error: Search is not available")) return "unavailable";
  return "error";
}

/**
 * `PostToolUse` / `PostToolUseFailure`, matched on `Search` — one `{kind:"network", tool:"Search", query,
 * outcome}` line in the daemon's audit log per call that RAN (a call the floors or a permission denied never
 * ran, and the daemon's own `Search` wrote nothing for one either). The query only: never the key (the
 * runtime holds it, not the hook input), never the answer. `Web search is turned off` is not an error
 * result in the runtime, so it is read on the success path. An observer: it answers nothing and a throw
 * stays inside it.
 */
function searchAuditHook(deps: SessionHooksDeps, failed: boolean): HookCallback {
  return async (input) => {
    try {
      if (deps.audit === undefined) return {};
      const post = input as { tool_name?: unknown; tool_input?: unknown; tool_response?: unknown; error?: unknown };
      if (post.tool_name !== WEB_FLOOR_ANSWER_TOOL) return {};
      const query = plainRecord(post.tool_input)["query"];
      const raw = failed ? post.error : post.tool_response;
      const text = typeof raw === "string" ? raw : "";
      const outcome = !failed && text === "Web search is turned off for this session." ? "disabled" : searchAuditOutcome(text, failed);
      deps.audit({ kind: "network", tool: WEB_FLOOR_ANSWER_TOOL, query: typeof query === "string" ? query : "", outcome });
    } catch (err) {
      logFacadeThrow("the Search audit line", err);
    }
    return {};
  };
}

/** `tool_input` as a plain record, for any hostile shape — `null`, an array, a string, a number all
 *  read as "no fields", never a throw and never a prototype walk (`Object.create(null)`-based copy,
 *  so a `__proto__` key in the model's own JSON is data here rather than an assignment). */
function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.create(null) as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) out[key] = (value as Record<string, unknown>)[key];
  return out;
}

/** A `WebSearch` domain list as the tools themselves read it: an array of non-blank strings, or
 *  `undefined` for absent, empty, all-blank, or the wrong type entirely. Mirrors the agent SDK's own
 *  `stringArray` collapse of an explicitly-empty list to "absent" — a list that filters nothing is
 *  indistinguishable in effect from not having named the field.
 *
 *  A wrong TYPE also reads as `undefined` here, and that is no longer load-bearing: `webSearchFloorHook`
 *  stands down on a wrong-typed list BEFORE it asks this function anything (see `wrongTypedDomainList`),
 *  so this collapse is only ever reached for a list that is genuinely absent or genuinely empty. */
function domainList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

/** Is this domain-list field present and of a shape the TOOL will refuse — anything but an array, or
 *  an array carrying a non-string element? An ABSENT field is not wrong-typed, and neither is an
 *  explicitly EMPTY array or one of only blank strings: the runtimes' own `stringArray` collapses
 *  those to "absent", so the floor may treat them the same way and inject into them.
 *
 *  JSON `null` IS ABSENT, measured rather than assumed: the Winter executor's own reader opens with
 *  `value === undefined || value === null -> absent` (agent SDK 0.0.17, `tools/impl/web-search.ts`).
 *  Reading it as wrong-typed here would make the floor stand down for a call the tool would happily
 *  run unfiltered — the one direction this predicate must never get wrong. */
function wrongTypedDomainList(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (!Array.isArray(value)) return true;
  return value.some((v) => typeof v !== "string");
}

/** Case-insensitive dedupe that keeps the FIRST spelling of each domain (so the floor's own entries
 *  survive verbatim when a model happened to list one too) and never grows past what it was given. */
function dedupeDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const domain of domains) {
    const key = domain.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(domain);
  }
  return out;
}

function sameDomains(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The transform, built from the three DECLARED `WebSearch` keys only — see `webSearchFloorHook`. */
function webSearchInput(record: Record<string, unknown>, patch: { allowed_domains?: string[]; blocked_domains?: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("query" in record) out["query"] = record["query"]; // verbatim, whatever it is: the tool's own schema/validation owns it
  if (patch.allowed_domains !== undefined) out["allowed_domains"] = patch.allowed_domains;
  else if ("allowed_domains" in record) out["allowed_domains"] = record["allowed_domains"];
  if (patch.blocked_domains !== undefined) out["blocked_domains"] = patch.blocked_domains;
  else if ("blocked_domains" in record) out["blocked_domains"] = record["blocked_domains"];
  return out;
}

/** `{ winter }` — the session's hook groups, built ONCE from `deps` and the per-tool hook functions
 *  above. `winter` is `Options["hooks"]` from `@yanlinglabs/winter-agent-sdk`. (WS-23: the identical
 *  `official` copy the retired official leg took is gone.)
 *
 *  Every hook function above is a safe, cheap no-op (`allow()`/`{}`) when its own dependency is
 *  absent, so registering the groups unconditionally costs nothing extra beyond the wire round trip
 *  `Options.hooks` already requires the moment ANY group is registered for an event — and the
 *  plugin-hook groups (no matcher) are the one case that always needs to be live, since a plugin
 *  can be enabled on a running daemon between sessions with no restart. */
export function sessionHooksFor(deps: SessionHooksDeps): { winter: Options["hooks"] | undefined } {
  const pending = new Map<string, PendingDiffSnapshot>();

  const preToolUse: FailClosedMatcher[] = [{ hooks: [pluginPreToolUseHook(deps)] }];
  // WS-23: every floor and security callback below is wrapped by `failClosed` (a throw is a deny)
  // and its group carries `failClosed: true` (a timeout / malformed answer / failed bridge is a deny
  // too, on a WS-23 SDK). The plugin, fileDiff and diagnostics hooks are deliberately NOT: they are
  // observers and a plugin's own gate, whose designed failure mode is to stay out of the way.
  //
  // The reviewer: only its OUTER code is wrapped. Its own designed failure modes are unchanged -- a
  // transient review failure still escalates with `ask`, and a structurally unavailable reviewer
  // still allows (`bashReviewerHook`'s own catch) -- what changes is that a throw OUTSIDE the review
  // (a settings getter, the escape parse) is a deny instead of a silent pass.
  if (deps.reviewer) preToolUse.push({ matcher: "Bash", failClosed: true, hooks: [failClosed("bash safety reviewer", bashReviewerHook(deps))] });
  // C3 round 3: the escape floor runs under EVERY policy, reviewer or none — see §2a. Its position
  // does not matter: a deny outranks every other hook answer, and the reviewer skips (never reviews,
  // never clears) a command this floor denies, whichever of the two runs first.
  // Fix round 2: in the escape floor's own group, a Bash write under any `.winter/<kind>` is asked about,
  // sandboxed or not (see `bashProtectedWriteHit`). An `ask` — the floor's deny, when both apply, outranks it.
  preToolUse.push({ matcher: "Bash", failClosed: true, hooks: [failClosed("sandbox-escape floor", escapeFloorHook(deps)), failClosed("protected-path Bash fence", bashProtectedWriteHook(deps.home))] });
  // WS-21 (spec §7.1, §7.2): the path fence — every policy. Unmatched (one callback per tool
  // call) because the write and read tools carry two vocabularies; anything else is an immediate allow.
  if (deps.home) preToolUse.push({ failClosed: true, hooks: [failClosed("path fence", pathFenceHook(deps))] });
  // WS-26: the connector-permission floor — every mode, every policy; see `connectorPermissionHook`.
  if (deps.connectors) preToolUse.push({ failClosed: true, hooks: [failClosed("connector-permission floor", connectorPermissionHook(deps))] });
  // ComputerV2: the call itself is allowed under every policy; its policy is per app, inside the call.
  preToolUse.push({ matcher: `${COMPUTER_V2_TOOL}|${COMPUTER_V2_MCP_NAME}`, hooks: [computerV2AllowHook(deps)] });
  if (deps.home) {
    for (const tool of Object.keys(DIFF_TOOL_FILE_PATH_ARG)) {
      preToolUse.push({ matcher: tool, hooks: [fileDiffPreToolUseHook(deps, pending)] });
    }
  }
  // The dangerous-domain floor — registered UNCONDITIONALLY (the shipped half of the list is a
  // constant; there is no configuration under which a session opts out) and LAST, deliberately:
  //
  //  - DENY needs no ordering help. `deny` is the strictest rank in the SDK's own hook reducer
  //    (deny > defer > ask > allow > none) and a committed deny short-circuits every hook after it,
  //    so a plugin's `allow` can never un-deny a floor hit from any position.
  //  - The TRANSFORM does. Several hooks' `transformedInput`s compose in evaluation order, LAST
  //    WRITER WINS — so a plugin pre-tool hook that one day rewrites a `WebSearch` call's own
  //    `blocked_domains` must not be able to land after the floor and drop it. Last here means last.
  for (const tool of [WEB_FLOOR_FETCH_TOOL, WEB_FLOOR_SEARCH_TOOL, WEB_FLOOR_ANSWER_TOOL]) {
    preToolUse.push({
      matcher: tool,
      failClosed: true,
      hooks: [failClosed("dangerous-domain floor", tool === WEB_FLOOR_FETCH_TOOL ? webFetchFloorHook(deps) : tool === WEB_FLOOR_SEARCH_TOOL ? webSearchFloorHook(deps) : searchFloorHook(deps))],
    });
  }

  // (`tool_result.siteIcons` for the daemon's own Search used to ride inside this callback, in chat and
  // dispatch. `Search` is the agent SDK's built-in since 2026-10-01 and reports its citations' icons on
  // its own host-facing `tool_result` block, as `WebFetch`/`WebSearch` do — the projector reads them there.)
  const postToolUse: HookCallbackMatcher[] = [{ hooks: [pluginPostToolUseHook(deps)] }];
  // `Search`'s audit line — the daemon's own `Search` wrote one per call; the runtime's copy cannot.
  if (deps.audit) postToolUse.push({ matcher: WEB_FLOOR_ANSWER_TOOL, hooks: [searchAuditHook(deps, false)] });
  for (const tool of Object.keys(DIFF_TOOL_FILE_PATH_ARG)) {
    const hooks: HookCallback[] = [];
    if (deps.home) hooks.push(fileDiffPostToolUseHook(deps, pending));
    if (deps.lsp) hooks.push(diagnosticsPostToolUseHook(deps));
    if (hooks.length > 0) postToolUse.push({ matcher: tool, hooks });
  }

  // Review r1 MAJOR 2: the failure twin of the unmatched PostToolUse plugin-observation group —
  // see `pluginPostToolUseFailureHook`'s own doc comment for why this is a SEPARATE SDK event
  // rather than a second branch of `PostToolUse`.
  const postToolUseFailure: HookCallbackMatcher[] = [{ hooks: [pluginPostToolUseFailureHook(deps)] }];
  if (deps.audit) postToolUseFailure.push({ matcher: WEB_FLOOR_ANSWER_TOOL, hooks: [searchAuditHook(deps, true)] });

  const built: Options["hooks"] = { PreToolUse: preToolUse, PostToolUse: postToolUse, PostToolUseFailure: postToolUseFailure };
  return { winter: built };
}
