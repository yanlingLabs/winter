// P8c Task 1.2 — `officialInputFor`: THE `RouterOfficialInput` for one official-leg session,
// re-built on every incarnation (mirrors `mode-options.ts`'s `buildWinterOptions`'s own "re-read the
// session's LIVE facts" posture — nothing here is snapshotted at session creation).
//
// See `official-capabilities.ts`'s header for the router-0.0.2 export gap this file works around
// (no `createApprovalBridge`/`minimalOsEnvironmentFrom`/`OptionsTemplatePolicy` reachable from the
// package root). Two more findings from the same measurement pass, load-bearing here:
//
//  1. `minimalOsEnvironmentFrom` is unreachable, so `base` is built by hand from the same "§3's
//     minimal OS set" the door's own doc names — `HOME`, `PATH`, `LANG`/`LC_ALL` when set, `TERM`.
//  2. THE ROUTER AUTO-WRAPS A PLAIN `canUseTool`. Measured directly in the installed 0.0.2 dist
//     (`dist/index.js`, `installFloor`): `isOurApprovalBridge(existing) ? existing :
//     createApprovalBridge({ mode, containment, broker: existing })` — the router calls
//     `createApprovalBridge` INTERNALLY on whatever plain broker function a host supplies, so this
//     file never needed the unexported factory in the first place. The broker below is exactly the
//     Interfaces block's own suggested shape: `(request) => canUseToolFor(deps)(request.toolName,
//     request.input, {...})`, reusing 8b's bridge so approval semantics are identical on both legs.
import { homedir, tmpdir } from "node:os";
import { isVendorCompliantProjectKey, transcriptProjectKey, type CredentialRef, type PermissionMode as WinterPermissionMode, type PermissionResult, type PermissionUpdate, type ProviderSelection } from "@yanlinglabs/winter-agent-sdk";
import { officialConnectionEnv, officialCredentialPlan, type RouterOfficialInput, type RuntimeSelection } from "@yanlinglabs/winter-runtime-sdk";
import type { ContextAssembler } from "../agent/context";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { assistantMemoryDirFor, memoryDirFor, type MemoryDirOptions } from "../agent/memory-dir";
import type { CapabilityServerRecord } from "../capabilities";
import { canUseToolFor, type CanUseToolDeps } from "./approval-bridge";
import { officialCapabilityServersFor, type OfficialMcpModule } from "./official-capabilities";
import { winterSystemPromptFor } from "./system-prompt";
import { ClaudeExecutableUnavailable } from "./official-executable";
import type { OfficialPeer } from "./create";

/** P8c-2: the six-valued mapping `mode-options.ts`'s `permissionModeFor` already has, adapted for
 *  the official leg's OWN enum — same literal spellings (`default`/`plan`/`acceptEdits`/`dontAsk`),
 *  EXCEPT `bypass`, which `mode-options.ts` maps to Winter's `bypassPermissions` and which the
 *  official door's own `assertOptionsInvariants` REFUSES outright (D14/P8c-2: never
 *  `bypassPermissions` on this leg). `acceptEdits` is the closest non-bypass floor — every edit is
 *  pre-approved but every OTHER tool still reaches `canUseTool`, which is strictly more
 *  conservative than what `bypass` asked for, never less. */
export type OfficialPermissionMode = "default" | "plan" | "acceptEdits" | "dontAsk";

export function officialPermissionModeFor(policy: SessionApprovalPolicy): OfficialPermissionMode {
  switch (policy) {
    case "plan": return "plan";
    case "dont-ask": return "dontAsk";
    case "ask": return "default";
    case "accept-edits": return "acceptEdits";
    case "auto": return "default";
    case "bypass": return "acceptEdits"; // never bypassPermissions on this leg (D14/P8c-2)
    case "chat": return "default";
  }
}

/** The narrow surface the official runtime's broker call is shaped like — a LOCAL type (the
 *  router's own `ApprovalRequest` is not exported; see `official-capabilities.ts`'s header for why
 *  this file does not chase re-exports that do not exist at 0.0.2). Field names mirror Winter's own
 *  `CanUseTool` ctx VERBATIM (both trace to the same underlying approval vocabulary), which is what
 *  makes reusing 8b's bridge directly, rather than translating, the right shape. */
export interface OfficialApprovalRequestLike {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  toolUseID: string;
  requestId?: string;
  agentID?: string;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
}

/** `(toolName, input, extra) => Promise<PermissionResult | null>` — the plain broker shape the
 *  router auto-wraps (see this file's header). Built on 8b's own `canUseToolFor` bridge so approval
 *  semantics — cards, policy gating, control-plane denial — are byte-identical on both legs. */
export function officialBrokerFor(
  deps: CanUseToolDeps,
): (toolName: string, input: Record<string, unknown>, extra: OfficialApprovalRequestLike) => Promise<PermissionResult | null> {
  const bridge = canUseToolFor(deps);
  return (toolName, input, extra) =>
    bridge(toolName, input, {
      signal: extra.signal,
      toolUseID: extra.toolUseID,
      requestId: extra.requestId ?? extra.toolUseID,
      ...(extra.agentID === undefined ? {} : { agentID: extra.agentID }),
      ...(extra.suggestions === undefined ? {} : { suggestions: extra.suggestions }),
      ...(extra.blockedPath === undefined ? {} : { blockedPath: extra.blockedPath }),
    });
}

/** §3's minimal OS environment, by hand (the router's own `minimalOsEnvironmentFrom` is not
 *  reachable from the package root — see this file's header). `HOME`/`PATH` are load-bearing for a
 *  spawned child; `LANG`/`LC_ALL`/`TERM` are carried through only when the host process actually has
 *  them, never invented. */
export function minimalOsEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = { HOME: env.HOME ?? homedir(), PATH: env.PATH ?? "/usr/bin:/bin" };
  for (const name of ["LANG", "LC_ALL", "TERM"] as const) { const v = env[name]; if (v) out[name] = v; }
  return out;
}

/** The router's own `officialCredentialPlan` throws `RuntimeLaunchInputError` (unexported, so it is
 *  not `instanceof`-checkable here) when a non-`custom` family has no credential ref and no explicit
 *  plan — surfaced as a Norma-typed refusal rather than an uncaught throw out of this function. */
export class OfficialCredentialPlanRefused extends Error {
  readonly code = "official_credential_plan_refused" as const;
  constructor(detail: string) {
    super(`the official leg's credential plan could not be built: ${detail}`);
    this.name = "OfficialCredentialPlanRefused";
  }
}

export class OfficialProjectKeyTooDeep extends Error {
  readonly code = "official_project_key_too_deep" as const;
  constructor(readonly cwd: string, readonly key: string) {
    super(`the transcript project key for "${cwd}" ("${key}") exceeds the official runtime's own length limit; move the project to a shorter path or set a shorter NORMA_TMPDIR (WS-14 §3/R-4)`);
    this.name = "OfficialProjectKeyTooDeep";
  }
}

export interface OfficialSessionInput {
  sessionId: string;
  parentSessionId?: string;
  mode: SessionMode;
  cwd: string;
  outDir?: string;
  extraDirs?: string[];
  effort?: string;
  /** `SessionMeta.origin` — `"dispatch-child"` skips the output style, same as the Winter leg. */
  origin?: string;
  displayName?: string;
}

export interface OfficialInputDeps {
  /** NORMA_HOME. */
  home: string;
  /** This session's persisted/decided `RuntimeSelection` (P8c-12) — `officialCredentialPlan`'s
   *  own family-derivation key. */
  selection: RuntimeSelection;
  /** `provider-selection.ts`'s `providerSelectionFor(model, credentials)` result — carries the
   *  `authRef` a non-`custom` family's credential plan is auto-derived from. `undefined` is valid
   *  only for `custom`/`claude-oauth`/`local-none` families, or when the caller supplies BOTH
   *  `explicitCredentials` and (if needed) `explicitConnectionEnv` directly (the hermetic test
   *  bed's own shape — WS-14's `custom` family names its own variables). */
  provider?: ProviderSelection;
  /** Test/host escape hatch: names each variable and its ref directly, bypassing
   *  `officialCredentialPlan`'s family-derivation (the router's OWN `custom`-family precedent —
   *  `officialCredentialPlan` returns `explicit` immediately when it is set, for ANY family). */
  explicitCredentials?: readonly { variable: string; ref: CredentialRef }[];
  explicitConnectionEnv?: Readonly<Record<string, string>>;
  /** The already-resolved official peer (`runtime.officialPeer()`'s result) — `undefined` refuses
   *  typed rather than building an input nothing can launch with. */
  officialPeer: OfficialPeer | undefined;
  /** `runtime.claudeExecutableFor()` — re-resolved live, PER SESSION (door.ts: "a per-query
   *  `Options` value wins over" the constructor-time default), so a `runtimes.claudeExecutable`
   *  edit takes effect for the very next turn with no daemon restart. */
  claudeExecutableFor: () => { path: string } | ClaudeExecutableUnavailable;
  assembler: Pick<ContextAssembler, "assemble">;
  /** This session's already-built per-session Winter capability servers (`buildCapabilitiesFor`'s
   *  own output) — mirrored onto the official leg by `officialCapabilityServersFor` (P8c-4). */
  capabilities: CapabilityServerRecord;
  /** Everything `officialBrokerFor`/`canUseToolFor` needs, MINUS the three fields this function
   *  fills from `OfficialSessionInput` itself (never let a caller's stale `sessionId`/`mode`/`cwd`
   *  silently win over the session actually being opened). */
  canUseToolDeps: Omit<CanUseToolDeps, "sessionId" | "mode" | "cwd">;
  policy: SessionApprovalPolicy;
  /** `Options.hooks` for the official leg, once lane 3 merges (`hooksFor(session).official`);
   *  `undefined` until then (P8c-7's own gate). */
  hooks?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
}

/** `winterSystemPromptFor`'s memory-bucket choice, verbatim (chat/dispatch share `_assistant`; code
 *  is per-project) — so the official leg's `autoMemoryDirectory` is the SAME directory the Winter
 *  leg's MEMDIR resolves to for this session (WS-14 §2: "identical for both branches"). */
function autoMemoryDirectoryFor(input: OfficialSessionInput, home: string): string {
  const opts: MemoryDirOptions = { normaHome: home };
  return input.mode === "dispatch" || input.mode === "chat" ? assistantMemoryDirFor(opts) : memoryDirFor(input.cwd, opts);
}

/** `officialInputFor`'s success shape: the `RouterOfficialInput` AND, separately, the executable
 *  path it resolved with — `pathToClaudeCodeExecutable` is NOT a field of `OptionsTemplatePolicy`
 *  (measured: `dist/official/options-template.d.ts`'s `OptionsTemplatePolicy` has no such member;
 *  only `RuntimeSdkOptions.vendoredOfficialRuntime`, set ONCE at construction, and — per
 *  `dist/sdk.d.ts`'s own comment on that field — the top-level `Options.pathToClaudeCodeExecutable`
 *  a caller passes to `sdk.query({ options })` itself, forwarded like the rest of `Options` via the
 *  router's own `forwardableOptions`). So the caller (`official-session.ts`) sets it at the OUTER
 *  `options` level, not inside `runtime.official.options` — this is what keeps `runtimes.
 *  claudeExecutable` hot (P8c-3) despite the constructor-time value being fixed at boot. */
export interface OfficialInput {
  input: RouterOfficialInput;
  pathToClaudeCodeExecutable: string;
}

/**
 * Builds this session's `RouterOfficialInput`, or the typed refusal that stops the session before
 * anything is spawned.
 */
export function officialInputFor(
  input: OfficialSessionInput,
  deps: OfficialInputDeps,
): OfficialInput | ClaudeExecutableUnavailable | OfficialProjectKeyTooDeep | OfficialCredentialPlanRefused {
  const executable = deps.claudeExecutableFor();
  if (executable instanceof ClaudeExecutableUnavailable) return executable;

  const projectKey = transcriptProjectKey(input.cwd);
  if (!isVendorCompliantProjectKey(projectKey)) return new OfficialProjectKeyTooDeep(input.cwd, projectKey);

  const env = deps.env ?? process.env;
  const permissionMode: WinterPermissionMode = officialPermissionModeFor(deps.policy) as WinterPermissionMode;

  const broker = officialBrokerFor({ ...deps.canUseToolDeps, sessionId: input.sessionId, mode: input.mode, cwd: input.cwd });
  const systemPromptAppend = winterSystemPromptFor(deps.assembler, {
    mode: input.mode,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    primary: input.cwd,
    cwd: input.cwd,
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.extraDirs === undefined ? {} : { extraDirs: input.extraDirs }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  });

  const mcpServers = deps.officialPeer === undefined
    ? {}
    : officialCapabilityServersFor(deps.capabilities, deps.officialPeer as unknown as OfficialMcpModule);

  const base = minimalOsEnvironment(env);
  const sharedTempRoot = env.NORMA_TMPDIR?.trim() ? env.NORMA_TMPDIR : tmpdir();
  // WS-14 §12: the router derives ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN for console-oauth)
  // from `provider.authRef` for every family it can — `explicitCredentials`/`explicitConnectionEnv`
  // are the `custom`-family escape hatch a hermetic loopback bed needs (WS-14's own precedent: name
  // each variable and its ref). Neither call ever touches a `SecretStore` — the read happens at
  // spawn, through the router's own `KeychainSeam`.
  let credentials: readonly { variable: string; ref: CredentialRef }[];
  try {
    credentials = officialCredentialPlan({ selection: deps.selection, provider: deps.provider, explicit: deps.explicitCredentials as never }) as never;
  } catch (err) {
    return new OfficialCredentialPlanRefused(err instanceof Error ? err.message : String(err));
  }
  const connectionEnv = officialConnectionEnv({ selection: deps.selection, provider: deps.provider, explicit: deps.explicitConnectionEnv });

  return {
    pathToClaudeCodeExecutable: executable.path,
    input: {
      sessionId: input.sessionId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      base,
      autoMemoryDirectory: autoMemoryDirectoryFor(input, deps.home),
      projectKey,
      sharedTempRoot,
      mcpServers,
      ...(credentials.length === 0 ? {} : { credentials }),
      ...(Object.keys(connectionEnv).length === 0 ? {} : { connectionEnv }),
      remoteConfig: "deny",
      advertisesHandoff: true,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      options: {
        // Structural assignment onto `Omit<OptionsTemplatePolicy, …>` — see this file's header for
        // why the type is not imported by name (it is not exported at 0.0.2).
        //
        // P8c-L1-BLOCKER (measured against the installed 0.0.2 `dist/index.js`, `buildOfficialOptions`):
        // `options.canUseTool` is used VERBATIM when set (`policy.canUseTool ?? createApprovalBridge({
        // …fail-closed default… })`) — it is NEVER auto-wrapped. `assertOptionsInvariants`'s own tail
        // check (`isOurApprovalBridge`) then refuses ANY value here that was not produced by the
        // router's OWN `createApprovalBridge`, which `official-capabilities.ts`'s header already
        // established is unreachable from the package root (only `"."` is in `package.json`'s
        // `exports`, and `createApprovalBridge` is not re-exported through it). So `officialBrokerFor`
        // above is built and TESTED (`official-options.test.ts`) but CANNOT be wired here today — doing
        // so makes `buildOfficialOptions` throw `canUseTool: the approval bridge is missing or is not
        // this branch's` for EVERY session, before any child spawns. Leaving the field UNSET falls
        // through to the router's own branded default, which DENIES every tool call with a fixed
        // message ("no approval broker is configured for this session … a host must bridge its broker
        // into canUseTool") — sessions still open and hold a plain-text conversation; a capability
        // tool call is refused until router 0.0.3 exports `createApprovalBridge` (or an equivalent
        // per-session hook). CARRIED to the lane report; `official-leg.e2e.test.ts`'s capability-tool
        // case is `.skip`ped with this same note.
        permissionMode: permissionMode as unknown as never,
        systemPromptAppend,
        ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
      } as RouterOfficialInput["options"],
    },
  };
}
