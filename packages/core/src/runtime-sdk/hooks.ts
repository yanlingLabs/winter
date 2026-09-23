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
//      port of anything the retired engine had: it is the only enforcement of the floor that exists
//      on the OFFICIAL leg at all, where claude's native web tools take no host-supplied option.
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
// **The official leg (`official` in the return value), fix wave M4 (ruling P8c-19).** Lane 3's own
// header used to read `OptionsTemplatePolicy.hooks` as the router's DECLARATIVE, settings-file-style
// `SettingsHooksConfig` — the wrong reading. Measured against the router 0.0.3 source
// (`dist/official/options-template.d.ts` + `.js`): `buildOfficialOptions` does
// `hooks: mergeHooks(createContainmentHooks(...), policy.hooks)`, and `mergeHooks(ours, hostHooks)`
// treats `hostHooks` as `Record<HookEvent, HookCallbackMatcher[]>` — the SAME `HookCallback`/
// `HookCallbackMatcher`/`HookEvent` shape `@yanlinglabs/winter-agent-sdk` exports (`options.d.ts`),
// which is itself a structural mirror of `@anthropic-ai/claude-agent-sdk`'s own `sdk.d.ts` types
// (`HookCallback = (input, toolUseID, {signal}) => Promise<HookJSONOutput>`; identical `HookInput`
// field names — `tool_name`/`tool_input`/`tool_response`/`tool_use_id`/`session_id`/`agent_id` — on
// both SDKs). So the exact object built for `winter` below is ALREADY the shape the official leg's
// `mergeHooks` expects for its second argument: no translation, no second implementation. The
// router puts its own containment matchers FIRST in each event's array (`mergeHooks`'s own
// `[...matchers, ...host[event] ?? []]`), so Winter's groups here always run AFTER the containment
// floor on the official leg — the ordering the fix-wave brief calls for. `official-options.ts`
// (lane 1's file) threads this value into `OptionsTemplatePolicy.hooks` via `session-driver.ts`'s
// `hooksFor(session).official`, already wired at integration.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
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
import type { Mode as SessionMode } from "../agent/tools/registry";

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
   * resolves against it) and, read LIVE per call, its TRUSTED project root (`repoRootFor(cwd)` when the
   * cwd is trusted, else `null` — an untrusted project has no project tier to protect). Absent `mode`:
   * the hook treats the session as code, the answer that raises a card rather than none.
   */
  mode?: SessionMode;
  cwd?: string;
  trustedProjectRoot?: () => string | null;
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
// every policy and on both legs (`sessionHooksFor` feeds both). A PreToolUse deny is terminal ahead of
// every permission mode (agent SDK 0.0.17 `permissions/evaluator.ts` ~1657).
//
// Conservative on purpose: a substring match on the control-plane filenames (plus `trust.json`), on
// any `.winter/agents`, and on every spelling of every fenced home path this file can predict — the
// literal home (and its realpath), `~`/`$HOME`/`${HOME}` for a home under the user's own,
// `$WINTER_HOME`/`${WINTER_HOME}`, `<home basename>/…`, and a relative path after a `cd` into the home —
// over a normalised command (case, quotes, `//`, `/./`). `cache` and `plugins` are refused only in a
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
function homePrefixes(home: string): string[] {
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
    if (base.length > 0) prefixes.add(base.toLowerCase());
  }
  return [...prefixes];
}

/** One fenced target as the floor matches it. `writeOnly` — the model is POINTED at content under it
 *  to read and run (plugin skills), so only a write-shaped use is refused (review N1). */
interface FloorNeedle { needle: string; writeOnly: boolean }

/**
 * Every fenced `<home>` path, spelled under every home prefix — the fenced dirs and files come from
 * `home-fence.ts`, i.e. from the SAME list the Bash sandbox's `denyWrite` carries (whole-branch review
 * 2026-09-23). A path lying outside the home is matched by its own absolute spelling.
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
    for (const n of spellings) out.set(n, (out.get(n) ?? true) && writeOnly);
  }
  return [...out].map(([needle, writeOnly]) => ({ needle, writeOnly }));
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
  }
  return start;
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
export function escapeFloorHit(command: string, home: string | undefined): string | undefined {
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
  // Review I7: the user tier's PROTECTED paths (spec §7.2), write-shaped — the shared runtime home's and
  // the old/compat spelling at the home's top level (a link into `sdk/` on a migrated home, the store
  // itself on router 0.0.11). A write tool gets a card for these; an unsandboxed command gets none.
  for (const pre of homePrefixes(bareHome)) {
    for (const base of [`${pre}/sdk`, pre]) {
      for (const needle of [...PROTECTED_KIND_NAMES.map((k) => `${base}/${k}`), `${base}/winter.md`]) {
        for (let at = c.indexOf(needle); at >= 0; at = c.indexOf(needle, at + 1)) {
          if (at <= writeStart) continue;
          const next = c.charAt(at + needle.length);
          if (next === "" || next === "/" || /[\s;&|()<>]/.test(next)) return "a protected path (skills, commands, rules, output styles or WINTER.md)";
        }
      }
    }
  }
  // …and the runtimes' transcript store, `sdk/projects`, write-shaped and OUTSIDE each project's
  // `memory/` (the model's MEMDIR, which it maintains itself).
  for (const pre of homePrefixes(bareHome)) {
    const needle = `${pre}/sdk/projects`;
    for (let at = c.indexOf(needle); at >= 0; at = c.indexOf(needle, at + 1)) {
      if (at <= writeStart) continue;
      const rest = c.slice(at + needle.length).split(/[\s;&|()<>]/, 1)[0] ?? "";
      if (rest !== "" && !rest.startsWith("/")) continue; // `sdk/projectsx`: not this directory
      if (/^\/[^/]+\/memory(\/|$)/.test(rest)) continue;
      return "sdk/projects, the runtimes' own transcript store";
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
// One PreToolUse hook for the write- and read-class tools, on both legs and under every policy (a
// PreToolUse answer is evaluated ahead of the permission mode — F16), in this order:
//  1. the control-plane fence the bridge already applies at (2) — the three control-plane filenames,
//     `mcp.json` and `settings*.json` under any `.winter/`, and every home-fenced path — as a hook too,
//     so it binds where the bridge is never consulted (a matching allow rule, bypass);
//  2. `sdk/projects/**` outside each project's `memory/` (`storeWriteDenial`) — deny;
//  3. the read row (`protectedReadDenial`) — deny;
//  4. a protected write (`protectedWriteDecision`) — ask in code, deny in chat and dispatch. The bridge
//     (5e) independently refuses to auto-allow one, and the router pins the same set as flag-layer ask
//     rules (claude's own sensitive-file check could otherwise swallow this hook's ask — F16).
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

const bashEscapeInput = (input: unknown): { command: string; escape: boolean; description?: string } => {
  const ti = (input as PreToolUseHookInput).tool_input as { command?: unknown; dangerouslyDisableSandbox?: unknown; description?: unknown } | null | undefined;
  return {
    command: typeof ti?.command === "string" ? ti.command : "",
    escape: ti?.dangerouslyDisableSandbox === true,
    ...(typeof ti?.description === "string" && ti.description.trim().length > 0 ? { description: ti.description } : {}),
  };
};

function escapeFloorHook(deps: SessionHooksDeps): HookCallback {
  return async (input) => {
    const { command, escape } = bashEscapeInput(input);
    if (!escape) return allow();
    const hit = escapeFloorHit(command, deps.home);
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
    if (escape && escapeFloorHit(command, deps.home) !== undefined) return allow();
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
      }, signal);
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

// ── 5. The dangerous-domain floor, on BOTH legs ────────────────────────────────────────────────
//
// **WHY THIS EXISTS AT ALL, given `Options.web.blockedDomains`.** At agent SDK 0.0.17 a WINTER child
// enforces the floor inside its own executors: `WebFetch` refuses a listed host on the input url, on
// every redirect hop and on a cache hit, and `WebSearch` sends the list as the backend's exclusion
// filter AND re-filters the hits locally. Nothing equivalent exists on the OFFICIAL leg — claude's
// native `WebFetch`/`WebSearch` are the user's ruling now (both tools stay, with claude's own
// behaviour), and `official-options.ts` sends no `web` block at all because claude has no such
// option to send it to. So on that leg this hook is the ONLY thing between a floor domain and the
// network, and `Options.hooks` is the one surface both legs share (`sessionHooksFor`'s own header).
//
// On the Winter leg it is defence in depth, and it EARNS that on its own terms: it is the earlier
// refusal (before the executor, so the transcript carries a policy sentence instead of a tool error),
// and it reads `dangerousDomainsAdded` LIVE, where the child's `blockedDomains` is frozen at the
// spawn it was built for until that session next incarnates.
//
// **WHY DENY AND NEVER ASK.** The spine lane measured that a Winter child's executor-level
// `blockedDomains` refuses a listed host even after an approved `ask` — so an `ask` here would raise
// a card whose approval provably cannot take effect on the leg where a card exists at all, and
// chat/dispatch never prompt in the first place. A floor hit is a hard refusal in every mode; that is
// the ruling ("dangerous domains are hard-blocked"), and `mode-options.ts`'s `webOptionsFor` says the
// same thing about the same list.

/** The two tool names this floor is keyed on. Both runtimes ship the pair under the SAME two names
 *  (`mode-options.ts`'s `SDK_WEB_BUILTINS`), and the official binary reports them unchanged to a
 *  `PreToolUse` hook (measured — `test/runtime-sdk/web-floor-measure.e2e.test.ts`), which is what
 *  lets one matcher pair serve both legs. */
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
 * The one refusal sentence, FIXED: the same text for every hit, on either leg, in every mode. Names
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
 *  A CROSS-HOST REDIRECT IS NOT A HOLE, and it is why a host-side hook is enough for a tool that
 *  walks redirects itself: claude's `WebFetch` does NOT follow a cross-host redirect — it returns
 *  `REDIRECT DETECTED` to the model and asks it to call again with the redirect url — so the second
 *  call arrives at this hook like any other, and the short-link-into-a-paste-host route is checked on
 *  the hop that would actually reach it. (A Winter child re-checks every hop inside its own executor
 *  as well.) Same-host and bare-`www.` redirects are auto-followed on both legs, and a same-host hop
 *  cannot cross a suffix-matched floor entry. */
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
 * it is not itself a floor match, and on the official leg nothing then stops a blocked subdomain from
 * being SURFACED as a search hit (a Winter child re-filters its own hits locally, claude cannot be
 * asked to). The exfiltration itself still cannot happen: FETCHING any surfaced link goes through
 * `webFetchFloorHook` above, on both legs.
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
    // have surfaced still goes through `webFetchFloorHook` on both legs.
    if (wrongTypedDomainList(record["allowed_domains"]) || wrongTypedDomainList(record["blocked_domains"])) return allow();
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

/** `{ winter, official }` — fix wave M4 (ruling P8c-19): BOTH legs get the same groups, built ONCE
 *  from the same `deps` and the same per-tool hook functions (this file's header explains why the
 *  two SDKs' `HookCallback`/`HookCallbackMatcher`/`HookEvent` shapes make that safe rather than a
 *  reuse-across-legs hazard). `winter` is `Options["hooks"]` from `@yanlinglabs/winter-agent-sdk`;
 *  `official` is the identical object, typed `unknown` only because `OptionsTemplatePolicy.hooks`
 *  (the router 0.0.3 export `official-options.ts` assigns it through) declares no narrower type —
 *  never a second, independently-built copy that could drift from `winter`.
 *
 *  Every hook function above is a safe, cheap no-op (`allow()`/`{}`) when its own dependency is
 *  absent, so registering the groups unconditionally costs nothing extra beyond the wire round trip
 *  `Options.hooks` already requires the moment ANY group is registered for an event — and the
 *  plugin-hook groups (no matcher) are the one case that always needs to be live, since a plugin
 *  can be enabled on a running daemon between sessions with no restart. */
export function sessionHooksFor(deps: SessionHooksDeps): { winter: Options["hooks"] | undefined; official: unknown } {
  const pending = new Map<string, PendingDiffSnapshot>();

  const preToolUse: HookCallbackMatcher[] = [{ hooks: [pluginPreToolUseHook(deps)] }];
  if (deps.reviewer) preToolUse.push({ matcher: "Bash", hooks: [bashReviewerHook(deps)] });
  // C3 round 3: the escape floor runs under EVERY policy, reviewer or none — see §2a. Its position
  // does not matter: a deny outranks every other hook answer, and the reviewer skips (never reviews,
  // never clears) a command this floor denies, whichever of the two runs first.
  preToolUse.push({ matcher: "Bash", hooks: [escapeFloorHook(deps)] });
  // WS-21 (spec §7.1, §7.2): the path fence — every policy, both legs. Unmatched (one callback per tool
  // call) because the write and read tools carry two vocabularies; anything else is an immediate allow.
  if (deps.home) preToolUse.push({ hooks: [pathFenceHook(deps)] });
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
  for (const tool of [WEB_FLOOR_FETCH_TOOL, WEB_FLOOR_SEARCH_TOOL]) {
    preToolUse.push({ matcher: tool, hooks: [tool === WEB_FLOOR_FETCH_TOOL ? webFetchFloorHook(deps) : webSearchFloorHook(deps)] });
  }

  const postToolUse: HookCallbackMatcher[] = [{ hooks: [pluginPostToolUseHook(deps)] }];
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

  const built: Options["hooks"] = { PreToolUse: preToolUse, PostToolUse: postToolUse, PostToolUseFailure: postToolUseFailure };
  return { winter: built, official: built };
}
