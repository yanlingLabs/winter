import { join } from "node:path";
import type {
  CanUseTool, EffortLevel, Options, PermissionMode, SandboxSettingsConfig, SpawnClaudeCodeProcess,
} from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { CONTROL_PLANE_FILENAMES } from "./control-plane";
import { providerSelectionFor, testProviderNameFor } from "./provider-selection";
import { WINTER_ADVERTISED_TOOLS_0_0_4, WINTER_NORMA_TOOL_PAIRS, WINTER_OWN_TOOL_NAMES } from "./tool-names";

/**
 * **The six Norma policies → Winter's `PermissionMode`, 1:1** (P8b-7).
 *
 * The only mapping that is not a rename is `ask → "default"` (surface map §5.2).
 *
 * **The seventh value.** `gate.ts`'s `SessionApprovalPolicy` has a seventh member, `"chat"`, and
 * `ipc/server.ts:1096` persists it on EVERY chat session — so it reaches this function in
 * production even though the wire `ApprovalPolicy` enum is six-valued and the Interfaces block says
 * `ApprovalPolicy`. It maps to `"default"`, deliberately, and NOT to `dontAsk`: under `dontAsk`
 * Winter's own `AskUserQuestion` descriptor says the tool is DENIED (surface map §5.6), which would
 * silently kill chat's only question surface. `"default"` routes every call through `canUseTool`,
 * where `gate.evaluate`'s own `"chat"` branch — allow READ_ONLY/NETWORK, deny everything else,
 * never ask — is the live policy. Chat's card-free guarantee therefore comes from the bridge, which
 * is where it already lives, rather than from a permission mode that would also take the questions
 * away. **Flagged for a controller ruling in the task report.**
 */
export function permissionModeFor(policy: SessionApprovalPolicy): PermissionMode {
  switch (policy) {
    case "plan": return "plan";
    case "dont-ask": return "dontAsk";
    case "ask": return "default";
    case "accept-edits": return "acceptEdits";
    case "auto": return "auto";
    case "bypass": return "bypassPermissions";
    case "chat": return "default";
  }
}

/** Every capability tool the daemon owns, and the modes it is exposed to (P8b-27 ruling 8). Keyed
 *  by the canonical `mcp__norma__<serverKey>__<tool>` names Task 7's `capabilityToolName` mints.
 *
 *  **This table, not `NORMA_CAPABILITY_TOOLS`, is what `disallowedTools` is built from** — Task 7's
 *  export lands in another lane, and the integration parity test diffs the two so a capability that
 *  exists in one and not the other is a loud failure rather than a silently unexposed tool.
 *
 *  Exposure mirrors today's registered `modes`, tool for tool (Norma map §5.2): `browser` is the
 *  only all-three entry (chat's read-only restriction is enforced INSIDE the capability, not by
 *  hiding the tool); `computer`/office are code+dispatch; the `sessions` trio is dispatch-only;
 *  `research` is chat+dispatch, which is the mode-scoped exposure WS-06 §5 would otherwise have
 *  collapsed into the code-mode web tools. */
export const CAPABILITY_TOOL_MODES: Readonly<Record<string, { modes: readonly SessionMode[] }>> = {
  "mcp__norma__sessions__session_spawn": { modes: ["dispatch"] },
  "mcp__norma__sessions__list_sessions": { modes: ["dispatch"] },
  "mcp__norma__sessions__manage_session": { modes: ["dispatch"] },
  "mcp__norma__computer__computer": { modes: ["code", "dispatch"] },
  "mcp__norma__browser__browser": { modes: ["code", "dispatch", "chat"] },
  "mcp__norma__office__docs": { modes: ["code", "dispatch"] },
  "mcp__norma__office__sheets": { modes: ["code", "dispatch"] },
  "mcp__norma__office__slides": { modes: ["code", "dispatch"] },
  "mcp__norma__research__Search": { modes: ["chat", "dispatch"] },
  "mcp__norma__research__ReadPage": { modes: ["chat", "dispatch"] },
  // P8b-33 (ruling): the SDK's own `WebSearch`/`WebFetch` are disallowed in EVERY mode — they carry
  // neither the Exa key nor the dangerous-domain floor — and code keeps today's daemon-owned
  // `web_fetch`/`web_search` through a new `web` capability server instead. Modes mirror today's
  // registration: `agent/tools/web.ts:1011,1090` declare `modes: ["code"]` for both.
  "mcp__norma__web__web_fetch": { modes: ["code"] },
  "mcp__norma__web__web_search": { modes: ["code"] },
};

/** The SDK's own web built-ins. Disallowed in EVERY mode in 8b (P8b-33): they have no Exa key and
 *  no dangerous-domain floor, and Norma's own floors are daemon state a built-in cannot reach.
 *  Measured NOT to be advertised at 0.0.3 (`WINTER_ADVERTISED_TOOLS_0_0_4`) — listed anyway, so an
 *  SDK bump that starts advertising them cannot silently widen any mode's web surface. */
export const SDK_WEB_BUILTINS: readonly string[] = ["WebFetch", "WebSearch"];

/**
 * Anchor a rule specifier to the FILESYSTEM ROOT — see `controlPlaneDenyRules`.
 *
 * The grammar has three anchors and only one of them binds the way this fence needs (measured; see
 * `controlPlaneDenyRules`' own comment): a **single leading `/`** is "relative to the rule's own
 * settings-file directory" and is INERT for an SDK-seeded rule; a **bare** pattern anchors to cwd;
 * **`//`** is the filesystem root.
 *
 * So an already-absolute path gets ONE more slash (`/h/x` → `//h/x`) and a bare pattern gets two
 * (`**{}/.norma/x` → `//**{}/.norma/x`). Doing this by concatenating a single constant is exactly
 * the bug this helper exists to prevent — it produced `/**{}/…`, the inert form, and the resulting
 * rules denied nothing.
 */
export function fsRootAnchored(pathOrPattern: string): string {
  return pathOrPattern.startsWith("/") ? `/${pathOrPattern}` : `//${pathOrPattern}`;
}

/**
 * **What CHAT is allowed to call**, by Winter name — the whole set, pinned as a literal.
 *
 * Chat is "conversation-with-a-memory": no filesystem, no shell, no repo (the shipped Chat Slice A
 * design; `registry.namesForMode("chat")` is `{AskQuestion, Search, ReadPage, browser}` today). On
 * the Winter leg that becomes `AskUserQuestion` (the one tool that replaced `AskQuestion`), the two
 * `research` capability tools, the `browser` capability tool, and Winter's own four default tools
 * (P8b-28, allowed silently in every mode).
 *
 * Everything else a Winter child advertises is in chat's `disallowedTools`.
 */
export const CHAT_ALLOWED_WINTER_TOOLS: readonly string[] = [
  "AskUserQuestion",
  ...[...WINTER_OWN_TOOL_NAMES].sort(),
];

/**
 * The Winter built-ins CHAT excludes — **derived from what the CHILD ACTUALLY ADVERTISES**
 * (`WINTER_ADVERTISED_TOOLS_0_0_4`, measured from the built binary) minus chat's allowed set, plus
 * the SDK's web built-ins and Norma's own pair-table names for completeness.
 *
 * Review F4: deriving this from Norma's pair table left `Monitor`, `ReportFindings` and
 * `ScheduleWakeup` — all three genuinely advertised — visible to a chat model that is supposed to
 * have no fs/shell/repo surface. The pair table is the wrong source: it has rows for tools the
 * child does not advertise and misses ones it does.
 *
 * The union with the pair table is deliberate belt-and-braces: `disallowedTools` is inert for a name
 * the child never advertises, so naming extras costs nothing, while a future SDK that starts
 * advertising `LSP` or `ToolSearch` finds them already excluded.
 */
export const CHAT_DISALLOWED_BUILTINS: readonly string[] = [...new Set([
  ...WINTER_ADVERTISED_TOOLS_0_0_4,
  ...WINTER_NORMA_TOOL_PAIRS.map(([winter]) => winter),
  ...SDK_WEB_BUILTINS,
])].filter((w) => !CHAT_ALLOWED_WINTER_TOOLS.includes(w)).sort();

export interface WinterOptionsInput {
  mode: SessionMode;
  /** Seven-valued in practice — chat sessions persist the internal `"chat"` policy. */
  policy: SessionApprovalPolicy;
  /** `SessionMeta.origin`; `"dispatch-child"` makes a code-mode child never-prompt (P8b-26). */
  origin?: string;
  /** The pre-allocated BACKEND uuid from 8a's creation transaction (surface map §6.1) — not
   *  Norma's own `s_<hex>` session id. */
  sessionId: string;
  /** NORMA_HOME for this daemon. The child resolves its own home from the brand's env, so this is
   *  what keeps a test session's transcript out of `~/.norma`. */
  home: string;
  profile?: string;
  cwd: string;
  model?: string;
  credentials: CredentialPresence;
  effort?: EffortLevel;
  systemPrompt?: string;
  outputStyle?: string;
  spawn: { pathToClaudeCodeExecutable: string; spawnClaudeCodeProcess?: SpawnClaudeCodeProcess };
  canUseTool: CanUseTool;
  abort: AbortController;
  /** Task 7's `NORMA_CAPABILITY_TOOLS`, or `CAPABILITY_TOOL_MODES` until it lands. */
  capabilityTools?: Readonly<Record<string, { modes: readonly SessionMode[] }>>;
  /** Extra child env, merged LAST. Never a channel for secrets. */
  env?: Record<string, string>;
  /** The environment PATH/HOME/TMPDIR are read from. Defaults to `process.env`; a test pins it. */
  baseEnv?: Record<string, string | undefined>;
}

/**
 * **The child's environment, BUILT rather than inherited.**
 *
 * `process.env` is never spread in. The child resolves its own home from the brand's env prefix
 * (`resolveWinterHome` under `NORMA_BRAND` reads `NORMA_HOME`), so a child that inherited the
 * daemon's ambient environment would write a real transcript under `~/.norma` the moment a test ran
 * on a machine with a real install — the exact thing CLAUDE.md's hard rule forbids. Passing
 * `NORMA_HOME` explicitly from `input.home` is what pins it to the temp home a test built.
 *
 * Only four ambient variables are forwarded, each for a concrete reason: `PATH` (the child spawns
 * tools), `HOME` (git and countless CLIs are broken without it), `TMPDIR`, and `LANG` for encoding.
 * Nothing else — no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`, no proxy vars. Credentials reach the
 * child as a NAMED `CredentialRef` through `Options.provider`, never as environment material
 * (surface map §7.1: "an `ANTHROPIC_API_KEY` sitting in the environment does not become a
 * credential by existing" — and this is the host half of that promise).
 */
export function buildChildEnv(input: WinterOptionsInput): Record<string, string> {
  const base = input.baseEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"] as const) {
    const v = base[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  Object.assign(env, input.env);
  // **The pinned keys are applied LAST, so they always win** (review F11). They were merged first,
  // which let a caller-supplied `input.env.NORMA_HOME` silently override the one value CLAUDE.md's
  // hard rule depends on — a test session would then have written a real transcript under
  // `~/.norma`. `input.env` is for extras; the home and profile are not negotiable.
  env.NORMA_HOME = input.home;
  env.NORMA_PROFILE = input.profile ?? "";
  // The scripted in-process double (Norma map §11.6): selection is BY NAME, because a spawned or
  // compiled child shares no module state with the test process. Set ONLY for a `winter-test/*`
  // model, so a real session can never accidentally carry it — and after `input.env` for the same
  // reason as the two above.
  const testProvider = testProviderNameFor(input.model);
  if (testProvider) env.WINTER_TEST_PROVIDER = testProvider;
  return env;
}

/**
 * **The control-plane paths no Winter child may write** (P8b-27a), as `Options.permissions.deny`
 * rules in the SDK's `Tool(specifier)` grammar.
 *
 * **This is NARROWER than the ruling's literal `<home>/**`, deliberately, and the difference is a
 * shipped feature.** Two directories under NORMA_HOME are agent-writable BY DESIGN:
 *
 *  - the MEMDIR, `<home>/projects/<key>/memory/` (`agent/memory-dir.ts`) — CLAUDE.md's tool surface
 *    is "file-based memory (a MEMDIR of markdown files written with normal write/edit — no
 *    dedicated memory tools)". A blanket `<home>/**` deny deletes file-based memory outright.
 *  - `$OUTDIR`, `<home>/outputs/<sessionId>` (`sessions/outdir.ts`) — "a blessed, agent-writable
 *    exception under `~/.norma`", folded into the session's own write fence.
 *
 * So the fence is drawn exactly where today's is: today's `controlPlaneFileTarget` matches **by
 * FILENAME, never by directory** ("`.norma/` itself stays writable … `.norma/memory/` is the MEMDIR
 * by design"), and today's seatbelt does the same with a `(deny file-write* …)` line placed AFTER
 * the writable-subpath allow so it carves out those exact files and nothing else. These rules are
 * the same shape: the three control-plane filenames under any `.norma` directory at any depth, plus
 * `<home>/run/**` (the socket/pid control plane, already the sole READ denial too).
 *
 * **EVERY rule is `//`-anchored, and that is load-bearing** (review F2, measured). In WS-07 §3.1's
 * grammar (`permissions/paths.ts:60-78` at `v0.0.3`):
 *  - a **single leading `/`** means "relative to the rule's own settings-file directory", and
 *    `sourceDir` is `undefined` for every SDK-seeded rule — which makes such a rule **INERT, and
 *    silently so**. The SDK hit this itself and left the comment at `engine.ts:1370-1375`: *"Found
 *    by the fixture: the rule list was right and nothing was denied."*
 *  - a **bare** pattern anchors to **cwd**, so a bare `**{}/.norma/<f>` covers only `<cwd>` and below — not
 *    the project-INDEPENDENT surface this fence exists to enforce.
 *  - `//` is the filesystem-root anchor and is what actually binds.
 *
 * Measured against the real matcher (the pinned checkout's `evaluate()` + `buildBaselineDenyRules`,
 * the same harness `baseline-projects-deny.test.ts` uses): bare `**{}/.norma/<f>` denied an in-cwd
 * target and did **not** deny an out-of-cwd one; a single-`/` absolute denied nothing at all; and
 * both `//`-anchored forms denied every target. The matcher is not exported from the installed
 * package, so `mode-matrix.test.ts` pins the anchor FORM and resolves each rule to its absolute
 * target instead — see its own comment.
 */
export function controlPlaneDenyRules(home: string): string[] {
  const writeTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const targets = [
    // Any project's control-plane files, at any depth — the project-INDEPENDENT invariant
    // (`controlPlaneFileTarget`'s own doc: "the agent must NEVER write ANY
    // `<any>/.norma/permissions.local.json`, whichever project owns it").
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => fsRootAnchored(["**", ".norma", f].join("/"))),
    // The user's own global copies, whose parent is literally `<home>` rather than `<x>/.norma`.
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => fsRootAnchored(join(home, f))),
    // The daemon's control plane: sockets, pid files, the runtime state db.
    fsRootAnchored([join(home, "run"), "**"].join("/")),
  ];
  return writeTools.flatMap((t) => targets.map((p) => `${t}(${p})`));
}

/**
 * The Bash sandbox (P8b-27c). `SandboxSettingsConfig` (`protocol/config.d.ts:83-101`) exposes
 * `filesystem.denyWrite`/`denyRead`, which is the same axis today's seatbelt profile uses
 * (`agent/sandbox.ts`: deny-by-default, read anywhere, write only under the given roots, plus an
 * explicit per-root and any-depth deny for the three control-plane filenames).
 *
 * `allowUnsandboxedCommands: false` is the load-bearing one: with it true a command can opt out of
 * the fence entirely, which is `dangerouslyDisableSandbox` without the approval card the engine
 * puts in front of it.
 *
 * **What is NOT verifiable from here:** the d.ts declares the shape, and the runtime that enforces
 * it is the private `winter-agent-runtime` package. Whether `denyWrite` actually fences a `bash`
 * child the way `sandbox-exec` does — and in particular whether it survives
 * `permissionMode: "bypassPermissions"` — can only be measured against a spawned `winter` binary.
 * Recorded as a Code-mode carry; Task 17's code e2e includes a self-grant attempt that must be
 * denied.
 */
export function sandboxConfigFor(home: string): SandboxSettingsConfig {
  return {
    enabled: true,
    filesystem: {
      // REAL DIRECTORY PATHS, not globs (review F8). Every entry is rendered as a seatbelt
      // **subpath** — `(deny file-write* (subpath "<canon(p)>"))`, `sandbox/profile.ts:335` — so a
      // glob like `**/.norma/permissions.local.json` or `<home>/run/**` becomes a literal path that
      // never exists and denies nothing. A subpath denies a real directory and everything under it,
      // which is the only shape this consumer has.
      //
      // What that means for the three control-plane FILENAMES: they cannot be expressed here at all
      // (a subpath is a directory, and denying `<x>/.norma` wholesale would take the MEMDIR with
      // it). Winter's own profile already carries exactly those three filenames, case-folded and
      // brand-aware (`sandbox/profile.ts:151-158`), and states that a user's own `denyWrite` cannot
      // defeat them — that is the protection that actually holds for the bash-redirect path, and it
      // is Winter's, not ours. Norma's contribution here is the daemon control plane.
      denyWrite: [join(home, "run")],
      // The sole read denial Norma has ever had (CLAUDE.md: "the sole read denial is
      // `~/.norma/run`") — reads are otherwise deliberately unrestricted.
      denyRead: [join(home, "run")],
    },
    // `allowUnsandboxedCommands` is deliberately NOT set. It is consulted only together with
    // `excludedCommands` (`sandbox/spawn.ts:109,122`), which this config does not set, so `false`
    // would be a no-op — and the earlier comment calling it "the load-bearing one" was wrong:
    // `dangerouslyDisableSandbox` wins over `excludedCommands` regardless. Norma's own floor for
    // that is P8b-31's always-card in the bridge, which does bind.
  };
}

/** Every capability tool NOT exposed to this mode, plus — for chat — the Winter built-ins chat
 *  excludes. The literal is pinned by the matrix test; the parity tripwire (added at integration)
 *  diffs `CAPABILITY_TOOL_MODES` against Task 7's `NORMA_CAPABILITY_TOOLS`. */
export function disallowedToolsFor(
  mode: SessionMode,
  capabilityTools: Readonly<Record<string, { modes: readonly SessionMode[] }>> = CAPABILITY_TOOL_MODES,
): string[] {
  const out = Object.entries(capabilityTools)
    .filter(([, v]) => !v.modes.includes(mode))
    .map(([name]) => name);
  // P8b-33: EVERY mode disallows the SDK's own web built-ins, not just chat. Dispatch's web surface
  // today is `Search`/`ReadPage` only (`web_fetch`/`web_search` are `modes: ["code"]`,
  // `agent/tools/web.ts:1011,1090`), so leaving dispatch's list empty would have GIVEN dispatch the
  // SDK's floorless web tools — which classify as `NETWORK` and therefore allow under every policy.
  out.push(...SDK_WEB_BUILTINS);
  if (mode === "chat") out.push(...CHAT_DISALLOWED_BUILTINS);
  return [...new Set(out)].sort();
}

/**
 * **The `Options` one Winter session runs under.** Pure — no I/O, no clock, no `process.env` beyond
 * the explicit `baseEnv` seam — so the 3×6 matrix test can assert the whole object.
 *
 * `prompt` is deliberately NOT here: the caller passes the host prompt queue to `query()` itself
 * (P8b-6/G-15), and a session opened with anything else is unreachable by messaging.
 *
 * `brand` and `mcpServers` are deliberately NOT here either: the router's door injects both
 * (surface map §2.3 — `forwardableOptions` adds the brand when the query supplied none, and merges
 * the host's capability servers into `mcpServers`). Setting them here would fight the door.
 *
 * `allowDangerouslySkipPermissions` is set ONLY under `bypass`, because `bypassPermissions` cannot
 * be selected without it and startup refuses otherwise (§5.2). That combination also trips the
 * static `WINTER_SDK_CAN_USE_TOOL_SHADOWED` warning (§5.3), which is expected: under bypass the
 * approval bridge is mostly dead code by design, and the control-plane fence in `canUseTool` still
 * runs for the calls that do reach it.
 */
export function buildWinterOptions(input: WinterOptionsInput): Options {
  const options: Options = {
    sessionId: input.sessionId,
    cwd: input.cwd,
    permissionMode: permissionModeFor(input.policy),
    canUseTool: input.canUseTool,
    abortController: input.abort,
    pathToClaudeCodeExecutable: input.spawn.pathToClaudeCodeExecutable,
    env: buildChildEnv(input),
    // `stream_event` frames are emitted only under this gate (options.d.ts:195) — without it the
    // projector has no `assistant_delta` to produce and the stream is byte-identical to a session
    // before partial streaming existed.
    includePartialMessages: true,
    disallowedTools: disallowedToolsFor(input.mode, input.capabilityTools),
    permissions: { deny: controlPlaneDenyRules(input.home) },
    sandbox: sandboxConfigFor(input.home),
  };
  if (input.spawn.spawnClaudeCodeProcess) options.spawnClaudeCodeProcess = input.spawn.spawnClaudeCodeProcess;
  if (input.model !== undefined) options.model = input.model;
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;
  if (input.outputStyle !== undefined) options.outputStyle = input.outputStyle;
  if (input.policy === "bypass") options.allowDangerouslySkipPermissions = true;
  const provider = providerSelectionFor(input.model, input.credentials);
  if (provider) options.provider = provider;
  // `toolAliases` is deliberately absent (the R4 measurement: none needed in 8b — the capability
  // tools carry their own `mcp__norma__*` names under R-1, and Winter's four default tools are
  // already bound under their built-in names by the router).
  return options;
}
