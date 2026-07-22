import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, mkdirSync } from "node:fs";
import { relative, sep, isAbsolute, resolve, dirname, basename, join } from "node:path";
import type { ApprovalOption, NewSessionEvent, Question, SessionEvent, Task } from "@norma/protocol";
import type { SessionStore } from "../sessions/store";
import type { SessionHub } from "../sessions/hub";
import type { Provider, ProviderEvent, TurnInputItem } from "../providers/types";
import type { ToolRegistry } from "./tools/registry";
import { isExternalToolName } from "./tools/registry";
import type { PermissionGate, SessionApprovalPolicy } from "./gate";
import type { ApprovalBroker } from "./approvals";
import type { QuestionBroker } from "./questions";
import type { TaskStore } from "./task-store";
import type { PlanBroker } from "./plans";
import type { SessionDirectories } from "./dirs";
import { sessionTmpDir } from "./session-tmp";
import type { PermissionRules } from "./permission-rules";
import { readOnlyBash } from "./readonly-bash";
import { SHIPPED_DANGEROUS_DOMAINS, dangerousDomainMatch } from "./dangerous-domains";
import { repoRootFor } from "./memory-dir";
import type { ContextAssembler } from "./context";
import type { Compactor } from "./compactor";
import type { McpManager } from "./mcp/manager";
import { bashLooksSafe, type BashReviewer, type ReviewInput } from "./reviewer";
import { resolveWithinAny, isWithin, canonicalizeForWrite, resolveLeafSymlinks } from "./paths";
import type { WorktreeManager } from "./worktree";
import type { SubagentManager } from "./subagents";
import type { AgentStore } from "./agents";
import { guardAgentName, type AgentStatus, type BackgroundAgentRegistry, type ResumeContext } from "./bg-agent-registry";
import type { HookResult } from "../plugins/hook-runner";
import type { ComputerUseService } from "./computer-use";
import { SubagentTranscripts } from "./subagent-transcript";
import { resolveModelAlias } from "./model-aliases";
import type { LspManager } from "./lsp/manager";
import { autoDiagnosticsSuffix, AUTO_DIAG_TOOL_NAMES } from "./lsp/auto-diagnostics";
import { DISPATCH_ALLOW_TOOLS, DISPATCH_SYSTEM_PROMPT } from "./dispatch-prompt";
import type { DispatchChildren } from "./dispatch-children";

/** Structural narrowing of BackgroundTaskRegistry (bg-registry.ts) to just what pinnedTools
 *  (below) needs — lets the engine (and tests) work with anything shaped like a per-session task
 *  lister, without requiring the full class (whose other members — start/read/kill — pinnedTools
 *  never touches). A real BackgroundTaskRegistry instance satisfies this structurally. */
export interface BgTaskLister {
  list(sessionId: string): Array<{ status: string }>;
}

const MAIN_THREAD = "main";
const MAX_TOOL_ITERATIONS = 24; // runaway guard until 1b-ii budgets land
// Dispatch (Phase 7) Task 4: session_spawn is registered on the SAME shared registry every
// session's specs() reads from (daemon.ts registers it once, globally, like spawn_agent) — so
// without an explicit exclusion it would be visible to every non-dispatch session too (a code
// session's main thread has no `allowTools` restriction at all; a spawn_agent child's own
// childExcludeTools, below, is the only thing that hides tools from IT). Named once here and
// reused at both exclusion sites (turn()'s isDispatch ternary, childExcludeTools' initial Set) so
// they can never drift apart. The bridge's OWN `meta.mode === "dispatch"` gate above is the
// actual authoritative check; this is tool-list hygiene — a provider that ignored its own tool
// list and called session_spawn anyway would still just hit the placeholder run() (session-
// spawn.ts), same belt-and-braces relationship spawn_agent's own depth-cap exclusion has to its
// own runtime reject.
const SESSION_SPAWN_TOOL = "session_spawn";

// Workflows Task A4: the module-wide name for the `Workflow` tool (B2 registers it for real, on
// the same shared registry every session's specs() reads from — see SESSION_SPAWN_TOOL's own doc
// comment just above for the identical pattern). A workflow's own spawned agents (runWorkflowAgent,
// below) are depth-1 and must never themselves be able to launch a workflow (Global Constraints:
// nesting depth 1) — named ONCE here so A4's child-exclusion, B2's registration, B3's gating, and
// B4's pin all read the SAME literal, with no `Workflow`/`workflow` casing drift between them.
const WORKFLOW_TOOL = "Workflow";

// 4h-i (CC parity: spawn_agent `mode`), widened to 6 values (SP-policies Task 2) — permissiveness
// order, LEAST to MOST permissive: "plan" (read-only, most restrictive) < "dont-ask" < "ask"
// (human-gated) < "accept-edits" < "auto" (auto-allows non-destructive tools) < "bypass" (least
// restrictive — no gating at all). Mirrors gate.ts's own PermissionGate.evaluate() ordering where
// it currently distinguishes these (plan denies everything mutating outright; ask/auto both gate
// mutating tools, auto auto-allows) — evaluate() itself is NOT behaviorally widened by this task
// (a later task teaches it the new values' own distinct behavior; today dont-ask/accept-edits/
// bypass ride evaluate()'s existing per-string branches unchanged, so behavior for the original
// three values — plan/ask/auto — is untouched).
const POLICY_RESTRICTIVENESS: Record<SessionApprovalPolicy, number> = {
  plan: 0, "dont-ask": 1, ask: 2, "accept-edits": 3, auto: 4, bypass: 5,
};

/** RESTRICT-ONLY: returns the MORE RESTRICTIVE of {parent, requested} — a spawn_agent `mode`
 *  override can only NARROW a child's effective approval policy relative to its parent thread's,
 *  never WIDEN it. A request that would widen (e.g. parent "ask" + requested "bypass", or parent
 *  "plan" + requested "auto") is silently ignored — the parent's policy wins. Pure and exported
 *  for direct unit testing: this is the security-critical piece of the `mode` feature (a bug here
 *  is a privilege-escalation bug, not a UX one). Signature is unchanged by the 6-value widening —
 *  it's generic over whatever SessionApprovalPolicy is, ranked purely through
 *  POLICY_RESTRICTIVENESS above. */
export function restrictPolicy(parent: SessionApprovalPolicy, requested: SessionApprovalPolicy): SessionApprovalPolicy {
  return POLICY_RESTRICTIVENESS[requested] < POLICY_RESTRICTIVENESS[parent] ? requested : parent;
}

/** Maps a CC-parity spawn `mode` arg to Norma's `approvalPolicy`. SP-policies Task 2: each CC mode
 *  now maps to its OWN distinct policy — `acceptEdits`→"accept-edits", `dontAsk`→"dont-ask",
 *  `bypassPermissions`→"bypass", `plan`→"plan" — no more collapsing to "auto" (that collapse was
 *  only ever a stopgap from when SessionApprovalPolicy had just 3 values; the 6-value type now has
 *  a home for each CC mode). `default`, absent, or any unrecognized string still maps to
 *  `undefined` — "no override", i.e. the child inherits the parent's policy unchanged (this is
 *  what lets the spawn bridge skip building a child-scoped meta entirely when there's nothing to
 *  narrow — see the bridge's `childMeta` computation). */
export function mapSpawnMode(mode: string | undefined): SessionApprovalPolicy | undefined {
  switch (mode) {
    case "plan": return "plan";
    case "acceptEdits": return "accept-edits";
    case "dontAsk": return "dont-ask";
    case "bypassPermissions": return "bypass";
    default: return undefined; // "default", absent, or an unrecognized string
  }
}

/** Mirrors protocol's ThreadInfoSchema (methods.ts) — kept as a plain local type rather than a
 *  zod import here since engine.ts only needs the shape, not a schema/validator of its own. */
export interface ThreadInfo {
  threadId: string;
  parentThreadId?: string;
  agentType?: string;
  status: "running" | "completed";
  stopReason?: string;
}

type Checkpoint = Extract<SessionEvent, { type: "checkpoint" }>;
function isCheckpoint(e: SessionEvent): e is Checkpoint {
  return e.type === "checkpoint";
}

type TurnCompleted = Extract<SessionEvent, { type: "turn_completed" }>;
function isTurnCompleted(e: SessionEvent): e is TurnCompleted {
  return e.type === "turn_completed";
}

/** Approval-card summary for a gated call. The ONE construction site for both ask-branch callers
 *  (worktree + generic) — they must not drift apart (5c whole-branch review).
 *
 *  skill_write gets a bespoke HONEST card instead of the generic `argsJson.slice(0,160)`: on a
 *  skill_write card that slice is mostly name+description, so a malicious body instruction past
 *  char ~160 would ride in on a benign-looking prefix while the card creates the ILLUSION the
 *  body was reviewed — and for skill_write the card IS the control (ALWAYS_ASK, gate.ts: standing
 *  instructions for future sessions get a card no policy can silence). The bespoke card therefore
 *  shows the skill name + FULL description (newline-stripped, capped) and says explicitly that
 *  the body is NOT shown, with its size — an honest "you have not reviewed this" instead of a
 *  false "you have". Constraints:
 *  - body text NEVER appears here, however short — a body could inject fake card lines;
 *  - every interpolated field is newline-stripped for the same reason;
 *  - malformed or mis-shaped argsJson falls back to the generic slice (honest raw JSON beats a
 *    fabricated pretty card; zod rejects the call at execute time anyway).
 *
 *  bash gets a humanized card (5e T2 review): the card must show what EXECUTES — the command —
 *  not a raw-JSON slice whose escaping/field-noise buries it, on the highest-stakes card in the
 *  system (the reviewer-escalation site feeds it too). The raw-JSON-honesty rationale above does
 *  not apply: `command` is the sole executed payload and is shown as-is (newline-stripped,
 *  capped). Constraints:
 *  - `justification` NEVER appears — it's model-authored persuasion text, not what executes; on
 *    the card it could dress a hostile command up as reviewed-and-fine;
 *  - empty/whitespace command or mis-shaped argsJson → generic slice (an empty "bash " card would
 *    hide the actual args; raw JSON is the honest degenerate-case fallback). */
function approvalCardSummary(call: { name: string; argsJson: string }): string {
  const oneLine = (s: string) => s.split(/\r?\n/).join(" ").trim();
  if (call.name === "skill_write") {
    try {
      const a = JSON.parse(call.argsJson || "{}") as { name?: unknown; description?: unknown; body?: unknown };
      if (typeof a.name === "string" && typeof a.description === "string" && typeof a.body === "string") {
        return `skill_write "${oneLine(a.name)}" — ${oneLine(a.description).slice(0, 200)} [body: ${a.body.length} chars — not shown; review in dashboard after approving]`;
      }
    } catch { /* malformed argsJson → generic slice below */ }
  }
  if (call.name === "bash") {
    try {
      const a = JSON.parse(call.argsJson || "{}") as { command?: unknown; allowNetwork?: unknown; dangerouslyDisableSandbox?: unknown };
      if (typeof a.command === "string" && oneLine(a.command) !== "") {
        const cmd = oneLine(a.command).slice(0, 120);
        // SP-approvals Task 11 (spec §8): the card must name WHICH escalation flavor this call
        // is — dangerouslyDisableSandbox wins the label when both are somehow set (it subsumes
        // allowNetwork's network grant; an unsandboxed call already has full network), mirroring
        // the dispatch loop's own precedence (the unsandboxed always-card branch is checked
        // before the generic ask branch that renders allowNetwork's "(with network)" label).
        if (a.dangerouslyDisableSandbox === true) return `bash (UNSANDBOXED): ${cmd}`;
        if (a.allowNetwork === true) return `bash (with network): ${cmd}`;
        return `bash ${cmd}`;
      }
    } catch { /* malformed argsJson → generic slice below */ }
  }
  return `${call.name} ${call.argsJson.slice(0, 160)}`;
}

// SP-approvals Task 5: the "always allow" suggestion for a bash approval card's rule-bearing
// options below — first token alone ("ls -la" → "ls"), or first+second for a well-known set of
// multi-word CLI heads ("git push origin" → "git push") where the SECOND token is the meaningful
// verb (CC's own bash-rule suggestion follows the same shape) — so `Bash(<prefix>:*)` reads as a
// natural verb-object unit for the commands people actually want to blanket-allow, rather than a
// single bare "git" that would then also cover `git push --force`, `git reset --hard`, etc.
// Whitespace-normalized (irregular spacing between tokens collapses the same as single spaces) so
// it composes cleanly with permission-rules.ts's own normalizeWhitespace on the read side.
// Exported for approval-options.test.ts's direct unit coverage; `approvalOptionsFor` below stays
// private — tested indirectly through the real dispatch loop instead (permission-gate-order.
// test.ts's own precedent for this exact feature area: drive the loop, don't unit-test internals).
const BASH_PREFIX_MULTI_WORD_HEADS = new Set([
  "git", "npm", "pnpm", "cargo", "docker", "kubectl", "brew", "bun", "swift", "xcodebuild", "gh", "make",
]);

export function suggestBashPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const head = tokens[0]!;
  return tokens.length > 1 && BASH_PREFIX_MULTI_WORD_HEADS.has(head) ? `${head} ${tokens[1]}` : head;
}

/** The "always allow" choices offered alongside plain approve/deny on an approval card
 *  (SP-approvals Task 5). Called ONLY from the plain `decision === "ask"` dispatch-loop branch
 *  below: a grant-flavored (out-of-root write/edit), worktree, or reviewer-escalation card asks a
 *  DIFFERENT question — "grant this directory?" / "enter this worktree?" / "the reviewer flagged
 *  this, proceed anyway?" — that a standing "always allow" rule must never silently answer on a
 *  human's behalf (a reviewer escalation in particular is already a non-safe verdict; v1 offers no
 *  memory for that path at all), so those three call sites pass no `options` and this helper is
 *  never even consulted for them. `rule`/`scope` on a returned option mirror exactly what choosing
 *  it persists via `PermissionRules.append` (server.ts's `approval.respond` handler) — the label
 *  ALWAYS shows the literal rule string, so a human approves the exact text that gets written, not
 *  a paraphrase of it. bash offers BOTH scopes (project/global): a shell command prefix is often
 *  legitimately either project-specific or a genuine cross-project habit. SP-policies Task 7:
 *  write/edit now return `undefined` here — they no longer reach this helper at all. An in-root
 *  edit under `ask` is SILENT (the in-project-silent flip in the dispatch loop), an out-of-root
 *  edit rides the grant card (its own options, NOT this helper), and a rules-store write
 *  hard-errors — so the generic `decision === "ask"` branch (this helper's only caller) is
 *  structurally unreachable for write/edit. The "persist an Edit rule from a write card" capability
 *  is NOT lost: it moves to the out-of-root grant card's path-scoped "Always allow edits in /foo" =
 *  `Edit(/foo)` option (Task 9), which is strictly better than the old blanket `Edit` rule
 *  (path-scoped + feeds bash's sandbox roots). Every other tool name (computer/schedule/web_fetch/
 *  skill_write/mcp__.../plugin__.../unclassified) likewise returns `undefined` — a plain
 *  approve/deny card, byte-identical to before this feature. */
function approvalOptionsFor(call: { name: string; argsJson: string }): ApprovalOption[] | undefined {
  if (call.name === "bash") {
    let command = "";
    try {
      const a = JSON.parse(call.argsJson || "{}") as { command?: unknown };
      if (typeof a.command === "string") command = a.command;
    } catch { /* malformed argsJson → suggestBashPrefix("") below yields "", same degenerate case */ }
    const rule = `Bash(${suggestBashPrefix(command)}:*)`;
    return [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: `Allow "${rule}" in this project`, rule, scope: "project" },
      { id: "allow_global", label: `Allow "${rule}" everywhere`, rule, scope: "global" },
      { id: "deny", label: "Deny" },
    ];
  }
  // SP-policies Task 7: write/edit deliberately fall through to `undefined` — see the doc comment
  // above (their approval path is now silence-in-root / grant-card-out-of-root, never this generic
  // card). Task 9 removes this helper's only remaining relevance to edits by reworking the grant card.
  return undefined;
}

/** SP-approvals Task 11 (spec §8): parses bash's two escalation args from a call's argsJson —
 *  `allowNetwork` (widened sandbox: write fence intact, network allowed for this call) and
 *  `dangerouslyDisableSandbox` (CC's exact name: a full sandbox escape). Malformed/missing
 *  argsJson degrades to `{false, false}` — a best-effort, gating/display-only parse; bash.ts's own
 *  zod schema re-validates the real args at execute time. Called from the dispatch loop below
 *  ONCE per bash call (never for any other tool name — every other call gets the same `{false,
 *  false}` fast path computed inline there, mirroring dirGrant/webFetchCard's own
 *  null-for-everything-else shape). */
function bashEscalationArgs(call: { argsJson: string }): { allowNetwork: boolean; dangerouslyDisableSandbox: boolean } {
  try {
    const a = JSON.parse(call.argsJson || "{}") as { allowNetwork?: unknown; dangerouslyDisableSandbox?: unknown };
    return { allowNetwork: a.allowNetwork === true, dangerouslyDisableSandbox: a.dangerouslyDisableSandbox === true };
  } catch {
    return { allowNetwork: false, dangerouslyDisableSandbox: false };
  }
}

/** SP-approvals Task 10 (spec §7): the web_fetch dangerous-domain approval card's options — called
 *  ONLY from `webFetchGate` below, NEVER from `approvalOptionsFor` above (a structurally different
 *  card: it fires for EVERY policy, not just `ask`, and its "always allow" option is scoped to a
 *  matched DOMAIN, not a bash/edit rule). `host` is the raw request hostname; `matchedEntry` is the
 *  SHIPPED/user-added list entry it matched against (the RULE this persists — e.g. a request to
 *  `uploads.transfer.sh` matches the shipped `transfer.sh` entry, so approving writes
 *  `WebFetch(domain:transfer.sh)`, covering the whole family, not just that one subdomain).
 *  `undefined` for BOTH params only in the unparseable-URL/no-hostname case — there is no valid
 *  host to name a rule for at all, so the card offers only Allow/Deny, no third option (an "always
 *  allow ___" button with nothing to fill the blank would be actively misleading).
 *
 *  MEDIUM-1, SP-approvals T10 review: the label reads `Always allow all of ${matchedEntry}` when
 *  `host !== matchedEntry` (a SUBDOMAIN hit) — approving actually grants the whole matched family
 *  (every subdomain of, and the bare, `matchedEntry`), not just the one subdomain that happened to
 *  trigger the card, and the label says so honestly rather than naming only the narrower host that
 *  was fetched. An EXACT hit (`host === matchedEntry`) keeps the simpler `Always allow ${host}` —
 *  nothing wider than the fetched host itself is being granted, so there's nothing to clarify. */
function webFetchApprovalOptions(host: string | undefined, matchedEntry: string | undefined): ApprovalOption[] {
  const options: ApprovalOption[] = [{ id: "allow_once", label: "Allow" }];
  if (host !== undefined && matchedEntry !== undefined) {
    const label = host === matchedEntry ? `Always allow ${host}` : `Always allow all of ${matchedEntry}`;
    options.push({ id: "allow_source", label, rule: `WebFetch(domain:${matchedEntry})`, scope: "global" });
  }
  options.push({ id: "deny", label: "Deny" });
  return options;
}

/** Sanitize+cap a reviewer-authored free-text field (`tool_review.reason`/`.summary`,
 *  `approval_requested.reviewerReason`) before it goes on the wire (phase 5e T2). Deliberately NOT
 *  `sanitizeForReminder` (below): that helper also neutralizes literal `<system-reminder>` tags,
 *  a concern specific to text embedded in a reminder block re-fed to the model — these fields
 *  never enter `eventToInput` (client-observability only, per the injection-containment invariant),
 *  so control-stripping + a length cap apply here. C0 controls (ESC/BEL/BS/...) and DEL are
 *  stripped alongside newlines (5e whole-branch hardening): reviewer output lands verbatim on
 *  terminal cards, and raw control bytes could perturb the terminal (ANSI escapes, bell, cursor
 *  moves), not just wrap badly. */
function sanitizeReviewText(s: string, maxLen: number): string {
  return s.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, maxLen);
}

/** phase 5e T3 (fs coverage): resolves a write/edit call's target against the review-time fence —
 *  the session's roots (primary cwd first) PLUS the session tmp dir, mirroring bash's OS-level
 *  sandbox-writable set (sandbox.ts's `writable`: cwd + roots + tmpDir), which is BROADER than
 *  fs-write.ts's own application-level fence (`roots` only, no tmpDir). Reuses resolveWithinAny
 *  (paths.ts) — the fence's own resolution logic — rather than reimplementing containment. A path
 *  outside even this broader set is a guaranteed fence violation the tool will reject on its own
 *  (fs-write.ts's own resolveWithinAny throws first) — reviewing a call that can never execute
 *  buys nothing, so this returns null and the call falls through to executeCall's normal error.
 *
 *  5e T3 review fix: the vetted target is CANONICALIZED (canonicalizeForWrite) before being
 *  classified or shown. resolveWithinAny returns the RAW pre-symlink text (its canonAncestor walk
 *  is containment-only), and for a NEW file realpath throws → isWithin fell back to that raw text
 *  — so `write("link/new.txt")` through an in-cwd symlink into an added root classified as
 *  "within cwd" and SKIPPED review while the bytes landed in the added root. Classification AND
 *  the précis must both see where the write actually lands. */
function resolveFsReviewTarget(path: string, roots: string[], tmpDir: string): string | null {
  try {
    return canonicalizeForWrite(resolveWithinAny([...roots, tmpDir], path));
  } catch {
    return null;
  }
}

/** phase 5e T3 (fs coverage): true if a fence-vetted, CANONICALIZED (resolveFsReviewTarget)
 *  write/edit target is unusual enough to review — (a) outside the PRIMARY cwd subtree (roots[0]:
 *  an added root or the session tmp dir), reusing paths.ts's own isWithin, or (b) a dotfile/
 *  dot-directory path segment anywhere inside cwd (.ssh/, .git/hooks/, a .zshrc-class file). A
 *  plain in-cwd, non-dotted write is NOT reviewed — this is the "unusual", not "every write",
 *  trigger the brief specifies. primaryCwd is realpathed here too: `resolved` is canonical, so a
 *  non-canonical root (possible via rootsOverride) would make relative() emit spurious ".."
 *  segments — a false-positive review, never a bypass, but still wrong. */
function fsWriteIsUnusual(resolved: string, primaryCwd: string): boolean {
  let cwd = primaryCwd;
  try { cwd = realpathSync(primaryCwd); } catch { /* vanished root — raw comparison is all there is */ }
  if (!isWithin(resolved, cwd)) return true;
  return relative(cwd, resolved).split(sep).some((seg) => seg.startsWith("."));
}

/** phase 5e T3 (fs coverage): the précis shown to the reviewer AND persisted as tool_review.summary
 *  — resolved path + a character count, NEVER file content. `chars` is the length of the text
 *  actually landing on disk: `content` for `write`, `new_string` for `edit` (the substituted
 *  text — matches write's "what's landing on disk" semantics). Malformed argsJson (already past
 *  resolution, so the call itself is well-formed enough to have a path) degrades to 0 chars rather
 *  than throwing — this précis is display-only; zod re-validates the real args at execute time. */
function fsWritePrecis(call: { name: string; argsJson: string }, resolved: string): string {
  let chars = 0;
  try {
    const a = JSON.parse(call.argsJson || "{}") as { content?: unknown; new_string?: unknown };
    const text = call.name === "edit" ? a.new_string : a.content;
    if (typeof text === "string") chars = text.length;
  } catch { /* malformed argsJson → chars stays 0 (display-only degradation) */ }
  return `${call.name} ${resolved} (${chars} chars)`;
}

/** write-permission-flow (task 24, CC parity): the directory to grant if a write/edit call's
 *  target resolves OUTSIDE every root — fs-write.ts's OWN fence (`roots` alone, never the
 *  reviewer's broader roots+tmpDir above) — so this can never disagree with what the tool's own
 *  resolveWithinAny will itself decide once dispatched. Returns null for an in-root path (nothing
 *  to grant — the dispatch loop's existing branches run byte-identical to before this feature), a
 *  non-write/edit call, or malformed/pathless argsJson (best-effort pre-check only; zod re-
 *  validates the real args at execute time).
 *
 *  ALSO returns null for a path inside the session tmp dir specifically (`tmpDir` — bash's own
 *  OS-sandbox-writable set includes it, resolveFsReviewTarget's BROADER roots+tmpDir fence
 *  reviews it, but fs-write.ts's fence deliberately EXCLUDES it — see that fence's own doc
 *  comment). That is an intentional narrower boundary the write/edit tools draw on purpose, not
 *  an ungranted directory — a tmp-dir write must keep falling through to the EXISTING reviewer
 *  branch (which reviews it, then still rejects it on execution) instead of being "fixed" by a
 *  grant that would quietly widen what write/edit are allowed to touch.
 *
 *  The returned `dir` is the CANONICALIZED (symlink-resolved) immediate parent of the REAL
 *  destination — leaf-link chain resolved first (resolveLeafSymlinks — task-24 review F4: an
 *  in-root DANGLING symlink aimed outside now surfaces here as its true outside target, so the
 *  grant names the actual escape directory), then canonicalizeForWrite (5e T3's own fix for
 *  symlinked DIRECTORY segments) — so the human is always shown where the bytes would really
 *  land, never a pre-symlink in-root-looking spelling. A resolution failure (e.g. the leaf-chain
 *  depth cap) returns null — no grant offered; the call falls through to the normal dispatch and
 *  the tool's own fence rejects it with the same error. */
function fsWriteOutOfRootDir(call: { name: string; argsJson: string }, roots: string[], tmpDir: string): { path: string; dir: string } | null {
  if (call.name !== "write" && call.name !== "edit") return null;
  let path = "";
  try {
    const a = JSON.parse(call.argsJson || "{}") as { path?: unknown };
    path = typeof a.path === "string" ? a.path : "";
  } catch { return null; }
  if (!path) return null;
  try {
    resolveWithinAny(roots, path);
    return null; // in-root — nothing to grant
  } catch {
    try {
      resolveWithinAny([...roots, tmpDir], path);
      return null; // tmp-dir target — an intentional fence exclusion, not an ungranted directory
    } catch { /* genuinely outside everything — fall through to the grant below */ }
    try {
      const raw = isAbsolute(path) ? resolve(path) : resolve(roots[0] ?? "/", path);
      return { path, dir: dirname(canonicalizeForWrite(resolveLeafSymlinks(raw))) };
    } catch { return null; } // unresolvable (link-chain cap etc.) — fail closed to the plain fence reject
  }
}

/** Files the daemon hot-merges into live policy/exec config (rules store + the two per-project
 *  settings overlays once ProjectSettingsResolver feeds permissions.allow — Task 7). The agent
 *  must never write ANY of them, in ANY project — humans edit them out-of-band or via cards. */
const CONTROL_PLANE_FILENAMES = new Set(["permissions.local.json", "settings.json", "settings.local.json"]);

/**
 * SP-approvals final review (composition hole, HIGH): a write/edit whose target is ANY project's
 * `<any>/.norma/permissions.local.json` — Task 1's PermissionRules project-scope rules file — must be a
 * hard error, no card, no grant, no matter what rule is in force. Without this, a broad `Edit` rule
 * (the feature's own most-encouraged click — it matches both `write` and `edit` call names, see
 * permission-rules.ts's `toolForCallName`) lets the agent write a NEW rule into this file itself —
 * e.g. `WebFetch(domain:webhook.site)` — which `webFetchGate` (§7, above) then treats as an
 * already-approved standing exception, silently clearing the dangerous-domain floor for a zero-card
 * exfil fetch. The store must be mutable ONLY through `PermissionRules.append()` (a human answering
 * an approval card's "always allow" option) or a human's own editor — never through the agent's own
 * write/edit tools.
 *
 * SP-policies whole-branch review (Item 1, HIGH): this check is now projectRoot-INDEPENDENT. The
 * PRIOR version anchored the match to the CURRENT session's project only — it compared the write's
 * resolved parent against `join(projectRoot, ".norma")` for THIS session's `projectRoot` alone. But
 * a broad `Edit(<parent>)` grant folds `<parent>` into the session writable set (writableRoots), so
 * a SIBLING project's tree — `<parent>/projB/.norma/permissions.local.json`, whose owning project is
 * NOT this session's — becomes in-root, and the single-project anchoring returned null ("not MY
 * store") → the in-project-silent flip wrote it with no card. Those minted rules (exfil exceptions,
 * BashUnsandboxed escapes) auto-activate the moment the user opens projB. The invariant is
 * project-wide: the agent must NEVER write ANY `<any>/.norma/permissions.local.json`, whichever project
 * owns it — so the match no longer needs (or takes) a `projectRoot`.
 *
 * SP-approvals final review 2 (bypass reproduced live on the default case-insensitive-but-case-
 * preserving macOS volume format): a case-SENSITIVE literal compare let `.norma/Permissions.Local.
 * json`, `.NORMA/permissions.local.json`, and a pre-created `.norma` SYMLINK pointing at some other
 * real directory all land unflagged — while `permission-rules.ts`'s `projectRulesFor` reads the
 * store back via a plain `join(root, ".norma", "permissions.local.json")` open, which macOS's
 * default filesystem resolves CASE-INSENSITIVELY and follows symlinks through — so the reader picked
 * every variant right back up as the real file. Fixed by case-folding every compare (`.toLowerCase()`)
 * and by testing the parent-dir name on BOTH spellings of the path:
 *   - the PRE-resolution spelling (`raw0`) catches a write THROUGH a symlink NAMED `.norma` (the
 *     reader follows the same link, so writer and reader hit the identical file) — canonicalization
 *     would resolve that `.norma` away to the link's real destination, whose name is NOT `.norma`.
 *   - the CANONICALIZED target (`canonicalizeForWrite`/`resolveLeafSymlinks`, preserved from the
 *     prior fix) catches the inverse: reaching a REAL `.../.norma/...` via a differently-NAMED
 *     symlink or `..` games — `raw0`'s literal parent isn't `.norma`, but the resolved one is.
 * Either match means "this is (some project's) rules store". `raw0`'s parent is checked FIRST, before
 * canonicalization can throw, so a pathological link chain never drops an otherwise-clear match.
 *
 * Matches by FILENAME alone, never by directory: `.norma/` itself stays writable (`.norma/memory/`
 * is the MEMDIR by design — memory files are `*.md`, never one of the control-plane filenames —
 * and any other file under `.norma/` is unaffected). `null` for every non-write/edit call, a
 * missing/malformed `path` arg, or a resolution failure (unresolvable link-chain etc.) — the normal
 * dispatch chain decides from there, same fail-open-to-the-next-check shape as `fsWriteOutOfRootDir`.
 *
 * CC-parity Task 6.5 (controller-added): `settings.json` and `settings.local.json` — the two
 * per-project overlays `ProjectSettingsResolver` (Task 6) reads — joined this function's filename
 * set once Task 7 wires their merged `permissions.allow` into the live gate, making them rule-
 * bearing control-plane files exactly like the rules store above: an agent write of
 * `settings.local.json` → `{"permissions":{"allow":["BashUnsandboxed(*:*)"]}}` would self-grant a
 * rule the same way an unguarded `permissions.local.json` write would. Matching by filename +
 * parent-dir-named-`.norma` (never by project identity — this function has never taken a
 * `projectRoot`, SP-policies whole-branch Item 1) has a deliberate side effect:
 * `~/.norma/settings.json` — the user's OWN global settings, whose parent directory is literally
 * named `.norma` — is now ALSO structurally denied, same as any project's. That closes the
 * SP3.4-backlog hole where a session `cwd`'d at `$HOME` treated `~/.norma` as an ordinary
 * in-project directory and could silently overwrite the user's global settings; nothing carves out
 * an exception for it. */
function controlPlaneFileTarget(
  call: { name: string; argsJson: string },
  roots: string[],
): { path: string; canonical: string } | null {
  // fix-wave C (Minor): notebook_edit writes via node fs directly (notebook.ts), bypassing the
  // bash seatbelt — this is its only guard, added for defense-in-depth completeness alongside
  // write/edit (not currently exploitable: notebook.ts requires an existing valid-notebook shape,
  // so it can't CREATE a settings file from nothing). Its own arg schema names the path field
  // `notebook_path`, not `path` — read below, or the name check alone would be a no-op.
  if (call.name !== "write" && call.name !== "edit" && call.name !== "notebook_edit") return null;
  let path = "";
  try {
    const a = JSON.parse(call.argsJson || "{}") as { path?: unknown; notebook_path?: unknown };
    path = typeof a.path === "string" ? a.path : typeof a.notebook_path === "string" ? a.notebook_path : "";
  } catch { return null; }
  if (!path) return null;
  const raw0 = isAbsolute(path) ? resolve(path) : resolve(roots[0] ?? "/", path);
  // Cheap, syscall-free early-out: a target whose filename isn't SOME casing of one of the
  // control-plane filenames (CONTROL_PLANE_FILENAMES, above) can never be a control-plane file,
  // regardless of what its parent resolves to — memory files are `*.md`, every other file under
  // `.norma/` has a different name. Comparing the ORIGINAL (pre-resolution) filename case-folded
  // is equivalent to the resolved one: canonicalization only corrects an EXISTING file's spelling
  // to what's on disk (the identical case-folded string on a case-insensitive volume) or leaves a
  // not-yet-existing tail verbatim.
  if (!CONTROL_PLANE_FILENAMES.has(basename(raw0).toLowerCase())) return null;
  // Pre-resolution parent: some casing of ".norma" ⇒ a control-plane file (catches a symlink NAMED
  // `.norma`). Checked BEFORE canonicalization so a link chain that throws below can't drop it.
  if (basename(dirname(raw0)).toLowerCase() === ".norma") {
    try { return { path, canonical: canonicalizeForWrite(resolveLeafSymlinks(raw0)) }; }
    catch { return { path, canonical: raw0 }; } // still a confirmed match; report the raw target
  }
  // Otherwise, resolve case/symlinks and re-check the parent — catches reaching a REAL `.../.norma/`
  // via a differently-named symlink or `..` games.
  try {
    const canonical = canonicalizeForWrite(resolveLeafSymlinks(raw0));
    return basename(dirname(canonical)).toLowerCase() === ".norma" ? { path, canonical } : null;
  } catch { return null; } // unresolvable — not a confirmed match; the normal dispatch chain decides
}

/** phase 5e T3 (external coverage): the précis for an mcp__/plugin__ call — tool name + a
 *  single-line argsJson slice(160). Same "raw JSON, never a hand-crafted rendering" honesty as
 *  approvalCardSummary's generic fallback, just capped shorter — this is what the REVIEWER sees,
 *  not the human's approval card (that still goes through approvalCardSummary separately). */
function externalPrecis(call: { name: string; argsJson: string }): string {
  return `${call.name} ${call.argsJson.replace(/\r?\n/g, " ").slice(0, 160)}`;
}

export const SYSTEM_PROMPT = [
  "You are Norma, an agentic assistant running on the user's Mac.",
  "You operate inside a session working directory; file tool paths are relative to it.",
  "Use the tools to accomplish the user's request, then reply with a concise summary.",
].join(" ");

export interface EngineConfig {
  store: SessionStore;
  hub: SessionHub;
  registry: ToolRegistry;
  gate: PermissionGate;
  // SP-approvals Task 3: the CC-grammar allow-rules store (project + global, Task 1) — consulted
  // by the dispatch loop below ONLY for a call the gate has already decided is "ask", to let a
  // standing rule (or, for bash, Task 2's readOnlyBash classifier) skip a re-prompt an ask-policy
  // session would otherwise show forever. Plain instance, not a getter (mirrors `gate` just
  // above): PermissionRules is already "hot" internally (its own mtime-cached project-file read,
  // and the caller-injected globalAllow thunk daemon.ts wires over the live settings holder), so
  // the engine never needs to re-resolve which INSTANCE to use, only call into the one it has.
  // Optional — absent (every pre-T3 test/config) means the new ruleAllowed computation below never
  // activates, byte-identical to before this field existed.
  permissionRules?: PermissionRules;
  // SP-approvals Task 10 (spec §7): the USER half of web_fetch's dangerous-domain floor —
  // `effective = dangerous-domains.ts's SHIPPED_DANGEROUS_DOMAINS ∪ dangerousDomainsAdded(cwd)`,
  // read fresh on every web_fetch call (webFetchGate below) so a settings.json edit to
  // `permissions.dangerousDomains.added` applies with no daemon restart, same hot-getter shape as
  // `reviewerAllow` below. Absent getter, or one resolving to undefined, means "no user
  // additions" — the SHIPPED list alone still applies; this can narrow-to-empty but never disables
  // the floor entirely (there is deliberately no equivalent of `permissions.allow: []`'s "opt out
  // of the Computer default" for this list — the shipped entries are immutable by construction).
  // Task 7 (CC project-folder-mechanics): takes the calling session's `cwd` so daemon.ts's real
  // wiring can resolve a PER-PROJECT addition (`ProjectSettingsResolver.effective(cwd)`) rather
  // than only the global settings.json — webFetchGate passes its own `cwd` param straight through.
  // Optional param: every pre-Task-7 test/getter that ignores it (a plain `() => [...]`) keeps
  // working unchanged — the call site below always passes `cwd`, but a getter is free not to use it.
  dangerousDomainsAdded?: (cwd?: string) => string[] | undefined;
  broker: ApprovalBroker;
  dirs: SessionDirectories;
  // `live`, when wired (daemon.ts, from providers/manager.ts's ActiveProvider.liveModel),
  // re-resolves the model + reasoningEffort ONCE PER TURN straight off the current settings.json
  // — the whole point being that changing the configured model does NOT require a daemon
  // restart. Absent (test harnesses that don't care) means every turn just uses this boot-time
  // `model` snapshot, unchanged behavior. `model` itself is ALWAYS present as the fallback `live`
  // resolves from when unset, and as what `contextWindow`'s default-Infinity ModelInfo lookup
  // falls back to matching when `live` is absent.
  provider: { provider: Provider; model: string; live?: () => { model: string; reasoningEffort?: string } };
  assembler: ContextAssembler;
  compactor: Compactor;
  mcp?: McpManager;
  // Both optional — absent means the corresponding tool bridge (ctx.ask / ctx.taskEvent) is
  // undefined, and the ask_user/task_* tools degrade (ask_user: immediate "proceed" message;
  // task tools: registered only when a TaskStore is passed to registerTaskTools by the caller).
  questions?: QuestionBroker;
  tasks?: TaskStore;
  approvalTimeoutMs?: number; // default 5 min
  // write-permission-flow hardening (task-24 review F2): directories the out-of-root write/edit
  // GRANT flow must never grant, in EITHER direction — a computed grant dir under one of these
  // prefixes, or one that CONTAINS a prefix (granting an ancestor would make the denied dir
  // reachable through the fence, since fence containment is subtree-based). Hard tool-error, no
  // card, under BOTH ask and auto. daemon.ts supplies [normaHome] — deliberately BROADER than
  // registerReadTools' runDir-only read denylist: a grant opens WRITE (and bash's seatbelt via
  // shared session roots), and a runDir-only list would let an auto write silently re-grant the
  // MEMDIR while memory.enabled:false, defeating that gate (review F2 ruling — do NOT narrow
  // this back to runDir). Raw paths; realpath-canonicalized at check time (mirrors fs-read.ts's
  // canonicalizeDenylist). Boot-constant like registerReadTools' own list, not a hot getter.
  grantDeniedPrefixes?: string[];
  reviewer?: BashReviewer; // safety review for auto-policy bash/fs/external calls (undefined → no review, unchanged behavior)
  // hot-settings T2: these were plain boot-captured values; now getters read LIVE off daemon.ts's
  // `settings` holder (reassigned whole-object by a later task's watcher) so a settings reload
  // needs no engine reconstruction. Every default below is preserved AT THE READ SITE (`?.()`
  // followed by the same `?? `/`!== false` fallback the pre-getter code used) — the getter itself
  // may be absent (a caller/test that never sets the field, same as before) or may resolve to
  // undefined at call time; both fall through to that identical default.
  // Task 8 (CC project-folder-mechanics): widened to `(cwd?: string) => …` so daemon.ts's real
  // wiring can resolve a PER-PROJECT reviewer.enabled (`ProjectSettingsResolver.effective(cwd)`)
  // rather than only the global settings.json — every dispatch-loop call site below passes its
  // own in-scope `cwd`, but a getter/test is free to ignore the param (every pre-Task-8
  // caller/test passes a plain `() => …` or `(cwd) => plainValue`, both still valid — an extra
  // optional param is call-site compatible either way).
  reviewerEnabled?: (cwd?: string) => boolean | undefined; // default true when reviewer is set; false disables the review path entirely
  // Widened to `| undefined` (rather than a getter always guaranteed to return string[]) so the
  // `?? []` at the read site stays meaningful for a getter/test that doesn't pre-bake the default
  // itself — daemon.ts's own getter DOES pre-bake it (`(cwd) => projectSettings.effective(cwd ??
  // null)?.reviewer?.allow ?? []`), but that's a choice, not a contract this type enforces.
  reviewerAllow?: (cwd?: string) => string[] | undefined; // extra commands/argv0s bashLooksSafe treats as obviously-safe (bypass review)
  // phase 5e T3: per-class on/off, read directly here (T4 threads settings.reviewerClasses → this
  // field; until then a caller sets it directly, same "stub until the settings task" shape as
  // reviewerEnabled predates settings wiring). Absent object OR an absent per-class key both mean
  // enabled=true — every existing caller/test that never sets this keeps today's default-on
  // behavior unchanged; only an EXPLICIT `false` for a class disables it.
  reviewerClasses?: (cwd?: string) => { bash?: boolean; fs?: boolean; external?: boolean } | undefined;
  // deferral wired ONLY when this is set AND enabled !== false — undefined (the setupEngine/
  // daemon default before this config existed) leaves specs()/instructions/execute untouched.
  // deferExternals mirrors registry.ts's opt of the same name ("always": externals defer whenever
  // ANY is visible, ignoring deferThreshold's count comparison; absent/"count" = unchanged).
  // Task 8: each sub-getter widened to `(cwd?: string) => …`, same reasoning as reviewerEnabled above.
  toolSearch?: { enabled?: (cwd?: string) => boolean | undefined; deferThreshold?: (cwd?: string) => number | undefined; deferExternals?: (cwd?: string) => "count" | "always" | undefined };
  // Plan mode (1d-ii): both optional, and both absent leaves existing behavior untouched. Without
  // `plans`, exit_plan_mode falls to the else executeCall branch → the tool's own placeholder
  // run() (tools/plan.ts) rather than the approval bridge below. `setPolicy` persists an approved
  // plan's mode switch to the SessionStore (so it survives into the NEXT turn); the bridge also
  // mutates the in-memory `meta` object for the CURRENT turn regardless of whether setPolicy is
  // set, since that's what lets a same-turn follow-up call see the new mode immediately.
  plans?: PlanBroker;
  setPolicy?: (sessionId: string, policy: SessionApprovalPolicy) => Promise<void> | void;
  // Worktree isolation (1d-iii): optional — absent means enter_worktree/exit_worktree fall to
  // their own placeholder run() (tools/worktree.ts) rather than the bridge below. When set, the
  // bridge mutates the turn's local `cwd` (now `let`, not `const`) SAME-TURN, so a follow-up tool
  // call later in this same turn resolves into (or back out of) the worktree immediately — it
  // also persists via store.setCwd/dirs.add so the NEXT turn sees it too.
  worktrees?: WorktreeManager;
  // State pin (4g-i): per-session live background-task listing, consulted ONLY by pinnedTools
  // (below) to force bash_output/task_stop visible while a task is running, without touching the
  // sticky loadedTools set. Absent → that pin never fires (bash_output/task_stop, if registered
  // deferred:true, stay hidden until ToolSearch-loaded like any other deferred built-in).
  bgRegistry?: BgTaskLister;
  // Subagents (1d-iv): both optional, and both absent leaves spawn_agent at its own placeholder
  // run() (tools/spawn.ts) rather than the parallel bridge below. Both must be set together for
  // the bridge to activate — see the `spawnCalls` filter in runThread's dispatch loop.
  subagents?: SubagentManager;
  agents?: AgentStore;
  // Async spawn (4h-ii-a, CC parity: Agent.run_in_background): tracks DETACHED child threads —
  // see bg-agent-registry.ts's own doc comment for why this is a separate registry from
  // bgRegistry above (that one owns backgrounded bash processes; this one owns agent threads,
  // whose live output already streams as ordinary thread events). Optional — a spawn call with
  // `run_in_background:true` while this is unset fails as a typed error (see the bridge below)
  // rather than silently falling back to the synchronous path, so a caller never gets a "running"
  // tool_result for a detached child nothing is actually tracking.
  bgAgents?: BackgroundAgentRegistry;
  // Dispatch (Phase 7): getter — daemon wires the registry after engine construction (computerUse
  // precedent: `let dispatchChildren` is declared before `new AgentEngine(...)`, this closure
  // reads it live, then daemon.ts assigns it right after construction). Absent (every test/config
  // that doesn't wire dispatch mode) → the session_spawn bridge never activates and session_spawn
  // calls fall through to the tool's own placeholder run() (session-spawn.ts).
  dispatch?: () => DispatchChildren | undefined;
  // Dispatch (Phase 7) Task 5: fired in runTurn's `finally`, AFTER `runningTurns.delete`, for
  // EVERY session (the dispatch session's own turns included, not just its children's) — the
  // registry's onTurnEnd derives a finished child's terminal status, appends a `child_update` to
  // the dispatch stream, and wakes the dispatch session (immediately if idle, or coalesced into a
  // single pending wake if it's still busy — see dispatch-children.ts). Absent (every config that
  // doesn't wire dispatch mode) → no-op, byte-identical to pre-Task-5 behavior.
  onTurnEnd?: (sessionId: string) => void;
  // Dispatch (Phase 7) Task 5: per-turn live roster for the DISPATCH session only — same
  // <system-reminder> user-message injection shape/point as taskListReminder (turn(), right after
  // the task-list reminder is pushed). The registry returns undefined for every session that isn't
  // the live dispatch session (or has no children yet), so a non-dispatch turn's input stays
  // byte-identical to before this field existed.
  dispatchRoster?: (sessionId: string) => string | undefined;
  // 4h-i Task 3 (CC parity: configurable nesting depth, settings.subagents.maxDepth): how many
  // levels of spawn_agent nesting are allowed, orthogonal to SubagentManager's maxConcurrent
  // (fan-out width) — this is depth, not count or concurrency. Undefined (getter absent, or
  // present but resolving to undefined) → defaults to 5 (runThread reads `subagentMaxDepth?.() ??
  // 5`), matching Claude Code's fixed max nesting depth of 5 (user decision: "whatever Claude Code
  // does"). `maxDepth: 1` reproduces the pre-4h-i behavior (a depth-1 child could never spawn
  // further). A thread at `depth < maxDepth` may spawn (spawn_agent stays in its specs, the bridge
  // runs its calls); a thread AT `depth >= maxDepth` has spawn_agent excluded from its specs and,
  // belt-and-braces, rejects any spawn_agent call it receives anyway.
  // hot-settings T2: getter over the live settings holder (was a plain boot-captured number) — see
  // reviewerEnabled's doc comment just above for the general shape/rationale.
  subagentMaxDepth?: () => number | undefined;
  // SessionTitler (Phase 2e-iii Task 3): optional — absent means no session gets an
  // auto-generated title. Fired fire-and-forget, only at the main thread's (depth 0) turn
  // completion, never on the error paths (an errored first turn has nothing worth titling).
  titler?: { maybeTitle(sessionId: string): Promise<void> };
  // Plugin hooks runtime (Phase 4f Task 2 — TYPE ONLY here; Task 3 wires the 4 actual call sites:
  // session-start/pre-tool(block)/post-tool/turn-end). daemon.ts builds this from a HookRegistry +
  // HookRunner + the hot `settings.hooks.enabled` read (plugins/hook-registry.ts's HookFacade).
  // Absent (every test/config predating Task 3) means no hook call site fires at all — this field
  // existing on the type does NOT by itself add any behavior.
  hooks?: { runFor(event: string, extra: Record<string, unknown>, sessionId: string, signal?: AbortSignal): Promise<Array<{ pluginId: string; result: HookResult }>> };
  // Computer use (Phase 5 CU): the lease-holding service the `computer` tool drives. Absent (every
  // config where settings.computerUse.enabled is not set) → `ctx.computerUse`/`ctx.attachImage` stay
  // undefined and no CU image is ever staged/drained — byte-identical to pre-CU behavior. Wired, the
  // engine (1) exposes it + an image-staging callback on the tool ctx, (2) drains staged screenshots
  // into the turn's input as `{type:"image"}` items at each round's end, and (3) releases the
  // session's held leases when the top-level turn settles (runTurn's finally).
  // hot-settings T5a: getter over the live settings-backed holder (was a plain boot-captured
  // value) — same T2 pattern/rationale as reviewerEnabled et al. above, so a boot-disabled CU can
  // be hot-enabled (and vice versa) without rebuilding the engine. `ctx.computerUse`'s type on
  // ToolContext (registry.ts) is UNCHANGED — it stays a plain `ComputerUseService | undefined`;
  // only this config field became a getter, resolved to that plain value at each read site below.
  computerUse?: () => ComputerUseService | undefined;
  // Subagent transcript files (CC parity: surfacing a subagent's full transcript as a file the
  // parent can read/glob/grep) — the SAME session-tmp-dir accessor daemon.ts already builds for
  // registerLspTools (`tmpDirOf`, sessionTmpDir-backed). Optional/absent (e.g. a test harness that
  // never wires it) → transcriptPathFor always resolves undefined and the writer never touches the
  // filesystem — every surface that would show a path (bg spawn tool_result, task_notification,
  // the sync trailer, agent_output) simply omits it, byte-identical to before this feature.
  tmpDirOf?: (sessionId: string) => string | undefined;
  // Auto-diagnostics after edit (lsp-consolidation T3, design doc `2026-07-15-lsp-consolidation-
  // design.md` §2) — CC parity: "after each file edit, it automatically reports type errors and
  // warnings so Claude can fix issues without a separate build step." Both getters, same hot-
  // settings T2/T5 shape as `computerUse`/`reviewerEnabled` above: `lsp` mirrors daemon.ts's own
  // `let lspManager` holder (rebuilt on an `lsp.enabled` hot flip — settings-apply.ts's registerLsp/
  // teardownLsp reassign that SAME holder this getter closes over), so a disable is visible on the
  // very next tool call with no engine reconstruction. Absent (every test/config that never wires
  // this) → executeCall's post-write/edit/notebook_edit hook below never fires, byte-identical to
  // pre-T3 behavior. `autoDiagnosticsEnabled` gates the hook independently of `lsp` itself being
  // present — settings.lsp.autoDiagnostics (default true; see settings.ts's
  // lspAutoDiagnosticsEnabledFrom) lets a user keep the on-demand `lsp` tool while opting OUT of
  // the automatic post-edit append.
  lsp?: () => LspManager | undefined;
  // Task 8 (CC project-folder-mechanics): widened to `(cwd?: string) => …`, same reasoning as
  // reviewerEnabled above — executeCall's own `cwd` param is passed at its one call site.
  autoDiagnosticsEnabled?: (cwd?: string) => boolean | undefined;
  // task-30 (push-notification track): the headless osascript fallback (notify-fallback.ts's
  // notifyHeadless) — called by the `notify` bridge (executeCall, below) ONLY when
  // `hub.attachedCount(sessionId) === 0` at the moment push_notification fires. Optional/absent
  // (every test that doesn't care) means the fallback simply never runs — the
  // notification_requested event is still always emitted via `hub.append` regardless of this
  // field. daemon.ts wires the real `notifyHeadless`; tests inject a spy to assert it fires (or
  // doesn't) without ever shelling out to osascript for real.
  notifyFallback?: (title: string, message: string) => void;
}

export class AgentEngine {
  private runningTurns = new Set<string>();
  // bg-retrigger Task 2: sessionIds with a detached-agent completion that landed WHILE a turn was
  // already running for that session — notifyBgCompletion sets this instead of starting a
  // reentrant turn; runTurn's finally drains it (starts exactly one follow-up turn) once the
  // in-flight turn settles, UNLESS that turn ended via interrupt() (see runTurn's finally).
  private retriggerPending = new Set<string>();
  private steerQueue = new Map<string, string[]>();
  // 4h-ii-b Task 4 (CC SendMessage): per-CHILD-THREAD steer queue, keyed by threadId (globally
  // unique th_<uuid>) — SEPARATE from the sessionId-keyed `steerQueue` above, which stays
  // MAIN-thread-only and untouched. A send_message to a RUNNING child pushes here (sendToThread);
  // the child's runThread drains its own thread's queue at each round boundary (round-top drain),
  // exactly mirroring how the main loop drains steerQueue. Deleted when a child thread's runThread
  // reaches any terminal return (see cleanupThreadSteer in runThread) so an undrained message can't
  // leak into a later resume of the SAME threadId.
  private threadSteerQueue = new Map<string, string[]>();
  private aborters = new Map<string, AbortController>();
  // loadedSkills is SESSION-scoped (sticky across turns) — NOT cleared per turn, unlike
  // steerQueue/aborters below (which ARE deleted in runTurn's finally, being per-turn). A skill
  // loaded via the Skill tool in one turn must still be injected into the NEXT turn's assembled
  // instructions, so this map lives for the lifetime of the engine (per session), not the turn.
  private loadedSkills = new Map<string, Set<string>>();
  // loadedTools mirrors loadedSkills above: SESSION-scoped (sticky across turns), NOT cleared in
  // runTurn's finally. A deferred mcp__ tool's schema, once loaded via the ToolSearch tool, must
  // stay loaded for every later round of the SAME turn (defense-in-depth's execute check runs
  // per-round) AND for every subsequent turn of the session — so this Set is shared, mutated
  // in-place (never copied/snapshotted), across specs()/deferredIndex()/executeCall's ctx. See
  // the NOTE in turn() below.
  // THREAD-LOCAL WRITES (4g final-review fix): this map is populated ONLY by the MAIN thread —
  // turn() seeds `this.loadedTools.get(sessionId)` and hands that SAME Set object to runThread as
  // opts.loaded. executeCall/markToolLoaded (below) always operate on THE CALLING THREAD's
  // `loaded` set (threaded through as a parameter), never by re-deriving it from this map via
  // sessionId. For the main thread that set IS this map's entry, so a load still lands here and
  // stays sticky across turns — unchanged. A CHILD thread's `loaded` (runThread's spawn bridge:
  // `childLoaded = new Set()`) is never stored in this map, so a subagent's ToolSearch load can
  // no longer leak into (or be shadowed by) the session-wide set.
  private loadedTools = new Map<string, Set<string>>();
  // Thread registry (1d-iv, for thread.list): SESSION-scoped, mirrors loadedSkills/loadedTools
  // above in lifetime (never cleared per-turn). Seeded lazily (via threadList()) with the main
  // thread entry on first read/turn, then appended to by the spawn bridge as children are
  // registered/completed. Never a snapshot — entries are mutated in place by completeThread.
  private threads = new Map<string, ThreadInfo[]>();
  // Plugin hooks (4f Task 3): sessionIds whose `session-start` hook has already fired in THIS
  // daemon process. PROCESS-LIFETIME, never persisted — a session RESUMED in a fresh daemon
  // process re-fires session-start once (acceptable v1: a resumed session has no in-memory record
  // it already started; CC has the same re-fire-on-restart shape). Only consulted when cfg.hooks
  // is wired, so it's inert (allocated-but-untouched) for every hook-less config — byte-identical.
  private hookSessionStarted = new Set<string>();
  // Vision image bridge (originally Phase 5 CU-only; generalized so ANY tool can stage an image —
  // the `computer` tool's screenshots AND the `read` tool's image/notebook-image-output attaches
  // both go through this ONE map): images staged this turn, keyed by imageKey(sessionId, threadId,
  // callId) — NOT bare callId: callIds are provider-minted with no cross-session/cross-thread
  // uniqueness guarantee, and a bare-callId collision between two concurrent sessions would drain
  // one session's image into the OTHER's model input (a cross-session leak). `ctx.attachImage`
  // (wired in executeCall whenever the thread's model is vision-capable — independent of whether
  // computer-use is configured) pushes here; the round-end drain in runThread (drainRoundImages)
  // pops each processed call's images into `input` as `{type:"image"}` items and deletes the entry;
  // runTurn's finally sweeps this session's leftovers. Never persisted (see the TurnInputItem image
  // variant's doc comment) — a purely in-turn, in-memory hand-off from tool to provider input.
  private pendingImages = new Map<string, string[]>();
  private static imageKey(sessionId: string, threadId: string, callId: string): string {
    return `${sessionId}|${threadId}|${callId}`;
  }
  // CC-parity subagent transcript writer (subagent-transcript.ts) — constructed in the constructor
  // BODY (not a field initializer) so it can close over `this.cfg`, which parameter-property
  // assignment guarantees is already set by the time the body runs.
  private readonly subagentTranscripts: SubagentTranscripts;
  // 4h-ii-b Task 5 (stale-name guard, CC v2.1.199 parity): per-session-per-name bookkeeping now
  // lives on BackgroundAgentRegistry itself (firstReached/recordReached) so BOTH the send_message
  // bridge (below) and task-stop.ts's plain tool can share it; nothing engine-local is needed here.
  constructor(private readonly cfg: EngineConfig) {
    this.subagentTranscripts = new SubagentTranscripts((sessionId) => this.cfg.tmpDirOf?.(sessionId));
  }

  /** Public path accessor (CC parity: surfacing a subagent's transcript file path) — undefined when
   *  cfg.tmpDirOf is absent/unresolved for this session. Every surface that shows the path (bg spawn
   *  tool_result, task_notification, the sync trailer, agent_output) goes through this ONE
   *  accessor, so they can never disagree on where the file lives. */
  transcriptPathFor(sessionId: string, threadId: string): string | undefined {
    return this.subagentTranscripts.pathFor(sessionId, threadId);
  }

  /** True while a turn is executing for the session. */
  isRunning(sessionId: string): boolean { return this.runningTurns.has(sessionId); }

  /** Number of sessions with a turn executing right now (update idle gate). */
  activeTurnCount(): number {
    return this.runningTurns.size;
  }

  /** Lazily seeds the main thread entry for a session on first read/turn. */
  private threadList(sessionId: string): ThreadInfo[] {
    let list = this.threads.get(sessionId);
    if (!list) {
      list = [{ threadId: MAIN_THREAD, status: "running" }];
      this.threads.set(sessionId, list);
    }
    return list;
  }

  /** Registers a new (child) thread entry — called by the spawn bridge when a subagent starts. */
  private registerThread(sessionId: string, info: ThreadInfo): void {
    this.threadList(sessionId).push(info);
  }

  /** Marks a thread (main or child) completed with its stop reason, in place. `"stalled"`
   *  (task-16, CC-parity follow-up) is only ever passed for a CHILD thread — the progress-stall
   *  watchdog can only abort a thread it's watching from the outside (a subagent's own
   *  `SubagentManager.run()` call), which the main thread never goes through. */
  private completeThread(sessionId: string, threadId: string, stopReason: "end_turn" | "aborted" | "error" | "stalled"): void {
    const t = this.threadList(sessionId).find((t) => t.threadId === threadId);
    if (t) { t.status = "completed"; t.stopReason = stopReason; }
  }

  /** All threads for a session (thread.list): main first, then children in registration order. */
  threadsFor(sessionId: string): ThreadInfo[] {
    return this.threadList(sessionId);
  }

  async runTurn(sessionId: string): Promise<void> {
    if (this.runningTurns.has(sessionId)) throw new Error(`turn already running for ${sessionId}`);
    this.runningTurns.add(sessionId);
    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
    try {
      await this.turn(sessionId, ac.signal);
    } finally {
      this.runningTurns.delete(sessionId);
      this.aborters.delete(sessionId);
      this.steerQueue.delete(sessionId);
      // Computer use (Phase 5 CU): release any peripheral leases the session held for CU when the
      // top-level turn settles (all terminal paths incl. abort) — UNLESS a detached background
      // agent of this session is still running: such a child shares the sessionId, runs OUTSIDE
      // any runTurn, and may be mid-CU-loop — yanking its lease here would misreport "computer use
      // unavailable — Norma.app not running" and force a fresh approval card mid-bg-run. The
      // service's own idle backstop (maxIdleMs, default 60s without a CU action) bounds the hold
      // for that case instead. Guarded so CU-less configs are byte-identical. Runs before the
      // bg-retrigger drain so a follow-up turn starts with a clean lease slate.
      //
      // hot-settings T5b: read the getter LIVE here, at finally-time — NOT a turn-start snapshot
      // (T5a's original shape). settings-apply.ts's teardownComputer calls releaseAll() globally
      // the instant CU is hot-DISABLED, so that direction was already covered without this read
      // needing to be live. The gap a snapshot left was the OPPOSITE direction — a hot ENABLE
      // mid-turn: a lease acquired by a live per-tool-call ctx.computerUse read (executeCall
      // always reads the getter fresh) wouldn't be released here until the service's own 60s
      // maxIdleMs backstop, since the turn-start snapshot was still `undefined`. Reading live
      // resolves to whatever service is actually live when the turn settles — the SAME instance
      // that would hold this session's lease in both the steady-state and enable-mid-turn cases;
      // a mid-turn DISABLE is a harmless no-op here (teardownComputer's releaseAll already released
      // everyone AND cleared the holder, so this read resolves to `undefined` — nothing to release).
      const cu = this.cfg.computerUse?.();
      // bgRunning gates BOTH the CU lease release below AND the pendingImages sweep further down —
      // computed once, unconditionally (not nested inside `if (cu)` anymore): a detached background
      // agent shares this sessionId and may be mid-CU-loop OR mid-`read`-of-an-image, so neither
      // teardown may run while one is live.
      const bgRunning = this.cfg.bgAgents?.list(sessionId).some((e) => e.status === "running") ?? false;
      if (cu && !bgRunning) {
        cu.releaseSession(sessionId);
      }
      if (!bgRunning) {
        // Teardown sweep for staged-but-undrained images (an abnormal unwind between staging and
        // the round-end drain — e.g. an emit throw mid-dispatch — would otherwise leak the base64
        // in the map for the daemon's lifetime). Generalized past CU: the `read` tool can stage an
        // image via ctx.attachImage whenever the model is vision-capable, with no computer-use
        // service involved at all — so this sweep must run whenever no bg agent is live, NOT only
        // when `cu` is configured. Keys are namespaced `${sessionId}|...` (imageKey) so this
        // touches only THIS session's leftovers; a mid-round child's staged-but-not-yet-drained
        // image must never be swept out from under its own round-end drain (same bgRunning guard).
        for (const key of this.pendingImages.keys()) {
          if (key.startsWith(`${sessionId}|`)) this.pendingImages.delete(key);
        }
      }
      // Dispatch (Phase 7): child turn-end → registry appends child_update + wakes the dispatch session.
      this.cfg.onTurnEnd?.(sessionId);
      if (this.retriggerPending.delete(sessionId) && !ac.signal.aborted) {
        // A detached agent finished mid-turn; its task_notification is already persisted. Drain it
        // now (CC parity: between-turns queue drain) so the model reacts without a user message.
        // An esc-aborted turn deliberately drops the drain — don't fight the user's interrupt; the
        // persisted event reaches the model on their next send.
        void this.runTurn(sessionId).catch((err) => console.error("bg-notification drain failed:", err));
      }
    }
  }

  /** Abort the in-flight turn for a session, if any. Idempotent — safe to call when idle. */
  interrupt(sessionId: string): { wasRunning: boolean } {
    const ac = this.aborters.get(sessionId);
    if (!ac) return { wasRunning: false };
    ac.abort();
    return { wasRunning: true };
  }

  /**
   * Inject a user message into a session. If a turn is running, the message is queued and
   * drained into the next round's input (steering it mid-turn); otherwise a new turn is
   * started so the message reaches the model. The message is always appended to history
   * immediately (via hub.append) regardless of which path is taken.
   */
  steer(sessionId: string, text: string): { injected: boolean } {
    // Surface as a user_message (history + all harnesses) — clientName "steer".
    this.cfg.hub.append(sessionId, { type: "user_message", sessionId, threadId: MAIN_THREAD, text, clientName: "steer" });
    if (this.isRunning(sessionId)) {
      const q = this.steerQueue.get(sessionId) ?? [];
      q.push(text); this.steerQueue.set(sessionId, q);
      return { injected: true };
    }
    // start a turn; the user_message is already in history
    void this.runTurn(sessionId).catch((e) => console.error("steer turn failed:", e));
    return { injected: false };
  }

  /**
   * 4h-ii-b Task 4 (CC SendMessage): deliver `text` to a RUNNING child thread. The child receives
   * it at its next step. QUEUE-ONLY — push `text` into this child thread's own steer queue (keyed by
   * threadId), which the child's runThread drains at its next round boundary (the round-top drain),
   * exactly like the main loop drains steerQueue. This is the running-target half of the
   * send_message bridge (SM4); the finished-target half reuses resumeThread instead.
   *
   * The child-scoped `user_message` is NO LONGER persisted here — it is persisted at the CHILD
   * round-top DRAIN (see runThread's child branch) instead (whole-branch review C1/I1). Persisting
   * at SEND time was a bug: a send that lands while the child is AWAITING executeCall (a real
   * multi-second bash/web_fetch/nested-spawn window) would slot the user_message BETWEEN that
   * round's tool_call and its tool_result in the child's persisted log — an INTERIOR corruption the
   * resume clean-termination guard (which only inspects the LAST event) misses. On resume,
   * childHistoryInput (a blind 1:1 seq map, no coalescing) then reconstructs an orphan
   * function_call immediately followed by a user turn → a hard provider reject. Persisting at the
   * drain instead guarantees the message lands AFTER the prior round's tool_result (clean
   * alternation), and a message that is never drained (child finishing, I1) is never persisted.
   */
  sendToThread(sessionId: string, threadId: string, text: string): void {
    const q = this.threadSteerQueue.get(threadId) ?? [];
    q.push(text);
    this.threadSteerQueue.set(threadId, q);
  }

  /**
   * child-transcript-view T1 (design doc "Wire"): the `thread.send` RPC's engine half — lets a
   * HARNESS connection do exactly what the send_message TOOL bridge above does for the MODEL
   * (resolve `agent` in `bgAgents`, apply the same stale-name guard, running → `sendToThread`,
   * terminal → `resumeThread` in the background), now user-initiated instead of model-initiated.
   * Deliberately NOT folded into the bridge's own inline loop above (that code path is
   * per-tool-call-batch and threads through `opts`/`meta`/`signal` values only a live turn has) —
   * this is the single shared "resolve + dispatch" surface both a future refactor of that bridge
   * AND this RPC can call; today only the RPC does, since the bridge's threading-through of the
   * calling thread's own model/effort/depth/signal must stay byte-identical to before this task.
   *
   * A user-initiated resume has no real parent thread/signal: `depth: 0` (same semantics as a
   * fresh top-level send), `parentThreadId: MAIN_THREAD` (the child re-anchors under the main
   * thread's thread_started, same as any other resume), and a throwaway `AbortSignal` for
   * `parentSignal` — irrelevant here since `runInBackground: true` makes `resumeThread` ignore it
   * (see that method's own doc comment: "A BG resume deliberately ignores it").
   *
   * `kind` distinguishes two error buckets (mirrors `memoryErrorCode`/`skillErrorCode`'s
   * structural split in ipc/server.ts): `"not_found"` — no such agent, or a stale-name-guard
   * failure (the addressed target is unreachable); `"invalid"` — the agent WAS found and terminal,
   * but `resumeThread`'s own guards refused it (no resumable history, worktree removed, etc.) —
   * the caller-facing "clear refusal" the design doc's Failure modes section calls for.
   */
  async sendToAgent(sessionId: string, agent: string, text: string): Promise<
    | { ok: true; delivered: "queued" | "resumed"; agentId: string }
    | { ok: false; kind: "not_found" | "invalid"; error: string }
  > {
    if (!this.cfg.bgAgents) {
      return { ok: false, kind: "not_found", error: "send_message is not available in this session" };
    }
    const entry = this.cfg.bgAgents.get(agent, sessionId);
    if (!entry) return { ok: false, kind: "not_found", error: `no agent '${agent}' to message` };
    const guard = guardAgentName(this.cfg.bgAgents, sessionId, agent, entry);
    if (!guard.ok) return { ok: false, kind: "not_found", error: guard.error };
    if (entry.status === "running") {
      this.sendToThread(sessionId, entry.threadId, text);
      return { ok: true, delivered: "queued", agentId: entry.agentId };
    }
    // terminal (completed/failed/stopped/timeout) → resume it in the background, exactly like the
    // model's own send_message-to-a-finished-agent — see resumeThread's own doc comment for the
    // full D1-D7 guard set (clean-termination repair, removed-worktree, policy no-widen, ...).
    const meta = this.cfg.store.meta(sessionId);
    const sel = this.cfg.provider.live?.() ?? { model: this.cfg.provider.model };
    const result = await this.resumeThread({
      sessionId,
      resumeArg: agent,
      prompt: text,
      runInBackground: true,
      meta,
      model: sel.model,
      reasoningEffort: sel.reasoningEffort,
      depth: 0,
      parentThreadId: MAIN_THREAD,
      parentSignal: new AbortController().signal,
    });
    if (result.isError) return { ok: false, kind: "invalid", error: result.output };
    return { ok: true, delivered: "resumed", agentId: entry.agentId };
  }

  /**
   * child-transcript-view T1: the `agent.stop` RPC's engine half — a thin, synchronous mirror of
   * the task_stop TOOL's own agent-stop branch (task-stop.ts), now user-reachable. Stopping a
   * RUNNING agent aborts it and returns "stopped"; stopping an already-TERMINAL agent is not an
   * error (idempotent, same as calling task_stop twice) — it just reports whatever status it
   * already settled at. Only an unresolvable `agent` (unknown id/name, or a stale-name-guard
   * failure) is an error.
   */
  stopAgent(sessionId: string, agent: string): { ok: true; status: AgentStatus } | { ok: false; error: string } {
    if (!this.cfg.bgAgents) {
      return { ok: false, error: "background agents are not available in this session" };
    }
    const entry = this.cfg.bgAgents.get(agent, sessionId);
    if (!entry) return { ok: false, error: `no agent '${agent}' to stop` };
    const guard = guardAgentName(this.cfg.bgAgents, sessionId, agent, entry);
    if (!guard.ok) return { ok: false, error: guard.error };
    if (entry.status === "running") {
      this.cfg.bgAgents.stop(entry.agentId);
      return { ok: true, status: "stopped" };
    }
    return { ok: true, status: entry.status };
  }

  private emit(sessionId: string, event: NewSessionEvent): SessionEvent {
    const persisted = this.cfg.hub.append(sessionId, event); // hub.append: store.append + broadcast (added below)
    this.captureSubagentTranscript(sessionId, persisted);
    return persisted;
  }

  /** CC-parity subagent transcript surfacing — see subagent-transcript.ts's own doc comment for the
   *  file format/exclusions. FAST NO-OP PATH FIRST: the vast majority of events are MAIN-thread (or
   *  carry no threadId at all), which must stay byte-identical to before this feature — so the
   *  cheap identity/string checks run before the registry scan. Only a REGISTERED child thread's
   *  own events reach the writer: `this.threads` is the SAME registry registerThread/threadsFor
   *  (thread.list) already maintain. The spawn bridge now calls registerThread BEFORE its paired
   *  thread_started emit (previously the other way around) specifically so a child's very FIRST
   *  captured event here IS its own thread_started — letting the writer derive its synthetic
   *  spawn_prompt line straight from it, with no separate "start" call needed at this chokepoint. */
  private captureSubagentTranscript(sessionId: string, event: SessionEvent): void {
    if (!("threadId" in event) || event.threadId === MAIN_THREAD) return;
    if (!this.threads.get(sessionId)?.some((t) => t.threadId === event.threadId)) return;
    this.subagentTranscripts.append(sessionId, event.threadId, event);
  }

  /** Manually trigger compaction (e.g. via an explicit IPC method), scoped to any turn
   *  currently running for this session so an abort/interrupt also cancels the compaction. */
  async compact(sessionId: string): Promise<{ compacted: boolean; uptoSeq: number; summaryChars: number }> {
    return this.cfg.compactor.compact(sessionId, this.aborters.get(sessionId)?.signal);
  }

  /** ToolSearch deferral is wired ONLY when cfg.toolSearch is set AND enabled !== false. Each
   *  sub-field is a getter (hot-settings T2) read fresh here — `enabled?.()` returning undefined
   *  (getter absent, or present but resolving to undefined) keeps the same "not explicitly false"
   *  default the pre-getter code had. Task 8 (CC project-folder-mechanics): each helper now takes
   *  the CALLER's in-scope `cwd` and threads it into every cfg getter, so daemon.ts's real wiring
   *  can resolve a PER-PROJECT toolSearch setting; every call site below passes its own local
   *  `cwd` (buildInstructionsFull's param, runThread's thread-local, executeCall's param). */
  private toolSearchEnabled(cwd: string | undefined): boolean {
    return this.cfg.toolSearch !== undefined && this.cfg.toolSearch.enabled?.(cwd) !== false;
  }

  private toolSearchThreshold(cwd: string | undefined): number | undefined {
    return this.toolSearchEnabled(cwd) ? this.cfg.toolSearch!.deferThreshold?.(cwd) : undefined;
  }

  private toolSearchDeferExternals(cwd: string | undefined): "count" | "always" | undefined {
    return this.toolSearchEnabled(cwd) ? this.cfg.toolSearch!.deferExternals?.(cwd) : undefined;
  }

  /** Per-turn/round pins (4g-i): state-required deferred built-ins forced visible WITHOUT
   *  touching the sticky `loadedTools` set (that Set is mutated ONLY by markToolLoaded — see the
   *  NOTE above `loadedTools`'s declaration). Callers union the result into a NEW Set
   *  (`effectiveLoaded`) at each of the three deferral seams (buildInstructionsFull, the
   *  per-round specs() call, and executeCall) — `loaded` itself is never copied or mutated here.
   *  Recomputed fresh at each seam (not cached) so a mid-turn state change — a plan approved, a
   *  worktree entered/exited via the same-turn bridges, a bg task started/exited — is reflected
   *  without waiting for the next turn. A no-op when the corresponding tool isn't registered
   *  deferred:true (or isn't registered at all) — specs()/execute don't care about pins for a
   *  tool that was never hidden in the first place. `_cwd` is unused today (no current pin is
   *  scope-aware) — kept in the signature for parity with the other deferral seams, which all
   *  thread cwd, in case a future pin needs it. */
  private pinnedTools(sessionId: string, meta: { approvalPolicy: SessionApprovalPolicy }, _cwd: string | null): Set<string> {
    const pins = new Set<string>();
    if (meta.approvalPolicy === "plan") pins.add("exit_plan_mode");
    if (this.cfg.worktrees?.active(sessionId)) pins.add("exit_worktree");
    const bgTasks = this.cfg.bgRegistry?.list(sessionId) ?? [];
    // 4h-ii-c Task 2: task_stop can kill a running bg TASK too (its bash-unify path — the ONLY
    // way to do so now that the standalone bash_kill tool is gone) — pinned alongside bash_output
    // whenever one is running.
    if (bgTasks.some((t) => t.status === "running")) { pins.add("bash_output"); pins.add("task_stop"); }
    // task_stop is ALSO pinned whenever a bg AGENT is running (independent of any bg bash task) —
    // that's its primary target (CC TaskStop parity: stop a running background agent).
    if (this.cfg.bgAgents?.list(sessionId).some((e) => e.status === "running")) pins.add("task_stop");
    // phase 5a Task 1: agent_list/agent_output are pinned whenever ANY bg agent entry exists for
    // this session — running OR terminal (unlike task_stop's running-only pin above), since a
    // FINISHED agent must stay collectable via agent_output without a ToolSearch load.
    if (this.cfg.bgAgents?.list(sessionId).length) { pins.add("agent_list"); pins.add("agent_output"); }
    return pins;
  }

  /** `model` is the PER-TURN resolved model (turn()'s `sel.model` — live-resolved when
   *  `cfg.provider.live` is wired, else the boot snapshot) — never the boot model directly, so a
   *  live model change is reflected in the auto-compact threshold on the very next turn, not just
   *  in the streamTurn call. Unknown model (no ModelInfo match, e.g. an openai-compatible
   *  provider with no static `models()` list) falls back to Infinity — i.e. auto-compact never
   *  fires rather than firing on a guessed window; this is the pre-existing behavior, unchanged. */
  private contextWindow(model: string): number {
    const m = this.cfg.provider.provider.models().find((mi) => mi.id === model);
    return m?.contextWindow ?? Infinity;
  }

  /** Auto-compact off the REAL provider-reported size of the previous turn (its `turn_completed`
   *  `inputTokens`) — not an estimate. Runs at the start of every turn, before `historyInput` is
   *  built, so a triggered compaction's checkpoint is what `historyInput` sees for this turn. No
   *  prior completed turn (first turn of a session) means the context is necessarily small, so
   *  there's nothing to check. `model` is this turn's resolved model (see `contextWindow`'s doc
   *  comment) — the Compactor's OWN summarization turn still runs on the boot-time model
   *  (Compactor is constructed once in daemon.ts and isn't live-wired); only the trigger
   *  threshold computed here uses the per-turn resolution. */
  private async maybeAutoCompact(sessionId: string, model: string): Promise<void> {
    const events = this.cfg.store.read(sessionId);
    const lastCompleted = [...events].reverse().find(isTurnCompleted);
    if (!lastCompleted) return;
    const used = lastCompleted.inputTokens;
    const frac = Number(process.env.NORMA_COMPACT_THRESHOLD_FRAC ?? 0.75);
    const absMax = process.env.NORMA_COMPACT_MAX_TOKENS ? Number(process.env.NORMA_COMPACT_MAX_TOKENS) : Infinity;
    const limit = Math.min(this.contextWindow(model) * frac, absMax);
    if (used > limit) await this.cfg.compactor.compact(sessionId, this.aborters.get(sessionId)?.signal);
  }

  /** Builds the turn's starting input from history: if the session has been compacted (a
   *  `checkpoint` event exists), the input opens with the checkpoint's summary in place of the
   *  messages it covers, followed only by messages after its `uptoSeq` — this is what actually
   *  shrinks the model's context after compaction. With no checkpoint, behavior is unchanged:
   *  the full user/assistant message history. */
  private historyInput(sessionId: string): TurnInputItem[] {
    const events = this.cfg.store.read(sessionId);
    const lastCp = [...events].reverse().find(isCheckpoint);
    const input: TurnInputItem[] = [];
    if (lastCp) input.push({ type: "message", role: "user", content: "[Summary of earlier conversation]\n" + lastCp.summary });
    const uptoSeq = lastCp ? lastCp.uptoSeq : 0;
    for (const e of events) {
      if (e.seq <= uptoSeq) continue;
      if ("threadId" in e && e.threadId !== MAIN_THREAD) continue;
      // CC parity: prior turns' tool calls/results are replayed verbatim (via the shared
      // eventToInput mapper below), not just summarized by their assistant_message — the model
      // no longer "forgets" what its tools did across turns. A checkpoint's `uptoSeq` is always a
      // MESSAGE seq (Compactor only ever folds up to a user/assistant boundary — see
      // compactor.ts's isMessage filter), so a tool_call/tool_result pair can never be split by a
      // checkpoint: either both are folded into the summary, or both survive as tail. That
      // guarantee is jointly held by TWO things, not one: (1) auto-compact runs at the start of a
      // turn (see maybeAutoCompact's doc comment above), before this turn's tool calls exist, so
      // there is never an in-flight pair for it to land inside; and (2) a manual `compact` IPC
      // call is live mid-turn and CAN race a pending tool call (e.g. a steer flood during a slow
      // approval), so compactor.ts's `compact` additionally clamps its candidate `uptoSeq` so it
      // never lands inside an unresolved main-thread tool_call/tool_result pair — see that
      // method's clamp comment. Only together do the two paths make the "never split" guarantee
      // hold unconditionally.
      const item = this.eventToInput(e);
      if (item) input.push(item);
    }
    return this.normalizeReplayOrder(input);
  }

  /** The ONE event→TurnInputItem mapping for history reconstruction (main + child threads must
   *  stay in lockstep — both feed the provider). Returns null for events with no provider shape. */
  private eventToInput(e: SessionEvent): TurnInputItem | null {
    if (e.type === "user_message") return { type: "message", role: "user", content: e.text };
    if (e.type === "assistant_message") return { type: "message", role: "assistant", content: e.text };
    if (e.type === "tool_call") return { type: "function_call", callId: e.callId, name: e.name, argsJson: e.argsJson };
    if (e.type === "tool_result") return { type: "tool_result", callId: e.callId, output: e.output, isError: e.isError };
    // history-parity Task 3: opaque reasoning items replay verbatim (CC/Codex parity). This ONE
    // case gives BOTH historyInput (cross-turn) and childHistoryInput (subagent resume) the replay.
    if (e.type === "reasoning_item") return { type: "reasoning", itemJson: e.itemJson };
    // bg-retrigger Task 1: a persisted bg-agent completion notice (engine.ts's `notifyBgCompletion`)
    // replays as a plain user-role message — same shape as `user_message` above — so the model
    // learns a detached agent finished without a user keystroke (CC parity).
    if (e.type === "task_notification") return { type: "message", role: "user", content: e.content };
    return null;
  }

  /** Replay-order normalization (whole-branch C1): a main-thread steer() persists its user_message
   *  at SEND time, which can land in seq between a tool_call and its tool_result (the live loop
   *  only drains steers at the next round top, so the PROVIDER never saw that interleaving). Replay
   *  must mirror what the provider actually received: any message items found between a
   *  function_call and its matching tool_result are deferred to immediately after that tool_result,
   *  preserving their relative order. Reasoning/tool items are never reordered.
   *
   *  Single pass with a per-open-pair buffer: on a function_call, subsequent `{type:"message"}`
   *  items buffer until the matching tool_result (same callId) is emitted, then flush in order right
   *  after it. Edge cases (never drop an item): sequential pairs (fc1,res1,fc2,res2) buffer
   *  independently; a function_call opening while a prior pair is still unresolved flushes that
   *  prior buffer first (degenerate — shouldn't exist post-compactor-clamp); a function_call whose
   *  matching tool_result never appears flushes its buffered messages at the end. Reasoning items
   *  and any non-matching tool_result between a pair pass through in place — only messages defer. */
  private normalizeReplayOrder(input: TurnInputItem[]): TurnInputItem[] {
    const out: TurnInputItem[] = [];
    let openCallId: string | null = null; // the function_call whose matching tool_result we await
    let buffer: TurnInputItem[] = []; // message items deferred while that pair is open
    for (const item of input) {
      if (item.type === "function_call") {
        // A new pair opens. If a prior pair never resolved (degenerate), flush its buffered
        // messages before this call so nothing is dropped or reordered ahead of it.
        if (buffer.length > 0) { out.push(...buffer); buffer = []; }
        openCallId = item.callId;
        out.push(item);
      } else if (item.type === "tool_result" && openCallId !== null && item.callId === openCallId) {
        // Close the open pair: result right after its call, then the deferred messages flush right
        // after the result (mirroring the live [fc, result, steer] order).
        out.push(item);
        if (buffer.length > 0) { out.push(...buffer); buffer = []; }
        openCallId = null;
      } else if (item.type === "message" && openCallId !== null) {
        buffer.push(item); // a message between a call and its matching result — defer it
      } else {
        out.push(item); // reasoning / non-matching tool_result / message outside any pair — in place
      }
    }
    if (buffer.length > 0) out.push(...buffer); // open pair with no matching result — never drop
    return out;
  }

  /** Reconstructs a SPECIFIC child thread's own history from the store, in seq order — the
   *  foundation for `resume` (4h-ii-b Task 3). CRUCIAL DIFFERENCE from `historyInput` above is now
   *  FILTERING, not mapping: both callers delegate to the same `eventToInput` mapper above, so a
   *  main-thread turn's tool calls/results and a child's replay exactly the same shapes. The
   *  difference is which events reach the mapper — historyInput fast-forwards past a checkpoint's
   *  `uptoSeq` and keeps only the MAIN thread; this reconstructs ALL of one specific child
   *  thread's events, unfiltered by any checkpoint (child threads are never compacted today, so
   *  there is no per-child checkpoint event to fast-forward past). A resumed child needs its own
   *  tool_call/tool_result pairs (unlike a main-thread turn, it has no assistant-text summary to
   *  fall back on for what its tools did), so this reconstruction is indistinguishable, shape-wise,
   *  from a child that never stopped.
   *
   *  KNOWN GAP (not fixed here — see this task's report): a child thread's ORIGINAL spawn prompt
   *  is never itself persisted as a `user_message` event scoped to that threadId — the spawn
   *  bridge passes it straight into runThread's in-memory `input` array (`[{type:"message",
   *  role:"user", content:prompt}]`), never through `hub.append`/`store` — so a reconstruction
   *  built purely from stored events for a real spawned child starts at its FIRST
   *  assistant_message, not the prompt that kicked it off. That opening prompt only survives in
   *  the `thread_started` event's own `prompt` field. Whatever calls this (T3's `resume`) must
   *  account for that gap — e.g. by prepending `thread_started.prompt` itself — this function
   *  only reconstructs what the store actually recorded for `threadId`. */
  private childHistoryInput(sessionId: string, threadId: string): TurnInputItem[] {
    const events = this.cfg.store.read(sessionId);
    const input: TurnInputItem[] = [];
    for (const e of events) {
      if (!("threadId" in e) || e.threadId !== threadId) continue;
      const item = this.eventToInput(e);
      if (item) input.push(item);
    }
    // whole-branch C1: child history is already structurally clean (send_message persists at the
    // DRAIN, not at send), so this is a pure no-op today — applied here for uniformity and to guard
    // any future child-scoped persist-at-send source (mirrors historyInput above).
    return this.normalizeReplayOrder(input);
  }

  /** task-15 (CC parity: resume an abnormally-ended agent; review-generalized) — repairs EVERY
   *  orphaned function_call anywhere in the reconstructed history (a tool_call the engine
   *  dispatched — the per-call dispatch loop's `this.emit(...{type:"tool_call"}...)` always fires
   *  BEFORE the awaited execution — whose matching tool_result never got persisted because the
   *  child stalled, was ESC-aborted, or errored while that tool was still in flight) by splicing a
   *  SYNTHETIC `tool_result` in immediately after it, so the provider never sees a function_call
   *  with no matching output — CC's own stated invariant ("the transcript must not contain a tool
   *  result without its tool use, or vice versa; append a synthetic error/cancel result when
   *  required").
   *
   *  FULL-ARRAY SCAN, not a tail check (review finding): the repair is deliberately in-memory-only
   *  (never persisted as a fake store event), so once a child has EVER stall-aborted mid-tool, the
   *  store permanently contains that unpaired tool_call — and every LATER resume's reconstruction
   *  replays it from the store again, now BURIED mid-history behind the repaired resume's own new
   *  prompt/turns (including a resume whose tail ends cleanly on an assistant message). A
   *  tail-only repair would hand the provider that buried orphan verbatim — mapInput is a blind
   *  1:1 map (send-message.test.ts's own `orphanFunctionCall` helper documents this exact shape as
   *  a hard provider reject) — silently defeating the fix for the repeated-failure case. So
   *  resumeThread runs this on EVERY resume, unconditionally; a fully-paired history passes
   *  through with identical contents (pure no-op, pinned by the clean-resume regression test).
   *
   *  Pairing check: `normalizeReplayOrder` guarantees a matched pair lands ADJACENT in replay
   *  order (interior messages are deferred past the result), so "is the next item this call's own
   *  tool_result" suffices. The one non-message item it never moves is opaque `reasoning`, which
   *  passes through in place — unreachable between a pair in practice (reasoning persists during
   *  streaming; call/result persist later, during that round's dispatch), but skipped here
   *  defensively so a hypothetical [call, reasoning, result] is still seen as paired rather than
   *  given a duplicate-callId synthetic. The synthetic still splices IMMEDIATELY after the orphan
   *  call itself (before any trailing reasoning — reasoning is order-transparent state that always
   *  PRECEDES the item it reasons for, so the pair must close before it).
   *  Returns a NEW array — `history` itself (and the store) is never mutated; this repair is
   *  purely an in-memory transform of the reconstructed input for THIS resume's request. */
  private repairOrphanedCalls(history: TurnInputItem[]): TurnInputItem[] {
    const repaired: TurnInputItem[] = [];
    for (let i = 0; i < history.length; i++) {
      const item = history[i]!;
      repaired.push(item);
      if (item.type !== "function_call") continue;
      let j = i + 1;
      while (j < history.length && history[j]!.type === "reasoning") j++;
      const candidate = history[j];
      if (candidate && candidate.type === "tool_result" && candidate.callId === item.callId) continue;
      repaired.push({
        type: "tool_result",
        callId: item.callId,
        output: "[cancelled: the agent ended before this tool call completed]",
        isError: true,
      });
    }
    return repaired;
  }

  /** No-timeout task: builds the `subagent (type) ...` failure text for a `!result.ok` spawn
   *  outcome — shared by the sync and detached (bg) spawn paths so a stalled child's partial
   *  output surfaces identically either way. A stall (`result.stalled`) additionally appends the
   *  child's LAST persisted ASSISTANT text, if any (reusing childHistoryInput, the same
   *  reconstruction the `resume` guard walks — but scanning BACKWARDS for the last assistant
   *  message rather than requiring it be terminal: a stalled child's history typically ends on
   *  the tool_result of the round it hung after, with its narration one item earlier). A child
   *  that stalls mid-way through its very FIRST round has nothing to append yet (its in-flight
   *  round's text was never persisted) — the plain stall message stands alone. Capped at 2000
   *  chars so a runaway child's own output can't balloon the parent's tool_result. */
  private subagentFailureText(
    agentType: string | undefined,
    result: { error: string; stalled?: true },
    sessionId: string,
    childThreadId: string,
  ): string {
    let text = `subagent (${agentType ?? "general-purpose"}) ${result.error}`;
    if (result.stalled) {
      const priorHistory = this.childHistoryInput(sessionId, childThreadId);
      for (let i = priorHistory.length - 1; i >= 0; i--) {
        const item = priorHistory[i]!;
        if (item.type === "message" && item.role === "assistant") {
          text += `\n\npartial output before stall:\n${item.content.slice(0, 2000)}`;
          break;
        }
      }
    }
    return text;
  }

  /** CC parity: a SUCCESSFUL synchronous spawn/resume result ends with an `agentId: <id>` trailer
   *  (sync results end with an agentId trailer the model can use to keep addressing this same
   *  agent — via send_message — after it already has the final report in hand). Shared by the
   *  fresh sync spawn path and the sync `resume` path (identical shape either way). The transcript
   *  clause is omitted when `path` is undefined (cfg.tmpDirOf unwired) — the rest of the trailer
   *  (agentId + the send_message pointer) still applies, since neither depends on a file existing.
   *  Never applied to an ERROR outcome — only a clean success gives the caller a "reason to keep
   *  talking to this same agent" pointer. */
  private syncTrailer(childId: string, path: string | undefined): string {
    const transcriptClause = path ? `transcript: ${path} — read/glob/grep it surgically for details; ` : "";
    return `\n\nagentId: ${childId} (${transcriptClause}send_message with to: '${childId}' to continue this agent)`;
  }

  // Shared by every <system-reminder> builder below (taskListReminder) AND by notifyBgCompletion's
  // persisted <task-notification>: both interpolate model/tool-authored strings (task subjects,
  // subagent name/result text) that may carry attacker-influenced content — newlines would inject
  // fake reminder/notification lines, and a literal closing tag would close the block early,
  // leaving durable ambient text in-context on every later turn (a persisted task_notification is
  // replayed on EVERY future turn, same durability concern as a reminder). Sanitize before
  // embedding, always.
  private sanitizeForReminder(s: string): string {
    return s.replace(/\r?\n/g, " ").replace(/<\/?system-reminder>/gi, "[tag]");
  }

  // ---- Plugin hooks (4f Task 3) ----------------------------------------------------------------
  // Four hook points hang off `cfg.hooks` (the Task-2 facade). Reserved-key note (once): the facade
  // spreads `extra` LAST over its own `{event, sessionId, pluginId, ts}`, so `extra` actually WINS a
  // key collision — the safety therefore does NOT come from spread order. It comes from the fact that
  // every per-event `extra` object below is authored HERE with only fixed, non-reserved literal keys
  // (toolName/argsJson/output/isError/threadId/cwd/stopReason/inputTokens/outputTokens) — none of
  // them is `event`/`sessionId`/`pluginId`/`ts`, so nothing can shadow the facade's common fields.
  // F1 (deny-only): only `pre-tool` can BLOCK, and only AFTER the gate has run (or, for the
  // read-only bridged tools, at their effect boundary) — a hook can restrict a call but never
  // widen/approve one. F2 (fail-open): `error`/`timeout`/non-blocked `ok` results are ignored so
  // the tool proceeds — that's just NOT treating them as `blocked`, no extra code.

  /** The isError tool_result a pre-tool BLOCK produces — the FIRST blocked hook result's pluginId +
   *  reason. Shape mirrors the engine's other early-outcome tool_results (depth-cap / deferred-
   *  builtin guards): a short human string + isError:true. */
  private hookBlockOutcome(blocked: { pluginId: string; result: HookResult }): { output: string; isError: boolean } {
    return { output: `blocked by plugin hook ${blocked.pluginId}: ${blocked.result.reason ?? "no reason given"}`, isError: true };
  }

  /** post-tool: observe a completed call's outcome (both success and isError). Observe-only —
   *  results are ignored. SKIPPED for a pre-tool-blocked call (it never ran): `blockedCallIds`
   *  carries every callId a pre-tool BLOCK shortcut set an outcome for. Callers guard on
   *  `this.cfg.hooks` before awaiting, so this is never reached hook-less (byte-identical). */
  private async firePostTool(
    sessionId: string,
    threadId: string,
    call: { name: string; argsJson: string; callId: string },
    outcome: { output: string; isError: boolean },
    blockedCallIds: Set<string>,
    signal?: AbortSignal, // [4f I1] session interrupt cuts through the hook chain
  ): Promise<void> {
    if (blockedCallIds.has(call.callId)) return;
    await this.cfg.hooks!.runFor("post-tool", { toolName: call.name, argsJson: call.argsJson, output: outcome.output, isError: outcome.isError, threadId }, sessionId, signal);
  }

  /** turn-end: fired immediately after a MAIN-thread `turn_completed` emit (all terminal paths:
   *  end_turn/aborted, deniedByHuman, provider error, iteration cap — INCLUDE-both-terminal-paths).
   *  Child-thread turns are excluded v1 (noise) — the threadId guard makes it a no-op for them.
   *  Observe-only. Callers guard on `this.cfg.hooks` before awaiting (byte-identical hook-less). */
  private async fireTurnEnd(
    sessionId: string,
    threadId: string,
    stopReason: "end_turn" | "aborted" | "error",
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    if (threadId !== MAIN_THREAD) return;
    // [4f I1] DELIBERATELY passes NO AbortSignal — unlike session-start/pre-tool/post-tool. turn-end
    // is the TERMINAL observation and must fire on ALL terminal paths, INCLUDING `aborted` (see this
    // method's doc above). But `stopReason === "aborted"` happens precisely when the session signal
    // fired (the provider only reports "aborted" once `signal` is aborted), so threading that signal
    // into runFor's pre-hook `aborted` check would suppress turn-end on exactly the aborted path the
    // design requires it to fire on. I1's interrupt-cuts-the-chain guarantee targets the ongoing work
    // of a live turn (pre-tool gate chain, post-tool observation, session-start injection), not the
    // turn's close-out — and turn-end hooks are already time-bounded by their own HookRunner budget.
    await this.cfg.hooks!.runFor("turn-end", { stopReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }, sessionId);
  }

  /** Per-turn task-list reminder (CC v2 parity): the model's own context carries task IDs
   *  nowhere else — `historyInput` above replays only user/assistant messages, never the
   *  task_updated events — so without this the model routinely loses track of ids and calls
   *  task_create again for work already on the list instead of task_update. Mirrors Claude
   *  Code's own system-reminder: injected as a "user" message (there's no dedicated reminder
   *  role on TurnInputItem) wrapped in an explicit <system-reminder> tag so the model treats it
   *  as ambient state, not something the user said — the tag text itself says as much ("never
   *  mention it"). ASSEMBLED INPUT ONLY: built fresh every turn from `cfg.tasks.list()`, appended
   *  to `input` in `turn()` below, and NEVER emitted/persisted as a session event — a session
   *  replay (historyInput on the NEXT turn) must not see this turn's reminder baked in as a fake
   *  user message. Returns undefined when there's nothing to remind about (no TaskStore wired,
   *  or the session's list is empty) so `turn()` can skip appending entirely. */
  private taskListReminder(sessionId: string): TurnInputItem | undefined {
    if (!this.cfg.tasks) return undefined;
    const tasks = this.cfg.tasks.list(sessionId);
    if (tasks.length === 0) return undefined;
    // FINAL-REVIEW FIX: subjects are model-authored strings that may carry attacker-influenced
    // content (the model quotes user/tool/file text into subjects) — sanitize before embedding
    // in the reminder block: newlines would inject fake reminder lines, and a literal
    // </system-reminder> would close the block early, leaving durable ambient "system" text
    // in-context on every later turn.
    const lines = tasks.map((t) => `#${t.id} [${t.status}] ${this.sanitizeForReminder(t.subject)}`).join("\n");
    const content = "<system-reminder>\nCurrent task list (update these by id — do NOT create a new task for work already listed):\n"
      + lines
      + "\nUse task_update with the task's id to change status; task_list shows full details."
      + "\nThis reminder is invisible to the user — never mention it.\n</system-reminder>";
    return { type: "message", role: "user", content };
  }

  /** Persists a detached child's completion as a task_notification history event (CC parity — the
   *  <task-notification> block LocalAgentTask builds; see the bg-retrigger spec). Exactly-once via
   *  registry.takeForNotification (single-consumer claim: a sync spawn's completion is registered
   *  notified:true and can never be claimed; task_stop marks its own target notified in-turn).
   *  Replaces the retired per-turn <system-reminder> sweep (buildBgCompletionReminder): the notice
   *  is now a durable main-thread event, replayed user-role by eventToInput on every later turn.
   *  Task 2 adds the wake (idle turn / between-turns drain) here. */
  private notifyBgCompletion(sessionId: string, agentId: string): void {
    const e = this.cfg.bgAgents?.takeForNotification(agentId);
    if (!e) return;
    // sanitize BOTH interpolations: `name` is model-supplied, `result` is subagent-authored — see
    // sanitizeForReminder's doc comment above (a persisted event replays on every later turn, so
    // injected structure would be durable). `result` is only set by registry.complete() — a
    // stop()-terminated entry never gets one, so the <result> line is omitted entirely then.
    // LOCAL hardening on top of sanitizeForReminder (which is shared with the <system-reminder>
    // builders and deliberately untouched): entity-escape a literal closing task-notification tag
    // (any casing/inner whitespace) so a hostile result can't close THIS block early — the real
    // closing tag below must stay the only one.
    const clean = (s: string) => this.sanitizeForReminder(s).replace(/<\/\s*task-notification\s*>/gi, "&lt;/task-notification&gt;");
    const label = clean(e.name ?? e.agentId);
    const summary = e.status === "completed" ? `Agent "${label}" completed`
      : e.status === "failed" ? `Agent "${label}" failed`
      : e.status === "timeout" ? `Agent "${label}" timed out`
      : `Agent "${label}" was stopped`;
    const result = e.result ? `\n<result>${clean(e.result)}</result>` : "";
    // CC parity: completion notifications carry an <output-file> element — an engine-controlled
    // path (session tmp dir + this agent's own threadId), never model/user text, so it needs no
    // sanitization pass. Omitted entirely when cfg.tmpDirOf is unwired (transcriptPathFor
    // undefined), matching every other transcript-path surface in this file.
    const outputFile = this.transcriptPathFor(sessionId, e.threadId);
    const outputFileTag = outputFile ? `\n<output-file>${outputFile}</output-file>` : "";
    const content = `<task-notification>\n<task-id>${e.agentId}</task-id>\n<status>${e.status}</status>\n<summary>${summary}</summary>${outputFileTag}${result}\n</task-notification>`;
    this.cfg.hub.append(sessionId, { type: "task_notification", sessionId, threadId: MAIN_THREAD, content });
    // bg-retrigger Task 2 (CC parity: background-agent wake): if a turn is already running for
    // this session, defer — runTurn's finally drains it once that turn settles (between-turns
    // queue drain). Otherwise the session is idle right now, so start a fresh turn immediately;
    // the event above is already in history, so that turn's own replay carries it to the model.
    if (this.isRunning(sessionId)) { this.retriggerPending.add(sessionId); return; }
    // steer()'s idle idiom: the event is already in history; a fresh turn replays it.
    void this.runTurn(sessionId).catch((err) => console.error("bg-notification turn failed:", err));
  }

  // Computed ONCE per turn by turn() (same one-per-turn rule as `instructions` itself) — a
  // same-turn ToolSearch load changes `loaded` but must not re-trigger this mid-turn; and the
  // plan-mode reminder is appended off the policy at turn start, not re-checked per round, so an
  // in-turn exit_plan_mode approval (which mutates `meta.approvalPolicy` for the REST of this
  // turn) does not retroactively add/remove this reminder mid-turn.
  private buildInstructionsFull(base: string, cwd: string, loaded: Set<string>, policy: SessionApprovalPolicy, sessionId: string): string {
    const tsEnabled = this.toolSearchEnabled(cwd);
    const deferThreshold = this.toolSearchThreshold(cwd);
    // Pins computed HERE, at instructionsFull's own once-per-turn/thread cadence (see this
    // method's callers — turn() and the spawn bridge each call it exactly once), NOT the
    // per-round cadence used at the specs()/executeCall seams below. `loaded` itself is never
    // mutated — pins are unioned into a NEW Set.
    const pins = tsEnabled ? this.pinnedTools(sessionId, { approvalPolicy: policy }, cwd) : new Set<string>();
    const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;
    const deferred = tsEnabled
      ? this.cfg.registry.deferredIndex(cwd, effectiveLoaded, deferThreshold, tsEnabled, this.toolSearchDeferExternals(cwd))
      : [];
    let instructionsFull = deferred.length
      ? base + "\n\n# Deferred tools\nThe following tools exist but their schemas are NOT loaded — calling them directly fails. Load schemas first with the ToolSearch tool (query \"select:<name>\" or keywords), then call them normally.\n" + deferred.map((d) => `- ${d.name} — ${d.description}`).join("\n")
      : base;
    if (policy === "plan") {
      instructionsFull += "\n\n# Plan mode\nYou are in plan mode: research and form a plan, but make NO changes — file edits, writes, and commands are disabled and will be blocked. Any clarifying question or choice you need from the user MUST go through the ask_user tool (structured options) — do not ask in prose and stop. When your plan is ready, call exit_plan_mode with the plan (markdown) to present it for approval. Only after approval will editing be enabled.";
    }
    return instructionsFull;
  }

  private async turn(sessionId: string, signal: AbortSignal): Promise<void> {
    const meta = this.cfg.store.meta(sessionId);
    const threadId = MAIN_THREAD;
    // Dispatch mode (Phase 7): the singleton coordinator session — meta.mode is set once at
    // createSession (Task 2) and never changes mid-session, so this is safe to read once per turn
    // like everything else built from `meta` below (sel.model, instructions, instructionsFull).
    const isDispatch = meta.mode === "dispatch";
    // Resolved ONCE per turn (spec: "changing models must NOT require a daemon restart") — a
    // settings.json edit mid-turn does not retroactively change THIS turn's model, only the
    // NEXT one's, mirroring how `instructions`/`instructionsFull` below are also computed once
    // per turn and not re-read mid-turn. Falls back to the boot-time `provider.model` when `live`
    // isn't wired (most test harnesses) — unchanged behavior for them.
    const sel = this.cfg.provider.live?.() ?? { model: this.cfg.provider.model };
    if (!meta.cwd) {
      this.emit(sessionId, { type: "turn_started", sessionId, threadId });
      this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: "session has no working directory — create the session with a cwd" });
      this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", inputTokens: 0, outputTokens: 0 });
      return;
    }
    // `let`, not `const`: the enter/exit_worktree bridge below reassigns this SAME-TURN so a
    // follow-up tool call later in this turn's dispatch loop resolves into (or back out of) the
    // worktree without waiting for the next turn's store.meta() re-read.
    let cwd = meta.cwd;
    // Trust-gated project .mcp.json bring-up, BEFORE the turn_started emit: this can spawn
    // subprocesses (slow), and a project server that's already started/recorded is a no-op, so
    // doing it here (rather than after turn_started) keeps the -p watchdog from tripping on a
    // slow first-turn project-server start. A failure here degrades to a turn with no project
    // tools rather than breaking the turn.
    try { await this.cfg.mcp?.ensureProject(cwd); } catch (e) { console.error("mcp ensureProject failed", e); }
    // Assembled ONCE per turn — not re-read per tool-round. Re-reading here would let a
    // same-turn tool write to <cwd>/NORMA.md (under `auto` policy) get injected as trusted
    // system instructions in a later round of the SAME turn. A NORMA.md change only takes
    // effect starting the NEXT turn.
    const instructions = this.cfg.assembler.assemble({
      cwd,
      loadedSkills: [...(this.loadedSkills.get(sessionId) ?? [])],
      basePromptOverride: isDispatch ? DISPATCH_SYSTEM_PROMPT : undefined,
      // Dreaming (Phase 7b): dispatch sessions load the shared `_assistant` memory bucket INSTEAD
      // of the cwd-resolved project MEMDIR (ContextAssembler's memoryBucket branch) — every other
      // caller keeps today's "project" behavior byte-for-byte.
      memoryBucket: isDispatch ? "assistant" : "project",
      // Output styles are main-conversation only. The dispatch COORDINATOR is already excluded by its
      // basePromptOverride above, but a dispatch CHILD (origin:"dispatch-child") runs mode:"code" with
      // the normal base and no override, so it would otherwise inherit the user's active style — e.g.
      // "learning" would leave TODO(human) gaps in autonomous work no human reviews. Exclude it here.
      skipOutputStyle: meta.origin === "dispatch-child",
    });
    // NOTE (correctness-critical): `loaded` MUST be THE ONE LIVE SET for this session — never a
    // snapshot/copy. It's read here to build specs()/deferredIndex() for round 0, and the SAME
    // object is handed to executeCall's ctx below; markToolLoaded (called by the ToolSearch tool)
    // mutates it in place. That's what makes a load in round 1 visible to round 2's specs() AND
    // to execute's defense-in-depth check, all within this one turn, without re-reading anything.
    if (!this.loadedTools.has(sessionId)) this.loadedTools.set(sessionId, new Set());
    const loaded = this.loadedTools.get(sessionId)!;
    const instructionsFull = this.buildInstructionsFull(instructions, cwd, loaded, meta.approvalPolicy, sessionId);
    // Auto-compact BEFORE historyInput is built, so a triggered compaction's checkpoint is
    // reflected in this turn's input. A compaction failure degrades to a normal (uncompacted)
    // turn rather than breaking it. Uses THIS turn's resolved model (sel.model), not the boot
    // snapshot — see contextWindow's doc comment.
    try { await this.maybeAutoCompact(sessionId, sel.model); } catch (e) { console.error("auto-compact failed", e); }
    const input = this.historyInput(sessionId);
    // Appended AFTER history (nearest the model's attention), BEFORE the tool loop starts — see
    // taskListReminder's doc comment for why this is transient (assembled input only, never a
    // persisted event) and why it's a "user" message rather than a new TurnInputItem role.
    const taskReminder = this.taskListReminder(sessionId);
    if (taskReminder) input.push(taskReminder);
    // Dispatch (Phase 7) Task 5: same assembled-input-only <system-reminder> user-message shape as
    // taskListReminder just above — non-undefined only for the live dispatch session (see
    // DispatchChildren.rosterFor), so every other session's input is unaffected.
    const dispatchRoster = this.cfg.dispatchRoster?.(sessionId);
    if (dispatchRoster) input.push({ type: "message", role: "user", content: dispatchRoster });
    // NOTE (bg-retrigger Task 1): the old per-turn bg-completion reminder call site lived here
    // (buildBgCompletionReminder) — retired. A detached child's completion is now PERSISTED as a
    // task_notification event at settle time (notifyBgCompletion, called from the detached
    // chain's .then/.catch) and replays via historyInput's eventToInput above like any message.

    // [4f session-start] Fire the session-start hook ONCE per sessionId per daemon process, at the
    // MAIN thread's turn start, BEFORE the first provider round (runThread) below — CC SessionStart
    // parity: the event exists to inject context. Marked started BEFORE the await so a concurrent
    // re-entry can't double-fire (runTurn already serializes turns per session anyway). Each `ok`
    // result with NON-EMPTY stdout becomes ONE <system-reminder> "user" message appended to THIS
    // turn's input — same assembled-input-only / never-persisted contract and same
    // sanitizeForReminder pass (newlines→spaces + literal </system-reminder>→[tag]) as
    // taskListReminder, so hook stdout can't inject a fake reminder block.
    // error/timeout results (F2 fail-open) and ok-with-empty-stdout inject nothing. extra: {cwd}.
    if (this.cfg.hooks && !this.hookSessionStarted.has(sessionId)) {
      this.hookSessionStarted.add(sessionId);
      const results = await this.cfg.hooks.runFor("session-start", { cwd }, sessionId, signal); // [4f I1] interrupt cuts the chain
      for (const { result } of results) {
        if (result.status === "ok" && result.stdout.trim().length > 0) {
          const content = "<system-reminder>\n"
            + this.sanitizeForReminder(result.stdout)
            + "\nThis reminder is invisible to the user — never mention it.\n</system-reminder>";
          input.push({ type: "message", role: "user", content });
        }
      }
    }

    await this.runThread({
      sessionId,
      threadId: MAIN_THREAD,
      instructionsFull,
      input,
      cwd,
      model: sel.model,
      reasoningEffort: sel.reasoningEffort,
      meta,
      depth: 0,
      signal,
      loaded,
      // Dispatch (Phase 7) Task 4: a dispatch session gets the allowTools whitelist (which already
      // includes session_spawn — dispatch-prompt.ts); a code session instead gets session_spawn
      // explicitly EXCLUDED (SESSION_SPAWN_TOOL's own doc comment above) — never both fields at
      // once (excludeTools would filter session_spawn OUT before allowTools ever got a chance to
      // filter it back IN, for a dispatch session that somehow had both set).
      ...(isDispatch ? { allowTools: DISPATCH_ALLOW_TOOLS } : { excludeTools: new Set([SESSION_SPAWN_TOOL]) }),
    });
  }

  /**
   * The tool-calling loop shared by the main turn (`turn()`, depth 0, threadId MAIN_THREAD) and
   * (later) sub-agent threads. Steer-queue draining only applies to the main thread — a child
   * thread has no steer queue of its own.
   */
  private async runThread(opts: {
    sessionId: string;
    threadId: string;
    instructionsFull: string;
    input: TurnInputItem[];
    cwd: string;
    model: string;
    // Per-turn resolved reasoning-effort (turn()'s sel.reasoningEffort), threaded straight into
    // the TurnRequest below. Subagents inherit the SAME effort as their parent thread (opts
    // .reasoningEffort's fallback in the spawn bridge) — no per-agent-def override, matching the
    // model-override precedence's own comment: agent defs get a model override but not an effort
    // one (spec: "do NOT add per-agent effort").
    reasoningEffort?: string;
    meta: ReturnType<SessionStore["meta"]>;
    depth: number;
    signal: AbortSignal;
    loaded: Set<string>;
    excludeTools?: Set<string>;
    allowTools?: Set<string>;
    // 4h-i (CC parity: Agent.max_turns): a per-thread override of MAX_TOOL_ITERATIONS. Only the
    // spawn bridge (below) ever passes this — main-thread callers (turn()) never set it, so the
    // main thread's bound is unchanged (MAX_TOOL_ITERATIONS, 24). A child's effective bound is
    // 1-50 (spawn.ts's zod range / the bridge's own clamp); omitted → the default 24. Note this
    // can go EITHER direction relative to the default — a child asking for max_turns > 24 (up to
    // 50) gets a LARGER cap than the main thread's default, not just a smaller one. Additive/sync
    // only: no new async surface, just a different bound for that one child thread's own loop.
    maxTurns?: number;
    // 4h-i Task 4 (CC parity: Agent.isolation "worktree"): a per-thread override of the allowed
    // fs-tool roots. Only the spawn bridge (below) ever passes this, and only for a child
    // spawned with `isolation:"worktree"` — set to EXACTLY `[worktreeDir]`, not an addition to
    // the session's own roots (this.cfg.dirs.roots(sessionId) is SESSION-scoped, keyed by
    // sessionId not threadId — widening it here would leak the worktree into the PARENT's own
    // roots too, and persist past the child's lifetime). Undefined (every other caller) means
    // executeCall falls back to the session's normal live roots, unchanged behavior. roots[0]
    // MUST be the primary cwd (registry.ts's own contract) — the spawn bridge sets this to
    // exactly `[childCwd]` where childCwd is also what's passed as this same call's `cwd`.
    rootsOverride?: string[];
    // No-timeout task: the spawn bridge's ONE progress chokepoint for the SubagentManager stall
    // watchdog (subagents.ts's own doc comment) — called once per provider event this thread's
    // own round-loop below receives (text_delta/tool_call/reasoning_item/usage/done/error alike),
    // so ANY streaming activity resets the child's stall timer, not just a subset. Only ever
    // supplied by the spawn bridge's sync/bg closures (their `run(fn)` callback receives it from
    // SubagentManager and threads it straight through here); the MAIN thread's own `turn()` call
    // never passes one, so this is a no-op there — byte-identical main-thread behavior.
    onProgress?: () => void;
  }): Promise<{ finalText: string; stopReason: "end_turn" | "aborted" | "error"; errorMessage?: string }> {
    const { sessionId, threadId, instructionsFull, input, meta, signal, loaded, excludeTools, allowTools, rootsOverride, onProgress } = opts;
    let cwd = opts.cwd;
    // Computer use (Phase 5 CU): whether THIS thread's resolved model accepts image input — the
    // `computer` tool's screenshot action refuses when this is explicitly false (ax_snapshot still
    // works). Undefined when the provider can't enumerate its models (openai-compatible with no
    // static list) → the tool treats undefined as "unknown, not blocked". Computed once per thread.
    const visionCapable = this.cfg.provider.provider.models().find((m) => m.id === opts.model)?.supportsVision;
    const tsEnabled = this.toolSearchEnabled(cwd);
    const deferThreshold = this.toolSearchThreshold(cwd);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let lastText = "";
    // The effective iteration bound for THIS thread — opts.maxTurns (spawn bridge only) or the
    // shared default. Computed once so the loop condition and the cap message below always agree
    // on the exact number.
    const effectiveMaxIterations = opts.maxTurns ?? MAX_TOOL_ITERATIONS;
    // 4h-i Task 3: the nesting-depth cap for THIS thread's own spawn attempts — see
    // EngineConfig.subagentMaxDepth's doc comment. Computed once so the spawn-gather filter below
    // and the belt-and-braces reject agree on the exact same number. hot-settings T2: getter
    // read fresh per thread — `?? 5` is the SAME default the pre-getter code applied.
    const maxDepth = this.cfg.subagentMaxDepth?.() ?? 5;
    // 4h-ii-b Task 4 (SM3): delete THIS child thread's steer queue when its runThread terminates,
    // so a send_message that landed but wasn't drained before the child finished can't resurface
    // when the SAME threadId is later resumed (resume reuses the threadId; its round-top drain
    // would otherwise pick up the stale entry). Called before EVERY terminal return below (the four
    // returns: error, end_turn/aborted, deniedByHuman, cap). NO-OP for MAIN — the main thread never
    // populates threadSteerQueue, so this leaves the byte-identical main path unchanged.
    const cleanupThreadSteer = () => { if (threadId !== MAIN_THREAD) this.threadSteerQueue.delete(threadId); };

    this.emit(sessionId, { type: "turn_started", sessionId, threadId });

    for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
      if (threadId === MAIN_THREAD) {
        const steers = this.steerQueue.get(sessionId);
        if (steers && steers.length) { for (const t of steers) input.push({ type: "message", role: "user", content: t }); steers.length = 0; }
      } else {
        // 4h-ii-b Task 4 (SM2): CHILD threads drain their OWN per-thread steer queue here — a
        // SEPARATE parallel branch to the MAIN branch above (which is untouched). A send_message to
        // this running child (sendToThread) queued into threadSteerQueue[threadId]; drain it into
        // this round's input exactly like the main loop drains steerQueue.
        // Whole-branch review C1/I1: PERSIST each drained message as a child user_message HERE, at
        // the drain — NOT at send time (sendToThread is queue-only now). The drain runs at the TOP of
        // a round: AFTER the prior round's tool_result was emitted+persisted (during that round's
        // dispatch), BEFORE the next provider call — so the persisted user_message gets a seq
        // strictly after the tool_result, never between a tool_call and its tool_result. That is
        // clean alternation on resume (childHistoryInput reconstructs [...tool_result, user], no
        // interior orphan function_call). A message that is never drained (child finishing before
        // this runs, I1) is simply never persisted → no trailing-user-turn corruption.
        const msgs = this.threadSteerQueue.get(threadId);
        if (msgs && msgs.length) {
          for (const t of msgs) {
            this.emit(sessionId, { type: "user_message", sessionId, threadId, text: t, clientName: "send_message" });
            input.push({ type: "message", role: "user", content: t });
          }
          msgs.length = 0;
        }
      }

      let textBuf = "";
      const calls: Extract<ProviderEvent, { type: "tool_call" }>[] = [];
      // history-parity Task 3: this round's opaque reasoning items, in provider emission order.
      // Prefixed ahead of the round's message/function_calls below, then cleared (must not leak
      // into the next round of the same turn). Empty when the provider emits none → the round's
      // input assembly is byte-identical to the pre-change behavior.
      const roundReasoning: string[] = [];
      let stop: "end_turn" | "tool_calls" | "aborted" | null = null;

      // Pins recomputed EVERY round (unlike buildInstructionsFull's once-per-thread read above) —
      // a mid-turn state change (plan approved, worktree entered/exited via the same-turn
      // bridges, a bg task started/exited) must be visible to the VERY NEXT round's specs() AND
      // to that round's tool-call dispatch below, not just the next turn. `loaded` is NEVER
      // mutated here — see the loadedTools NOTE above. Reused for every executeCall/
      // requestApproval invocation triggered by THIS round's calls, further down.
      const pins = tsEnabled ? this.pinnedTools(sessionId, meta, cwd) : new Set<string>();
      const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;

      for await (const ev of this.cfg.provider.provider.streamTurn({
        model: opts.model,
        instructions: instructionsFull,
        input,
        tools: this.cfg.registry.specs(cwd, tsEnabled
            ? { loaded: effectiveLoaded, deferThreshold, builtinDeferral: true, deferExternals: this.toolSearchDeferExternals(cwd) }
            : undefined)
          .filter((s) => !excludeTools?.has(s.name))
          .filter((s) => !allowTools || allowTools.has(s.name)),
        signal,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      })) {
        // No-timeout task: ONE chokepoint — every provider event this thread receives, of any
        // kind, resets the SubagentManager stall watchdog for a child thread (a no-op for the
        // main thread, which never supplies onProgress). Deliberately unconditional (fires for
        // text_delta/tool_call/reasoning_item/usage/done/error alike) — see onProgress's own doc
        // comment on why "any streaming activity" is the right chokepoint, not a subset.
        onProgress?.();
        if (ev.type === "text_delta") {
          textBuf += ev.delta;
          // TRANSIENT streaming event: broadcast to attached harnesses, never persisted (spec 2a).
          if (ev.delta.length > 0) this.cfg.hub.broadcastTransient(sessionId, { type: "assistant_delta", sessionId, threadId, delta: ev.delta });
        }
        else if (ev.type === "tool_call") calls.push(ev);
        else if (ev.type === "reasoning_item") {
          roundReasoning.push(ev.itemJson);
          // Persist AT ARRIVAL so seq order = provider emission order (the replay-order invariant,
          // spec §B4/§B6). itemJson is sensitive-opaque: this append is its only sink — never log it.
          this.emit(sessionId, { type: "reasoning_item", sessionId, threadId, itemJson: ev.itemJson });
        }
        else if (ev.type === "usage") { usage.inputTokens += ev.inputTokens; usage.outputTokens += ev.outputTokens; }
        else if (ev.type === "done") stop = ev.stopReason;
        else if (ev.type === "error") {
          // Phase 5 routines T3: forward the provider's structured error code (ProviderEvent's
          // "auth"|"rate_limit"|"server"|"network"|"bad_request" — providers/types.ts) as the
          // additive-optional `agent_error.code` field, so a consumer (routines/runner.ts's quota
          // detection) can check `code === "rate_limit"` instead of string-matching `message`.
          this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: ev.message, code: ev.code });
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
          if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "error", usage); // [4f turn-end] provider-error terminal
          // `errorMessage` is consumed ONLY by the spawn bridge below (a CHILD thread's failure
          // must surface through the parent's tool_result — the agent_error/turn_completed events
          // just emitted are invisible to the parent model, which only sees the child's return
          // value). Main-thread callers (turn(), which just `await`s runThread without touching
          // the return value) are unaffected — see the grep note in the 4e-fix3 report.
          cleanupThreadSteer();
          return { finalText: lastText, stopReason: "error", errorMessage: ev.message };
        }
      }

      // Emission-order replay (spec §B4): reasoning items precede the round's message/function_calls.
      // Simplification, documented: all of a round's reasoning items are prefixed as a block in
      // arrival order (the Responses API emits reasoning before the items it reasons for — codex
      // report §13.1; a hypothetical mid-batch reasoning item would be hoisted to the block, never
      // dropped/reordered relative to other reasoning items). Empty roundReasoning → no-op, so the
      // no-reasoning path (every non-reasoning provider) is byte-identical to before.
      for (const r of roundReasoning) input.push({ type: "reasoning", itemJson: r });
      roundReasoning.length = 0;

      if (textBuf.length > 0) {
        this.emit(sessionId, { type: "assistant_message", sessionId, threadId, text: textBuf });
        input.push({ type: "message", role: "assistant", content: textBuf });
        lastText = textBuf;
      }

      if (stop !== "tool_calls" || calls.length === 0) {
        // A steer/message landed as we finished → drain at next iteration top, keep going. But an
        // interrupt must win: an aborted turn ends now with turn_completed(aborted) even if one is
        // queued (it stays queued for the next runTurn, e.g. via steer()'s own restart). 4h-ii-b
        // Task 4 (SM3): GENERALIZED from MAIN-only to also continue a CHILD when a send_message
        // landed as it finished (else a message sent while the child is on its final round would be
        // silently dropped) — `pending` reads the MAIN steerQueue for the main thread and this
        // child's threadSteerQueue for a child. For the MAIN thread this is byte-identical to the
        // prior `if (threadId === MAIN_THREAD) { const pending = steerQueue.get(sessionId); ... }`.
        const pending = threadId === MAIN_THREAD ? this.steerQueue.get(sessionId) : this.threadSteerQueue.get(threadId);
        if (stop !== "aborted" && pending && pending.length) { continue; }
        cleanupThreadSteer();
        this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: stop === "aborted" ? "aborted" : "end_turn", ...usage });
        if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, stop === "aborted" ? "aborted" : "end_turn", usage); // [4f turn-end] end_turn/aborted terminal
        if (opts.depth === 0 && this.cfg.titler) void this.cfg.titler.maybeTitle(sessionId);
        return { finalText: lastText, stopReason: stop === "aborted" ? "aborted" : "end_turn" };
      }

      // spawn_agent calls in this round run CONCURRENTLY (parallel subagent fan-out), computed
      // BEFORE the per-call loop below so N spawns in one assistant message don't serialize —
      // each child runs its own full runThread() to completion via SubagentManager.run (which
      // enforces maxConcurrent + a timeout), and the collected outcomes are consumed by the loop
      // below in the model's ORIGINAL call order (a plain Map keyed by callId, not the resolution
      // order of Promise.all). Only active when both cfg.subagents and cfg.agents are wired
      // (daemon.ts) AND this is a depth-0 thread — a depth>0 (child) thread trying to spawn is
      // denied in the loop below instead (belt-and-braces: its own specs already exclude
      // spawn_agent via excludeTools, so this only matters if a provider ignores that). 4h-i Task
      // 3: "depth-0 thread" generalizes to "depth < maxDepth" — any thread below the configured
      // nesting cap (not just the main thread) gathers its own spawn_agent calls through this SAME
      // bridge, recursively, so a depth-1 child can itself spawn a depth-2 grandchild when
      // maxDepth allows it.
      const spawnOutcomes = new Map<string, { output: string; isError: boolean }>();
      // Task 9 (dispatch integration test) ordering fix: a session_spawn call's `child_update`
      // ("running") used to be appended to the dispatch stream INSIDE DispatchChildren.spawnChild
      // itself — which runs synchronously in the sessionSpawnCalls loop below, BEFORE this round's
      // tool_call/tool_result for that very call are emitted (the per-call loop further down is
      // what emits those). That left the dispatch stream reading child_update(running) BEFORE the
      // tool_call that caused it — backwards for any client rendering the conversation in order.
      // Fix: spawnChild no longer appends that event itself; a successful spawn's childId is
      // recorded here instead, and the per-call loop's `preOutcome` branch calls
      // `dispatchReg.announceChild(childId)` right after emitting THIS call's own tool_result —
      // giving tool_call → tool_result → child_update(running), the order a coordinator's own
      // actions actually happened in.
      const spawnedChildIds = new Map<string, string>();
      // [4f] callIds a pre-tool BLOCK short-circuited this round (Site 1 for bridged spawn_agent/
      // send_message, Site 2 for normal calls). Consulted by firePostTool so a blocked call — which
      // NEVER ran — gets no post-tool observe. Round-scoped (a fresh Set per provider round).
      const hookBlockedCallIds = new Set<string>();
      const spawnCalls = this.cfg.subagents && this.cfg.agents && opts.depth < maxDepth
        ? calls.filter((c) => c.name === "spawn_agent")
        : [];
      // 4h-ii-b Task 4 (SM1 + SM6, CC SendMessage): message a subagent by agentId/name. DEPTH-0
      // ONLY — only the main thread orchestrates in v1 (no agent-to-agent messaging), belt-and-
      // braces with send_message's unconditional exclusion from every child's tool set below.
      // Precomputed here (like spawnOutcomes) and consumed by the per-call dispatch loop below as a
      // send_message call's tool_result, so it never falls through to executeCall. Processed in a
      // simple `for` loop (not Promise.all): a running-target delivery is sync (sendToThread), a
      // finished-target resume is async (awaited), and there's no benefit to parallelizing them.
      const sendMessageOutcomes = new Map<string, { output: string; isError: boolean }>();
      const sendMessageCalls = opts.depth === 0 ? calls.filter((c) => c.name === "send_message") : [];
      // Dispatch (Phase 7) Task 4: session_spawn calls in the DISPATCH session's main thread spawn
      // full first-class CHILD SESSIONS (DispatchChildren.spawnChild) — a completely separate
      // session with its own turn()/transcript, not a subagent THREAD nested under this one
      // (spawn_agent's mechanism above). Reuses the SAME `spawnOutcomes` map + the per-call loop's
      // call-order consumption the spawn_agent bridge already established (that loop's
      // `preOutcome = spawnOutcomes.get(call.callId) ?? sendMessageOutcomes.get(call.callId)`
      // check doesn't care WHICH bridge populated the entry) — so a session_spawn callId rides the
      // identical "never reaches executeCall" exclusion spawn_agent callIds already get, with NO
      // parallel outcome map / skip-set of its own. Only active for the MAIN thread of a
      // dispatch-mode session (meta.mode === "dispatch") AND when daemon.ts has wired a
      // DispatchChildren registry (cfg.dispatch?.()) — absent either condition, session_spawn
      // calls fall through to the per-call loop below and hit the tool's own placeholder run()
      // (session-spawn.ts). A plain `for` loop, not Promise.all (spawn_agent's shape above): each
      // spawnChild() call is fully synchronous (store.createSession/hub.append are sync bun:sqlite
      // + sync fs appends; only the child's OWN turn is fire-and-forget), so there is no
      // concurrency to gain from parallelizing N session_spawn calls in one round.
      const dispatchReg = meta.mode === "dispatch" ? this.cfg.dispatch?.() : undefined;
      const sessionSpawnCalls = dispatchReg ? calls.filter((c) => c.name === "session_spawn") : [];
      if (sessionSpawnCalls.length > 0) {
        for (const call of sessionSpawnCalls) {
          let parsed: { dir?: unknown; prompt?: unknown; model?: unknown; type?: unknown; title?: unknown } = {};
          try { parsed = JSON.parse(call.argsJson || "{}"); } catch { /* rejected below — empty dir/prompt */ }
          const dir = typeof parsed.dir === "string" ? parsed.dir : "";
          const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
          const type = typeof parsed.type === "string" ? parsed.type : "code";
          const title = typeof parsed.title === "string" && parsed.title.trim().length > 0
            ? parsed.title.trim() : prompt.slice(0, 60);
          // Pre-flight rejections, ALL as isError tool_results, BEFORE any session is created —
          // same ordering discipline as spawn_agent's own pre-thread_started checks above (a
          // rejected call must leave no trace: no child session, no user_message, no
          // child_update). Order: type, then dir shape, then prompt presence, then model.
          if (type === "cowork") {
            spawnOutcomes.set(call.callId, { output: "type 'cowork' is not yet available — use 'code'.", isError: true });
            continue;
          }
          if (!dir.startsWith("/") || dir === "/") {
            spawnOutcomes.set(call.callId, { output: "dir must be an absolute directory path (not '/').", isError: true });
            continue;
          }
          if (!prompt) {
            spawnOutcomes.set(call.callId, { output: "prompt is required — write the child a complete, self-contained task.", isError: true });
            continue;
          }
          // Model override (v1, decision documented in the task-4 report): turn() resolves
          // `sel.model` ONCE per turn, GLOBALLY, off cfg.provider.live?.() — there is no
          // per-session model column (SessionRow, sessions/store.ts) and thus no seam to pin a
          // model to a specific child session the way spawn_agent pins one to a THREAD via
          // `resumeCtx.model`/the runThread `model` arg. So a validated override rides as a
          // `[model: <id>]` trailer on the child's FIRST user_message instead (folded into
          // `childPrompt` below, before spawnChild ever sees it) — and the tool_result says so, so
          // the coordinator knows the mechanism rather than assuming a silent, precise override.
          let effectiveOverride = typeof parsed.model === "string" ? parsed.model : undefined;
          if (effectiveOverride !== undefined) {
            const known = this.cfg.provider.provider.models();
            // Same alias resolution as the spawn_agent bridge above (resolveModelAlias) — daemon.ts
            // wires registerSessionSpawnTool with the SAME `[...knownModelIds, ...deriveModelAliases(...)]`
            // list spawn_agent gets, so an alias offered in the tool's own schema enum must resolve
            // here too, or a caller using the advertised alias would be wrongly rejected as unknown.
            if (known.length > 0) effectiveOverride = resolveModelAlias(effectiveOverride, known.map((m) => m.id));
            if (known.length > 0 && !known.some((m) => m.id === effectiveOverride)) {
              spawnOutcomes.set(call.callId, {
                output: `unknown model '${effectiveOverride}' — available models: ${known.map((m) => m.id).join(", ")}; omit \`model\` to inherit the default model`,
                isError: true,
              });
              continue;
            }
          }
          const childPrompt = effectiveOverride ? `${prompt}\n\n[model: ${effectiveOverride}]` : prompt;
          // Non-null: sessionSpawnCalls (and thus this loop) is only ever non-empty when
          // dispatchReg was truthy at the ternary above that derived it from the SAME expression.
          const childId = dispatchReg!.spawnChild({ dispatchSessionId: sessionId, dir, prompt: childPrompt, title });
          spawnedChildIds.set(call.callId, childId); // announced AFTER this call's own tool_result — see doc comment above
          const modelNote = effectiveOverride
            ? ` (model override '${effectiveOverride}' noted in the child's opening prompt — no per-session model override exists yet)`
            : "";
          spawnOutcomes.set(call.callId, {
            output: `spawned session ${childId} ("${title}") in ${dir}${modelNote} — you'll get a child_update when it finishes.`,
            isError: false,
          });
        }
      }
      if (spawnCalls.length > 0) {
        await Promise.all(spawnCalls.map(async (call) => {
          // [4f pre-tool — Site 1 (bridged)] FIRST statement in the callback, before ANY spawn work
          // (no thread_started/register/subagents.run yet). spawn_agent is bridge-intercepted, so it
          // hits the per-call loop's `preOutcome` branch and `continue`s BEFORE Site 2 — meaning
          // Site 2 never fires for it. Firing here is the ONLY pre-tool for this callId (no-double-
          // fire). F1: spawn_agent is READ_ONLY (no approval gate to run "after"), so its effect
          // boundary IS the gate boundary. A BLOCK sets this call's spawnOutcomes entry to the block
          // tool_result and returns — no thread_started ever emits.
          if (this.cfg.hooks) {
            const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
            const blocked = results.find((r) => r.result.status === "blocked");
            if (blocked) { spawnOutcomes.set(call.callId, this.hookBlockOutcome(blocked)); hookBlockedCallIds.add(call.callId); return; }
          }
          let parsed: { prompt?: unknown; agentType?: unknown; model?: unknown; description?: unknown; max_turns?: unknown; mode?: unknown; isolation?: unknown; run_in_background?: unknown; name?: unknown; resume?: unknown } = {};
          try { parsed = JSON.parse(call.argsJson || "{}"); } catch { /* defensive: empty prompt below */ }
          const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
          const agentType = typeof parsed.agentType === "string" ? parsed.agentType : undefined;
          const modelOverride = typeof parsed.model === "string" ? parsed.model : undefined;
          const description = typeof parsed.description === "string" ? parsed.description : undefined;
          // 4h-ii-b Task 2 (CC parity: stable per-session handle for resume/send_message) — same
          // hand-parse-before-zod reasoning as model/description/mode/isolation/run_in_background
          // above: only a string is recognized; anything else (wrong type, absent) → undefined,
          // same as omitting the arg entirely (the child is addressable by agentId only, today's
          // unchanged behavior).
          const spawnName = typeof parsed.name === "string" ? parsed.name : undefined;
          // 4h-ii-b Task 3 (CC parity: resume a finished agent) — same hand-parse-before-zod
          // reasoning as name/model/mode above: only a non-empty string is recognized (an agentId
          // or a `name` to resume); anything else → undefined, i.e. today's fresh-spawn path.
          const resumeArg = typeof parsed.resume === "string" && parsed.resume.length > 0 ? parsed.resume : undefined;
          // 4h-i (CC parity: Agent.max_turns): this bridge hand-parses raw argsJson BEFORE
          // spawn.ts's own zod validation would ever run (same reason model/description are
          // hand-checked above), so a provider that ignores the declared `.int().positive().max(50)`
          // schema could still send an out-of-range or non-integer value through — clamp
          // defensively here rather than trusting the schema. Non-finite/non-integer/non-positive
          // → ignored (undefined), same as omitting the arg (falls back to MAX_TOOL_ITERATIONS).
          const maxTurns = typeof parsed.max_turns === "number" && Number.isInteger(parsed.max_turns) && parsed.max_turns > 0
            ? Math.min(parsed.max_turns, 50)
            : undefined;
          // 4h-i (CC parity: spawn_agent `mode`) — same hand-parse-before-zod reasoning as
          // max_turns/model/description above: only accept one of the 5 known mode strings;
          // anything else (wrong type, typo, provider hallucination) → undefined, same as omitting
          // the arg entirely (no override, child inherits the parent's policy). mapSpawnMode below
          // further narrows "default"/unrecognized to "no override" too.
          const modeRaw = typeof parsed.mode === "string" ? parsed.mode : undefined;
          // RESTRICT-ONLY (the security-critical bit — see restrictPolicy's own doc comment):
          // requestedPolicy is undefined when there's nothing to apply (mode absent/"default"/
          // unrecognized) — in that case childPolicy is EXACTLY meta.approvalPolicy (the parent's),
          // so childMeta below stays the SAME object as `meta`, byte-identical to pre-4h-i
          // behavior. When a mode DOES map to a policy, restrictPolicy takes the more restrictive
          // of {parent, requested} — a request that would WIDEN the child's permissions relative to
          // the parent (e.g. parent "ask" + requested "auto"/bypassPermissions) is silently denied
          // and the parent's policy wins; only a NARROWING request actually changes childPolicy.
          const requestedPolicy = mapSpawnMode(modeRaw);
          const childPolicy = requestedPolicy !== undefined ? restrictPolicy(meta.approvalPolicy, requestedPolicy) : meta.approvalPolicy;
          // 4h-i Task 4 (CC parity: Agent.isolation "worktree") — same hand-parse-before-zod
          // reasoning as mode/max_turns/model/description above: only the literal "worktree" is
          // recognized; anything else (wrong type, typo, provider hallucination) → false, same as
          // omitting the arg entirely (no isolation, child runs in the parent's own cwd — today's
          // unchanged behavior).
          const wantsWorktreeIsolation = parsed.isolation === "worktree";
          // 5a (USER pin: background children, CC parity): at depth 0 with a registry wired, omitted now
          // means DETACHED — `false` opts into the synchronous await. Depth>0 and registry-less sessions
          // keep the sync default (children need their delegate's answer in-report; notifications are
          // main-thread-only; an omitted flag must never hit the "not available" typed error).
          const bgDefault = opts.depth === 0 && !!this.cfg.bgAgents;
          const runInBackground = bgDefault ? parsed.run_in_background !== false : parsed.run_in_background === true;
          // 4h-ii-b Task 3 (D7): a resume takes over the WHOLE callback for this call — it sits
          // EARLY, before any fresh-spawn machinery (childId gen, description/model checks,
          // worktree, register). resumeThread does its own typed-error guards (no prompt / unknown
          // / still-running) BEFORE any thread_started re-emit or store write, and drives the
          // resumed run through the SAME sync/bg fork the fresh path uses. `threadId` is the
          // RESUMING thread (this callback's own thread) — it becomes the re-emitted child's
          // parentThreadId (D2).
          if (resumeArg !== undefined) {
            spawnOutcomes.set(call.callId, await this.resumeThread({
              sessionId,
              resumeArg,
              prompt,
              runInBackground,
              meta,
              model: opts.model,
              reasoningEffort: opts.reasoningEffort,
              depth: opts.depth,
              parentThreadId: threadId,
              parentSignal: signal, // ESC cascade for a SYNC resume (no-timeout task) — see resumeThread's args doc
            }));
            return;
          }
          // Child-scoped meta: a shallow copy ONLY when childPolicy actually narrows (differs from
          // the parent's) — never mutate the shared `meta` object itself (that object is the SAME
          // one `turn()`'s dispatch loop uses for the REST of the parent's turn; mutating
          // `meta.approvalPolicy` here would corrupt the parent's own policy for later tool calls
          // in this same turn, and this bridge runs N spawns concurrently via Promise.all — a
          // second spawn's read of `meta.approvalPolicy` must never see a first spawn's override).
          // When childPolicy === meta.approvalPolicy (no mode, or an escalation request that was
          // denied), childMeta IS `meta` — the identical object, not just an equal-valued copy.
          const childMeta = childPolicy !== meta.approvalPolicy ? { ...meta, approvalPolicy: childPolicy } : meta;

          // 4g-ii (CC parity): spawn_agent's `description` is now a REQUIRED arg (spawn.ts's own
          // zod schema enforces this — but this concurrent bridge hand-parses call.argsJson and
          // short-circuits BEFORE executeCall's registry.execute() ever runs its zod validation,
          // same reason the model-override check below can't rely on the schema either. Must be
          // checked BEFORE thread_started/registerThread/subagents.run, mirroring the model-
          // override early-return just below. Message format matches registry.execute()'s own
          // "invalid arguments for X: field" wording for a consistent typed-error shape. No
          // `.trim()` here — matches spawn.ts's `z.string().min(1)` exactly (a whitespace-only
          // description satisfies min(1) too), so both paths agree on what counts as "present".
          if (!description) {
            spawnOutcomes.set(call.callId, { output: `invalid arguments for spawn_agent: description`, isError: true });
            return; // no thread_started, no thread registry entry, no subagents.run slot
          }

          const def = this.cfg.agents!.resolve(agentType, opts.cwd);

          // Defect 1 (4e gate F9): validate an EXPLICIT model override — modelOverride (the
          // calling model's own tool arg) or def.model (an agent-def's configured override), NOT
          // opts.model, which is the inherited parent-thread model and is already
          // resolver-validated (turn()'s sel.model / manager.ts's liveModel) — BEFORE emitting
          // thread_started or registering the thread. A provider whose models() enumerates a
          // known set (codex-oauth: the gpt-5.6 trio) rejects an override outside that set as a
          // typed error tool_result, so a hallucinated model id (e.g. "gpt-5-mini") fails fast
          // instead of spawning a child whose provider call 404s. A provider with an EMPTY
          // models() (openai-compatible with no static `models` configured, i.e. an arbitrary
          // endpoint the provider can't enumerate) can't validate anything, so the override
          // passes through unchanged — same as before this fix.
          let effectiveOverride = modelOverride ?? def.model;
          if (effectiveOverride !== undefined) {
            const known = this.cfg.provider.provider.models();
            // Short model aliases (CC parity, model-aliases.ts): "sol"/"terra"/"luna" resolve to
            // the unique known id ending "-<alias>" (e.g. "gpt-5.6-sol") BEFORE the unknown-model
            // check below — an unresolvable alias (ambiguous or no match) is returned unchanged, so
            // it falls straight into that SAME existing error path, unchanged.
            if (known.length > 0) effectiveOverride = resolveModelAlias(effectiveOverride, known.map((m) => m.id));
            if (known.length > 0 && !known.some((m) => m.id === effectiveOverride)) {
              const ids = known.map((m) => m.id).join(", ");
              spawnOutcomes.set(call.callId, {
                output: `unknown model '${effectiveOverride}' — available models: ${ids}; omit \`model\` to inherit the session's model`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }

          // 4h-ii-a (CC parity: Agent.run_in_background) — a bg spawn needs somewhere to land its
          // detached state; if the registry was never wired (daemon.ts) this fails as a typed
          // error BEFORE thread_started/registerThread/subagents.run, same reason the checks above
          // do — a caller must never get a `{agentId,status:"running"}` tool_result for a child
          // nothing is actually tracking (no way to observe completion, no `stop()` target).
          if (runInBackground && !this.cfg.bgAgents) {
            spawnOutcomes.set(call.callId, {
              output: `run_in_background is not available in this session`,
              isError: true,
            });
            return; // no thread_started, no thread registry entry, no subagents.run slot
          }

          // 4h-ii-b Task 2 (CC parity: stable per-session handle for resume/send_message,
          // Tasks 3-4) — a `name` colliding with an EXISTING agent in this session must fail the
          // spawn BEFORE thread_started/registerThread/subagents.run, same reason the
          // description/model/run_in_background checks above do: a caller must never get a ghost
          // thread for a name that `registry.get` would just resolve to the OTHER agent. The
          // message is byte-identical to what BackgroundAgentRegistry.register() itself produces
          // on the same collision (bg-agent-registry.ts) so both paths agree. This is only a
          // PRE-check for the common case — a name already registered from a prior spawn/turn; it
          // cannot see two sibling spawns in the SAME batch reusing one name (neither has
          // registered yet when this runs) — register()'s own collision result (surfaced at the
          // bg register() call below) is the backstop for that rare edge, unchanged.
          if (spawnName) {
            const existing = this.cfg.bgAgents?.get(spawnName, sessionId);
            if (existing) {
              spawnOutcomes.set(call.callId, {
                output: `name '${spawnName}' already in use by agent ${existing.agentId}`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }

          // 4h-i Task 4 (CC parity: Agent.isolation "worktree") — create the child's isolation
          // worktree BEFORE thread_started/registerThread/subagents.run, same as the
          // description/model checks above: a create failure (no git repo, or
          // WorktreeManager not wired into this session) must fail the spawn as a typed
          // isError tool_result with NO ghost thread, never a half-spawned child.
          // `createDetached` is a STATELESS WorktreeManager method (worktree.ts) — it does NOT
          // touch the per-session `sessions` map that enter_worktree/exit_worktree use, so a
          // child's ephemeral isolation worktree can never collide with (or be silently torn
          // down by) this session's own concurrent enter_worktree/exit_worktree state. Base off
          // opts.cwd (THIS spawning thread's own cwd — for a depth>0 spawner that is itself an
          // isolated child, that's already its own worktree dir, so a grandchild's isolation
          // worktree nests off the child's, not the top-level session repo).
          let isolatedWorktree: { dir: string; branch: string } | undefined;
          if (wantsWorktreeIsolation) {
            if (!this.cfg.worktrees) {
              spawnOutcomes.set(call.callId, {
                output: `isolation:"worktree" is not available in this session`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
            try {
              isolatedWorktree = this.cfg.worktrees.createDetached(opts.cwd, `spawn-${randomUUID().slice(0, 8)}`);
            } catch (err) {
              spawnOutcomes.set(call.callId, {
                output: `isolation:"worktree" requires a git repository (${err instanceof Error ? err.message : String(err)})`,
                isError: true,
              });
              return; // no thread_started, no thread registry entry, no subagents.run slot
            }
          }
          // The child's own cwd: the fresh worktree dir when isolated, otherwise unchanged
          // (opts.cwd, today's behavior). This is what the child's runThread actually runs at
          // AND what buildInstructionsFull below resolves project context relative to.
          const childCwd = isolatedWorktree?.dir ?? opts.cwd;

          const childId = "th_" + randomUUID().slice(0, 8);
          // Subagent transcript surfacing (captureSubagentTranscript, above): registerThread now
          // runs BEFORE the thread_started emit (swapped from the original order) so that emit's
          // registry-membership check already sees `childId` as registered the instant
          // thread_started fires — making thread_started itself the FIRST event the transcript
          // writer ever sees for this thread, which is what lets it derive the synthetic
          // spawn_prompt line directly from that event. Nothing between the two statements reads
          // `this.threads`, so this reorder has no other observable effect.
          this.registerThread(sessionId, {
            threadId: childId, parentThreadId: threadId, agentType: agentType ?? "general-purpose", status: "running",
          });
          this.emit(sessionId, {
            type: "thread_started", sessionId, threadId: childId, parentThreadId: threadId,
            agentType: agentType ?? "general-purpose", prompt, description,
          });
          // 4h-i Task 3: spawn_agent is excluded from the child's own specs ONLY when the child
          // itself sits AT (or past) the nesting cap — i.e. it has no room left to spawn a
          // grandchild. `childDepth < maxDepth` keeps spawn_agent visible so the child can spawn
          // one more level (recursing into this SAME bridge, via its own runThread call, with the
          // gate-1 spawnCalls filter above reading ITS OWN opts.depth). ask_user/exit_plan_mode/
          // enter_plan_mode stay excluded from every child regardless of depth (unchanged).
          // 4h-ii-b Task 4 (SM6): send_message is excluded from EVERY child UNCONDITIONALLY (not
          // depth-conditional like spawn_agent) — v1 has no agent-to-agent messaging; only the main
          // thread orchestrates. Belt-and-braces with the bridge's own `opts.depth === 0` gate on
          // sendMessageCalls above. Captured into resumeCtx.excludeTools below, so a resumed child
          // stays excluded too.
          // 4h-ii-c Task 2: task_stop is excluded from EVERY child UNCONDITIONALLY too, same
          // rationale — v1 depth-0-only: a child must not be able to kill its siblings' or its
          // parent's OWN background agents/tasks, only the main thread orchestrates.
          // phase 5a Task 1: agent_list/agent_output are excluded from EVERY child for the SAME
          // depth-0-only reason — a child must not enumerate or read its siblings'/parent's OWN
          // background agents, only the main thread orchestrates.
          // phase 5c Task 2: skill_write is excluded from EVERY child UNCONDITIONALLY — consent
          // laundering: skill_write's whole gate posture is ALWAYS_ASK (a card the human sees on
          // every call, gate.ts), but a child's approval requests surface through the PARENT's
          // queue, where a background child pushing standing-instruction cards is exactly the
          // durable-prompt-injection path the card exists to guard — the human would be approving
          // a persistent skill mid-stream of some other task's card traffic. Only the main thread,
          // where the card appears in direct response to the conversation, may author skills.
          // Dispatch (Phase 7) Task 4: session_spawn is excluded from EVERY spawn_agent child
          // UNCONDITIONALLY too (SESSION_SPAWN_TOOL's own doc comment above) — a spawn_agent
          // child only ever exists inside a CODE session (dispatch sessions can't spawn_agent at
          // all — it's not in DISPATCH_ALLOW_TOOLS), so this is tool-list hygiene consistent with
          // the main thread's own exclusion, not a new authorization boundary (the bridge's
          // `meta.mode === "dispatch"` gate above already denies it functionally either way).
          const childDepth = opts.depth + 1;
          const childExcludeTools = new Set(["ask_user", "exit_plan_mode", "enter_plan_mode", "send_message", "task_stop", "agent_list", "agent_output", "skill_write", SESSION_SPAWN_TOOL]);
          if (childDepth >= maxDepth) childExcludeTools.add("spawn_agent");
          // 4h-ii-b Task 1: instructionsFull is computed ONCE here — hoisted out of the bg and
          // sync closures below, which used to each build their own copy independently — so it
          // can be captured into `resumeCtx` just below AND reused by both closures without
          // recomputing. Every input (def.instructions, childCwd, a fresh childLoaded Set,
          // childPolicy, sessionId) is already known at this point in the bridge either way, so
          // this is purely a hoist: same value, computed earlier, not a behavior change.
          const childLoaded = new Set<string>();
          const instructionsFull = this.buildInstructionsFull(def.instructions, childCwd, childLoaded, childPolicy, sessionId);
          // 4h-ii-b Task 1: everything a future `resume` (Task 3) needs to re-run THIS child
          // EXCEPT input/signal — captured now, at spawn time, from the exact values this bridge
          // already computed to start the child's own live run below. Stored on the registry
          // entry regardless of run_in_background — BOTH the bg and sync paths register with this
          // SAME context (see each path's own register() call just below).
          const resumeCtx: ResumeContext = {
            agentType: agentType ?? "general-purpose",
            cwd: childCwd,
            roots: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
            approvalPolicy: childPolicy,
            model: effectiveOverride ?? opts.model,
            instructions: instructionsFull,
            maxTurns,
            // 4h-ii-b Task 3 (D5): capture-at-spawn, don't re-derive-at-resume. `openingPrompt` is
            // the child's original prompt (never persisted as a child event — the fresh run passes
            // it straight into `input` below), so resume must prepend it by hand. `loaded` is
            // snapshotted here (right after buildInstructionsFull, which does NOT mutate
            // childLoaded — so it's [] at a normal spawn); a resumed run re-derives deferral from
            // scratch rather than inheriting the child's later in-run ToolSearch loads. depth/
            // excludeTools/allowTools are the exact runThread args this spawn computed, arrayified.
            openingPrompt: prompt,
            description,
            depth: childDepth,
            loaded: Array.from(childLoaded),
            excludeTools: Array.from(childExcludeTools),
            allowTools: def.allowTools ? Array.from(def.allowTools) : undefined,
          };
          // 4h-ii-a (CC parity: Agent.run_in_background): the async/detached path — starts the
          // child through the SAME SubagentManager slot (concurrency-limited) + depth cap as the
          // synchronous path below, but does NOT await it. `entryAbort` is THIS bg entry's own
          // controller (bg-agent-registry.ts's `stop()` fires it) — the child's own runThread
          // signal is `AbortSignal.any([childSignal, entryAbort.signal])`. 4h-ii-c: this call's own
          // `subagents.run` now passes `timeoutMs: null` (below), so `childSignal` itself never
          // aborts on a clock anymore — `entryAbort` (a future task_stop) is this detached child's
          // ONLY kill mechanism. This call's tool_result is set SYNCHRONOUSLY, right here, before
          // any of the child's own work has run — Promise.all resolves as soon as this closure
          // returns, without waiting on the detached chain below.
          if (runInBackground) {
            const entryAbort = new AbortController();
            const registered = this.cfg.bgAgents!.register({
              agentId: childId,
              sessionId,
              threadId: childId,
              // `name` (4h-ii-b Task 2): the caller's own stable per-session handle (spawn.ts's
              // `name` arg) — undefined when omitted, unchanged register() behavior.
              name: spawnName,
              abort: entryAbort,
              resume: resumeCtx,
            });
            if (!registered.ok) {
              // childId itself can't collide (a fresh randomUUID), so this can only ever be a
              // NAME collision — the pre-check above already rejects the common case (a name
              // already registered from a prior spawn/turn) before thread_started even fires, so
              // this is the backstop for the one thing the pre-check can't see: two sibling
              // spawns in the SAME batch reusing one name (neither had registered yet when the
              // pre-check ran for either). thread_started already fired above for THIS call, so
              // this must still complete that thread entry rather than leaving a ghost "running" thread.
              this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason: "error" });
              this.completeThread(sessionId, childId, "error");
              spawnOutcomes.set(call.callId, { output: registered.error, isError: true });
              return;
            }
            void this.cfg.subagents!.run(async (childSignal, progress) => {
              return this.runThread({
                sessionId,
                threadId: childId,
                instructionsFull,
                input: [{ type: "message", role: "user", content: prompt }], // FRESH — no parent history
                cwd: childCwd,
                model: effectiveOverride ?? opts.model,
                // Subagents inherit the PARENT thread's resolved reasoning effort — no per-agent-def
                // override, same as the synchronous path below.
                reasoningEffort: opts.reasoningEffort,
                meta: childMeta,
                depth: childDepth,
                // registry.stop() (entryAbort.signal) and the stall watchdog's own childSignal
                // are the only things that can abort this detached child — see this branch's own
                // doc comment above. The parent turn's `signal` is deliberately NOT folded in
                // here (unlike the sync path below): CC parity — ESC stops foreground work only;
                // a detached background agent survives the interrupt and is stopped explicitly
                // (task_stop) or by the stall watchdog.
                signal: AbortSignal.any([childSignal, entryAbort.signal]),
                loaded: childLoaded,
                excludeTools: childExcludeTools,
                allowTools: def.allowTools,
                maxTurns,
                rootsOverride: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
                // No-timeout task: every provider event this child streams resets its stall
                // window (runThread's ONE chokepoint) — this is the bg path's ONLY default
                // clock now, see the run() opts note just below.
                onProgress: progress,
              });
            }, {
              reentrant: opts.depth > 0,
              // No-timeout task (user rule 2026-07-12): NO `timeoutMs` here anymore — the old
              // shape (`null` at depth 0 = untimed, `undefined` at depth>0 = the manager's 300s
              // default) is retired along with the manager's default wall clock itself. What
              // bounds a detached child now, at EVERY depth: (a) the progress-STALL watchdog
              // (SubagentManager's own default, 600s of NO streamed events — exactly what CC's
              // watchdog covers, and it reaches the depth>0 grandchildren task_stop can't, which
              // is what the old C1 "untimed ⟺ killable" 300s net existed for), (b) the per-thread
              // iteration cap (maxTurns/MAX_TOOL_ITERATIONS — bounds a live-but-looping child the
              // stall watchdog would never catch), (c) task_stop via `entryAbort` (depth-0 only),
              // and (d) an EXPLICIT settings.subagents.timeoutMs wall clock if the user opts one
              // in (the manager's own constructor getter — applies here like everywhere else).
            })
              .then((result) => {
                // task-16 (Stalled roster verb): `result.stalled` is set ONLY by the stall
                // watchdog's own SubagentStallError (subagents.ts) — pool saturation, an explicit
                // wall-clock timeout, and a thrown fn all leave it undefined and still report
                // "error" here, unchanged.
                const stopReason = result.ok ? result.value.stopReason : result.stalled ? "stalled" : "error";
                this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason });
                this.completeThread(sessionId, childId, stopReason);
                // Same outcome shape as the synchronous path's spawnOutcomes.set below (Defect 2,
                // 4e gate F10) — a completed-but-errored child (result.ok, stopReason "error")
                // reports as a failure, not a quiet success. This result is only READ later — by
                // notifyBgCompletion just below (persisted <result>) or a future resume/get —
                // never by this already-returned tool_result. subagentFailureText (no-timeout
                // task) appends a STALLED child's last persisted assistant text, so the partial
                // work surfaces in the notification like it does in the sync tool_result.
                this.cfg.bgAgents!.complete(childId, !result.ok
                  ? { ok: false, result: this.subagentFailureText(agentType, result, sessionId, childId) }
                  : result.value.stopReason === "error"
                    ? { ok: false, result: `subagent (${agentType ?? "general-purpose"}) failed: ${result.value.errorMessage ?? "provider error"}` }
                    : { ok: true, result: result.value.finalText || "the subagent finished without a final message" },
                  // 4h-ii-c: only reachable if an EXPLICIT wall clock is configured (the manager
                  // has no default one anymore, no-timeout task) — kept wired so a timed-out
                  // detached child is never misreported as a generic "failed" when one exists.
                  !result.ok && result.timedOut ? { timedOut: true } : undefined);
                // bg-retrigger Task 1: LAST — after complete() above, so the claim sees the
                // terminal status/result, and after the thread_completed emit (event order:
                // completion first, notification second).
                this.notifyBgCompletion(sessionId, childId);
              })
              .catch((err) => {
                // Defensive only — SubagentManager.run() itself never throws (see its own doc
                // comment); this guards against a throw in the `.then` handler above (e.g. a
                // registry bug) so a detached child NEVER leaves an unhandled rejection.
                const message = err instanceof Error ? err.message : String(err);
                this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason: "error" });
                this.completeThread(sessionId, childId, "error");
                this.cfg.bgAgents!.complete(childId, { ok: false, result: message });
                // bg-retrigger Task 1: LAST, mirroring the .then above — takeForNotification's
                // single-consumer claim makes a double persist impossible even if the .then
                // already notified before throwing.
                this.notifyBgCompletion(sessionId, childId);
              })
              .finally(() => {
                // 4h-i Task 4 teardown, mirrored for the detached path — see the synchronous
                // path's own `finally` block below for the full rationale (clean-only removal,
                // dirty worktrees left on disk for review).
                if (isolatedWorktree) {
                  try {
                    const removed = this.cfg.worktrees!.removeDetached(isolatedWorktree.dir, opts.cwd, true);
                    if (!removed) {
                      console.error(`spawn_agent isolation:"worktree": left dirty worktree at ${isolatedWorktree.dir} (uncommitted changes) — not auto-removed`);
                    }
                  } catch (err) {
                    console.error(`spawn_agent isolation:"worktree": teardown failed for ${isolatedWorktree.dir}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              })
              .catch(() => {
                // Terminal net (whole-branch review): the `.catch` above re-calls emit/
                // completeThread, which can throw again for the same PERSISTENT cause (e.g. an
                // appendFileSync IO fault on the completion emit), and `.finally` re-propagates —
                // leaving the void-ed detached chain rejected with no handler. The synchronous
                // path surfaces the same fault as a caught turn error, but a detached child has no
                // caller to surface to, so swallow it here rather than emit an unhandled rejection.
              });
            // NOTE: only {agentId, status, outputFile?} — never the AbortController/registry entry
            // itself — ever reaches the model, via this tool_result JSON. `outputFile` (CC parity:
            // bg spawn results carry an output-file path) is OMITTED entirely when undefined
            // (cfg.tmpDirOf unwired) rather than serialized as `null`/absent-looking — a caller that
            // greps this JSON for the key literally either finds it or doesn't.
            const outputFile = this.transcriptPathFor(sessionId, childId);
            spawnOutcomes.set(call.callId, {
              output: JSON.stringify({ agentId: childId, status: "running", ...(outputFile ? { outputFile } : {}) }),
              isError: false,
            });
            return; // Promise.all resolves without waiting on the detached chain above
          }

          // 4h-ii-b Task 1: register a SYNC spawn in the bg-agent registry too — before this task
          // only `run_in_background` spawns ever got a registry entry. CC parity: ANY finished
          // agent (sync or async) must be resumable, and `resume` (Task 3) looks a child up by
          // agentId in this SAME registry regardless of how it was spawned. `entryAbort` mirrors
          // the bg path's own controller above (AgentEntry.abort is a mandatory field) and is
          // folded into this child's own signal below via AbortSignal.any, exactly like the bg
          // path — nothing calls registry.stop() yet (no stop tool exists today), but this keeps
          // a future stop() working uniformly for sync- and bg-spawned children without touching
          // this bridge again. Gated on `this.cfg.bgAgents` being wired at all (optional, same as
          // the bg path's own guard) — when it's absent this block is a no-op and the sync spawn
          // runs exactly as it did before this task (plain `childSignal`, no registry entry).
          // Registration failure is defensive-only, same reasoning as the bg path's own
          // register() call above: childId can't collide (a fresh randomUUID) and a `name`
          // collision with an EXISTING agent was already rejected by the pre-check before
          // thread_started fired — the only thing this register() can still reject is a
          // same-batch sibling reusing one name (see the bg path's own comment above). Unlike the
          // bg path, a failure here must NOT fail the sync spawn itself (the registry is a BONUS
          // here, not the only channel back to the caller like it is for a detached child), so
          // `registeredInBg` just guards the later complete() call.
          const entryAbort = this.cfg.bgAgents ? new AbortController() : undefined;
          const registeredInBg = !!(entryAbort && this.cfg.bgAgents!.register({
            agentId: childId,
            sessionId,
            threadId: childId,
            name: spawnName,
            abort: entryAbort,
            resume: resumeCtx,
          }).ok);

          // Nested-spawn saturation fix (T3 review): `opts.depth` is THIS spawning thread's own
          // depth — >0 means it already holds a concurrency slot (it's itself a child), so this
          // run() call is a REENTRANT acquire. SubagentManager bounds a reentrant wait
          // (acquireTimeoutMs) instead of queueing unbounded, so pool saturation under nesting
          // fails fast with a typed error instead of stalling for the full per-run timeoutMs
          // (300s) — see SubagentManager.acquire's doc comment. A depth-0 (top-level) spawn is
          // never reentrant and keeps its existing unbounded queueing behind busy siblings.
          try {
            const result = await this.cfg.subagents!.run(async (childSignal, progress) => {
              return this.runThread({
                sessionId,
                threadId: childId,
                instructionsFull,
                input: [{ type: "message", role: "user", content: prompt }], // FRESH — no parent history
                cwd: childCwd,
                model: effectiveOverride ?? opts.model,
                // Subagents inherit the PARENT thread's resolved reasoning effort — no per-agent-def
                // override (agent defs only carry a model override, never an effort one).
                reasoningEffort: opts.reasoningEffort,
                // childMeta: the SAME object as `meta` (byte-identical, no copy) when there's no
                // narrowing `mode` override — the child inherits the parent's (possibly
                // later-mutated) approval policy, exactly as before 4h-i. Only a NARROWING `mode`
                // (restrictPolicy above) produces a child-scoped shallow copy, so the parent's own
                // `meta.approvalPolicy` is NEVER mutated by a spawn's mode override — see
                // `childMeta`'s own doc comment above for why (concurrent spawns, same-turn parent
                // policy corruption).
                meta: childMeta,
                depth: childDepth,
                // ESC cascade (no-timeout task, CC parity: "aborts the active model stream or
                // tool process ... must kill descendants"): the PARENT thread's own `signal`
                // (for the main thread, runTurn's per-turn AbortController — the exact thing
                // interrupt(sessionId) fires; for a depth>0 spawner, its own composite, which
                // transitively includes the chain up to main) is folded into this SYNC child's
                // composite, so a user ESC aborts the child's provider stream/tools instead of
                // leaving the parent blocked on a child that no longer has anyone waiting for
                // it. This became load-bearing when the default wall clock was removed — an
                // ESC'd sync child used to be bounded by the 300s net; now nothing else would
                // end it promptly (the stall watchdog only catches SILENT children). The
                // detached (run_in_background) path above deliberately does NOT fold this in —
                // bg agents survive ESC and are stopped explicitly (CC parity).
                // registeredInBg → entryAbort is defined (see the register block above) and its
                // signal is folded in, mirroring the bg path's own AbortSignal.any wiring.
                signal: registeredInBg ? AbortSignal.any([signal, childSignal, entryAbort!.signal]) : AbortSignal.any([signal, childSignal]),
                loaded: childLoaded,
                // enter_plan_mode excluded alongside exit_plan_mode (4g Task 4): the child inherits
                // the parent's (or, with a narrowing `mode` override, its OWN child-scoped) `meta`
                // object BY REFERENCE (just above) — an unexcluded child calling enter_plan_mode
                // would mutate that object's `approvalPolicy` AND persist it via `cfg.setPolicy`
                // (when it's the SAME object as the parent's, that would silently put the WHOLE
                // session into plan mode once the spawn returns). Plan-mode entry/exit stays a
                // main-thread-only decision regardless of which meta object the child got.
                // spawn_agent's presence/absence here is depth-conditional — see childExcludeTools
                // above (4h-i Task 3).
                excludeTools: childExcludeTools,
                allowTools: def.allowTools,
                maxTurns,
                // 4h-i Task 4: isolated child's fs tools are fenced to EXACTLY the worktree dir
                // (not additive to the session's own roots — see rootsOverride's own doc comment
                // on RunThreadOpts). Undefined (no isolation) → executeCall falls back to the
                // session's normal live roots, unchanged behavior.
                rootsOverride: isolatedWorktree ? [isolatedWorktree.dir] : undefined,
                // No-timeout task: every provider event this child streams resets its stall
                // window — see runThread's ONE chokepoint and subagents.ts's own header.
                onProgress: progress,
              });
            }, { reentrant: opts.depth > 0 });
            // task-16 (Stalled roster verb): see the bg `.then` handler's identical comment above.
            const stopReason = result.ok ? result.value.stopReason : result.stalled ? "stalled" : "error";
            this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason });
            this.completeThread(sessionId, childId, stopReason);
            // Defect 2 (4e gate F10): a child that ran to completion (result.ok) but whose OWN
            // final round hit a provider error (runThread's error branch, stopReason "error") must
            // be reported to the parent as a FAILURE, not as a quiet "finished without a final
            // message" success — the parent's tool_result is the only channel a child has back to
            // its caller (unlike the main thread, whose agent_error event the user sees directly).
            // The `!result.ok` branch (stall / explicit wall clock / thrown error) now routes
            // through subagentFailureText (no-timeout task), which appends a STALLED child's last
            // persisted assistant text — the partial work a genuinely-stalled long scan already
            // produced must reach the parent, not evaporate with the abort.
            // stopReason "aborted" (no-timeout task, ESC cascade): the parent's own signal is now
            // folded into the child's composite above, so a user ESC lands here as a
            // cleanly-aborted child — report it AS an abort ("subagent (type) aborted"), never a
            // stall/timeout message and never a fake success built from a half-finished
            // finalText.
            // Computed ONCE (4h-ii-b Task 1) — the exact same {output,isError}-shaped outcome
            // both feeds the parent's tool_result (spawnOutcomes) AND, when this sync spawn was
            // also registered above (registeredInBg), the registry's own complete() — same
            // {ok,result} shape the bg path's own `.then` handler already uses just above, so a
            // `resume`d-then-re-finished sync child and a bg child report through the exact same
            // registry contract.
            const outcome: { output: string; isError: boolean } = !result.ok
              ? { output: this.subagentFailureText(agentType, result, sessionId, childId), isError: true }
              : result.value.stopReason === "error"
                ? { output: `subagent (${agentType ?? "general-purpose"}) failed: ${result.value.errorMessage ?? "provider error"}`, isError: true }
                : result.value.stopReason === "aborted"
                  ? { output: `subagent (${agentType ?? "general-purpose"}) aborted`, isError: true }
                  // CC parity (SYNC result trailer): a successful sync result ends with an
                  // `agentId: <id>` trailer pointing at the transcript file + how to keep
                  // addressing this same agent — see syncTrailer's own doc comment.
                  : { output: (result.value.finalText || "the subagent finished without a final message") + this.syncTrailer(childId, this.transcriptPathFor(sessionId, childId)), isError: false };
            spawnOutcomes.set(call.callId, outcome);
            // { notified: true } — this sync child's result already reached the parent directly
            // as this SAME call's tool_result, this SAME turn; without this a later
            // takeForNotification claim (notifyBgCompletion, built for run_in_background's
            // DETACHED completions) could persist it as a task_notification too, leaking the
            // child's raw output into a turn that never asked for it (see
            // BackgroundAgentRegistry.complete's own doc comment).
            // 4h-ii-c: `timedOut` stays threaded through for the explicit-wall-clock opt-in case
            // (the manager has no default clock anymore — no-timeout task), consistent with the
            // bg path's own `.then` handler above.
            if (registeredInBg) this.cfg.bgAgents!.complete(childId, { ok: !outcome.isError, result: outcome.output },
              { notified: true, timedOut: !result.ok && result.timedOut });
          } finally {
            // 4h-i Task 4: teardown runs whether the child succeeded, errored, or timed out —
            // clean-only (mirrors exit_worktree's default guard AND CC's own isolation
            // teardown): a CLEAN worktree (no uncommitted changes) is removed; a DIRTY one is
            // left on disk for the user to review (logged) — NO auto-merge, NO force-remove
            // (no data loss). `this.cfg.worktrees` is guaranteed set here (isolatedWorktree is
            // only ever assigned after that same guard above).
            if (isolatedWorktree) {
              try {
                const removed = this.cfg.worktrees!.removeDetached(isolatedWorktree.dir, opts.cwd, true);
                if (!removed) {
                  console.error(`spawn_agent isolation:"worktree": left dirty worktree at ${isolatedWorktree.dir} (uncommitted changes) — not auto-removed`);
                }
              } catch (err) {
                console.error(`spawn_agent isolation:"worktree": teardown failed for ${isolatedWorktree.dir}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }));
      }

      // 4h-ii-b Task 4 (SM1/SM4): the send_message bridge. Each depth-0 send_message call resolves
      // its `to` (agentId/name) in this session's bg-agent registry and routes: a RUNNING target
      // gets the message queued into its thread steer queue (sendToThread); a TERMINAL target is
      // resumed in the BACKGROUND (resumeThread with runInBackground:true — send_message never
      // blocks the parent, and this reuses ALL of T3's guards: clean-termination, removed-worktree,
      // policy no-widen). The precomputed {output,isError} becomes the call's tool_result in the
      // dispatch loop below (read via `preOutcome`), so a send_message call never reaches
      // executeCall. `to`/`message` are hand-parsed from argsJson (string-only) BEFORE any zod
      // would run — same defensive shape as the spawn bridge — so a malformed call is a typed error.
      for (const call of sendMessageCalls) {
        // [4f pre-tool — Site 1 (bridged)] FIRST statement, before any send_message work. Same
        // rationale as the spawn_agent bridge above: send_message is bridge-intercepted (its
        // outcome lands in sendMessageOutcomes → preOutcome branch → continue), so it never reaches
        // Site 2 — this is its one and only pre-tool fire. send_message is READ_ONLY (no gate), so
        // its effect boundary is the gate boundary. A BLOCK sets the outcome and skips the delivery.
        if (this.cfg.hooks) {
          const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
          const blocked = results.find((r) => r.result.status === "blocked");
          if (blocked) { sendMessageOutcomes.set(call.callId, this.hookBlockOutcome(blocked)); hookBlockedCallIds.add(call.callId); continue; }
        }
        let smParsed: { to?: unknown; message?: unknown } = {};
        try { smParsed = JSON.parse(call.argsJson || "{}"); } catch { /* defensive: typed error below */ }
        const to = typeof smParsed.to === "string" && smParsed.to.length > 0 ? smParsed.to : undefined;
        const message = typeof smParsed.message === "string" && smParsed.message.length > 0 ? smParsed.message : undefined;
        if (!to) { sendMessageOutcomes.set(call.callId, { output: "invalid arguments for send_message: to", isError: true }); continue; }
        if (!message) { sendMessageOutcomes.set(call.callId, { output: "invalid arguments for send_message: message", isError: true }); continue; }
        // No registry wired (daemon.ts never built bgAgents) → nothing to address, mirroring the
        // spawn bridge's own `run_in_background && !bgAgents` guard.
        if (!this.cfg.bgAgents) { sendMessageOutcomes.set(call.callId, { output: "send_message is not available in this session", isError: true }); continue; }
        const target = this.cfg.bgAgents.get(to, sessionId);
        if (!target) { sendMessageOutcomes.set(call.callId, { output: `no agent '${to}' to message`, isError: true }); continue; }
        // 4h-ii-b Task 5 (stale-name guard, CC v2.1.199 parity): only a BY-NAME resolution is
        // checked/tracked — `to !== target.agentId` is exactly that (get() tries the agentId map
        // FIRST, so a hit where `to` equals the returned entry's own agentId was resolved BY ID).
        // A direct by-ID send bypasses this entirely and never updates the tracking map — a stable
        // identifier that never goes stale needs no guard. child-transcript-view T1: factored into
        // `guardAgentName` (bg-agent-registry.ts), shared with task_stop and the thread.send/
        // agent.stop RPCs (`sendToAgent`/`stopAgent` below), so this guard can't drift across its
        // four call sites.
        const guard = guardAgentName(this.cfg.bgAgents, sessionId, to, target);
        if (!guard.ok) { sendMessageOutcomes.set(call.callId, { output: guard.error, isError: true }); continue; }
        if (target.status === "running") {
          this.sendToThread(sessionId, target.threadId, message);
          sendMessageOutcomes.set(call.callId, { output: `message delivered to '${to}'`, isError: false });
          continue;
        }
        // terminal (completed/failed/stopped/timeout) → resume it in the background. Its {output,isError}
        // (a bg resume returns {agentId,status:"running"} immediately, or a T3 guard's typed error)
        // becomes this send_message call's tool_result.
        sendMessageOutcomes.set(call.callId, await this.resumeThread({
          sessionId,
          resumeArg: to,
          prompt: message,
          runInBackground: true, // detached — parentSignal is ignored on the bg fork (ESC never cascades into bg)
          meta,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          depth: opts.depth,
          parentThreadId: threadId,
          parentSignal: signal,
        }));
      }

      for (const call of calls) {
        this.emit(sessionId, { type: "tool_call", sessionId, threadId, callId: call.callId, name: call.name, argsJson: call.argsJson });
        input.push({ type: "function_call", callId: call.callId, name: call.name, argsJson: call.argsJson });

        let outcome: { output: string; isError: boolean; deniedByHuman?: boolean };
        // A precomputed outcome from the spawn OR send_message bridge above becomes this call's
        // tool_result verbatim (both are computed BEFORE this loop so N spawns/messages in one
        // assistant message don't serialize the dispatch), so it never falls through to executeCall.
        const preOutcome = spawnOutcomes.get(call.callId) ?? sendMessageOutcomes.get(call.callId);
        if (preOutcome) {
          outcome = preOutcome;
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          // Task 9 ordering fix (see spawnedChildIds' doc comment above): a successful session_spawn
          // call's child_update(running) is announced HERE, right after ITS OWN tool_result — so the
          // dispatch stream always reads tool_call → tool_result → child_update(running), never the
          // reverse. No-op for every other bridged callId (send_message, an errored session_spawn).
          const announceChildId = spawnedChildIds.get(call.callId);
          if (announceChildId) dispatchReg?.announceChild(announceChildId);
          // [4f post-tool — bridged outcome] observe a spawn_agent/send_message call's result.
          // firePostTool SKIPS a pre-tool-blocked call (hookBlockedCallIds) — that call never ran.
          if (this.cfg.hooks) await this.firePostTool(sessionId, threadId, call, outcome, hookBlockedCallIds, signal); // [4f I1] interrupt cuts the chain
          continue;
        }
        if (call.name === "spawn_agent" && opts.depth >= maxDepth) {
          // Belt-and-braces: a thread AT the nesting cap already had spawn_agent excluded from its
          // specs (childExcludeTools above), so this only fires if a provider ignores the tool
          // list and calls it anyway. A thread BELOW the cap (opts.depth < maxDepth) never reaches
          // here for spawn_agent — its calls were already siphoned off into spawnOutcomes by the
          // spawn-gather filter earlier in this same round (4h-i Task 3).
          outcome = { output: "subagents cannot spawn further subagents", isError: true };
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          continue;
        }
        // 4g fix-wave-1 (T1 review): reject a deferred:true built-in that's called before being
        // loaded/pinned — BEFORE any of the bridge intercepts below get a chance to run. Those
        // bridges (worktree, exit_plan_mode) dispatch straight from `call.name`, bypassing
        // executeCall entirely — so without this guard a model calling e.g. enter_worktree
        // unloaded would silently reach the bridge and succeed, instead of being told to load its
        // schema via ToolSearch first like every other deferred tool. Mirrors registry.execute()'s
        // own rejection message byte-for-byte, and reuses THIS round's `effectiveLoaded` (loaded ∪
        // pins, computed once above) — so a PINNED tool (exit_plan_mode while policy==="plan",
        // exit_worktree while a worktree is active) is IN effectiveLoaded and naturally passes:
        // the states that make a tool meaningful keep it callable. `isDeferredBuiltin`'s
        // `tsEnabled` arg is this round's SAME toolSearchEnabled() flag threaded through specs()/
        // executeCall above — when toolSearch is disabled it always returns false, so this guard
        // is a no-op then, preserving the pre-4g byte-identical invariant.
        if (this.cfg.registry.isDeferredBuiltin(call.name, tsEnabled) && !effectiveLoaded.has(call.name)) {
          outcome = { output: `tool ${call.name} is deferred — load its schema via ToolSearch first`, isError: true };
          this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
          input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
          continue;
        }
        let decision = this.cfg.gate.evaluate(call.name, meta.approvalPolicy);
        // Worktree tools are MUTATING (gate.ts), so under `ask` policy (the DEFAULT) `decision` is
        // "ask", not "allow" — checked here, BEFORE the generic `decision === "ask"` branch below,
        // so that branch never gets first crack at a worktree call. Without this dedicated branch,
        // the generic one would run executeCall on approval (the tool's own placeholder run()),
        // and the bridge (setCwd + git + same-turn cwd + worktree_* events) would NEVER run outside
        // `auto` policy — see task-4-report.md for the bug writeup.
        const isWorktree = (call.name === "enter_worktree" || call.name === "exit_worktree") && !!this.cfg.worktrees;
        // `cwd` is typed `string` (never undefined here), so this ternary is only a defensive
        // guard against an empty string — repoRootFor("") would realpath-fail and fall back to the
        // DAEMON's own process.cwd(), a wrong and misleading project root. `projectRoot: null`
        // degrades safely everywhere it's read below: PermissionRules.decision() just consults
        // global rules, and controlPlaneFileTarget is projectRoot-INDEPENDENT (SP-policies
        // whole-branch Item 1 — it refuses ANY project's rules store, so a null projectRoot never
        // affects its verdict; see its own doc comment). SP-policies Task 6: HOISTED above the
        // `dirGrant` computation just below (it used to sit between `dirGrantDenied` and
        // `rulesFileTarget`) — `writableRoots` (also below) needs it to resolve this call's
        // `Edit(<path>)`-declared writable dirs BEFORE `dirGrant`'s own fsWriteOutOfRootDir check
        // runs, not just for the later ruleAllowed consumers that already read it.
        const projectRoot = cwd ? repoRootFor(cwd) : null;
        // CC parity (write-permission-flow): out-of-root write/edit. Norma has no model-invocable
        // "request a directory" tool anymore — an out-of-root Write/Edit itself carries the SAME
        // approval seam bash uses (cc-expert findings, task-24 recon: real CC shows exactly ONE
        // prompt for an out-of-scope edit, not a generic "run this tool" card followed by a second
        // "grant this directory" card — so the grant is handled here in the dispatch loop, BEFORE
        // the generic `decision === "ask"` branch below gets first crack, rather than layering a
        // second approval on top of it). `dirGrant` is null (byte-identical fast path — the
        // UNCHANGED branches below run) for every in-root call; `!rootsOverride` skips this for a
        // worktree-isolated child, whose roots are a FIXED confinement ([worktreeDir]) that
        // SessionDirectories.add can never extend — granting there would be a no-op that only costs
        // the human a pointless prompt before the SAME hard fail, so it falls through to today's
        // plain reject instead (fs-write.ts's own fence, unchanged). `let`, not `const`: the auto
        // pre-grant below NULLS it once the grant lands, so the call then flows through the normal
        // dispatch chain as an ordinary in-root write (task-24 review F1 — see the pre-grant).
        // SP-policies Task 6: roots come from `writableRoots` (this session's roots UNIONED with
        // any `Edit(<path>)`-declared dirs for this project, see its own doc comment) rather than
        // the raw session roots — `undefined` rootsOverride argument here since this whole ternary
        // is already gated on `!rootsOverride` (a worktree child's fixed confinement is never
        // widened by an Edit rule).
        let dirGrant =
          (call.name === "write" || call.name === "edit") && decision !== "deny" && !rootsOverride
            ? fsWriteOutOfRootDir(call, this.writableRoots(sessionId, projectRoot, undefined), sessionTmpDir(sessionId))
            : null;
        // task-24 review F2: the control plane (daemon.ts passes ~/.norma/run — the SAME denylist
        // the read tools get) is NEVER grantable, either policy, no card — checked once here, and
        // consulted by both the auto pre-grant below and the deny branch in the dispatch chain.
        const dirGrantDenied = dirGrant !== null && this.grantDenied(dirGrant.dir);
        // SP-approvals final review (composition hole): the permission-rules store itself is NEVER
        // a valid write/edit target — checked here, unconditionally (not gated on `decision`,
        // `dirGrant`, or anything ruleAllowed-related below), so it is computed and dispatched
        // BEFORE the ruleAllowed short-circuit gets a chance to run. See
        // controlPlaneFileTarget's own doc comment for the full exfil-composition rationale
        // (final review 2: filesystem-IDENTITY comparison, not string spelling; CC-parity Task 6.5:
        // now also the two per-project settings overlays, not just the rules store).
        const rulesFileTarget = (call.name === "write" || call.name === "edit" || call.name === "notebook_edit")
          ? controlPlaneFileTarget(call, this.writableRoots(sessionId, projectRoot, rootsOverride))
          : null;
        // SP-approvals Task 10: web_fetch's dangerous-domain floor — computed for EVERY policy
        // (gate.ts's `decision` above is now unconditionally "allow" for web_fetch, so this is the
        // ONLY thing standing between a dangerous-domain fetch and executeCall). `null` for every
        // non-web_fetch call and for a web_fetch call this floor has nothing to say about (byte-
        // identical fast path, mirrors `dirGrant`'s own null-for-everything-else shape above).
        const webFetchCard = call.name === "web_fetch" ? this.webFetchGate(call, cwd) : null;
        // SP-approvals Task 11 (spec §8): bash's two escalation args, parsed ONCE here — before
        // the ruleAllowed block below and the dispatch chain further down — so every consumer
        // (the classifier guard, the always-card branch) sees the SAME parse. `{allowNetwork:
        // false, dangerouslyDisableSandbox: false}` for every non-bash call (byte-identical fast
        // path, mirrors dirGrant/webFetchCard's own null-for-everything-else shape just above).
        const bashEscalation = call.name === "bash" ? bashEscalationArgs(call) : { allowNetwork: false, dangerouslyDisableSandbox: false };
        // [4f pre-tool — Site 2 (normal calls)] Post-gate (decision computed just above), before ANY
        // dispatch branch runs/approves. Bridged calls (spawn_agent/send_message) NEVER reach here —
        // they were siphoned into spawn/sendMessageOutcomes and hit the `preOutcome` branch ABOVE,
        // which `continue`s — so pre-tool fires EXACTLY ONCE per call (bridged ⇒ Site 1; normal ⇒
        // Site 2), no double-fire. F1 (deny-only): a `blocked` result short-circuits to an isError
        // tool_result; every other status (ok/error/timeout, F2 fail-open) falls through to the
        // normal gate/approval/executeCall dispatch UNCHANGED — the hook can restrict, never widen.
        // Kept as ONE logical site here rather than threaded through each requestApproval onApprove
        // (LOCKED DECISION 2): for an `ask` call the hook fires before the approval prompt, but since
        // it can ONLY block (deny-only) that never bypasses the gate — a blocked call simply never
        // reaches the prompt. A `deny` (plan-mode) call still fires the hook; block-or-not is moot
        // there (the tool won't run either way), acceptable for a single site.
        if (this.cfg.hooks) {
          const results = await this.cfg.hooks.runFor("pre-tool", { toolName: call.name, argsJson: call.argsJson, threadId }, sessionId, signal); // [4f I1] interrupt cuts the chain
          const blocked = results.find((r) => r.result.status === "blocked");
          if (blocked) {
            outcome = this.hookBlockOutcome(blocked);
            hookBlockedCallIds.add(call.callId); // post-tool must NOT observe a call that never ran
            this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
            input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
            continue;
          }
        }
        // task-24 review F1 — auto-policy pre-grant. Under `auto` the grant itself is silent
        // (mirrors bash's own silent auto-allow; explicit product choice diverging from real CC's
        // acceptEdits, which still prompts out-of-scope — see task-24-report). But the WRITE must
        // then flow through the SAME dispatch chain an in-root write gets — in particular the fs
        // safety-reviewer branch below (an out-of-root target is by definition outside the primary
        // cwd subtree, so fsWriteIsUnusual reviews it) — which the first cut bypassed by
        // dispatching executeCall directly from the grant branch. So: apply the grant HERE (mkdir
        // — review F3: the fence realpaths roots, so a not-yet-existing grant dir would silently
        // drop out of resolveWithinAny; creating it is exactly what was approved — then
        // SessionDirectories.add + directory_added), NULL dirGrant, and fall through — the call is
        // now an ordinary in-root write and every later branch (reviewer included) sees it
        // unchanged. Placed AFTER the pre-tool hook block so a hook-blocked call never grants.
        //
        // SP-policies Task 9: `accept-edits` joins `auto` on this silent pre-grant. That policy's
        // whole contract is "edits/writes are free" (gate.ts's EDIT_CLASS → "allow"), so an
        // out-of-project edit under it must land with NO card, exactly like an in-project one —
        // applyDirGrant here gives it the same silent session grant an in-project write already has.
        // Under `auto` the granted call then rides the fs reviewer (auto-only branch below); under
        // `accept-edits` no reviewer branch fires (all three are `=== "auto"`-gated), so it flows
        // straight to executeCall — silent either way. SP-policies Task 10: `bypass` now joins them
        // too — bypass is opt-in no-guardrails, so an out-of-project edit under it gets the SAME
        // silent pre-grant rather than riding the `ask`-shaped grant card below (its reviewer branch
        // is `auto`-only same as the other two, so a bypass-granted call also flows straight to
        // executeCall, silent).
        let grantFailure: string | null = null;
        if (dirGrant && !dirGrantDenied && (meta.approvalPolicy === "auto" || meta.approvalPolicy === "accept-edits" || meta.approvalPolicy === "bypass")) {
          grantFailure = this.applyDirGrant(sessionId, threadId, dirGrant.dir);
          if (!grantFailure) dirGrant = null;
        }
        // SP-approvals Task 3: the whole point of `ask` policy is a human in the loop, but without
        // this it re-prompts for the SAME command/tool forever — Task 1's PermissionRules (a
        // CC-grammar allow-rules store, project + global) and Task 2's readOnlyBash (a
        // deterministic, fail-to-ask read-only-command classifier) are the two ways a call can
        // clear that prompt with no human touching anything. Computed ONCE per call, and ONLY
        // reachable when there's an actual prompt to skip: `decision === "ask"` is the outer guard,
        // so a `deny` (plan mode) call structurally NEVER consults a rule — not because no rule
        // happens to match, but because this whole block never runs for it. An `auto`-policy
        // MUTATING/NETWORK call never reaches here either (already silently allowed; nothing to
        // skip) — the one exception is gate.ts's ALWAYS_ASK class (skill_write), which is `"ask"`
        // under auto too; that's harmless here because Task 1's rule grammar (KNOWN_TOOLS: Bash/
        // Edit/Computer/Worktree) has no token for it, so `toolForCallName` returns `null` and
        // ruleAllowed can never flip to true for it regardless of what's configured — the "no
        // policy setting silences it" invariant ALWAYS_ASK exists for stays intact unchanged.
        //
        // `grantPending` (an out-of-root write/edit still awaiting its OWN grant-flavored approval
        // card, `dirGrant` computed above) takes precedence over both sources: a rule only speaks
        // to WHETHER a tool/command is fine, never to WHICH directory it's fine to touch outside
        // the session's roots — that second question is exactly what the grant card exists to ask,
        // so a matching rule must never let a call skip it. Excluding ruleAllowed here — rather
        // than letting it flip `decision` and relying on the `dirGrant` branch below to still fire
        // — keeps that precedence structural, not incidental.
        //
        // SP-approvals Task 11 (spec §8): `dangerouslyDisableSandbox` excludes this ENTIRE block
        // too, for the exact same "structural, not incidental" reason as `grantPending` above — a
        // dangerouslyDisableSandbox call always cards regardless of what this block would compute
        // (its own always-card branch, further down, never even reads `ruleAllowed`/`decision`),
        // so excluding it here means "no rule/classifier can ever silence it" holds because
        // ruleAllowed can NEVER become true for such a call, not merely because a later branch
        // happens to intercept first. `allowNetwork` does NOT get the same outer exclusion — a
        // STANDING RULE may still cover a network call (spec) — only the classifier sub-check
        // below narrows for it.
        let ruleAllowed = false;
        if (decision === "ask" && this.cfg.permissionRules && !bashEscalation.dangerouslyDisableSandbox) {
          // `projectRoot` is the SAME hoisted value the `dirGrant`/`writableRoots` computation above
          // already used (derived once at the top of the loop) — reused here rather than recomputed.
          const grantPending = dirGrant !== null;
          if (!grantPending && this.cfg.permissionRules.decision({ name: call.name, argsJson: call.argsJson }, projectRoot) === "allow") {
            ruleAllowed = true;
          }
          // readOnlyBash is bash-only, and consulted ONLY when no rule already matched — a
          // fail-to-ask classifier (readonly-bash.ts), so `false` here means "no opinion" (falls
          // through to the normal ask prompt), never "unsafe". SP-approvals Task 11: also skipped
          // whenever `allowNetwork` is set — the classifier must NEVER be the reason a network
          // call runs unreviewed (a STANDING RULE may still cover one, per the check just above;
          // the classifier's fail-to-ask heuristic simply has no concept of "safe to run WITH
          // network" at all, so it stays out of that decision entirely).
          if (!ruleAllowed && !grantPending && call.name === "bash" && !bashEscalation.allowNetwork) {
            try {
              const a = JSON.parse(call.argsJson || "{}");
              if (typeof a.command === "string" && readOnlyBash(a.command)) ruleAllowed = true;
            } catch { /* malformed argsJson → no opinion, falls through to the normal ask prompt */ }
          }
          if (ruleAllowed) decision = "allow";
        }
        // SP-policies: a BashUnsandboxed rule (permission-rules.ts, disjoint from Bash) pre-clears a sandbox
        // escape in EVERY mode except plan (decision 7). decision() matches it ONLY for a
        // dangerouslyDisableSandbox call, so this can never fire for an ordinary bash call. Computed even
        // though the ruleAllowed block above excludes escape calls — the escape is a separate, higher-stakes
        // class with its own rule form, never silenced by a plain Bash rule. Runs BEFORE the dont-ask deny
        // flip below (ordering is load-bearing): a BashUnsandboxed-covered escape under dont-ask must stay
        // "allow" and run silently, not get converted to "deny" by that flip.
        //
        // SP-policies whole-branch review (Item 2, MEDIUM — ACCEPTED, documented not guarded): a PERSISTED
        // `BashUnsandboxed(<prefix>:*)` rule (like `bypass`) grants SILENT, unsandboxed execution for that
        // prefix. For a file-WRITING prefix that necessarily includes writing the control plane itself —
        // the rules store and, since CC-parity Task 6.5, the two settings overlays too
        // (`*/.norma/{permissions.local,settings,settings.local}.json`, which the seatbelt regexes +
        // controlPlaneFileTarget otherwise deny) and `~/.norma/run/core.sock` — because a true escape
        // runs with NO seatbelt at all (tools/bash.ts spawns /bin/bash directly, no profile). This is
        // a DELIBERATE, human-pre-authorized
        // consequence: the human wrote (or approved the "always allow" card for) that BashUnsandboxed rule,
        // explicitly choosing unrestricted shell for that prefix. Guarding it would require parsing the shell
        // command string to reason about what it writes — fragile and defeatable (out of scope). The store
        // guard here protects the write/edit TOOLS and the SANDBOXED bash path; a self-authored escape rule is
        // a strictly higher, separately-consented bar.
        let unsandboxedRuleAllowed = false;
        if (bashEscalation.dangerouslyDisableSandbox && this.cfg.permissionRules && meta.approvalPolicy !== "plan"
            && this.cfg.permissionRules.decision({ name: call.name, argsJson: call.argsJson }, projectRoot) === "allow") {
          unsandboxedRuleAllowed = true;
          decision = "allow"; // flows to executeCall (unsandboxed), skipping the escape card + the reviewer
        }
        // SP-policies Task 7: in-project edits are SILENT by default. A write/edit whose target is in
        // the session writable set (dirGrant === null ⇒ in-root, now that Task 6's writableRoots has
        // folded in any Edit(<path>)-declared dirs) and is not the rules store gets no card — under
        // ask/dont-ask alike (accept-edits/auto/bypass already return "allow" from the gate, so this
        // never fires for them). This is the flip that stops `ask` from carding an ordinary edit.
        // Runs BEFORE the dont-ask flip below so an in-project edit under dont-ask is SILENCED, not
        // denied. `!rulesFileTarget` keeps a write to the permission-rules store on its dedicated
        // hard-error branch (else if (rulesFileTarget)) with the accurate message.
        if (decision === "ask" && (call.name === "write" || call.name === "edit") && !dirGrant && !rulesFileTarget) {
          decision = "allow";
        }
        // SP-policies Task 7: dont-ask declines everything it would otherwise CARD, with no prompt.
        // Anything still "ask" here (no rule, no classifier, not an in-project edit) is auto-denied.
        // Deliberately NOT guarded by `!dirGrant`: an out-of-project edit is still "ask" at this point
        // (its grant card hasn't been offered yet) and SHOULD be denied under dont-ask — because the
        // `decision === "deny"` branch is FIRST in the dispatch chain below, this deny short-circuits
        // before the `else if (dirGrant)` grant-card branch could run, so no grant card is surfaced.
        // `!rulesFileTarget` is excluded so a rules-store write still hits its dedicated hard-error
        // branch (accurate message) rather than this generic dont-ask deny. An UNCOVERED
        // dangerouslyDisableSandbox escape is likewise converted here (the ruleAllowed block excluded
        // it, in-project-silent skips it — not write/edit), so it denies before its own escape branch.
        // SP-policies Task 11: a BashUnsandboxed-COVERED escape never reaches this flip as "ask" —
        // unsandboxedRuleAllowed (computed above, ahead of these flips) already set it "allow", so it
        // runs silently under dont-ask instead of being denied here.
        if (decision === "ask" && meta.approvalPolicy === "dont-ask" && !rulesFileTarget) {
          decision = "deny";
        }
        if (decision === "deny") {
          // Plan mode's blanket deny (gate.ts) OR dont-ask's auto-decline (the flip just above): tool
          // NOT run, no approval flow. The message is mode-aware — dont-ask and plan reach this same
          // branch but for different reasons, so each gets its own accurate explanation.
          outcome = {
            output: meta.approvalPolicy === "dont-ask"
              ? "Denied automatically — you're in dont-ask mode, which declines every action that needs approval. Switch to ask or auto to be prompted, or add an allow-rule for this."
              : "Blocked in plan mode — you are researching and planning, so file changes and commands are disabled. Make no changes; when your plan is ready, call exit_plan_mode to present it for approval.",
            isError: true,
          };
        } else if (rulesFileTarget) {
          // SP-approvals final review: hard error, no card, no grant — mirrors dirGrantDenied's own
          // control-plane branch just below in both style and precedence (checked BEFORE it, and
          // before the out-of-root grant-card branch, so an Edit rule AND a would-be grant card are
          // both preempted). See controlPlaneFileTarget's own doc comment for why.
          outcome = {
            output: `cannot ${call.name} ${rulesFileTarget.path}: the permission rules store can only be changed by answering an approval card (or editing it yourself)`,
            isError: true,
          };
        } else if (dirGrant && dirGrantDenied) {
          // task-24 review F2: hard error, no card, no grant — under BOTH ask and auto (this
          // branch precedes the ask-policy grant card below AND the generic ask branch; the auto
          // pre-grant above already skipped a denied dir). bash's seatbelt shares the session
          // roots, so a grant here would open the control plane to bash too — never offered.
          outcome = {
            output: `cannot ${call.name} ${dirGrant.path}: ${dirGrant.dir} is Norma's control plane and can never be granted`,
            isError: true,
          };
        } else if (grantFailure) {
          // auto pre-grant's mkdir failed (EACCES/EROFS/...): the grant did NOT land (no
          // directory_added, dir not added to the session roots) — surface why instead of letting
          // the fence throw its generic "outside the allowed directories" a moment later.
          outcome = { output: grantFailure, isError: true };
        } else if (isWorktree) {
          // "allow" (auto policy) runs the bridge directly, synchronously. "ask" (default policy)
          // still waits on the ApprovalBroker via requestApproval, but passes the bridge itself as
          // the onApprove action, so an APPROVED enter/exit runs the bridge — not executeCall.
          // `newCwd` is captured through the `onCwd` callback in both branches; because
          // runWorktreeBridge is synchronous, the callback (if any) has already run by the time
          // each branch's `await`/direct call returns, so reading `newCwd` right after is safe —
          // and it's reassigned to the loop's local `cwd` so a same-turn follow-up call resolves
          // into (or back out of) the worktree either way (mirrors the plan bridge's same-turn
          // `meta.approvalPolicy` mutation above).
          let newCwd: string | undefined;
          const onCwd = (next: string) => { newCwd = next; };
          if (decision === "ask") {
            outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
              timeoutMs: this.approvalTimeoutFor(meta),
              summary: approvalCardSummary(call),
              // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
            }, loaded, async () => this.runWorktreeBridge(call, sessionId, threadId, cwd, onCwd), pins, rootsOverride, visionCapable);
          } else {
            outcome = this.runWorktreeBridge(call, sessionId, threadId, cwd, onCwd);
          }
          if (newCwd !== undefined) cwd = newCwd;
        } else if (dirGrant) {
          // Out-of-project write/edit under `ask` (the auto/accept-edits/bypass cases were ALL
          // pre-granted + nulled above, so they never reach this branch): ONE grant-flavored card
          // through the SAME requestApproval seam bash/worktree use. SP-policies Task 9 gives it
          // three options — [Allow once, Always allow edits in <dir>, Deny] — and a ONE-SHOT roots
          // override instead of task-24's persistent applyDirGrant session grant:
          //   - `oneShot` = the session's writable set (writableRoots) PLUS this grant dir, passed to
          //     THIS executeCall only. It's never stored, so the write lands but the dir does NOT join
          //     the session roots — no directory_added, no free ride for the next out-of-project write.
          //   - "Always allow edits in <dir>" persists `Edit(<dir>)` at project scope via the option's
          //     rule (ipc/server.ts's approval.respond handler, keyed by optionId) — a FUTURE call then
          //     gets <dir> in writableRoots (Task 6's editPathRules fold), silently. "Allow once"
          //     persists nothing; a repeat out-of-project write cards again.
          // onApprove mkdir's the grant dir FIRST (mkdirForOneShotGrant — NO dirs.add / directory_added,
          // unlike applyDirGrant): the write fence (resolveWithinAny) SKIPS a not-yet-existing root, so
          // a deep new grant dir would drop out of `oneShot` and the just-approved write would fail its
          // own containment; creating it is exactly what was approved. The human card IS the review
          // under `ask` (the AI-reviewer branches below are auto-policy-only). Denial rides
          // requestApproval's deniedByHuman path unchanged (nothing created, nothing persisted).
          const grant = dirGrant; // narrow for the closure
          const oneShot = [...this.writableRoots(sessionId, projectRoot, rootsOverride), grant.dir];
          outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
            timeoutMs: this.approvalTimeoutFor(meta),
            summary: `${call.name} ${grant.path} — outside your project; allow this edit?`,
            // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
            options: [
              { id: "allow_once", label: "Allow once" },
              { id: "allow_project", label: `Always allow edits in ${grant.dir}`, rule: `Edit(${grant.dir})`, scope: "project" },
              { id: "deny", label: "Deny" },
            ],
          }, loaded, async () => {
            const failure = this.mkdirForOneShotGrant(grant.dir);
            if (failure) return { output: failure, isError: true };
            return this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, oneShot, visionCapable);
          }, pins, rootsOverride, visionCapable);
        } else if (call.name === "bash" && bashEscalation.dangerouslyDisableSandbox && !unsandboxedRuleAllowed && meta.approvalPolicy !== "bypass") {
          // SP-policies Task 11: the sandbox-escape gate. Reworked from SP-approvals' always-card
          // floor into a mode split. `!unsandboxedRuleAllowed` guards it because a BashUnsandboxed
          // rule pre-cleared the escape above (set decision="allow"); the branch's own
          // `bashEscalation.dangerouslyDisableSandbox` is still true, so without this guard a
          // pre-cleared escape would still card here.
          //
          // Remaining modes here: auto (reviewer GATES), ask/accept-edits (human card, reviewer
          // annotates). plan denied it (deny branch); dont-ask denied it (ask→deny flip); bypass ran
          // it silently (branch guard); a BashUnsandboxed rule pre-cleared it (unsandboxedRuleAllowed).
          let command = "";
          let justification: string | undefined;
          try {
            const a = JSON.parse(call.argsJson || "{}");
            command = typeof a.command === "string" ? a.command : "";
            justification = typeof a.justification === "string" ? a.justification : undefined;
          } catch { /* review "" */ }
          // The escape card now offers standing memory (v1 offered none): a BashUnsandboxed(<prefix>:*)
          // rule, project or global scope, that a FUTURE matching escape's unsandboxedRuleAllowed
          // pre-clear then silences. `<prefix>` is suggestBashPrefix (same head heuristic as the plain
          // bash card's Bash(<prefix>:*)); the rule string is DISJOINT from Bash — a plain Bash rule
          // never covers an escape (permission-rules.ts Task 5).
          const urule = `BashUnsandboxed(${suggestBashPrefix(command)}:*)`;
          const escapeOptions = [
            { id: "allow_once", label: "Allow once" },
            { id: "allow_unsandboxed_project", label: `Always allow "${urule}" in this project`, rule: urule, scope: "project" as const },
            { id: "allow_unsandboxed_global", label: `Always allow "${urule}" everywhere`, rule: urule, scope: "global" as const },
            { id: "deny", label: "Deny" },
          ];
          const reviewerReady = this.cfg.reviewer && this.cfg.reviewerEnabled?.(cwd) !== false && this.reviewClassEnabled("bash", cwd);
          if (meta.approvalPolicy === "auto" && reviewerReady) {
            // auto: the reviewer is the GATE — safe runs unsandboxed unattended; non-safe/error escalates to
            // the SAME human card the ask path shows. One tool_review is emitted either way.
            let v: { verdict: "safe" | "unsafe" | "error"; reason: string };
            try { v = await this.cfg.reviewer!.review({ class: "bash", command, justification }, signal); }
            catch { v = { verdict: "error", reason: "reviewer unavailable — manual approval required" }; }
            this.emit(sessionId, { type: "tool_review", sessionId, threadId, toolName: call.name, verdict: v.verdict, reason: sanitizeReviewText(v.reason, 300), summary: sanitizeReviewText(approvalCardSummary(call), 160) });
            if (v.verdict === "safe") {
              outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable);
            } else {
              outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
                timeoutMs: this.approvalTimeoutFor(meta), summary: approvalCardSummary(call),
                reviewerReason: sanitizeReviewText(v.reason, 300), options: escapeOptions,
              }, loaded, undefined, pins, rootsOverride, visionCapable);
            }
          } else {
            // ask / accept-edits (or auto with no reviewer configured): human card; the reviewer, when
            // present, ANNOTATES only (never a second gate) — unchanged from SP-approvals.
            let reviewerReason: string | undefined;
            if (reviewerReady) {
              reviewerReason = await this.annotateWithReview({ class: "bash", command, justification }, approvalCardSummary(call), call, sessionId, threadId, signal);
            }
            outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
              timeoutMs: this.approvalTimeoutFor(meta), summary: approvalCardSummary(call),
              reviewerReason, options: escapeOptions,
            }, loaded, undefined, pins, rootsOverride, visionCapable);
          }
        } else if (decision === "ask") {
          outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
            timeoutMs: this.approvalTimeoutFor(meta),
            summary: approvalCardSummary(call),
            // no denialMessage → the helper defaults to `denied by ${res.by}` (unchanged behavior)
            // SP-approvals Task 5: the bash/write/edit "always allow" options — see
            // approvalOptionsFor's own doc comment for why the other sites in this dispatch loop
            // (dirGrant just above, isWorktree above that, the dangerouslyDisableSandbox
            // always-card branch just above THIS one too, reviewAndDispatch's escalation call
            // below, and T10's webFetchCard branch right below THIS one) deliberately pass none of
            // THIS SPECIFIC shape (webFetchCard has its own options, computed by webFetchGate).
            // SP-approvals Task 11: this branch is ALSO where an allowNetwork bash call (no
            // matching rule) cards — approvalCardSummary already renders its "(with network)"
            // label, and approvalOptionsFor's bash options are unchanged (the suggested
            // Bash(<prefix>:*) rule covers a matching call regardless of allowNetwork, by design —
            // spec: "a persisted rule then covers matching network calls silently").
            options: approvalOptionsFor(call),
          }, loaded, undefined, pins, rootsOverride, visionCapable);
        } else if (webFetchCard && meta.approvalPolicy !== "bypass") {
          // SP-approvals Task 10: web_fetch's dangerous-domain floor fires here — reached under
          // EVERY policy (`decision` is unconditionally "allow" for web_fetch now, gate.ts), not
          // just `ask`. `undefined` onApprove → the default executeCall path, same as the plain
          // `decision === "ask"` branch above; the ONLY difference is the summary/options come from
          // webFetchGate instead of approvalCardSummary/approvalOptionsFor.
          //
          // SP-policies Task 10: NOW excludes `bypass` (the guard added to this branch's
          // condition) — bypass is opt-in no-guardrails, so a dangerous-domain fetch under it
          // falls through to the final `else` → executeCall, silently, same as the escape branch
          // above under bypass. And splits the remaining policies by mode: `dont-ask` DENIES
          // outright here (no card — dont-ask never prompts). gate.ts's NETWORK class is
          // unconditionally "allow", so the generic `decision === "ask"` → deny flip earlier in
          // this function never even sees a web_fetch call — this floor is the ONLY place a
          // dont-ask session's dangerous-domain fetch is ever adjudicated, so it needs its own
          // accurate, mode-aware deny message rather than silently inheriting the ask-shaped card.
          // Every OTHER policy (ask/auto/accept-edits/plan) keeps the UNCHANGED approval card below.
          if (meta.approvalPolicy === "dont-ask") {
            outcome = {
              output: `web_fetch denied — dont-ask mode declines a fetch to a dangerous domain with no standing WebFetch rule.`,
              isError: true,
            };
          } else {
            outcome = await this.requestApproval(call, cwd, sessionId, threadId, signal, {
              timeoutMs: this.approvalTimeoutFor(meta),
              summary: webFetchCard.summary,
              options: webFetchCard.options,
            }, loaded, undefined, pins, rootsOverride, visionCapable);
          }
        } else if (call.name === "exit_plan_mode" && this.cfg.plans && meta.approvalPolicy === "plan") {
          outcome = await this.runPlanBridge(call, sessionId, threadId, meta);
        } else if (call.name === "enter_plan_mode") {
          // Unconditional — no PlanBroker/manager dependency to gate on (see runEnterPlanBridge's
          // doc comment). decision is always "allow" here (enter_plan_mode is in gate.ts's
          // READ_ONLY set under every policy), so this branch is reached for every call.
          outcome = await this.runEnterPlanBridge(sessionId, meta);
        } else if (
          // SP-policies Task 8: the reviewer is auto-ONLY — this DROPS the SP-approvals Task 3
          // widening that used to also fire here whenever `ruleAllowed` was true under `ask`
          // policy. A standing rule (or the readOnlyBash classifier) allowing a call under `ask`
          // is a HUMAN pre-authorization: the human already decided this call needs no gate at
          // all, and that decision is final. The reviewer's actual job is to stand in for a human
          // gate that would otherwise fire; under `ask`, a rule-allowed call never reaches a human
          // gate in the first place (`ruleAllowed`, computed above, short-circuits `decision` to
          // "allow" before any of these branches run), so there is nothing left for the reviewer
          // to stand in for. It now runs ONLY under `auto`, where every call — rule-allowed or not
          // — is otherwise gateless and the reviewer is the sole safety net, unchanged in strictness.
          // fs/external reviewer branches below are untouched by this — they were already
          // `=== "auto"`-only (the SP-approvals T3 brief scoped the now-removed widening to bash
          // alone: write/edit's in-root rule coverage is the common case, and out-of-root always
          // keeps its own grant card regardless — see the dirGrant precedence above; external
          // tools have no rule/classifier source at all).
          // SP-policies Task 11: `!bashEscalation.dangerouslyDisableSandbox` excludes a sandbox escape
          // from this ordinary bash reviewer. A rule-pre-cleared escape (unsandboxedRuleAllowed set
          // decision="allow") would otherwise land here and be reviewed+carded like a plain bash call;
          // instead it falls straight through to executeCall (unsandboxed, silent). An UN-pre-cleared
          // escape under auto is handled by the escape branch above (which gates it on the reviewer),
          // never reaching here (that branch's `decision` is "allow" too, but it's checked first).
          decision === "allow" && call.name === "bash" && !bashEscalation.dangerouslyDisableSandbox && this.cfg.reviewer &&
          this.cfg.reviewerEnabled?.(cwd) !== false && meta.approvalPolicy === "auto" && this.reviewClassEnabled("bash", cwd)
        ) {
          let command = "";
          let justification: string | undefined;
          try {
            const a = JSON.parse(call.argsJson || "{}");
            command = typeof a.command === "string" ? a.command : "";
            justification = typeof a.justification === "string" ? a.justification : undefined;
          } catch { /* fall through to review of "" → likely unsafe */ }
          if (command && bashLooksSafe(command, this.cfg.reviewerAllow?.(cwd) ?? [])) {
            // Static bypass — reviewer.review() never runs, so NO tool_review event (phase 5e T2:
            // observability covers actual reviewer invocations, not every gate decision).
            outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable);
          } else {
            outcome = await this.reviewAndDispatch(
              { class: "bash", command, justification }, `${call.name} ${command}`,
              call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable, meta,
            );
          }
        } else if (
          decision === "allow" && (call.name === "write" || call.name === "edit") && this.cfg.reviewer &&
          this.cfg.reviewerEnabled?.(cwd) !== false && meta.approvalPolicy === "auto" && this.reviewClassEnabled("fs", cwd)
        ) {
          // fs coverage (5e T3): review only an UNUSUAL write/edit target (outside the primary cwd
          // subtree, or a dotfile/dot-dir segment inside it) — a plain in-cwd write falls straight
          // to executeCall below, unreviewed, matching today's behavior exactly.
          let path = "";
          try {
            const a = JSON.parse(call.argsJson || "{}") as { path?: unknown };
            path = typeof a.path === "string" ? a.path : "";
          } catch { /* malformed argsJson → executeCall's own zod validation rejects it below */ }
          // Same roots/tmpDir executeCall itself will resolve against (SP-policies Task 6:
          // writableRoots, not the raw session roots) — the review must see EXACTLY the fence
          // executeCall enforces, Edit(<path>)-widened dirs included.
          const fsRoots = this.writableRoots(sessionId, projectRoot, rootsOverride);
          const fsTmpDir = sessionTmpDir(sessionId);
          const resolved = path ? resolveFsReviewTarget(path, fsRoots, fsTmpDir) : null;
          if (resolved && fsWriteIsUnusual(resolved, fsRoots[0]!)) {
            const precis = fsWritePrecis(call, resolved);
            outcome = await this.reviewAndDispatch(
              { class: "fs", precis }, precis,
              call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable, meta,
            );
          } else {
            outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable);
          }
        } else if (
          decision === "allow" && isExternalToolName(call.name) && this.cfg.reviewer &&
          this.cfg.reviewerEnabled?.(cwd) !== false && meta.approvalPolicy === "auto" && this.reviewClassEnabled("external", cwd)
        ) {
          // external coverage (5e T3): ALWAYS reviewed under auto when the class is enabled — no
          // "looks safe" bypass exists for third-party code Norma can't inspect (unlike bash).
          const precis = externalPrecis(call);
          outcome = await this.reviewAndDispatch(
            { class: "external", precis }, precis,
            call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable, meta,
          );
        } else {
          outcome = await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable);
        }

        this.emit(sessionId, { type: "tool_result", sessionId, threadId, callId: call.callId, output: outcome.output, isError: outcome.isError });
        input.push({ type: "tool_result", callId: call.callId, output: outcome.output, isError: outcome.isError });
        // [4f post-tool — normal outcome] observe the executed call's result (success or isError).
        // A pre-tool-blocked normal call `continue`d at Site 2 and never reached here, so it's
        // naturally skipped (hookBlockedCallIds guards it anyway, defense-in-depth).
        if (this.cfg.hooks) await this.firePostTool(sessionId, threadId, call, outcome, hookBlockedCallIds, signal); // [4f I1] interrupt cuts the chain

        // A human explicitly denied this action → end the turn now and return control to the
        // user (Claude Code parity). The denied tool_result is already persisted above, so the
        // NEXT turn's context shows "you tried X, the user denied it" alongside whatever the
        // user then says. Any later calls in this same batch were never emitted/pushed (the
        // loop pushes function_call + tool_result one at a time), so nothing is left dangling.
        if (outcome.deniedByHuman) {
          this.drainRoundImages(sessionId, threadId, calls, input); // clear any staged screenshots (turn ends; input discarded)
          cleanupThreadSteer();
          this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "end_turn", ...usage });
          if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "end_turn", usage); // [4f turn-end] deniedByHuman terminal
          if (opts.depth === 0 && this.cfg.titler) void this.cfg.titler.maybeTitle(sessionId);
          return { finalText: lastText, stopReason: "end_turn" };
        }
      }

      // Computer use (Phase 5 CU): after the whole assistant batch's tool_results are in `input`,
      // append any screenshots the `computer` tool staged this round as `{type:"image"}` user items
      // — the model sees them on the NEXT round's provider call. Placed here (round end, not per
      // call) so an image never splits a function_call/tool_result pair. No-op when nothing staged.
      this.drainRoundImages(sessionId, threadId, calls, input);
    }

    const capMessage = `tool-iteration cap (${effectiveMaxIterations}) reached`;
    cleanupThreadSteer();
    this.emit(sessionId, { type: "agent_error", sessionId, threadId, message: capMessage });
    this.emit(sessionId, { type: "turn_completed", sessionId, threadId, stopReason: "error", ...usage });
    if (this.cfg.hooks) await this.fireTurnEnd(sessionId, threadId, "error", usage); // [4f turn-end] iteration-cap terminal
    return { finalText: lastText, stopReason: "error", errorMessage: capMessage };
  }

  /**
   * 4h-ii-b Task 3 (D6/D7): re-run a FINISHED child thread WITH its full prior context — the
   * engine half of spawn_agent `resume`. Called from the spawn bridge's per-call callback (an
   * early branch that takes over the whole callback for a resume call), and structured so T4's
   * `send_message`-to-a-finished-agent can reuse the SAME "re-run this terminal thread with a new
   * prompt" path (a resume of a finished agent IS a send_message to a finished agent).
   *
   * Returns the {output,isError} outcome the caller drops into `spawnOutcomes` — for a sync resume
   * the child's final text (awaited); for a `run_in_background` resume, {agentId,status:"running"}
   * immediately (the detached run re-completes the registry entry off-turn, exactly like a fresh
   * bg spawn). NO worktree is created or torn down here (D6): a resume reuses `rc.roots`.
   */
  private async resumeThread(args: {
    sessionId: string;
    resumeArg: string;
    prompt: string;
    runInBackground: boolean;
    meta: ReturnType<SessionStore["meta"]>;
    model: string;
    reasoningEffort?: string;
    depth: number;
    parentThreadId: string;
    // ESC cascade (no-timeout task): the RESUMING thread's own signal — folded into a SYNC
    // resume's composite exactly like the fresh sync spawn path, so a user ESC also cancels a
    // child being resumed synchronously (it blocks the parent turn the same way a fresh sync
    // spawn does). A BG resume deliberately ignores it (detached children survive ESC, CC parity).
    parentSignal: AbortSignal;
  }): Promise<{ output: string; isError: boolean }> {
    const { sessionId, resumeArg, prompt, runInBackground, meta, model, reasoningEffort, depth, parentThreadId, parentSignal } = args;

    // D7 — all typed-error guards BEFORE any thread_started re-emit / store write / runThread.
    if (!prompt) return { output: "resume requires a prompt (the new instruction to continue with)", isError: true };
    const entry = this.cfg.bgAgents?.get(resumeArg, sessionId);
    if (!entry) return { output: `no agent '${resumeArg}' to resume`, isError: true };
    if (entry.status === "running") return { output: `agent '${resumeArg}' is still running — use send_message to message it`, isError: true };
    const rc = entry.resume;
    // Defensive (Task 1's contract): an entry may predate the resume-context capture, or have been
    // registered by a caller that never built one — such an agent is simply not resumable.
    if (!rc) return { output: `agent '${resumeArg}' has no saved context to resume`, isError: true };

    // task-15 (CC parity: resume an ABNORMALLY-ended agent) — REPAIR-BY-HISTORY-SHAPE, not a
    // clean-termination refusal. Reconstruct the child's PRE-EXISTING stored history HERE (before
    // the reopen / thread_started re-emit / user_message persist below, so it reflects the child's
    // TRUE end state). CC itself resumes stall-aborted/ESC-aborted/errored agents by repairing a
    // broken transcript rather than refusing it ("the transcript must not contain a tool result
    // without its tool use, or vice versa; append a synthetic error/cancel result when required") —
    // this guard now mirrors that:
    //   - ends on an ASSISTANT message (a cleanly completed/stopped child) → resumable as-is.
    //   - ends on a PAIRED tool_result (a capped or human-denied child's last round — the call
    //     already got its result, just no closing assistant text) → resumable AS-IS, no repair.
    //     Verified against BOTH providers: codex-oauth.ts's streamTurn calls buildRequestBody,
    //     which is openai-compatible.ts's OWN buildRequestBody (the identical function — there is
    //     only one input-mapping codepath in this codebase), whose mapInput is a blind,
    //     order-agnostic 1:1 map with NO adjacency validation at all. And this exact
    //     [...,function_call,function_call_output,message(user)] shape is not hypothetical — it's
    //     what a capped or human-denied MAIN-thread turn already sends to the SAME endpoint on its
    //     very next turn today (historyInput has no clean-termination guard whatsoever), in
    //     production, unconditionally. The old comment here calling this "non-standard adjacency"
    //     was an unverified assumption; it is not the fix — a REAL provider reject.
    //   - ends on an ORPHAN function_call (the call was dispatched — its tool_call event persisted
    //     at engine.ts's per-call dispatch loop — but its tool_result never was: the child
    //     stalled/aborted/errored while the tool was still in flight) → REPAIRED below
    //     (repairOrphanedCalls), never refused. The repair is an IN-MEMORY transform of the
    //     reconstructed input only — never persisted as a fake store event (the store must stay a
    //     truthful record of what actually happened). Review generalization: BECAUSE it is never
    //     persisted, the stored orphan survives forever and reappears buried mid-history in every
    //     LATER reconstruction of this child — so the repair runs UNCONDITIONALLY on every resume
    //     (all three resumable shapes above, not just this one) and scans the WHOLE array, not
    //     just the tail. See repairOrphanedCalls's own doc comment.
    //   - no history at all (child aborted before its very first event ever persisted — a fresh
    //     spawn's opening prompt is never itself stored, see childHistoryInput's KNOWN GAP note) →
    //     still refused, just with a clearer message.
    //   - anything else that isn't an assistant turn (e.g. a trailing BARE user message — only
    //     reachable if a PRIOR resume of this same child itself ended before producing anything new)
    //     stays refused with the original message — out of this fix's scope, unchanged behavior.
    //   A STATUS CHECK IS INSUFFICIENT — status is orthogonal to last-event shape (verified against
    // this file): the tool-iteration cap path (~:1362) returns stopReason:"error" → the completion
    // fork (~:1188) maps that to isError:true → complete(ok:false) → status "failed" (NOT
    // "completed"); the human-denied path (~:1354) emits the denied tool_result then returns
    // stopReason:"end_turn" → isError:false → complete(ok:true) → status "completed" YET its last
    // child event is a tool_result; and a cleanly-stopped child is status "stopped" yet ends on an
    // assistant turn and SHOULD resume. So neither `=== "completed"` nor `!== "failed"` gets this
    // right — only the last-event shape does.
    const priorHistory = this.childHistoryInput(sessionId, entry.threadId);
    // whole-branch #3: a cleanly-finished child whose FINAL round emitted a reasoning item then
    // ended the turn with EMPTY assistant text (see runThread's `if (textBuf.length > 0)` — no
    // assistant_message persisted) leaves a TRAILING reasoning item as its last reconstructed item.
    // Reasoning is opaque, ORDER-TRANSPARENT state (it always PRECEDES the item it reasons for), so
    // it must not count as the terminal shape: walk back past any trailing reasoning items to the
    // last REAL item, then apply the shape check on THAT. A [tool_result, reasoning] tail (mid-tool,
    // cleanly paired, + a stray reasoning item) still lands on the tool_result → allowed (below);
    // a [function_call, reasoning] tail (a stray reasoning item after an orphan) still lands on the
    // orphan function_call → still repaired (below).
    let lastIdx = priorHistory.length - 1;
    while (lastIdx >= 0 && priorHistory[lastIdx]!.type === "reasoning") lastIdx--;
    const lastPrior = priorHistory[lastIdx];
    if (!lastPrior) {
      return {
        output: `agent '${resumeArg}' has no resumable history (it ended before producing anything) — spawn a fresh agent instead`,
        isError: true,
      };
    }
    if (lastPrior.type !== "function_call" && lastPrior.type !== "tool_result" && !(lastPrior.type === "message" && lastPrior.role === "assistant")) {
      return { output: `agent '${resumeArg}' didn't finish cleanly and can't be resumed`, isError: true };
    }

    // T3 REVIEW (MINOR) — REMOVED-WORKTREE guard. An isolation:"worktree" child's worktree is torn
    // down on clean completion, so on resume rc.roots points at a possibly-removed dir; the fs/bash
    // tools would then fence to a gone directory and error confusingly mid-run. rc.roots is only set
    // when the child WAS isolated (undefined → a plain-cwd child, skip); rc.roots[0] is the primary
    // cwd by contract. Reject up front rather than fail confusingly later.
    if (rc.roots && rc.roots[0] && !existsSync(rc.roots[0])) {
      return { output: `cannot resume an isolated agent '${resumeArg}'; its worktree was removed`, isError: true };
    }

    const agentType = rc.agentType ?? "general-purpose";

    // 4h-ii-b Task 4 (SM3, defensive): start the resumed run with a CLEAN thread steer queue. A
    // send_message to the prior (now-terminal) instance is stale on resume — and there is a narrow
    // window where one can be orphaned into this queue: runThread's own cleanupThreadSteer runs at
    // its terminal return BEFORE the detached completion handler flips bgAgents status to terminal,
    // so a delivery in that gap sees "running" and lands here AFTER cleanup. Deleting the key here,
    // before input reconstruction / the round-0 top-drain, guarantees such a message can't be
    // drained into the resumed run (it would otherwise surface as a spurious extra user turn).
    this.threadSteerQueue.delete(entry.threadId);

    // D4 — POLICY ON RESUME (restrict-only, no widen): the MORE RESTRICTIVE of {current session
    // policy, the child's ORIGINAL captured policy}. This never widens beyond the child's original
    // grant (satisfies "a resume can't widen the child's original policy"), AND additionally caps
    // the resumed run at the CURRENT session policy if the session has TIGHTENED since spawn (e.g.
    // the user switched to plan mode) — strictly safer than reusing rc.approvalPolicy verbatim,
    // never wider. Same shallow-copy-only-when-it-narrows discipline as the fresh path's childMeta.
    const childPolicyOnResume = restrictPolicy(meta.approvalPolicy, rc.approvalPolicy);
    const childMeta = childPolicyOnResume !== meta.approvalPolicy ? { ...meta, approvalPolicy: childPolicyOnResume } : meta;

    // D3 — flip the registry entry back to running with a FRESH abort controller (register() can't
    // re-admit a known agentId). reopen() also resets notified so the resumed completion re-fires
    // its reminder (bg path); the sync path re-marks it notified below.
    const entryAbort = new AbortController();
    this.cfg.bgAgents!.reopen(entry.agentId, entryAbort);

    // D2 — re-emit thread_started so both client reducers RE-ADD the child (they prune all child
    // items on the main thread's turn_completed, and dedupe thread_started by threadId → a no-op if
    // still present, a correct re-add if pruned). parentThreadId is the RESUMING thread. The NEW
    // prompt rides thread_started.prompt (what the clients render as the child's prompt), so the
    // child user_message persisted below needs no separate broadcast for display.
    this.emit(sessionId, {
      type: "thread_started", sessionId, threadId: entry.threadId, parentThreadId,
      agentType, prompt, description: rc.description,
    });
    // registerThread would PUSH a second thread.list entry for the same child on every resume — D2
    // says "call registerThread", but a literal push double-lists the child; refine to flip the
    // EXISTING entry back to running in place (register it only if somehow absent). thread_started's
    // own by-threadId dedupe already covers the client-facing event stream.
    const existingThread = this.threadsFor(sessionId).find((t) => t.threadId === entry.threadId);
    if (existingThread) { existingThread.status = "running"; existingThread.stopReason = undefined; }
    else this.registerThread(sessionId, { threadId: entry.threadId, parentThreadId, agentType, status: "running" });

    // D1 — persist the NEW prompt as a child-scoped user_message BEFORE reconstructing input, so
    // childHistoryInput picks it up as the LAST child event. Without this, resume #1 works but
    // resume #2's reconstruction loses the between-assistants user turn (see childHistoryInput's
    // KNOWN GAP note and this task's D1). The store's first_message index special-cases
    // threadId==="main" only, so a child user_message appends without mis-indexing. runThread does
    // NOT re-persist its input, so this event is written exactly once (pinned by an engine test).
    this.emit(sessionId, { type: "user_message", sessionId, threadId: entry.threadId, text: prompt, clientName: "resume" });
    // Reconstruct: opening prompt (the fresh spawn never persisted it) + the child's OWN stored
    // history (now ending with the prompt just persisted). task-15 (review-generalized): repair
    // ALWAYS runs, on this fresh full reconstruction — every orphaned function_call anywhere in
    // the history (a fresh one at the tail, or one BURIED mid-history by a prior repaired resume —
    // the repair is in-memory-only, so the stored orphan persists forever and resurfaces in every
    // later reconstruction) gets its synthetic cancellation tool_result spliced in right after it,
    // never touching the store. A fully-paired history passes through content-identical (pure
    // no-op). Each synthetic lands adjacent to its own call, so the just-persisted new-prompt
    // user_message stays LAST: [ ...history (with synthetics paired in), new user message ].
    const input: TurnInputItem[] = [
      { type: "message", role: "user", content: rc.openingPrompt },
      ...this.repairOrphanedCalls(this.childHistoryInput(sessionId, entry.threadId)),
    ];

    // D5 — replay the EXACT runThread args captured at spawn (fresh Sets from the arrayified
    // snapshots), NOT re-derived: rc.depth (the child's own depth, gates its grandchild spawns),
    // rc.instructions/cwd/roots/maxTurns, rc.model ?? the resuming turn's model. reasoningEffort is
    // the CURRENT resuming turn's effort (inherited per-turn, not frozen at spawn). Both the sync
    // and bg forks fold entryAbort.signal into the run signal, mirroring the fresh path; a SYNC
    // resume additionally folds `parentSignal` (ESC cascade — see the args doc comment above),
    // exactly like the fresh sync spawn. `progress` (no-timeout task) threads through to
    // runThread's per-provider-event stall-reset chokepoint, mirroring both fresh paths.
    const runResumed = (childSignal: AbortSignal, progress: () => void) => this.runThread({
      sessionId,
      threadId: entry.threadId,
      instructionsFull: rc.instructions,
      input,
      cwd: rc.cwd,
      model: rc.model ?? model,
      reasoningEffort,
      meta: childMeta,
      depth: rc.depth,
      signal: runInBackground
        ? AbortSignal.any([childSignal, entryAbort.signal])
        : AbortSignal.any([parentSignal, childSignal, entryAbort.signal]),
      loaded: new Set(rc.loaded),
      excludeTools: new Set(rc.excludeTools),
      allowTools: rc.allowTools ? new Set(rc.allowTools) : undefined,
      maxTurns: rc.maxTurns,
      rootsOverride: rc.roots,
      onProgress: progress,
    });

    // D6 — same sync/bg fork the fresh path uses; `reentrant` keys off the RESUMING thread's depth
    // (a depth>0 resumer already holds a SubagentManager slot), exactly like the fresh spawn.
    if (runInBackground) {
      // No-timeout task: the old `timeoutMs: depth === 0 ? null : undefined` override is retired
      // with the manager's default wall clock itself — a resumed detached child is bounded by the
      // exact same set as a fresh bg spawn (stall watchdog at every depth, iteration cap,
      // task_stop at depth 0, optional explicit settings wall clock) — see the fresh bg spawn's
      // own run() opts comment.
      void this.cfg.subagents!.run(async (childSignal, progress) => runResumed(childSignal, progress), {
        reentrant: depth > 0,
      })
        .then((result) => {
          // task-16 (Stalled roster verb): see the fresh bg spawn's `.then` handler's identical
          // comment above.
          const stopReason = result.ok ? result.value.stopReason : result.stalled ? "stalled" : "error";
          this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason });
          this.completeThread(sessionId, entry.threadId, stopReason);
          this.cfg.bgAgents!.complete(entry.agentId, !result.ok
            ? { ok: false, result: this.subagentFailureText(agentType, result, sessionId, entry.threadId) }
            : result.value.stopReason === "error"
              ? { ok: false, result: `subagent (${agentType}) failed: ${result.value.errorMessage ?? "provider error"}` }
              : { ok: true, result: result.value.finalText || "the subagent finished without a final message" },
            // 4h-ii-c: only reachable with an EXPLICIT wall clock configured (the manager has no
            // default one anymore — no-timeout task) — kept wired, same as the fresh bg spawn's
            // `.then`, so a timed-out resumed child is never misreported as generic "failed".
            !result.ok && result.timedOut ? { timedOut: true } : undefined);
          // bg-retrigger T1 (concern fix): LAST, exactly like the fresh detached spawn's `.then` —
          // a detached RESUME completion is as invisible to the parent as a fresh bg spawn's, and
          // reopen() reset `notified`, so the resumed run's OWN completion notifies again (CC parity).
          this.notifyBgCompletion(sessionId, entry.agentId);
        })
        .catch((err) => {
          // Defensive: SubagentManager.run() never throws; this guards a throw in the .then handler
          // above so a detached resume never leaves an unhandled rejection.
          const message = err instanceof Error ? err.message : String(err);
          this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason: "error" });
          this.completeThread(sessionId, entry.threadId, "error");
          this.cfg.bgAgents!.complete(entry.agentId, { ok: false, result: message });
          // bg-retrigger T1 (concern fix): LAST, mirroring the `.then` above — the single-consumer
          // claim makes a double persist impossible even if the .then already notified before throwing.
          this.notifyBgCompletion(sessionId, entry.agentId);
        })
        .catch(() => { /* terminal net: a throw in the .catch above (persistent IO fault on the completion emit) has no caller to surface to on a detached run — swallow rather than emit an unhandled rejection */ });
      const resumeOutputFile = this.transcriptPathFor(sessionId, entry.threadId);
      return { output: JSON.stringify({ agentId: entry.threadId, status: "running", ...(resumeOutputFile ? { outputFile: resumeOutputFile } : {}) }), isError: false };
    }

    const result = await this.cfg.subagents!.run(async (childSignal, progress) => runResumed(childSignal, progress), { reentrant: depth > 0 });
    // task-16 (Stalled roster verb): see the fresh sync spawn's identical comment above.
    const stopReason = result.ok ? result.value.stopReason : result.stalled ? "stalled" : "error";
    this.emit(sessionId, { type: "thread_completed", sessionId, threadId: entry.threadId, stopReason });
    this.completeThread(sessionId, entry.threadId, stopReason);
    // Mirrors the fresh sync spawn's outcome branch exactly (no-timeout task): a stall routes
    // through subagentFailureText (partial-output surfacing), an ESC-aborted resume reads as an
    // abort — never a stall/timeout message, never a fake success from a half-finished finalText.
    const outcome: { output: string; isError: boolean } = !result.ok
      ? { output: this.subagentFailureText(agentType, result, sessionId, entry.threadId), isError: true }
      : result.value.stopReason === "error"
        ? { output: `subagent (${agentType}) failed: ${result.value.errorMessage ?? "provider error"}`, isError: true }
        : result.value.stopReason === "aborted"
          ? { output: `subagent (${agentType}) aborted`, isError: true }
          // CC parity (SYNC result trailer) — same helper the fresh sync spawn path uses.
          : { output: (result.value.finalText || "the subagent finished without a final message") + this.syncTrailer(entry.threadId, this.transcriptPathFor(sessionId, entry.threadId)), isError: false };
    // { notified: true }: this sync resume's result reached the caller directly as its own
    // tool_result this same turn, so a later takeForNotification claim must never re-surface
    // it (same reasoning as the fresh sync path). `timedOut` (4h-ii-c): only reachable with an
    // EXPLICIT wall clock configured (no default clock anymore — no-timeout task); kept threaded
    // so such a child reports "timeout", not "failed".
    this.cfg.bgAgents!.complete(entry.agentId, { ok: !outcome.isError, result: outcome.output },
      { notified: true, timedOut: !result.ok && result.timedOut });
    return outcome;
  }

  /** Workflows: bridges a workflow script's agent() call to the SAME SubagentManager/runThread path
   *  spawn_agent uses. The child runs at accept-edits (Global Constraints — the launch gate on the
   *  Workflow tool call itself is the human's one consent point) and is EXCLUDED from the Workflow
   *  tool (nesting depth 1). Returns a plain {ok,result} the WorkflowRuntime posts back over the
   *  bridge. Never throws — SubagentManager.run never throws (subagents.ts). */
  async runWorkflowAgent(
    sessionId: string, prompt: string, opts: { label?: string; model?: string; schema?: unknown } | undefined, signal: AbortSignal,
  ): Promise<{ ok: boolean; result: string }> {
    if (!this.cfg.subagents || !this.cfg.agents) return { ok: false, result: "subagents are not available in this session" };
    const meta = this.cfg.store.meta(sessionId);
    const cwd = meta.cwd;
    if (!cwd) return { ok: false, result: "session has no working directory" };
    const agentType = opts?.label ?? "general-purpose";
    const def = this.cfg.agents.resolve(agentType, cwd);
    const childCwd = cwd;
    const childPolicy: SessionApprovalPolicy = "accept-edits";
    const childMeta = { ...meta, approvalPolicy: childPolicy };
    const childId = "wfa_" + randomUUID().slice(0, 8); // same minting shape as the spawn bridge (engine.ts: "th_" + randomUUID().slice(0,8))
    const childLoaded = new Set<string>();
    const instructionsFull = this.buildInstructionsFull(def.instructions, childCwd, childLoaded, childPolicy, sessionId);
    const childExcludeTools = new Set(["ask_user", "exit_plan_mode", "enter_plan_mode", "send_message", "task_stop", "agent_list", "agent_output", "skill_write", SESSION_SPAWN_TOOL, WORKFLOW_TOOL]);
    this.registerThread(sessionId, { threadId: childId, parentThreadId: MAIN_THREAD, agentType, status: "running" });
    this.emit(sessionId, { type: "thread_started", sessionId, threadId: childId, parentThreadId: MAIN_THREAD, agentType, prompt, description: opts?.label });
    const result = await this.cfg.subagents.run(async (childSignal, progress) => this.runThread({
      sessionId, threadId: childId, instructionsFull,
      input: [{ type: "message", role: "user", content: prompt }],
      cwd: childCwd, model: opts?.model ?? this.cfg.provider.model, meta: childMeta, depth: 1,
      signal: AbortSignal.any([childSignal, signal]),
      loaded: childLoaded, excludeTools: childExcludeTools, allowTools: def.allowTools, onProgress: progress,
    }));
    const stopReason = result.ok ? result.value.stopReason : result.stalled ? "stalled" : "error";
    this.emit(sessionId, { type: "thread_completed", sessionId, threadId: childId, stopReason });
    this.completeThread(sessionId, childId, stopReason);
    if (!result.ok) return { ok: false, result: this.subagentFailureText(agentType, result, sessionId, childId) };
    if (result.value.stopReason === "error") return { ok: false, result: `workflow agent (${agentType}) failed: ${result.value.errorMessage ?? "provider error"}` };
    return { ok: true, result: result.value.finalText || "the agent finished without a final message" };
  }

  /** phase 5e T3: class-off flag — T4 threads settings.reviewerClasses into cfg; until then a
   *  caller sets cfg.reviewerClasses directly (see its own doc comment). Absent object OR absent
   *  per-class key → enabled; only an EXPLICIT `false` disables that class. hot-settings T2:
   *  `reviewerClasses` is now a getter, called fresh here — an absent getter, or one that
   *  resolves to undefined/an absent key, both fall through to the same enabled-by-default `!==
   *  false` check. Task 8 (CC project-folder-mechanics): takes the caller's in-scope `cwd` and
   *  threads it into `reviewerClasses` so daemon.ts's real wiring can resolve a PER-PROJECT
   *  override; every call site (the dispatch loop's bash/fs/external reviewer branches) passes its
   *  own branch-local `cwd`. */
  private reviewClassEnabled(cls: "bash" | "fs" | "external", cwd: string | undefined): boolean {
    return this.cfg.reviewerClasses?.(cwd)?.[cls] !== false;
  }

  /** SP-approvals T11 review, MEDIUM-1 (CC parity: an unsandboxed retry still rides the normal
   *  review path, which includes the reviewer under auto) — runs the SAME bash reviewer as
   *  reviewAndDispatch below, but strictly as an ANNOTATION on the dangerouslyDisableSandbox
   *  always-card, never as a second gate: unlike reviewAndDispatch (which escalates/executes off
   *  the verdict), the verdict here is NEVER read for auto-approve/deny purposes — only `.reason`
   *  is returned, for the caller to attach to its own ALREADY-DECIDED card via `reviewerReason`.
   *  Emits EXACTLY ONE `tool_review` per invocation, for every verdict (safe/unsafe/error) — same
   *  shape and the same fail-closed-to-"error" degradation on a throw/timeout as
   *  reviewAndDispatch's own verdict computation — so this is indistinguishable, from the
   *  observability side, from any other bash review. Returns `undefined` ONLY on an "error"
   *  verdict (fail-open on the ANNOTATION only — the caller's card fires regardless either way, it
   *  just shows no reviewer text); a genuine safe OR unsafe verdict's `.reason` is always
   *  returned — the reviewer's stated opinion is useful context on this card either way, since the
   *  CARD (never the verdict) is what actually gates the run. Deliberately does NOT consult
   *  bashLooksSafe's static bypass (see the one call site's own doc comment for why). */
  private async annotateWithReview(
    reviewInput: ReviewInput,
    toolSummary: string,
    call: { name: string },
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let v: { verdict: "safe" | "unsafe" | "error"; reason: string };
    try {
      v = await this.cfg.reviewer!.review(reviewInput, signal);
    } catch {
      v = { verdict: "error", reason: "reviewer unavailable — manual approval required" };
    }
    this.emit(sessionId, {
      type: "tool_review", sessionId, threadId, toolName: call.name, verdict: v.verdict,
      reason: sanitizeReviewText(v.reason, 300),
      summary: sanitizeReviewText(toolSummary, 160),
    });
    return v.verdict === "error" ? undefined : sanitizeReviewText(v.reason, 300);
  }

  /** phase 5e T3: the machinery every review class shares (T2's original bash-only flow,
   *  generalized) — call reviewer.review(), emit EXACTLY ONE tool_review (safe/unsafe/error), and
   *  on any non-safe verdict escalate via requestApproval; on safe, run the call normally. This is
   *  the ONE place that verdict/emission/escalation happens for bash/fs/external alike, so a class
   *  can never drift from another's handling of the same verdict. The only per-class variance left
   *  here is denialMessage's justification-reconsideration sentence — BASH ONLY, because only
   *  bash's tool schema offers a `justification` param for the reviewer to reconsider on retry;
   *  fs/external get the same "blocked by the safety reviewer: <reason>" + timeout sentence with
   *  that clause dropped. */
  private async reviewAndDispatch(
    reviewInput: ReviewInput,
    toolSummary: string,
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    loaded: Set<string>,
    pins: Set<string>,
    rootsOverride: string[] | undefined,
    visionCapable: boolean | undefined,
    // Whole-branch fix wave: a dispatch child is unattended by design (see approvalTimeoutFor's own
    // doc comment) — this is the HIGHEST-risk approval path (the reviewer already flagged the call
    // unsafe/errored), so it must never hand a dispatch child the SHORTEST window. `meta.origin`
    // is all this needs (mirrors approvalTimeoutFor's own signature).
    meta: { origin?: string },
  ): Promise<{ output: string; isError: boolean; deniedByHuman?: boolean }> {
    // "error" (phase 5e T2): review() THREW (fail-closed) — distinct from a genuine "unsafe"
    // verdict for tool_review observability, though both escalate identically.
    let v: { verdict: "safe" | "unsafe" | "error"; reason: string };
    try {
      v = await this.cfg.reviewer!.review(reviewInput, signal);
    } catch {
      v = { verdict: "error", reason: "reviewer unavailable — manual approval required" };
    }
    // Exactly one tool_review per ACTUAL review() invocation, for every verdict — sanitized+capped
    // at emission (reason<=300, summary<=160), never the raw client-observability-only fields
    // eventToInput ignores.
    this.emit(sessionId, {
      type: "tool_review", sessionId, threadId, toolName: call.name, verdict: v.verdict,
      reason: sanitizeReviewText(v.reason, 300),
      summary: sanitizeReviewText(toolSummary, 160),
    });
    if (v.verdict === "safe") {
      return await this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable);
    }
    // Whole-branch fix wave: env can still WIDEN a dispatch child's window beyond 10 minutes, but
    // never narrows it below that floor (same "env widens, never narrows the child floor" contract
    // approvalTimeoutFor documents for the ask-path/worktree sites above) — a non-child session's
    // window is exactly `reviewTimeoutMs`, unchanged. The denial message is derived from whichever
    // value is ACTUALLY used here, never a hardcoded "60s" — so a client is never told a shorter
    // wait than what's really about to happen (the bug this fix closes).
    const reviewTimeoutMs = Number(process.env.NORMA_REVIEW_APPROVAL_TIMEOUT_MS ?? 60_000);
    const timeoutMs = meta.origin === "dispatch-child" ? Math.max(reviewTimeoutMs, 600_000) : reviewTimeoutMs;
    const timeoutSec = Math.round(timeoutMs / 1000);
    const denialMessage =
      reviewInput.class === "fs" || reviewInput.class === "external"
        ? `blocked by the safety reviewer: ${v.reason}. No approval within ${timeoutSec}s.`
        : `blocked by the safety reviewer: ${v.reason}. No approval within ${timeoutSec}s. If this command is genuinely necessary, call bash again with a "justification" explaining why — the reviewer will reconsider.`;
    return await this.requestApproval(call, cwd, sessionId, threadId, signal, {
      timeoutMs,
      // Plain call summary (approvalCardSummary, same as every other card) — reviewerReason below
      // carries the reason for clients to render distinctly.
      summary: approvalCardSummary(call),
      reviewerReason: sanitizeReviewText(v.reason, 300),
      denialMessage,
    }, loaded, undefined, pins, rootsOverride, visionCapable);
  }

  /** write-permission-flow (task 24): apply an out-of-root write/edit grant — mkdir the directory
   *  (review F3: SessionDirectories.canon and resolveWithinAny both realpath roots, so a
   *  NOT-YET-EXISTING grant dir would silently drop out of the fence right after being "granted"
   *  and the approved write would still fail; creating the directory is exactly what the user
   *  approved), then add it to the session's live roots and emit `directory_added` (existing
   *  protocol event, already rendered by CLI/dashboard — observability, not an approval). Returns
   *  an error message instead of throwing (mkdir can fail: EACCES/EROFS/a FILE already at that
   *  path) — on failure NOTHING is granted and no event is emitted. Both grant sites (the auto
   *  pre-grant and the ask card's onApprove) share this ONE definition. */
  private applyDirGrant(sessionId: string, threadId: string, dir: string): string | null {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.cfg.dirs.add(sessionId, dir);
    this.emit(sessionId, { type: "directory_added", sessionId, threadId, path: dir, persisted: false });
    return null;
  }

  /** SP-policies Task 9: the mkdir-ONLY half of applyDirGrant — create a grant dir so an APPROVED
   *  out-of-project edit's write can land, WITHOUT the persistent session grant applyDirGrant does
   *  (no `dirs.add`, no `directory_added`). The `ask`-card path grants ONE-SHOT (the write rides an
   *  explicit `oneShot` roots override for this call only; durable coverage comes from the
   *  "Always allow edits in <dir>" Edit(<dir>) rule instead, if chosen), so it must NOT extend the
   *  session roots. The mkdir itself is still required: the write fence (resolveWithinAny) SKIPS a
   *  not-yet-existing root, so a deep new grant dir would otherwise drop out of `oneShot` and the
   *  write would fail its own containment. Returns an error string on failure (EACCES/EROFS/...),
   *  the same shape applyDirGrant surfaces, else null. */
  private mkdirForOneShotGrant(dir: string): string | null {
    try {
      mkdirSync(dir, { recursive: true });
      return null;
    } catch (err) {
      return `could not create ${dir}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** write-permission-flow hardening (task-24 review F2): true when `dir` (a computed grant dir —
   *  already canonicalized by fsWriteOutOfRootDir: existing part realpathed, missing tail literal)
   *  must never be granted. BIDIRECTIONAL containment against each denied prefix (realpathed here,
   *  mirroring fs-read.ts's canonicalizeDenylist): `dir` at/under a prefix is the direct case;
   *  `dir` CONTAINING a prefix is the indirect one — fence containment is subtree-based, so
   *  granting an ANCESTOR of ~/.norma/run would make the control plane writable through that root
   *  just as surely as granting it directly (and bash's seatbelt shares the session roots). */
  private grantDenied(dir: string): boolean {
    for (const p of this.cfg.grantDeniedPrefixes ?? []) {
      let cp: string;
      try { cp = realpathSync(p); } catch { cp = resolve(p); }
      if (dir === cp || dir.startsWith(cp + sep) || cp.startsWith(dir + sep)) return true;
    }
    return false;
  }

  /** SP-policies Task 6: the session's writable-dir set — `dirs.roots(sessionId)` (or a worktree
   *  child's FIXED `rootsOverride`) UNIONED with the absolute dirs a hand-authored `Edit(<path>)`
   *  rule declares for this project (PermissionRules.editPathRules). Consulted by BOTH the
   *  write/edit fence (fsWriteOutOfRootDir, controlPlaneFileTarget, the fs-reviewer's fsRoots)
   *  AND bash's seatbelt (executeCall's ctx.roots — tools/bash.ts realpaths this exact array into
   *  sandbox.ts's buildSeatbeltProfile `(subpath ...)` rules), so one Edit rule widens both
   *  surfaces identically. A worktree-isolated child (`rootsOverride` set) keeps its FIXED
   *  confinement — Edit rules never widen it, mirroring fsWriteOutOfRootDir's own `!rootsOverride`
   *  guard at its call site (a grant there would be a no-op anyway: SessionDirectories.add can
   *  never extend a worktree child's roots).
   *
   *  SECURITY GUARD (Task 4 reviewer carry-forward): `editPathRules` returns raw, unvetted dirs — a
   *  rule string a human (or a persuaded model, via the "always allow" approval option) can write
   *  directly. Two shapes must NEVER be unioned in as-is:
   *   - the bare filesystem root "/" — checked explicitly, BEFORE `grantDenied`, because
   *     `grantDenied`'s own bidirectional containment check (`dir.startsWith(cp + sep)`) degenerates
   *     for a bare "/" (`"/" + sep` is `"//"`, which no real absolutized path ever starts with) and
   *     so would never itself catch it. Without this, `Edit(/)` would leak "/" into bash's seatbelt
   *     roots and make the ENTIRE disk bash-writable (sandbox.ts's `subpath` is a real macOS
   *     Seatbelt primitive with no equivalent quirk — `subpath "/"` truly matches everything).
   *   - any dir `grantDenied` already refuses to grant (the SAME `~/.norma`-class control-plane
   *     denylist the out-of-root dirGrant flow uses) — an `Edit(~/.norma)` (or an ancestor/
   *     descendant of it) must not silently become "in-root" either, or every downstream check that
   *     exists specifically to protect the control plane (dirGrantDenied's hard-error branch,
   *     controlPlaneFileTarget's own identity check) would simply never run for it: `dirGrant`
   *     would compute as `null` (the call looks ordinary, in-root), so `dirGrantDenied`'s
   *     `grantDenied` check — which only ever runs when `dirGrant` is non-null — is never reached.
   *  Each Edit dir is realpath-resolved FIRST (`realpathSync`) — and a not-yet-existing dir is
   *  SKIPPED entirely, never raw-fallback-included — so a symlinked Edit dir resolves to the identity
   *  `grantDenied` itself expects (mirrors `controlPlaneFileTarget`'s filesystem-identity-over-
   *  string-spelling principle), and a missing root can never reach bash's realpath/Seatbelt (which
   *  would ENOENT-crash every bash call). See the loop below. */
  private writableRoots(sessionId: string, projectRoot: string | null, rootsOverride: string[] | undefined): string[] {
    const base = rootsOverride ?? this.cfg.dirs.roots(sessionId);
    if (rootsOverride || !this.cfg.permissionRules || projectRoot === null) return base;
    const editDirs: string[] = [];
    for (const raw of this.cfg.permissionRules.editPathRules(projectRoot)) {
      // SP-policies Task 6 review (HIGH + MEDIUM): realpath-or-SKIP, never a raw fallback. A
      // not-yet-existing Edit dir is SKIPPED entirely — every session root MUST exist (bash.ts
      // realpaths ctx.roots and sandbox.ts turns each into a Seatbelt subpath; a missing root
      // ENOENT-crashes EVERY bash call in the session, not just a write to that dir). realpathSync
      // also fully resolves symlinks, so a symlinked Edit path can't dodge the grantDenied denylist
      // below by pointing a not-yet-real tail at the control plane — an unresolvable tail just drops.
      let real: string;
      try { real = realpathSync(raw); } catch { continue; }
      if (real === "/" || this.grantDenied(real)) continue; // "/" (whole disk) + ~/.norma control plane
      editDirs.push(real);
    }
    return editDirs.length ? [...new Set([...base, ...editDirs])] : base;
  }

  /** SP-approvals Task 10 (spec §7): web_fetch's dangerous-domain floor — the ONE thing that still
   *  cards for web_fetch now that gate.ts's NETWORK class is unconditionally "allow". Called from
   *  the dispatch loop for EVERY `call.name === "web_fetch"`, regardless of `meta.approvalPolicy`
   *  (ask, auto, AND plan — a floor, not a policy-gated check: NETWORK is allowed in plan for
   *  read-only research, so a plan-mode session must not get a silent bypass either). Returns
   *  `null` when the call should just run — a well-formed URL whose host matches nothing dangerous,
   *  OR one that DOES match but is already covered by a standing `WebFetch(domain:...)` exception
   *  rule (the "Always allow from this source" option's own persistence target) — otherwise the
   *  `{summary, options}` for the approval card this call must show.
   *
   *  Fails CLOSED on an unparseable/missing `url`, AND on a `url` that parses but carries no
   *  hostname at all (LOW-3, SP-approvals T10 review — e.g. a `file://` URL, whose `.hostname` is
   *  `""`): neither case has a host to evaluate against the dangerous list, so there is nothing
   *  safe to allow — `webFetchApprovalOptions(undefined, undefined)` gives that card only
   *  Allow/Deny, no "always allow" option. (`tools/web.ts`'s `ssrfGuard` still separately refuses
   *  private/loopback/non-http(s) targets at execute time regardless of this floor's verdict.) */
  private webFetchGate(call: { name: string; argsJson: string }, cwd: string): { summary: string; options: ApprovalOption[] } | null {
    let url: URL;
    try {
      const a = JSON.parse(call.argsJson || "{}") as { url?: unknown };
      if (typeof a.url !== "string") throw new Error("missing url");
      url = new URL(a.url);
    } catch {
      return {
        summary: `web_fetch — could not parse the url argument to check it against the dangerous-domain list`,
        options: webFetchApprovalOptions(undefined, undefined),
      };
    }
    const host = url.hostname.toLowerCase();
    if (!host) {
      return {
        summary: `web_fetch ${url.toString()} — the URL has no hostname to check against the dangerous-domain list`,
        options: webFetchApprovalOptions(undefined, undefined),
      };
    }
    const added = this.cfg.dangerousDomainsAdded?.(cwd) ?? [];
    const matchedEntry = dangerousDomainMatch(host, [...SHIPPED_DANGEROUS_DOMAINS, ...added]);
    if (matchedEntry === null) return null; // nothing dangerous about this host — free by default
    // `projectRoot` mirrors the SAME ternary the ruleAllowed block above uses (a defensive guard
    // against an empty cwd, not a real-world case — cwd is always set by the time a tool call
    // dispatches). WebFetch(domain:...) rules only ever ride GLOBAL scope from this card (see
    // webFetchApprovalOptions), but decision() itself is scope-generic — a hand-edited project rule
    // works too (proven in permission-rules.test.ts), so this still passes a real project root.
    const projectRoot = cwd ? repoRootFor(cwd) : null;
    if (this.cfg.permissionRules?.decision({ name: call.name, argsJson: call.argsJson }, projectRoot) === "allow") return null;
    return {
      summary: `web_fetch ${url.toString()} — ${host} matches a dangerous-domain rule (known exfiltration/tunnel-provider risk)`,
      options: webFetchApprovalOptions(host, matchedEntry),
    };
  }

  /** Shared approval-request flow for the `ask`-policy path, the reviewer's escalation path, and
   *  (1d-iii) the worktree bridge's ask-policy path. Registers the broker wait BEFORE emitting
   *  `approval_requested` — the broadcast is synchronous, so a watcher that resolves the approval
   *  as soon as it observes the event (see engine.test.ts) would otherwise race `broker.wait()`
   *  and resolve into an empty pending-map slot, timing out. On denial, `opts.denialMessage` lets
   *  a caller (the reviewer path) override the default `denied by ${res.by}` string with a
   *  retry-hint message; the `ask` path passes no override, preserving that exact string
   *  byte-for-byte. `onApprove` lets a caller run something OTHER than executeCall when approved
   *  (the worktree dispatch branch passes the worktree bridge here); omitted (the `ask`/reviewer
   *  callers above), it defaults to `executeCall` — behavior-preserving for every existing caller.
   *  `pins` (4g-i) is the CALLING round's pinnedTools() result — forwarded to executeCall's
   *  default path unchanged; callers that pass their own `onApprove` (the worktree bridge) don't
   *  need it, but still supply it for signature uniformity (defaults to an empty Set).
   *  `loaded` (4g final-review fix) is the CALLING THREAD's live `loaded` set (runThread's
   *  `opts.loaded` — the same object for every caller in this file, main or child) — forwarded
   *  unchanged to executeCall's default path so an approved call's load/defense-in-depth check
   *  lands on the thread that actually asked, not always the session-scoped map.
   *  `rootsOverride` (4h-i Task 4) — forwarded unchanged to executeCall's default path; callers
   *  that pass their own `onApprove` (the worktree bridge) don't need it. */

  /** Dispatch (Phase 7) Task 6: relayed child approvals fail closed after 10 minutes (CC parity —
   *  there's no live human necessarily watching the child directly, so the mirrored card in the
   *  dispatch stream needs a longer fuse than a directly-attended session's default 5); everything
   *  else keeps the configured/default 5. The broker already resolves {approved:false, by:
   *  "timeout"} on expiry (approvals.ts) — this only widens the WINDOW for dispatch children, the
   *  fail-closed behavior itself is unchanged. Used at all three requestApproval call sites below
   *  that previously inlined `this.cfg.approvalTimeoutMs ?? 5 * 60_000` directly. */
  private approvalTimeoutFor(meta: { origin?: string }): number {
    if (meta.origin === "dispatch-child") return 600_000;
    return this.cfg.approvalTimeoutMs ?? 5 * 60_000;
  }

  private async requestApproval(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    // reviewerReason (phase 5e T2): populated ONLY by the reviewer-escalation call site — an
    // ask-policy or reviewer-less card omits it, matching the protocol field's additive-optional
    // shape (older-shaped events, and every non-reviewer caller here, still parse/behave unchanged).
    opts: {
      timeoutMs: number; summary: string; denialMessage?: string; reviewerReason?: string;
      // SP-approvals Task 5: populated ONLY by the plain ask-policy call site below
      // (approvalOptionsFor) — the dirGrant/worktree/reviewer-escalation call sites all omit it, so
      // `options` stays `undefined` on their broker meta + emitted event, byte-identical to before
      // this field existed.
      options?: ApprovalOption[];
    },
    loaded: Set<string>,
    onApprove?: () => Promise<{ output: string; isError: boolean }>,
    pins: Set<string> = new Set(),
    rootsOverride?: string[],
    // Computer use (Phase 5 CU): forwarded to the default onApprove's executeCall so an approved
    // `computer` screenshot under `ask` policy still sees the model's vision capability.
    visionCapable?: boolean,
  ): Promise<{ output: string; isError: boolean; deniedByHuman?: boolean }> {
    // issuedAt/expiresAt computed ONCE and threaded to BOTH the broker (so approval.list surfaces
    // the same deadline) and the emitted event — keeping list().expiresAt === event.expiresAt for
    // the same approval. expiresAt is the broker's fail-closed deadline (SP3 T4b).
    const issuedAt = Date.now();
    const expiresAt = issuedAt + opts.timeoutMs;
    const waiting = this.cfg.broker.wait(sessionId, call.callId, opts.timeoutMs, {
      toolName: call.name, summary: opts.summary, issuedAt, expiresAt, options: opts.options,
    });
    try {
      this.emit(sessionId, {
        type: "approval_requested", sessionId, threadId, callId: call.callId, toolName: call.name,
        summary: opts.summary, issuedAt, expiresAt, reviewerReason: opts.reviewerReason, options: opts.options,
      });
    } catch (err) {
      // emit failed (e.g. disk): resolve the registered waiter now so it doesn't linger until timeout
      this.cfg.broker.resolve(sessionId, call.callId, false, "emit-failure");
      throw err;
    }
    const res = await waiting;
    this.emit(sessionId, { type: "approval_resolved", sessionId, threadId, callId: call.callId, approved: res.approved, by: res.by });
    if (res.approved) {
      return await (onApprove ? onApprove() : this.executeCall(call, cwd, sessionId, threadId, signal, loaded, pins, rootsOverride, visionCapable));
    }
    // An EXPLICIT human denial (any `by` other than the broker's "timeout") ends the turn and
    // hands control back to the user (Claude Code parity) — see the caller's `deniedByHuman`
    // check in the tool loop. Crucially it does NOT invite a "retry with a justification"
    // (that path let a model re-submit the SAME command and have the AI reviewer re-approve it
    // in-turn with no second human confirmation — a real gate bypass). The retry-with-
    // justification hint is kept ONLY for genuine timeouts (no human ever answered), where the
    // caller supplies `denialMessage`.
    if (res.by !== "timeout") {
      return {
        output: `The user denied this ${call.name} action — it was NOT run. Stop here and wait for the user to tell you how to proceed. Do not retry it, rephrase it, or attempt a workaround; the user will give further instructions.`,
        isError: true,
        deniedByHuman: true,
      };
    }
    return { output: opts.denialMessage ?? `denied by ${res.by}`, isError: true };
  }

  /** exit_plan_mode's approval bridge — wired ONLY when cfg.plans is set (see the else-if guard
   *  at the call site); otherwise exit_plan_mode falls through to executeCall's placeholder run.
   *  Mirrors requestApproval's wait-before-emit + emit-failure pattern above: the PlanBroker wait
   *  is registered BEFORE `plan_presented` is emitted, since the broadcast is synchronous and a
   *  watcher that responds as soon as it observes the event would otherwise race an unregistered
   *  wait into a lost response (see engine-plan.test.ts). On approval, `meta.approvalPolicy` is
   *  mutated IN PLACE on the SAME object the dispatch loop's gate check reads every iteration —
   *  that's what makes a follow-up tool call LATER IN THIS SAME TURN see the new mode immediately,
   *  without waiting for the next turn's `store.meta()` re-read. `cfg.setPolicy` persists the
   *  change to the SessionStore so it also survives into the next turn. */
  private async runPlanBridge(
    call: { callId: string; name: string; argsJson: string },
    sessionId: string,
    threadId: string,
    meta: { approvalPolicy: SessionApprovalPolicy },
  ): Promise<{ output: string; isError: boolean }> {
    const plans = this.cfg.plans!;
    let plan = "";
    try {
      const a = JSON.parse(call.argsJson || "{}");
      plan = typeof a.plan === "string" ? a.plan : "";
    } catch { /* empty */ }
    const planTimeoutMs = Number(process.env.NORMA_PLAN_TIMEOUT_MS ?? 300_000);
    const waiting = plans.wait(sessionId, call.callId, planTimeoutMs); // BEFORE emit (race lesson)
    try {
      this.emit(sessionId, { type: "plan_presented", sessionId, threadId, callId: call.callId, plan });
    } catch (err) {
      plans.respond(sessionId, call.callId, { approved: false, autoAccept: false }, "emit-failure");
      await waiting;
      throw err;
    }
    const res = await waiting;
    const approved = "approved" in res ? res.approved : false;
    const autoAccept = "approved" in res ? res.autoAccept : false;
    const feedback = "approved" in res ? res.feedback : undefined;
    const by = "approved" in res ? res.by : "timeout";
    this.emit(sessionId, { type: "plan_resolved", sessionId, threadId, callId: call.callId, approved, feedback, autoAccept, by });
    if (approved) {
      const next = autoAccept ? "auto" : "ask";
      await this.cfg.setPolicy?.(sessionId, next);
      meta.approvalPolicy = next; // SAME-TURN: follow-up calls in this turn use the new mode
      return {
        output: `Plan approved (auto-accept edits: ${autoAccept ? "on" : "off"}). Proceed with the plan. Create a task for each step with task_create as you work.`,
        isError: false,
      };
    }
    const reason = feedback && feedback.trim().length > 0
      ? feedback
      : (by === "timeout"
          ? "no response — the user did not respond within the time limit"
          : "the user rejected the plan without specific feedback");
    return {
      output: `Plan rejected: ${reason}. Stay in plan mode and revise your plan, then call exit_plan_mode again.`,
      isError: false,
    };
  }

  /** enter_plan_mode's bridge (4g Task 4, CC parity) — mirrors runPlanBridge's `meta` mutation +
   *  `cfg.setPolicy` persistence mechanics, but is wired UNCONDITIONALLY at the call site (no
   *  `cfg.plans`-style optional dependency to gate on): entering plan mode needs no human
   *  approval — it's strictly restrictive, so there's no broker wait, no `plan_presented`/
   *  `plan_resolved` event pair, just an immediate switch. Guard: calling this while ALREADY in
   *  plan mode is a typed error (not a gate denial — gate.ts's READ_ONLY membership allows the
   *  call through under every policy, including "plan", precisely so this guard can produce a
   *  clear message instead of the generic "Blocked in plan mode" text). On success,
   *  `meta.approvalPolicy` is mutated IN PLACE on the SAME object the dispatch loop's gate check
   *  reads every iteration — a follow-up tool call LATER IN THIS SAME TURN sees the new mode
   *  immediately; `cfg.setPolicy` persists the switch to the SessionStore so it also survives into
   *  the next turn (same as the exit bridge — see runPlanBridge's doc comment). */
  private async runEnterPlanBridge(
    sessionId: string,
    meta: { approvalPolicy: SessionApprovalPolicy },
  ): Promise<{ output: string; isError: boolean }> {
    if (meta.approvalPolicy === "plan") {
      return { output: "already in plan mode", isError: true };
    }
    await this.cfg.setPolicy?.(sessionId, "plan");
    meta.approvalPolicy = "plan"; // SAME-TURN: follow-up calls in this turn use the new mode
    return {
      output: "Plan mode ON — read-only tools only; present your plan with exit_plan_mode when ready.",
      isError: false,
    };
  }

  /** enter_worktree/exit_worktree's bridge — wired ONLY when cfg.worktrees is set (see the
   *  `isWorktree` guard at the call site); otherwise both tools fall through to executeCall's
   *  placeholder run (tools/worktree.ts). Called from BOTH decisions the gate can produce for a
   *  MUTATING tool: directly when `decision === "allow"` (auto policy), and as `requestApproval`'s
   *  `onApprove` action when `decision === "ask"` (the DEFAULT policy) — see the dispatch loop
   *  above. Synchronous (WorktreeManager's git calls are Bun.spawnSync), unlike the approval/plan
   *  bridges above which wait on a broker. `setCwd` persists the switch to the SessionStore so it
   *  also survives into the next turn; `onCwd` reports the new cwd to the caller, which mutates the
   *  dispatch loop's local `cwd` (now `let`) so a follow-up call LATER IN THIS SAME TURN resolves
   *  into (or back out of) the worktree immediately — this works identically whether the caller is
   *  the direct "allow" branch or the "ask"-approved `onApprove` closure. A thrown manager
   *  error (e.g. dirty worktree on remove, not a git repo, already in a worktree) becomes an
   *  isError outcome rather than propagating and failing the whole turn. */
  private runWorktreeBridge(
    call: { callId: string; name: string; argsJson: string },
    sessionId: string,
    threadId: string,
    cwd: string,
    onCwd: (next: string) => void,
  ): { output: string; isError: boolean } {
    const worktrees = this.cfg.worktrees!;
    try {
      if (call.name === "enter_worktree") {
        let name: string | undefined;
        try { name = JSON.parse(call.argsJson || "{}").name; } catch { /* ignore — name stays undefined */ }
        const wt = worktrees.enter(sessionId, cwd, name);
        this.cfg.store.setCwd(sessionId, wt.dir);
        this.cfg.dirs.add(sessionId, wt.dir);
        onCwd(wt.dir); // SAME-TURN: subsequent calls in this turn resolve into the worktree
        this.emit(sessionId, { type: "worktree_entered", sessionId, threadId, name: wt.name, path: wt.dir, branch: wt.branch });
        return {
          output: `Entered worktree ${wt.name} at ${wt.dir} on branch ${wt.branch}. You're now working in an isolated copy; the original repo is untouched.`,
          isError: false,
        };
      }
      let action: "keep" | "remove" = "keep";
      let discardChanges = false;
      try {
        const a = JSON.parse(call.argsJson || "{}");
        if (a.action === "remove") action = "remove";
        if (a.discard_changes === true) discardChanges = true;
      } catch { /* default to keep, discardChanges false */ }
      // Capture the worktree dir BEFORE exit() clears the manager's active-session entry, so we
      // can drop it from SessionDirectories below — on BOTH keep and remove: once exited we're
      // back in the original repo either way, and a lingering root (especially one whose dir was
      // just deleted by {remove}) must not stick around in the allowed-roots list.
      const activeDir = worktrees.active(sessionId)?.dir;
      const res = worktrees.exit(sessionId, action, discardChanges);
      this.cfg.store.setCwd(sessionId, res.originalCwd);
      if (activeDir) this.cfg.dirs.remove(sessionId, activeDir);
      onCwd(res.originalCwd); // SAME-TURN revert
      this.emit(sessionId, { type: "worktree_exited", sessionId, threadId, name: res.name, action, removed: res.removed });
      return {
        output: action === "remove"
          ? `Left and removed worktree ${res.name}.`
          : `Left worktree ${res.name}; branch ${res.branch} kept — merge or PR it when ready.`,
        isError: false,
      };
    } catch (e) {
      return { output: (e as Error).message, isError: true };
    }
  }

  /** Drain the images ANY tool staged for this round's calls (via ctx.attachImage → pendingImages,
   *  keyed by imageKey — session|thread|callId, see the map's doc comment) into `input` as
   *  `{type:"image"}` items. Originally Phase 5 CU-only (the `computer` tool's screenshots);
   *  generalized so the `read` tool's image/notebook-image-output attaches ride the identical path
   *  — this function has no idea which tool staged what. Called at the END of a round's dispatch
   *  loop — AFTER every tool_result — so an image never splits a function_call/tool_result pair
   *  (the whole assistant batch stays intact, then the images follow as a user turn the model sees
   *  next round). Also called before the deniedByHuman early return so the map never leaks staged
   *  entries. A no-op (byte-identical) when nothing was staged this round. */
  private drainRoundImages(sessionId: string, threadId: string, calls: Array<{ callId: string }>, input: TurnInputItem[]): void {
    if (this.pendingImages.size === 0) return;
    for (const c of calls) {
      const key = AgentEngine.imageKey(sessionId, threadId, c.callId);
      const imgs = this.pendingImages.get(key);
      if (!imgs) continue;
      this.pendingImages.delete(key);
      for (const url of imgs) input.push({ type: "image", imageUrl: url });
    }
  }

  private async executeCall(
    call: { callId: string; name: string; argsJson: string },
    cwd: string,
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    // 4g final-review fix: the CALLING THREAD's live `loaded` set — runThread's own `opts.loaded`,
    // threaded straight through by every call site in this file (main-thread branches AND the
    // requestApproval/executeCall calls inside a spawned child's own runThread invocation). This
    // is THE set a load must land in and THE set the defense-in-depth check below must read —
    // for the MAIN thread it IS `this.loadedTools.get(sessionId)` (turn() hands that exact object
    // to runThread as opts.loaded), so main-thread behavior is byte-identical to before; for a
    // CHILD thread it's the fresh per-spawn `childLoaded` Set (runThread's spawn bridge), never
    // `this.loadedTools` — so a subagent's ToolSearch load now lands where its OWN specs()/guard
    // actually look, instead of a session-wide set the child never consults.
    loaded: Set<string>,
    // 4g-i: the CALLING round's pinnedTools() result (runThread's `pins`, or requestApproval's
    // forwarded copy of it) — defaulted so any caller that doesn't care about pins compiles
    // unchanged. Unioned below with `loaded`, never mutating either.
    pins: Set<string> = new Set(),
    // 4h-i Task 4: forwarded straight from runThread's own `opts.rootsOverride` (see its doc
    // comment) — undefined for every caller except a worktree-isolated child, in which case it's
    // EXACTLY that child's `[worktreeDir]`, replacing (not extending) the session-wide roots
    // this.cfg.dirs.roots(sessionId) would otherwise return.
    rootsOverride?: string[],
    // Computer use (Phase 5 CU): whether the turn's model accepts image input — forwarded from
    // runThread's per-thread `visionCapable` (and through requestApproval's default onApprove). Set
    // on ctx.visionCapable so the `computer` tool's screenshot action can refuse a non-vision model.
    visionCapable?: boolean,
  ): Promise<{ output: string; isError: boolean }> {
    let args: unknown;
    try { args = call.argsJson.length ? JSON.parse(call.argsJson) : {}; }
    catch { return Promise.resolve({ output: `tool arguments were not valid JSON`, isError: true }); }
    // SP-policies Task 6: writableRoots unions in any Edit(<path>)-declared dirs for this project
    // (guarded against "/" and the grantDenied control-plane denylist — see its own doc comment)
    // — this becomes ctx.roots below, so an Edit rule widens BOTH the write/edit fence (the
    // dispatch-loop sites above) AND bash's seatbelt (tools/bash.ts realpaths this exact array
    // into sandbox.ts's buildSeatbeltProfile). `cwd` here is executeCall's own param, not the
    // dispatch loop's local — recomputed the identical way (`cwd ? repoRootFor(cwd) : null`) since
    // this method has no access to the loop's already-hoisted `projectRoot`.
    const roots = this.writableRoots(sessionId, cwd ? repoRootFor(cwd) : null, rootsOverride);
    const tmpDir = sessionTmpDir(sessionId);
    const markSkillLoaded = (n: string) => {
      let set = this.loadedSkills.get(sessionId);
      if (!set) { set = new Set(); this.loadedSkills.set(sessionId, set); }
      set.add(n);
    };
    // Mutate the CALLING THREAD's own `loaded` set in place — never `this.loadedTools.get
    // (sessionId)` (that lookup is what caused the bug: a child thread's load used to land in the
    // session-wide map instead of the `childLoaded` set the child's own specs()/guard consult,
    // AND polluted the session-wide set for good measure). See `loaded`'s doc comment above.
    const markToolLoaded = (n: string) => { loaded.add(n); };
    // Dispatch (Phase 7) Task 6: a dispatch child's question waits "indefinitely" (spec §6 — the
    // child just sits in awaiting_input, mirrored into the dispatch stream, until answered).
    // setTimeout caps at 2^31-1 ms (~24.8 days) — that IS our indefinite; a comment, not a
    // behavior knob. Every other session keeps the existing env/default window.
    const meta = this.cfg.store.meta(sessionId);
    const askTimeoutMs = meta.origin === "dispatch-child"
      ? 2 ** 31 - 1
      : Number(process.env.NORMA_ASK_TIMEOUT_MS ?? 300_000);
    const ask = this.cfg.questions
      ? async (questions: Question[]) => {
          // Register the wait BEFORE emitting: broadcast is synchronous, so a watcher that
          // responds as soon as it observes question_asked would otherwise race the broker
          // (see requestApproval's identical wait-before-emit comment above).
          const waiting = this.cfg.questions!.wait(sessionId, call.callId, askTimeoutMs);
          try {
            this.emit(sessionId, { type: "question_asked", sessionId, threadId, callId: call.callId, questions });
          } catch (err) {
            this.cfg.questions!.respond(sessionId, call.callId, {}, "emit-failure");
            await waiting;
            return { timedOut: true } as const;
          }
          const res = await waiting;
          this.emit(sessionId, {
            type: "question_resolved", sessionId, threadId, callId: call.callId,
            answers: "answers" in res ? res.answers : {},
            by: "by" in res ? res.by : "timeout",
            // CC AskUserQuestion parity: mirror the broker's notes onto the persisted/broadcast
            // event too (schema-optional, additive) so replay/other clients can see them — the
            // model-visible copy is folded into the tool's own return string in ask-user.ts.
            ...("notes" in res && res.notes ? { notes: res.notes } : {}),
          });
          return res;
        }
      : undefined;
    // Gated on cfg.tasks (mirrors `ask` above being gated on cfg.questions) — previously
    // unconditional, which left cfg.tasks dead and contradicted the "absent means ctx.taskEvent
    // is undefined" comment on EngineConfig. registerTaskTools is what actually decides whether
    // task_create/task_update/task_list exist at all, so this only matters if a future caller
    // registers those tools without also wiring a TaskStore into the engine config (M2 finding).
    const taskEvent = this.cfg.tasks
      ? (task: Task) => { this.emit(sessionId, { type: "task_updated", sessionId, threadId, task }); }
      : undefined;
    // task-30 (push-notification track): unlike ask/taskEvent above, this bridge is NEVER gated on
    // an optional subsystem — hub is a mandatory EngineConfig field, so push_notification always
    // gets a working ctx.notify when dispatched through the real engine. Two things happen, always
    // in this order: (1) emit + persist notification_requested (so ANY attached client, live or
    // via later replay, can render it) — (2) if NOBODY is attached right now
    // (hub.attachedCount === 0), also fire the headless osascript fallback. The count check reads
    // attachedCount AFTER the emit so a client that raced in via harness_attached during the emit's
    // own broadcast still counts as "attached" for this decision (appendAndBroadcast is fully
    // synchronous, so there is no actual race — this ordering is just belt-and-suspenders).
    const notify = (title: string, message: string) => {
      this.emit(sessionId, { type: "notification_requested", sessionId, threadId, title, message });
      if (this.cfg.hub.attachedCount(sessionId) === 0) this.cfg.notifyFallback?.(title, message);
    };
    // The calling thread's own `loaded` set (see its doc comment above), unioned with this
    // round's pins into a NEW Set — `loaded` itself is NEVER copied/mutated by this union.
    const effectiveLoaded = pins.size ? new Set([...loaded, ...pins]) : loaded;
    // Computer use (Phase 5 CU): wire the `computer` tool's OWN bridge (ctx.computerUse) ONLY when
    // the service is configured — otherwise it stays undefined and the tool ctx is byte-identical
    // to pre-CU. hot-settings T5a: read the getter LIVE here (per tool call), not the runTurn-start
    // snapshot — a mid-turn hot-disable must make a LATER call in the same turn see `undefined`
    // too. Safe unguarded: during T5b's disable DRAIN window the `computer` tool is still
    // registered and the getter still resolves live, so a NEW `computer` call CAN still dispatch
    // then — it merely prolongs the bounded drain (T4's computerInFlight gate waits it out) rather
    // than being yanked; once teardownComputer runs (unregister + holder cleared) this getter
    // resolves `undefined` and the tool is gone, so a later call errors cleanly. No "half disabled"
    // state is ever observed: at every instant the tool's presence and this getter agree.
    const cuNow = this.cfg.computerUse?.();
    // ctx.attachImage — generalized (multimodal-read T1): wired whenever the THREAD's model is
    // vision-capable, independent of computer-use. Previously gated on `cuNow` (CU-only); now ANY
    // tool that stages an image (the `computer` tool's screenshots, the `read` tool's images and
    // notebook image outputs) can do so as long as the model can actually see it. `visionCapable`
    // is undefined only when the resolved model isn't in the provider's own model list (an unknown
    // model) — treated as "not vision-capable" here (no wiring), the conservative default. Closes
    // over this call's namespaced key (session|thread|callId — see the pendingImages doc comment
    // for why bare callId is unsafe): a staged image lands in pendingImages under that key, drained
    // into `input` at this round's end (drainRoundImages).
    const attachImage = visionCapable
      ? (dataUrl: string) => {
          const key = AgentEngine.imageKey(sessionId, threadId, call.callId);
          const arr = this.pendingImages.get(key) ?? [];
          arr.push(dataUrl);
          this.pendingImages.set(key, arr);
        }
      : undefined;
    const result = await this.cfg.registry.execute(call.name, args, {
      cwd, roots, tmpDir, sessionId, signal, markSkillLoaded,
      markToolLoaded,
      loadedTools: effectiveLoaded,
      deferThreshold: this.toolSearchThreshold(cwd),
      deferExternals: this.toolSearchDeferExternals(cwd),
      builtinDeferral: this.toolSearchEnabled(cwd),
      ask,
      taskEvent,
      notify,
      computerUse: cuNow,
      attachImage,
      visionCapable,
    });
    // Auto-diagnostics after edit (lsp-consolidation T3): ONLY a SUCCESSFUL write/edit/
    // notebook_edit ever reaches this — `result.isError` gates it BEFORE any LSP call, so a
    // failed write never triggers a diagnostics run at all (not merely "runs but is discarded").
    // Both gates are read LIVE, per call (hot-settings shape, mirrors `cuNow` above): `cfg.lsp`
    // resolves `undefined` the instant `lsp.enabled` is hot-disabled (daemon.ts's `let lspManager`
    // holder), and `autoDiagnosticsEnabled` resolves the live `settings.lsp.autoDiagnostics`
    // (default true) so a mid-session toggle applies to the very next edit, no engine
    // reconstruction. `autoDiagnosticsSuffix` itself is NEVER-FAIL (see its own doc comment) — a
    // dead/slow/unsupported server or an unmatched extension resolves to "", leaving `result`
    // (and thus the model-visible tool_result) untouched.
    if (!result.isError && AUTO_DIAG_TOOL_NAMES.has(call.name)) {
      const mgr = this.cfg.lsp?.();
      if (mgr && this.cfg.autoDiagnosticsEnabled?.(cwd) !== false) {
        // `signal` (the turn's own abort signal) makes an ESC/interrupt cut the diagnostics wait
        // short — the suffix resolves "" promptly instead of riding out the full per-language
        // settle/timeout window (whole-branch review fast-follow).
        const suffix = await autoDiagnosticsSuffix({ lsp: mgr, toolName: call.name, args, cwd, roots, signal });
        if (suffix) return { ...result, output: result.output + suffix };
      }
    }
    return result;
  }
}
