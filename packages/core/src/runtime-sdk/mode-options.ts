import { join } from "node:path";
import type {
  CanUseTool, EffortLevel, Options, PermissionMode, SandboxSettingsConfig, SpawnClaudeCodeProcess,
} from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { CONTROL_PLANE_FILENAMES } from "./control-plane";
import { providerSelectionFor, testProviderNameFor } from "./provider-selection";
import { WINTER_NORMA_TOOL_PAIRS, WINTER_OWN_TOOL_NAMES } from "./tool-names";

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
};

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
 * The Winter built-ins CHAT excludes — every name in the pair table that chat's allowed set does
 * not contain. Derived, then pinned as a literal by the matrix test, so a new pair-table row is
 * automatically excluded from chat (fail-closed) AND the test says the list moved.
 *
 * `WebSearch`/`WebFetch` are in here by construction and additionally by ruling: chat's research
 * runs through the daemon-owned `research` capability, which carries the Exa key and the
 * dangerous-domain floor (P8b-12/C-6); the SDK's own web built-ins carry neither, so a chat session
 * reaching them would be a silent floor bypass.
 */
export const CHAT_DISALLOWED_BUILTINS: readonly string[] = WINTER_NORMA_TOOL_PAIRS
  .map(([winter]) => winter)
  .filter((w) => !CHAT_ALLOWED_WINTER_TOOLS.includes(w))
  .filter((w, i, a) => a.indexOf(w) === i)
  .sort();

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
  const env: Record<string, string> = {
    NORMA_HOME: input.home,
    NORMA_PROFILE: input.profile ?? "",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"] as const) {
    const v = base[key];
    if (typeof v === "string" && v !== "") env[key] = v;
  }
  // The scripted in-process double (Norma map §11.6): selection is BY NAME, because a spawned or
  // compiled child shares no module state with the test process. Set ONLY for a `winter-test/*`
  // model, so a real session can never accidentally carry it.
  const testProvider = testProviderNameFor(input.model);
  if (testProvider) env.WINTER_TEST_PROVIDER = testProvider;
  return { ...env, ...input.env };
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
 */
export function controlPlaneDenyRules(home: string): string[] {
  const writeTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const targets = [
    // Any project's control-plane files, at any depth — the project-INDEPENDENT invariant
    // (`controlPlaneFileTarget`'s own doc: "the agent must NEVER write ANY
    // `<any>/.norma/permissions.local.json`, whichever project owns it").
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => `**/.norma/${f}`),
    // The user's own global copies, whose parent is literally `<home>` rather than `<x>/.norma`.
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => join(home, f)),
    // The daemon's control plane: sockets, pid files, the runtime state db.
    join(home, "run", "**"),
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
    allowUnsandboxedCommands: false,
    filesystem: {
      denyWrite: [
        ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => `**/.norma/${f}`),
        ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => join(home, f)),
        join(home, "run", "**"),
      ],
      // The sole read denial Norma has ever had (CLAUDE.md: "the sole read denial is
      // `~/.norma/run`") — reads are otherwise deliberately unrestricted.
      denyRead: [join(home, "run", "**")],
    },
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
  if (mode === "chat") out.push(...CHAT_DISALLOWED_BUILTINS);
  return out.sort();
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
