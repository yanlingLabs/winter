// Phase 8c Lane 3, Tasks 3.2-3.4 — the Winter-leg `Options.hooks` wiring, gated on the P8c-7
// measurement (`test/runtime-sdk/hooks-measure.e2e.test.ts`: measured = YES — a real spawned
// `winter` child round-trips `PreToolUse`/`PostToolUse` callbacks through the wrapper's stdio
// "hook" control request, and a `PreToolUse` deny genuinely blocks the call). This module is the
// ONE place that builds the four features the retired engine ran through its own `cfg.hooks`
// facade + dispatch-loop call sites, re-expressed as SDK `HookCallback`s:
//
//   1. Plugin manifest hooks (`plugins/hook-runner.ts` + `hook-registry.ts`'s `HookFacade`) — a
//      `PreToolUse` group with no matcher (fires for every tool) that can DENY, and a
//      `PostToolUse` group (also unmatched) that only observes.
//   2. The bash-safety reviewer (`agent/reviewer.ts`'s `BashReviewer`) — a `PreToolUse` group
//      matched on `"Bash"`, gated to Norma's `auto` policy exactly as the retired engine gated it
//      (`meta.approvalPolicy === "auto" && reviewerReady`, engine.ts:4547-4548): the reviewer is a
//      GATE for auto-policy calls, never a second opinion layered under `ask`/`accept-edits`, whose
//      human card already exists on this leg through the approval bridge.
//   3. Diagnostics-after-edit (`agent/lsp/auto-diagnostics.ts`, ported to Winter's own tool
//      names/shapes at Task 3.2) — a `PostToolUse` group per file-mutating tool that appends the
//      diagnostics block as `additionalContext`.
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
// **The official leg (`official` in the return value) is a documented carry, not a stub bug.**
// `OptionsTemplatePolicy.hooks` (global-constraints Interfaces block) is typed `unknown` precisely
// because its shape is the router's own settings-file-style `SettingsHooksConfig`
// (`@yanlinglabs/winter-agent-sdk`'s `settings/types.d.ts`: `SettingsHookMatcherGroup` /
// `SettingsHookHandler`) — a DECLARATIVE config the router's `mergeHooks` consumes, not a place a
// raw JS `HookCallback` closure over THIS session's `HookFacade`/`BashReviewer`/`LspManager`
// instances can be handed directly. Neither that merge point nor a live-callback bridge for it is
// among Lane 3's owned files or documented interfaces (they live in `runtime-sdk/official-options.ts`,
// lane 1's), so `official` returns `undefined` here — see this file's own report for the carry.
import { readFileSync, statSync } from "node:fs";
import type {
  HookCallback, HookCallbackMatcher, HookJSONOutput, Options,
  PostToolUseHookInput, PreToolUseHookInput,
} from "@yanlinglabs/winter-agent-sdk";
import type { FileDiffSummary } from "@norma/protocol";
import { BashReviewer, bashLooksSafe } from "../agent/reviewer";
import type { SessionApprovalPolicy } from "../agent/gate";
import { AUTO_DIAG_TOOL_NAMES, autoDiagnosticsSuffix } from "../agent/lsp/auto-diagnostics";
import type { LspManager } from "../agent/lsp/manager";
import { resolveWithinAny } from "../agent/paths";
import { computeLineDiff } from "../diffs/myers";
import { DIFF_PATCH_MAX_BYTES, mintDiffId, writeDiff } from "../diffs/store";
import type { HookResult } from "../plugins/hook-runner";
import { attachFileDiff } from "./diff-attach";

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
  /** Norma's own session id — what a produced `fileDiff` is filed under (`diffs/store.ts`'s
   *  `<home>/diffs/<sessionId>/` and `diff-attach.ts`'s pending map). */
  sessionId: string;
  /** NORMA_HOME. Absent ⇒ the `fileDiff` producer is skipped entirely (mirrors the retired
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

function additionalContext(text: string): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
}

// ── 1. Plugin manifest hooks ───────────────────────────────────────────────────────────────────

/** `PreToolUse`, no matcher (every tool) — mirrors the retired engine's "Site 2" pre-tool fire:
 *  runs every plugin's `pre-tool` hook in registry order and, on the FIRST `blocked` verdict,
 *  denies with the same message shape `hookBlockOutcome` used (`engine.ts:1986-1988`). Fail-open
 *  for `error`/`timeout`/non-blocked `ok` — those are simply not `blocked`, no extra code needed. */
function pluginPreToolUseHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.hookFacade) return allow();
    const pre = input as PreToolUseHookInput;
    const results = await deps.hookFacade.runFor(
      "pre-tool",
      { toolName: pre.tool_name, argsJson: safeJson(pre.tool_input), threadId: pre.agent_id ?? "main" },
      pre.session_id,
      signal,
    );
    const blocked = results.find((r) => r.result.status === "blocked");
    if (!blocked) return allow();
    return deny(`blocked by plugin hook ${blocked.pluginId}: ${blocked.result.reason ?? "no reason given"}`);
  };
}

/** `PostToolUse`, no matcher — observe-only (F2 fail-open: results are never consulted). Skipped
 *  entirely for a call the PreToolUse group already denied — Winter never runs the tool in that
 *  case, so `PostToolUse` never fires for it either (unlike the retired engine, which had to track
 *  `blockedCallIds` itself because ONE dispatch loop handled both ends; the SDK's own event
 *  ordering makes that bookkeeping unnecessary here). */
function pluginPostToolUseHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.hookFacade) return allow();
    const post = input as PostToolUseHookInput;
    await deps.hookFacade.runFor(
      "post-tool",
      { toolName: post.tool_name, argsJson: safeJson(post.tool_input), output: safeJson(post.tool_response), isError: false, threadId: post.agent_id ?? "main" },
      post.session_id,
      signal,
    );
    return allow();
  };
}

// ── 2. Bash safety reviewer ─────────────────────────────────────────────────────────────────────

/** `PreToolUse`, matched on `"Bash"` — the reviewer is the auto-policy GATE (see this file's own
 *  header and `deps.policy`'s doc comment). `bashLooksSafe` bypasses the review call entirely for
 *  an obviously-safe command (no shell metacharacters, read-only argv0, or an allow-listed entry) —
 *  identical to the retired engine's own bypass. A reviewer that throws (timeout, malformed
 *  verdict, aborted) denies with today's exact wording (`engine.ts:4553`) rather than silently
 *  allowing an unreviewable command through. */
function bashReviewerHook(deps: SessionHooksDeps): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    if (!deps.reviewer) return allow();
    if (deps.policy?.() !== "auto") return allow();
    if (deps.reviewerEnabled?.() === false) return allow();
    const pre = input as PreToolUseHookInput;
    const command = typeof (pre.tool_input as { command?: unknown } | null | undefined)?.command === "string"
      ? (pre.tool_input as { command: string }).command
      : "";
    if (!command) return allow();
    if (bashLooksSafe(command, deps.reviewerAllow?.() ?? [])) return allow();
    try {
      const verdict = await deps.reviewer.review({ class: "bash", command }, signal);
      if (verdict.verdict === "unsafe") return deny(verdict.reason || "the safety reviewer judged this command unsafe");
      return allow();
    } catch {
      return deny("reviewer unavailable — manual approval required");
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

/** `{ winter, official }` — see this file's own header for why `official` is `undefined` (a
 *  disclosed carry, not an oversight). `winter` is always populated: every hook function above is
 *  a safe, cheap no-op (`allow()`/`{}`) when its own dependency is absent, so registering the
 *  groups unconditionally costs nothing extra beyond the wire round trip `Options.hooks` already
 *  requires the moment ANY group is registered for an event — and the plugin-hook groups (no
 *  matcher) are the one case that always needs to be live, since a plugin can be enabled on a
 *  running daemon between sessions with no restart. */
export function sessionHooksFor(deps: SessionHooksDeps): { winter: Options["hooks"] | undefined; official: unknown } {
  const pending = new Map<string, PendingDiffSnapshot>();

  const preToolUse: HookCallbackMatcher[] = [{ hooks: [pluginPreToolUseHook(deps)] }];
  if (deps.reviewer) preToolUse.push({ matcher: "Bash", hooks: [bashReviewerHook(deps)] });
  if (deps.home) {
    for (const tool of Object.keys(DIFF_TOOL_FILE_PATH_ARG)) {
      preToolUse.push({ matcher: tool, hooks: [fileDiffPreToolUseHook(deps, pending)] });
    }
  }

  const postToolUse: HookCallbackMatcher[] = [{ hooks: [pluginPostToolUseHook(deps)] }];
  for (const tool of Object.keys(DIFF_TOOL_FILE_PATH_ARG)) {
    const hooks: HookCallback[] = [];
    if (deps.home) hooks.push(fileDiffPostToolUseHook(deps, pending));
    if (deps.lsp) hooks.push(diagnosticsPostToolUseHook(deps));
    if (hooks.length > 0) postToolUse.push({ matcher: tool, hooks });
  }

  const winter: Options["hooks"] = { PreToolUse: preToolUse, PostToolUse: postToolUse };
  return { winter, official: undefined };
}
