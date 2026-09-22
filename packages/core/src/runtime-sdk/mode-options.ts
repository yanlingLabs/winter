import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentDefinition, CanUseTool, CredentialRef, EffortLevel, McpServerConfig, Options, PermissionMode, ProviderConnectionConfig,
  SandboxSettingsConfig, SdkPluginConfig, SpawnClaudeCodeProcess, WebFetchConfig, WebToolsConfig,
} from "@yanlinglabs/winter-agent-sdk";
import { RESUME_STAGING_PREFIX, type CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { EXA_API_KEY_SECRET } from "../agent/tools/search";
import { keychainService } from "../profile";
import type { SessionApprovalPolicy } from "../agent/gate";
import type { Settings } from "../settings";
import type { Mode as SessionMode } from "../agent/tools/registry";
import { CONTROL_PLANE_FILENAMES } from "./control-plane";
import { providerFor, testProviderNameFor } from "./provider-selection";
import { splitTag, WINTER_TEST_PREFIX, type ModelTag } from "./model-tag";
import { WINTER_ADVERTISED_TOOLS_0_0_4, RUNTIME_HOST_TOOL_PAIRS, WINTER_OWN_TOOL_NAMES } from "./tool-names";

/**
 * **The six Winter policies → Winter's `PermissionMode`** (P8b-7, AMENDED by the whole-branch
 * review's F1).
 *
 * Two mappings are not renames. `ask → "default"` (surface map §5.2), and **`auto → "default"`**:
 * Winter's `auto` means "the HOST gate decides everything without a card" (`gate.evaluate`'s own
 * `auto` column — allow MUTATING, deny nothing a card would have asked about), and Winter's `auto`
 * mode means something else entirely — its MODEL-BACKED classifier runs ahead of `canUseTool`, a
 * model call per tool use Winter never configured, and with an ineligible model or a test double it
 * FAILS CLOSED ("Blocked by classifier") before the gate is ever asked. Dispatch is created with
 * `approvalPolicy: "auto"`, so `auto → auto` put the shipped default behind that classifier. Under
 * `"default"` every call reaches `canUseTool`, where the gate's `auto` verdict is the live policy —
 * which is what `auto` has always meant on the engine. The mode-matrix test pins both.
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
/**
 * **May a child spawned for `policy` ever be in `bypassPermissions`?** The ONE rule behind both of the
 * Winter leg's spawn-time bypass facts (`buildWinterOptions`): `allowDangerouslySkipPermissions` is set
 * iff this is true, and `permissions.disableBypassPermissionsMode` (the clamp against an agent
 * DEFINITION minting its own bypass) is set iff it is false.
 *
 * Both are fixed when the child is SPAWNED, and the runtime refuses a live `setPermissionMode(
 * "bypassPermissions")` on a clamped child. So a live policy change whose two ends disagree here
 * cannot be told to the running child — it needs a new one. `session.setPolicy` (`ipc/server.ts`)
 * reads this same function to decide that, so the rule that sets the clamp and the rule that decides
 * a replacement can never drift apart.
 */
export function bypassAllowedAtSpawn(policy: SessionApprovalPolicy): boolean {
  return policy === "bypass";
}

export function permissionModeFor(policy: SessionApprovalPolicy): PermissionMode {
  switch (policy) {
    case "plan": return "plan";
    case "dont-ask": return "dontAsk";
    case "ask": return "default";
    case "accept-edits": return "acceptEdits";
    case "auto": return "default";   // the gate decides, never Winter's classifier (review F1)
    case "bypass": return "bypassPermissions";
    case "chat": return "default";
  }
}

/** Every capability tool the daemon owns, and the modes it is exposed to (P8b-27 ruling 8). Keyed
 *  by the canonical `mcp__winter__<serverKey>__<tool>` names Task 7's `capabilityToolName` mints.
 *
 *  **This table, not `WINTER_CAPABILITY_TOOLS`, is what `disallowedTools` is built from** — Task 7's
 *  export lands in another lane, and the integration parity test diffs the two so a capability that
 *  exists in one and not the other is a loud failure rather than a silently unexposed tool.
 *
 *  Exposure mirrors today's registered `modes`, tool for tool (Winter map §5.2): `browser` is the
 *  only all-three entry (chat's read-only restriction is enforced INSIDE the capability, not by
 *  hiding the tool); `computer`/office are code+dispatch; the `sessions` trio is dispatch-only;
 *  `research` is chat+dispatch, which is the mode-scoped exposure WS-06 §5 would otherwise have
 *  collapsed into the code-mode web tools. */
export const CAPABILITY_TOOL_MODES: Readonly<Record<string, { modes: readonly SessionMode[] }>> = {
  "mcp__winter__sessions__session_spawn": { modes: ["dispatch"] },
  "mcp__winter__sessions__list_sessions": { modes: ["dispatch"] },
  "mcp__winter__sessions__manage_session": { modes: ["dispatch"] },
  "mcp__winter__computer__computer": { modes: ["code", "dispatch"] },
  "mcp__winter__browser__browser": { modes: ["code", "dispatch", "chat"] },
  "mcp__winter__office__docs": { modes: ["code", "dispatch"] },
  "mcp__winter__office__sheets": { modes: ["code", "dispatch"] },
  "mcp__winter__office__slides": { modes: ["code", "dispatch"] },
  // `Search` — chat's and dispatch's own search tool (Exa ANSWER mode). Its exposure ALSO depends on
  // whether an Exa key is stored, which is runtime state, so `disallowedToolsFor` decides that half;
  // this row states the mode registration, as every other row does.
  "mcp__winter__research__Search": { modes: ["chat", "dispatch"] },
  // `mcp__winter__research__ReadPage` and the `mcp__winter__web__*` pair were here until the 2026-09-18
  // web-tools ruling. P8b-33's reason for a daemon-owned web pair ("the SDK's built-ins carry neither
  // the Exa key nor the dangerous-domain floor") expired at agent SDK 0.0.17, which gives the child
  // both through `Options.web` — so the daemon's copies retired rather than shadowing the real tools.
  // See `SDK_WEB_BUILTINS` for the per-LEG rule that replaces them.
  // Fix wave (review F7): the `lsp` capability server — code-only, as the registry door was.
  "mcp__winter__lsp__lsp": { modes: ["code"] },
};

/**
 * **The two web built-ins BOTH runtimes ship**, under the same two names.
 *
 * Agent SDK 0.0.17 gives the Winter runtime its own `WebFetch`/`WebSearch` — a copy of claude's, on
 * by default in every session's `init.tools` — and the official leg has always had claude's native
 * pair. So the blanket per-mode disallow P8b-33 imposed (they had no Exa key and no dangerous-domain
 * floor, both of which were daemon state a built-in could not reach) is retired: `Options.web` now
 * carries the key as an `authRef` the child resolves itself and the floor as `blockedDomains`.
 *
 * **The rule is now per LEG and per MODE** (user ruling, 2026-09-18) — see `disallowedToolsFor`:
 *
 *   official leg   both tools stay, claude's own, with claude's own per-domain approval behaviour.
 *   Winter, code   both tools.
 *   Winter, chat   `WebFetch`, plus `WebSearch` ONLY when no Exa key is stored — with a key, the
 *   Winter, disp.  daemon's `Search` (Exa answer mode) is the search surface instead, and exposing
 *                  two searches to one model is a choice nobody asked it to make.
 */
export const SDK_WEB_BUILTINS: readonly string[] = ["WebFetch", "WebSearch"];

/**
 * The daemon's own `Search`, by wire name — the ONE capability tool whose exposure depends on runtime
 * state rather than on the mode alone, and the exact complement of `WebSearch`'s rule above.
 *
 * A literal, like every key in `CAPABILITY_TOOL_MODES`, and for the same reason: it is diffed against
 * `capabilityToolName("research", "Search")` by the names test rather than computed here, so this
 * module keeps no import edge into `capabilities/`.
 */
export const EXA_GATED_SEARCH_TOOL = "mcp__winter__research__Search";

/**
 * Which runtime leg a tool list is being built for. The two legs' web surfaces are decided by
 * DIFFERENT owners — Winter's by this daemon's `Options.web`, claude's by claude — so the leg is a
 * REQUIRED argument rather than a defaulted one: a call site that forgets it would silently hand one
 * leg the other's answer, and that is the exact failure the ruling is about.
 */
export type ToolExposureLeg = "winter" | "official";

export interface ToolExposure {
  leg: ToolExposureLeg;
  /**
   * Is an Exa API key stored? Decides chat/dispatch's search surface (see `SDK_WEB_BUILTINS`).
   *
   * ABSENT READS AS `true` — the NARROWER surface (no `WebSearch` in chat/dispatch). A caller that
   * cannot answer the question must not thereby widen a mode's tool set; `session-driver.ts` probes
   * it live at every incarnation, so the real sessions always answer it.
   */
  exaKeyPresent?: boolean;
}

/**
 * The bare allow rules the two web built-ins need on the WINTER leg in code mode, and nowhere else.
 *
 * WHY THEY ARE NEEDED (measured in the pinned SDK's `permissions/evaluator.ts`): neither tool is in
 * `isBuiltInReadOnly` or `TASK_MODE_CLASS_SILENT_ALLOW`, so the mode stage answers `unresolved` for
 * them — and under `dontAsk` the post-allow-stage fallback DENIES an unresolved call outright and
 * `canUseTool` is never called (§6.3, "every would-prompt outcome becomes a denial"). Winter's
 * `dont-ask` policy maps to that mode, and Winter's own gate has always answered `allow` for the web
 * class under EVERY policy (`agent/gate.ts`'s `NETWORK`, "web tools free at this gate"). Without
 * these rules a `dont-ask` code session would silently lose both tools — a behaviour change the
 * ruling did not ask for, invisible except as a refusal in the transcript.
 *
 * THEY CANNOT WIDEN ANYTHING. Both runtimes evaluate deny rules (stage 2) and ask rules (stage 3)
 * BEFORE allow rules (stage 5), so a PreToolUse hook's deny (lane B3's floor) and every deny rule
 * still win. The private-address ask is deliberately ahead of stage 5 too — the SDK's own evaluator
 * says so in as many words ("neither a permissive mode nor a broad allow (`WebFetch`, …)") — so a
 * loopback or private target still prompts in code mode under this rule. And a BARE name is not an
 * exact-host `WebFetch(domain:<host>)` rule, so it grants none of the standing DNS-rebinding consent
 * that naming a host does.
 *
 * NOT on the official leg, deliberately: claude asks per domain there and the user asked for claude's
 * native behaviour to be kept exactly.
 */
export const WEB_BUILTIN_ALLOW_RULES: readonly string[] = [...SDK_WEB_BUILTINS];

/**
 * Anchor a rule specifier to the FILESYSTEM ROOT — see `controlPlaneDenyRules`.
 *
 * The grammar has three anchors and only one of them binds the way this fence needs (measured; see
 * `controlPlaneDenyRules`' own comment): a **single leading `/`** is "relative to the rule's own
 * settings-file directory" and is INERT for an SDK-seeded rule; a **bare** pattern anchors to cwd;
 * **`//`** is the filesystem root.
 *
 * So an already-absolute path gets ONE more slash (`/h/x` → `//h/x`) and a bare pattern gets two
 * (`**{}/.winter/x` → `//**{}/.winter/x`). Doing this by concatenating a single constant is exactly
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
 * design; `registry.namesForMode("chat")` is `{AskQuestion, Search, browser}` today). On
 * the Winter leg that becomes `AskUserQuestion` (the one tool that replaced `AskQuestion`), the
 * `research` capability's `Search`, the `browser` capability tool, and Winter's own four default tools
 * (P8b-28, allowed silently in every mode).
 *
 * Everything else a Winter child advertises is in chat's `disallowedTools`.
 *
 * 2026-09-18 (user ruling): `WebFetch` joins it, and it is now the ONLY way chat reads a page — the
 * `research` capability's `ReadPage` retired in the same change. The SDK's own `WebFetch` does that act
 * the way claude does, with
 * the daemon's domain floor and a `privateAddressPolicy` of `deny` (chat never asks, so a private
 * target is refused rather than prompted). `WebSearch` is NOT in this literal: whether chat sees it
 * depends on whether an Exa key is stored, which is runtime state and therefore `disallowedToolsFor`'s
 * decision, not a module constant's.
 */
export const CHAT_ALLOWED_WINTER_TOOLS: readonly string[] = [
  "AskUserQuestion",
  "WebFetch",
  ...[...WINTER_OWN_TOOL_NAMES].sort(),
];

/**
 * The Winter built-ins CHAT excludes — **derived from what the CHILD ACTUALLY ADVERTISES**
 * (`WINTER_ADVERTISED_TOOLS_0_0_4`, measured from the built binary) minus chat's allowed set, plus
 * Winter's own pair-table names for completeness.
 *
 * **NEITHER web built-in is here, in either direction** (0.0.17): `WebFetch` is in chat's allowed set
 * and `WebSearch`'s exposure depends on whether an Exa key is stored — a runtime fact. Both are
 * therefore decided in ONE place, `disallowedToolsFor`, rather than half here and half there, which
 * is why the pair table's own two rows are filtered out below.
 *
 * Review F4: deriving this from Winter's pair table left `Monitor`, `ReportFindings` and
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
  ...RUNTIME_HOST_TOOL_PAIRS.map(([winter]) => winter),
])].filter((w) => !CHAT_ALLOWED_WINTER_TOOLS.includes(w) && !SDK_WEB_BUILTINS.includes(w)).sort();

export interface WinterOptionsInput {
  mode: SessionMode;
  /** Seven-valued in practice — chat sessions persist the internal `"chat"` policy. */
  policy: SessionApprovalPolicy;
  /** `SessionMeta.origin`; `"dispatch-child"` makes a code-mode child never-prompt (P8b-26). */
  origin?: string;
  /** The pre-allocated BACKEND uuid from 8a's creation transaction (surface map §6.1) — not
   *  Winter's own `s_<hex>` session id. */
  sessionId: string;
  /** WINTER_HOME for this daemon. The child resolves its own home from the brand's env, so this is
   *  what keeps a test session's transcript out of `~/.winter`. */
  home: string;
  profile?: string;
  cwd: string;
  /** WS-20: always a provider-qualified tag (or a `winter-test/<name>` double). */
  model?: ModelTag;
  /** WS-20: NOT consumed by this file any more — `providerFor` names a provider's credential
   *  LOCATOR unconditionally (a tag always resolves to exactly its provider), never gated on
   *  presence. Presence-based refusal is `session-driver.ts`'s `beforeTurn`'s own job. Kept on the
   *  interface for callers that still pass it. */
  credentials: CredentialPresence;
  effort?: EffortLevel;
  systemPrompt?: string;
  outputStyle?: string;
  spawn: { pathToClaudeCodeExecutable: string; spawnClaudeCodeProcess?: SpawnClaudeCodeProcess };
  canUseTool: CanUseTool;
  abort: AbortController;
  /** Task 7's `WINTER_CAPABILITY_TOOLS`, or `CAPABILITY_TOOL_MODES` until it lands. */
  capabilityTools?: Readonly<Record<string, { modes: readonly SessionMode[] }>>;
  /**
   * P8b-36 (Task 16): THIS session's daemon-owned capability servers, already keyed by server name
   * (`buildSessionCapabilities(session)` — `capabilities/index.ts`'s `CapabilityServerRecord`).
   * SPREAD into `Options.mcpServers` verbatim: the child derives each tool's wire name
   * (`mcp__winter__<key>__<tool>`) from the RECORD KEY, so the record is not re-keyed here. Any other
   * server merged into the same record goes through `assertNoCapabilityCollision` first — the
   * driver's job, not this builder's. Absent ⇒ no `mcpServers` at all (the matrix test pins that).
   */
  capabilities?: Readonly<Record<string, McpServerConfig>>;
  /**
   * P8b-30 / Task 9 concern 6 (Task 16 obligation): the BYO endpoint for an `openai-compatible`
   * provider. Threaded into `Options.provider.connection` so a session pointed at a non-OpenAI
   * compatible endpoint is not silently routed to the catalog's `api.openai.com`. `endpointOrigin`
   * is always `"user"` here — a host-entered endpoint, the conservative reading the SDK documents.
   * Ignored when no provider is selected (a `winter-test/*` model, or a model Winter cannot name).
   */
  connection?: ProviderConnectionConfig;
  /**
   * P8b-24 / surface map §6.2: resume the backend transcript named by `sessionId` instead of
   * starting a new one. When set, `Options.resume` carries the uuid and `Options.sessionId` is
   * OMITTED — the id comes from the transcript. The driver sets it only when that transcript
   * exists (measured: a resume of a transcript that was never written hangs and dies before init).
   */
  resume?: boolean;
  /** Extra child env, merged LAST. Never a channel for secrets. */
  env?: Record<string, string>;
  /** The environment PATH/HOME/TMPDIR are read from. Defaults to `process.env`; a test pins it. */
  baseEnv?: Record<string, string | undefined>;
  /**
   * P8c-7 (measured = YES, `test/runtime-sdk/hooks-measure.e2e.test.ts`): `hooks.ts`'s
   * `sessionHooksFor(...).winter` — plugin manifest hooks, the bash safety reviewer,
   * diagnostics-after-edit, and the `fileDiff` producer, wired verbatim onto `Options.hooks`.
   * Absent ⇒ no hooks at all (byte-identical to every pre-8c-Lane-3 session) — the driver decides
   * whether to build one; this builder never constructs `SessionHooksDeps` itself.
   */
  hooks?: Options["hooks"];
  /**
   * P8d-8 (D30): the WINTER leg's own advisor target model, ALREADY RESOLVED by the caller
   * (`session-driver.ts`'s `optionsFor`, from `winterOptionsFromSettings(settings()).advisorModel ??
   * d30DefaultModel(model)` — a LIVE read at every incarnation, never a boot snapshot). Set verbatim
   * onto `Options.advisor.model`, which the SDK's own doc says "wins over its own settings.advisor.model"
   * — so this is Winter's deterministic 8d workaround for the M5 gap (`advisor-reviewer.ts`'s own
   * header), never conditional on whether `runtimes.advisorModel` itself is set. Absent only when the
   * session has no model at all yet (`d30DefaultModel` falls through to the caller's `model`, itself
   * possibly `undefined`) — in which case no `advisor` key is set and the child's own default applies.
   */
  /** WS-20: always a provider-qualified tag. */
  advisorModel?: ModelTag;
  /** WS-20: the "anthropic" vs "console" arm is the tag's own prefix (`providerFor`,
   *  provider-selection.ts), not a settings-driven decision `credentialRefFor` used to make — this
   *  field is NOT consumed for that anymore. Batch 3 (item 2) gave it a second, unrelated consumer:
   *  `permissionDenyRulesFor(input.home, input.settings)` reads `settings.permissions.deny` for the
   *  extra SDK-grammar deny rules layered onto the fixed control-plane fence. Still just an input
   *  the caller passes in — `buildWinterOptions` never reads a file itself. */
  settings?: Settings | null;
  /**
   * Daemon settings surface (2026-09-17 plan, item 3): `<home>/agents/*.md`, ALREADY PARSED by the
   * caller (`session-driver.ts`'s `optionsFor`, `loadUserAgentDefinitions(home).definitions`) —
   * this builder stays pure/no-I/O (the doc comment on `buildWinterOptions` below, and the 3×6
   * matrix test that relies on it), so it never reads the directory itself. Absent or empty ⇒ no
   * `agents` key at all, byte-identical to a pre-item-3 session. Read fresh at EVERY incarnation by
   * the caller (never cached here or there), so a new/edited/removed file reaches the session's
   * next incarnation with no daemon restart.
   */
  agents?: Readonly<Record<string, AgentDefinition>>;
  /**
   * 2026-09-18 (agent SDK 0.0.17): is an Exa API key stored?
   *
   * TWO consumers, and they pull in opposite directions, which is why it is one input and not two:
   * `disallowedToolsFor` withholds `WebSearch` from chat/dispatch when a key exists (the daemon's
   * `Search` covers it), and `Options.web.search.authRef` NAMES that key for the child when it does.
   *
   * A PURE boolean, probed by the caller (`session-driver.ts`'s `optionsFor`, live at every
   * incarnation beside the provider credential probe) — this builder never reads a secret store, and
   * the VALUE never reaches it: the daemon names the credential and the child resolves it.
   *
   * Absent reads as "a key is stored" — the narrower tool surface; see `ToolExposure`.
   */
  exaKeyPresent?: boolean;
  /**
   * The dangerous-domain FLOOR, as hostnames, for `Options.web.blockedDomains` (0.0.17).
   *
   * `SHIPPED_DANGEROUS_DOMAINS ∪ settings.permissions.dangerousDomains.added` for THIS session's
   * project, already resolved by the caller (the daemon's own `dangerousDomainsAdded(cwd)` getter,
   * which is project-settings aware) — this builder stays pure and reads no settings tree itself.
   *
   * The two match rules agree: Winter's own `dangerousDomainMatch` is "equal, or a `.`-anchored
   * suffix", and the SDK documents `blockedDomains` as suffix matching on a label boundary with a
   * leading `*.`/`.` ignored. So the list travels verbatim, with no translation.
   */
  dangerousDomains?: readonly string[];
  /**
   * `pins.research` — `WebFetch`'s PAGE-DIGEST model (user ruling 2026-09-18), already resolved by
   * the caller through `pinsFor(settings)`.
   *
   * Passed as the QUALIFIED tag (not the bare id the session's own `Options.model` carries): the SDK
   * resolves it through the same selection path as a session model, and a qualified key is the one
   * form that names its provider unambiguously. `Options.web.fetch.authRef` is set alongside it from
   * that provider's own Keychain locator — always, even for the session's own provider, for the same
   * reason `Options.advisor.authRef` is set explicitly: the child's own fallback would resolve
   * `<providerId>:default` under the BRAND's Keychain service, which is the DIST service even for a
   * dev-profile daemon.
   *
   * ABSENT means "the session's own model", the SDK's documented default — which is also what the
   * caller passes when the pin resolves to the session's own tag, or to a provider with no stored
   * credential (a stated-but-unresolvable digest model is a typed refusal on every `WebFetch` call,
   * and a tool that cannot work is worse than one that costs a little more).
   */
  digestModel?: ModelTag;
  /**
   * B1 (2026-09-22): the skills THIS session's child may load — `SkillStore.childSkillSurface`'s
   * answer, computed by the caller (`session-driver.ts`'s `optionsFor`, live at every incarnation, code
   * mode only) because building it touches the filesystem and this builder stays pure.
   *
   * `plugins` are skills-only local-plugin views (see `childSkillSurface` for why never a plugin's own
   * directory); `skills` is the invocable subset (the daemon's plugin-tier names minus `Skill(<name>)`
   * deny rules). BOTH ARE OMITTED FROM `Options` WHEN `plugins` IS EMPTY — byte-identical to every
   * session before this field existed, and a filter over an empty index would only add a warning.
   * With plugins present, `skills` is always stated, `[]` included (the SDK reads `[]` as "none").
   */
  plugins?: readonly SdkPluginConfig[];
  skills?: readonly string[];
}

/**
 * **The child's environment, BUILT rather than inherited.**
 *
 * `process.env` is never spread in. The child resolves its own home from the brand's env prefix
 * (`resolveWinterHome` under `CORE_BRAND` reads `WINTER_HOME`), so a child that inherited the
 * daemon's ambient environment would write a real transcript under `~/.winter` the moment a test ran
 * on a machine with a real install — the exact thing CLAUDE.md's hard rule forbids. Passing
 * `WINTER_HOME` explicitly from `input.home` is what pins it to the temp home a test built.
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
  // which let a caller-supplied `input.env.WINTER_HOME` silently override the one value CLAUDE.md's
  // hard rule depends on — a test session would then have written a real transcript under
  // `~/.winter`. `input.env` is for extras; the home and profile are not negotiable.
  env.WINTER_HOME = input.home;
  env.WINTER_PROFILE = input.profile ?? "";
  // The scripted in-process double (Winter map §11.6): selection is BY NAME, because a spawned or
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
 * shipped feature.** Two directories under WINTER_HOME are agent-writable BY DESIGN:
 *
 *  - the MEMDIR, `<home>/projects/<key>/memory/` (`agent/memory-dir.ts`) — CLAUDE.md's tool surface
 *    is "file-based memory (a MEMDIR of markdown files written with normal write/edit — no
 *    dedicated memory tools)". A blanket `<home>/**` deny deletes file-based memory outright.
 *  - `$OUTDIR`, `<home>/outputs/<sessionId>` (`sessions/outdir.ts`) — "a blessed, agent-writable
 *    exception under `~/.winter`", folded into the session's own write fence.
 *
 * So the fence is drawn exactly where today's is: today's `controlPlaneFileTarget` matches **by
 * FILENAME, never by directory** ("`.winter/` itself stays writable … `.winter/memory/` is the MEMDIR
 * by design"), and today's seatbelt does the same with a `(deny file-write* …)` line placed AFTER
 * the writable-subpath allow so it carves out those exact files and nothing else. These rules are
 * the same shape: the three control-plane filenames under any `.winter` directory at any depth, plus
 * `<home>/run/**` (the socket/pid control plane, already the sole READ denial too).
 *
 * **EVERY rule is `//`-anchored, and that is load-bearing** (review F2, measured). In WS-07 §3.1's
 * grammar (`permissions/paths.ts:60-78` at `v0.0.3`):
 *  - a **single leading `/`** means "relative to the rule's own settings-file directory", and
 *    `sourceDir` is `undefined` for every SDK-seeded rule — which makes such a rule **INERT, and
 *    silently so**. The SDK hit this itself and left the comment at `engine.ts:1370-1375`: *"Found
 *    by the fixture: the rule list was right and nothing was denied."*
 *  - a **bare** pattern anchors to **cwd**, so a bare `**{}/.winter/<f>` covers only `<cwd>` and below — not
 *    the project-INDEPENDENT surface this fence exists to enforce.
 *  - `//` is the filesystem-root anchor and is what actually binds.
 *
 * Measured against the real matcher (the pinned checkout's `evaluate()` + `buildBaselineDenyRules`,
 * the same harness `baseline-projects-deny.test.ts` uses): bare `**{}/.winter/<f>` denied an in-cwd
 * target and did **not** deny an out-of-cwd one; a single-`/` absolute denied nothing at all; and
 * both `//`-anchored forms denied every target. The matcher is not exported from the installed
 * package, so `mode-matrix.test.ts` pins the anchor FORM and resolves each rule to its absolute
 * target instead — see its own comment.
 */
export function controlPlaneDenyRules(home: string): string[] {
  const writeTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  // P8d-12 (WS-16 §10); Winter Phase 10b (D1-3, W18-9): the official leg's own SDK-parent staging
  // root — `claude-resume-<uuid>` directories the Claude Agent SDK stages a cross-generation resume
  // payload under, directly in the SYSTEM temp dir (never under `home`, which is why this rule
  // anchors at `tmpdir()` rather than joining `home` the way every other rule here does). Nothing on
  // either leg may read OR write another generation's — or another session's — staged resume
  // payload: the official SDK's own process boundary does not fence that off from a child it spawns,
  // and a resume payload can carry provider-native state as sensitive as anything under
  // `<home>/runtimes`. As of 10b the prefix is IMPORTED from the router's own
  // `RESUME_STAGING_PREFIX` (`@yanlinglabs/winter-runtime-sdk`, exported since 0.0.4) rather than
  // hand-rolled here — this is the same literal `isResumeStagingRoot`/`resumeStagingRoot` build
  // staging roots FROM, so a future rename on the router's side fails this rule at compile/test time
  // instead of silently drifting. `runtime-state/recovery.ts`'s step 8 scan still repeats its OWN
  // copy of the prefix (a different subsystem this phase does not bridge) and names this file in its
  // own comment, so a rename there is still a manual sweep.
  //
  // The mid-segment `*` is a real glob wildcard on the pinned SDK's own matcher, not a literal
  // asterisk: `packages/runtime/src/permissions/paths.ts`'s `globSegmentToRegexBody` compiles a
  // mid-segment `*` to `[^/]*`, so `<prefix>*` matches every `claude-resume-<uuid>` name and nothing
  // else — recorded so this form is not re-investigated.
  const claudeResumeStaging = fsRootAnchored([join(tmpdir(), `${RESUME_STAGING_PREFIX}*`), "**"].join("/"));
  const targets = [
    // Any project's control-plane files, at any depth — the project-INDEPENDENT invariant
    // (`controlPlaneFileTarget`'s own doc: "the agent must NEVER write ANY
    // `<any>/.winter/permissions.local.json`, whichever project owns it").
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => fsRootAnchored(["**", ".winter", f].join("/"))),
    // The user's own global copies, whose parent is literally `<home>` rather than `<x>/.winter`.
    ...[...CONTROL_PLANE_FILENAMES].sort().map((f) => fsRootAnchored(join(home, f))),
    // The daemon's control plane: sockets, pid files, the runtime state db.
    fsRootAnchored([join(home, "run"), "**"].join("/")),
    claudeResumeStaging,
    // HIGH (fix wave, pre-merge review, finding 2c): an agent DEFINITION file is itself a
    // permission-bearing surface (`agent-definitions.ts`'s own header: "an agent definition's
    // `permissionMode`/`tools`/`disallowedTools` fields are themselves a permission grant") — same
    // class of self-grant the three control-plane filenames above exist to fence, just a directory
    // of them rather than three fixed names. Both tiers, same "project-INDEPENDENT, any depth"
    // treatment as the control-plane filenames: the user's own `<home>/agents/**` and any project's
    // `**/.winter/agents/**`, whichever project owns it. `permissionMode` is ALSO stripped at parse
    // time (`parseAgentDefinitionFile`) — this write fence and that strip are independent layers over
    // the same invariant, the same "two layers over one self-grant" posture `controlPlaneFileTarget`'s
    // own doc states for the host-side fence vs. the deny-rule fence.
    fsRootAnchored([join(home, "agents"), "**"].join("/")),
    fsRootAnchored(["**", ".winter", "agents", "**"].join("/")),
  ];
  // Task 17: the engine's read tool denied `<home>/run` and `<home>/runtimes` (the runtime store,
  // 8a's model-denied directory); the Winter leg's read-class tools carry the same two denials.
  const readTools = ["Read", "Glob", "Grep"];
  const readTargets = [
    fsRootAnchored([join(home, "run"), "**"].join("/")),
    fsRootAnchored([join(home, "runtimes"), "**"].join("/")),
    claudeResumeStaging,
  ];
  return [...writeTools.flatMap((t) => targets.map((p) => `${t}(${p})`)), ...readTools.flatMap((t) => readTargets.map((p) => `${t}(${p})`))];
}

/**
 * Daemon settings surface batch 3 (item 2): `controlPlaneDenyRules(home)` (the FIXED control-plane
 * fence above) PLUS whatever `settings.permissions.deny` names (user/daemon-authored SDK-grammar
 * rules — today only `Skill(<name>)`, written by `settings.setSkillDenied`, but a hand-written entry
 * of any other shape rides along unchanged). This is the ONE place both legs' `Options.permissions.
 * deny` is assembled from, so `buildWinterOptions` (below) and `official-options.ts`'s
 * `officialInputFor` reuse this exact function rather than each concatenating the two lists their
 * own way — the same "provably the same fence on both legs" precedent `controlPlaneDenyRules`'s own
 * doc states for `sandboxConfigFor`. `settings` is read from the ALREADY-RESOLVED input a caller
 * passes in (never a file read here) — this function stays as pure as `controlPlaneDenyRules`
 * itself, just with one more input.
 */
export function permissionDenyRulesFor(home: string, settings: Settings | null | undefined): string[] {
  return [...controlPlaneDenyRules(home), ...(settings?.permissions?.deny ?? [])];
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
/**
 * USER RULING 2026-09-18: reads are GLOBALLY allowed, on BOTH legs, stated the same way on both.
 *
 * Winter's position has always been that `Read`/`Glob`/`Grep` are unfenced apart from the daemon's
 * own state (CLAUDE.md: "Reads are deliberately unfenced"). Until this constant that was true only
 * INDIRECTLY: neither leg carried an allow rule, so a read outside the working directory made the
 * runtime ask, the ask reached `canUseTool`, the approval bridge normalised the tool name and
 * `PermissionGate.evaluate` allowed it as read-only. Correct, but a host round trip per call, invisible
 * in the `Options` either leg is handed, and pinned by no test on the official leg (the measured
 * "8d" e2e covers a Bash read outside cwd, never the Read TOOL).
 *
 * Stating it as an allow rule makes it native and makes the two legs literally identical. It cannot
 * widen the fence: both runtimes evaluate DENY before ALLOW — claude's own order, and the Winter
 * SDK's `permissions/evaluator.ts` header ("1 PreToolUse hooks -> 2 deny rules -> 3 ask rules -> 4
 * permission mode -> 5 allow rules -> 6 canUseTool") — so `controlPlaneDenyRules`'s `<home>/run`,
 * `<home>/runtimes` and the resume-staging denials still win, exactly as before.
 *
 * Bare tool names, deliberately: `Read` means every use of the tool. A path-scoped form
 * (`Read(//**)`) would say the same thing less clearly and tie this to one runtime's glob dialect.
 * Only ever attached where these tools EXIST — chat's and dispatch's toolsets exclude them through
 * `disallowedToolsFor`, and a rule for an absent tool is noise, so the callers gate on code mode.
 */
export const GLOBAL_READ_ALLOW_RULES: readonly string[] = ["Read", "Glob", "Grep"];

export function sandboxConfigFor(home: string): SandboxSettingsConfig {
  return {
    enabled: true,
    filesystem: {
      // REAL DIRECTORY PATHS, not globs (review F8). Every entry is rendered as a seatbelt
      // **subpath** — `(deny file-write* (subpath "<canon(p)>"))`, `sandbox/profile.ts:335` — so a
      // glob like `**/.winter/permissions.local.json` or `<home>/run/**` becomes a literal path that
      // never exists and denies nothing. A subpath denies a real directory and everything under it,
      // which is the only shape this consumer has.
      //
      // What that means for the three control-plane FILENAMES: they cannot be expressed here at all
      // (a subpath is a directory, and denying `<x>/.winter` wholesale would take the MEMDIR with
      // it). Winter's own profile already carries exactly those three filenames, case-folded and
      // brand-aware (`sandbox/profile.ts:151-158`), and states that a user's own `denyWrite` cannot
      // defeat them — that is the protection that actually holds for the bash-redirect path, and it
      // is Winter's, not ours. Winter's contribution here is the daemon control plane.
      // `runtimes` joined `run` here (2026-09-18) because the read list already had it and the write
      // list did not, and on the OFFICIAL leg that asymmetry is reachable. Measured in
      // `official-leg.e2e.test.ts`'s "8d MEASURED" test: that leg has NO path-independent out-of-cwd
      // fence for Bash — containment there is these two lists plus `permissions.deny`, and a deny
      // rule is per-tool (`Write(path)` does not constrain a `Bash` redirect). So `echo … >
      // <home>/runtimes/bin/winter` had nothing stopping it, and that path is rung 4 of
      // `resolveWinterExecutable`'s ladder (`runtime-sdk/executable.ts`) — code the NEXT spawn would
      // run — while `<home>/runtimes/anthropic-config` holds the Console profile and
      // `<home>/runtimes/claude-config` the official child's own state. The Winter leg was already
      // covered (its seatbelt fences Bash to the working directory; the same e2e comment notes the
      // contrast), so this closes the leg that was not.
      //
      // Nothing legitimate writes here through a TOOL: the runtime store is the daemon's own, and a
      // child's internal writes (the official transcript store under `claude-config`) are the binary's,
      // never its Bash sandbox's.
      denyWrite: [join(home, "run"), join(home, "runtimes")],
      // The sole read denial Winter has ever had (CLAUDE.md: "the sole read denial is
      // `~/.winter/run`") — reads are otherwise deliberately unrestricted.
      // …plus `runtimes/` (8a: the runtime store is never model-readable — the engine's read tool
      // carried this denial; on the Winter leg the sandbox and the Read/Glob/Grep deny rules do).
      denyRead: [join(home, "run"), join(home, "runtimes")],
    },
    // `allowUnsandboxedCommands` is deliberately NOT set. It is consulted only together with
    // `excludedCommands` (`sandbox/spawn.ts:109,122`), which this config does not set, so `false`
    // would be a no-op — and the earlier comment calling it "the load-bearing one" was wrong:
    // `dangerouslyDisableSandbox` wins over `excludedCommands` regardless. Winter's own floor for
    // that is P8b-31's always-card in the bridge, which does bind.
  };
}

/**
 * Every capability tool NOT exposed to this mode, plus — for chat — the Winter built-ins chat
 * excludes, plus the per-leg web-built-in rule. The literal is pinned by the matrix test; the parity
 * tripwire diffs `CAPABILITY_TOOL_MODES` against Task 7's `WINTER_CAPABILITY_TOOLS`.
 *
 * **`exposure` is required, and comes SECOND** — ahead of the defaulted `capabilityTools`, because a
 * required parameter cannot follow an optional one and this one may not be defaulted (see
 * `ToolExposure`). The web rule it decides (0.0.17, user ruling 2026-09-18):
 *
 *   official        nothing is added: claude's NATIVE `WebFetch`/`WebSearch` stay. (Their APPROVALS
 *                   are Winter's, not claude's — see `official-options.ts`'s own note at the call
 *                   site, and `approval-bridge.ts`'s private-address floor.)
 *   winter + code   nothing is added either: both tools are the code-mode web surface now.
 *   winter + chat   `WebSearch` is disallowed WHEN AN EXA KEY IS STORED, because the daemon's
 *   winter + disp.  `Search` (Exa answer mode) is then the search surface. With NO key `Search`
 *                   cannot work at all, so it is disallowed INSTEAD and `WebSearch` — whose backend
 *                   has an anonymous tier — takes its place rather than leaving those two modes with
 *                   no search. Exactly one of the two is withheld, never both and never neither.
 *
 * `WebFetch` is never disallowed on either leg in any mode any more.
 */
export function disallowedToolsFor(
  mode: SessionMode,
  exposure: ToolExposure,
  capabilityTools: Readonly<Record<string, { modes: readonly SessionMode[] }>> = CAPABILITY_TOOL_MODES,
): string[] {
  const out = Object.entries(capabilityTools)
    .filter(([, v]) => !v.modes.includes(mode))
    .map(([name]) => name);
  if (mode === "chat") out.push(...CHAT_DISALLOWED_BUILTINS);
  // The one place either web built-in is withheld — see this function's own doc comment, and
  // `SDK_WEB_BUILTINS` for the ruling. A string in `disallowedTools` that the child does not
  // advertise is inert, so this is safe to state for a leg whose tool happens to be named otherwise.
  if (exposure.leg === "winter" && mode !== "code" && (exposure.exaKeyPresent ?? true)) out.push("WebSearch");
  // …and its EXACT COMPLEMENT: with no key stored the daemon's own `Search` is withheld instead,
  // because Exa's `/answer` endpoint cannot be called anonymously. The capability server makes the
  // same decision on the same value (`capabilities/research.ts`, reading `CapabilitySession.
  // exaKeyPresent`) — both are needed, and for opposite failure modes: a `disallowedTools` entry for a
  // tool the server never advertised denies nothing, silently, while a server that advertises a tool
  // this list withheld offers nothing, also silently.
  // The MODE guard mirrors the clause above deliberately (whole-branch review NIT): `Search` is a
  // chat/dispatch tool, so code mode's answer comes from the base scan and nothing else. Without it
  // this line also pushed the name for `code`, where it was deduped and inert — a true no-op, and an
  // asymmetry that read as an oversight to the next person to touch either clause.
  if (exposure.leg === "winter" && mode !== "code" && exposure.exaKeyPresent === false) out.push(EXA_GATED_SEARCH_TOOL);
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
    // A resume names the transcript through `resume` and gets its id FROM it; a fresh start names
    // the id the child's transcript will be written under. Never both.
    ...(input.resume ? { resume: input.sessionId } : { sessionId: input.sessionId }),
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
    // Task 16 ruling (ledger:93): ON. The dispatch golden carries a child's own text, and with this
    // off a subagent's `assistant_message`/`assistant_delta` never reach the host at all (Task 11's
    // measurement) — child transcripts would be thinner on the Winter leg than on the engine. The
    // cost is more frames per child turn, which the projector folds onto the child's threadId.
    forwardSubagentText: true,
    disallowedTools: disallowedToolsFor(
      input.mode,
      { leg: "winter", ...(input.exaKeyPresent === undefined ? {} : { exaKeyPresent: input.exaKeyPresent }) },
      input.capabilityTools,
    ),
    // Batch 3 (item 2): the fixed control-plane fence PLUS `settings.permissions.deny` (today just
    // `Skill(<name>)` toggles) — see `permissionDenyRulesFor`'s own doc for why this reads
    // `input.settings` rather than the vestigial "no longer consumed" note this field used to carry.
    //
    // HIGH (fix wave, pre-merge review, finding 2a): `disableBypassPermissionsMode` (the pinned SDK's
    // own `Options.permissions` field, `protocol/config.d.ts`) is the ONE lever this leg has against
    // an agent DEFINITION's own `permissionMode: bypassPermissions` — the runtime honours a
    // definition's mode over the session's own whenever the session's is `default`/`dontAsk`/`plan`,
    // and self-sets `allowDangerouslySkipPermissions` for it, with nothing upstream of the spawn
    // fencing that off. `<home>/agents/*.md` and a trusted project's `.winter/agents/*.md` are both
    // plain files a session under `ask`/`auto`/`accept-edits` can write (see `controlPlaneDenyRules`
    // below, extended in the same fix, for the write fence — this is the SEPARATE, belt-and-suspenders
    // runtime-level clamp), so a self-authored definition could otherwise mint itself an uncarded
    // child. Disabled unless the SESSION's own policy is `bypass` — that is the one case where
    // `allowDangerouslySkipPermissions`/`permissionMode: "bypassPermissions"` is this session's own,
    // legitimate, daemon-decided top-level mode (set two lines below), and disabling the runtime's
    // ability to enter it would break that mode for the session itself, not just for a definition.
    //
    // A SPAWN-TIME fact, which is why a live switch across the bypass boundary replaces the child
    // (`session.setPolicy`, keyed on `bypassAllowedAtSpawn` — the same function used here) instead of
    // asking it: a clamped child refuses `setPermissionMode("bypassPermissions")`, and an unclamped one
    // would keep its `allowDangerouslySkipPermissions` after the user switched bypass off.
    permissions: {
      // Code mode only — see `GLOBAL_READ_ALLOW_RULES`' own doc (the tools do not exist elsewhere),
      // and `WEB_BUILTIN_ALLOW_RULES`' own doc for why the two web built-ins need a bare allow rule
      // on THIS leg (under `dontAsk` the runtime denies an unresolved call without ever calling
      // `canUseTool`, and Winter's gate has always answered `allow` for the web class).
      ...(input.mode === "code" ? { allow: [...GLOBAL_READ_ALLOW_RULES, ...WEB_BUILTIN_ALLOW_RULES] } : {}),
      deny: permissionDenyRulesFor(input.home, input.settings),
      disableBypassPermissionsMode: !bypassAllowedAtSpawn(input.policy),
    },
    sandbox: sandboxConfigFor(input.home),
    // Agent SDK 0.0.16 defaults a spawn to BACKGROUND (claude's own default), which means a finished
    // child re-enters the model on a turn NOBODY PUSHED — a second `system/init`, an assistant
    // stream and its own `result`, with no `user` frame. The projector opens a turn only from
    // `beginTurn` (the host's push), so such a turn would log `assistant_message`/`turn_completed`
    // with no `turn_started`, and `WinterSession`'s own `inFlight`/idle-timer bookkeeping counts it
    // as the host's turn. Until the projector and the Mac transcript handle an unsolicited turn, the
    // daemon keeps the 0.0.15 shape: a spawn is foreground unless the model asks for background.
    // `run_in_background` STAYS advertised (unlike `WINTER_DISABLE_BACKGROUND_TASKS`, which would
    // withhold it), so nothing the model can ask for is taken away.
    backgroundByDefault: false,
    // The official leg is already pinned to `settingSources: []` by the ROUTER, which also refuses a
    // non-empty value outright (`winter-runtime-sdk/src/official/options-template.ts`); the Winter leg
    // passed nothing, and in the agent SDK an ABSENT `settingSources` means all three sources
    // (`user`/`project`/`local`). MEASURED at 0.0.16, what that actually gated is FILE DISCOVERY, not
    // the settings document: `context/winter-md.ts` (WINTER.md), `context/output-styles.ts`,
    // `commands/resolver.ts` and the skills/agent-definition loaders each default to all three tiers
    // and walk `<home>` + `<cwd>/.winter/**` themselves. The SDK's settings-document cascade
    // (`packages/sdk/src/settings/resolve.ts`) exists, is tested and is pinned against claude's schema,
    // but has NO production call site at 0.0.16 — so the child was never parsing `<home>/settings.json`
    // as a settings file, and this line must not be described as stopping that.
    //
    // What it stops is a SECOND discovery pass that duplicates — and is weaker than — the daemon's own:
    // `ContextAssembler` already composes the instructions and the skill listing, `SkillStore` already
    // scans `<cwd>/.winter/skills` TRUST-GATED where the SDK's own loader is not, the agent definitions
    // arrive as `Options.agents` (trust-gated the same way), and `outputStyle` arrives resolved by name.
    // Winter ships no slash-command surface at all, so `.winter/commands` has no daemon counterpart to
    // lose. The daemon's `Options` are the single source of a session's configuration on BOTH legs; this
    // is what makes that true rather than aspirational, and it keeps holding when that cascade is wired.
    //
    // B1 (2026-09-22) — AT 0.0.17 THAT CASCADE IS WIRED: `production-wiring.ts` now calls
    // `resolveSettingsDetailed` for every session, so a `"user"` source would make the child parse
    // `<home>/settings.json` — the DAEMON's own file, a different schema — as a settings tier and
    // enforce its `permissions`, connect its `mcpServers` and run its `hooks` a second time, beside
    // the daemon doing the same. So this stays `[]`, and the skills the old discovery would have found
    // reach the child through the one door `[]` leaves open instead: `plugins`/`skills` below
    // (`SkillStore.childSkillSurface`), which the SDK's index does not source-gate.
    settingSources: [],
  };
  if (input.spawn.spawnClaudeCodeProcess) options.spawnClaudeCodeProcess = input.spawn.spawnClaudeCodeProcess;
  // WS-20 (§0.1 Spawn boundary): the Winter leg's `Options.model` is the BARE modelId, split from
  // the tag once, right here — the winter-test double is the one exception, passed through WHOLE
  // (it is not a tag at all, and splitting it would strip its own "winter-test/" identity).
  if (input.model !== undefined) {
    options.model = input.model.startsWith(WINTER_TEST_PREFIX) ? input.model : splitTag(input.model).modelId;
  }
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;
  if (input.outputStyle !== undefined) options.outputStyle = input.outputStyle;
  if (bypassAllowedAtSpawn(input.policy)) options.allowDangerouslySkipPermissions = true;
  if (input.hooks !== undefined) options.hooks = input.hooks;
  const provider = input.model !== undefined ? providerFor(input.model, input.home) : undefined;
  if (input.advisorModel !== undefined) {
    // Fix wave (M7): when the advisor's own target model resolves to the SAME provider as the
    // session's own model, thread the SESSION's already-resolved `authRef` onto `Options.advisor`
    // too. The pinned `@yanlinglabs/winter-agent-sdk@0.0.6`'s own `AdvisorConfig`
    // (`protocol/config.d.ts`) has NO `connection` field at all — only `model`/`authRef` — so
    // `authRef` is the entire lever this door has, not a partial stand-in for a wider fix.
    //
    // Measured root cause (`advisor-winter-leg-e2e.test.ts`'s F2 case, gated on the REAL compiled
    // `dist/winter`): with no `authRef` at all, the advisor's own generation falls through to the
    // runtime's OWN independent "<providerId>:default" credential resolution — a SEPARATE keychain
    // read that knows nothing about whatever `input.connection` override the session itself is
    // using (a BYO/loopback `openai-compatible` endpoint, say), and on a real machine with real
    // credential material under the SAME keychain service name (`profile.ts`'s `keychainService()`,
    // shared with the user's own daily-driver install) that independent read can reach a DIFFERENT,
    // never-consented item and block on a macOS consent dialog no test harness can click through.
    // The SDK's own doc on `AdvisorConfig.authRef` ("uses the route's ref, else the target
    // provider's own keychain record") is exactly the escape hatch: an explicit, matching authRef
    // is the same credential (and therefore the same already-configured provider connection) the
    // session's own turn already resolved — never an independent, uninstructed lookup.
    //
    // D3 (2026-09-22) — THE PROVIDER IDENTITY IS THE TAG ITSELF. `advisor.model` is the FULL qualified
    // tag, never `splitTag(...).modelId`: the pinned SDK 0.0.17 resolves a `<providerId>/<model>`
    // advisor key to ITS OWN provider (`provider/slots.ts`'s qualified-key door — a full catalog key
    // passes unfiltered with its own providerId — then `session-provider.ts` builds the reviewer on
    // `config.advisor.authRef`, "the advisor's OWN authRef, never the session's"). That is exactly how
    // `WebFetch`'s digest model already runs cross-provider (`digestOptionsFor`, below). The BARE id
    // this door used to send is what made the SDK read the advisor under the SESSION's provider, which
    // is why WS-20 had to drop every cross-provider advisor — on every spawn, in the dist log, for a
    // session on deepseek with `runtimes.advisorModel: codex-oauth/gpt-5.6-sol`.
    //
    // `authRef` is the advisor's OWN provider's Keychain locator, stated explicitly for the M7 reason
    // above (the child's own fallback would resolve the BRAND's Keychain service, which is the dist
    // service even for a dev-profile daemon). A same-provider advisor gets the identical locator the
    // session's own provider carries, so that case is unchanged apart from the full tag.
    //
    // The reserved `winter-test/*` double travels whole and names no credential. Only a genuinely
    // UNROUTABLE tag — `providerFor` answers nothing for the `unstated/unstated` sentinel a hand-edited
    // settings file can carry — is dropped, logged once per spawn naming the setting.
    if (input.advisorModel.startsWith(WINTER_TEST_PREFIX)) {
      options.advisor = { model: input.advisorModel };
    } else {
      const advisorProvider = providerFor(input.advisorModel, input.home);
      if (advisorProvider !== undefined) {
        options.advisor = {
          model: input.advisorModel,
          ...(advisorProvider.authRef === undefined ? {} : { authRef: advisorProvider.authRef }),
        };
      } else {
        console.error(`runtimes.advisorModel: ${JSON.stringify(input.advisorModel)} names no provider — dropping the advisor rather than guessing which one it means`);
      }
    }
  }
  if (provider) options.provider = input.connection === undefined ? provider : { ...provider, connection: input.connection };
  // P8b-36: the session's own servers, spread under their own names (see `capabilities` above).
  if (input.capabilities !== undefined) options.mcpServers = { ...input.capabilities };
  // `toolAliases` is deliberately absent (the R4 measurement: none needed in 8b — the capability
  // tools carry their own `mcp__winter__*` names under R-1, and Winter's four default tools are
  // already bound under their built-in names by the router).
  // Item 3: empty is treated the same as absent — an EMPTY `agents: {}` is not "no agents"
  // byte-identically to a session before this field existed the way `undefined` is, so both are
  // normalized to "no key at all" here rather than leaving that distinction to every caller.
  if (input.agents !== undefined && Object.keys(input.agents).length > 0) options.agents = { ...input.agents };
  // B1: the daemon's resolved plugin skills — see `WinterOptionsInput.plugins` for the omission rule.
  if (input.plugins !== undefined && input.plugins.length > 0) {
    options.plugins = input.plugins.map((p) => ({ ...p }));
    options.skills = [...(input.skills ?? [])];
  }
  options.web = webOptionsFor(input);
  return options;
}

/**
 * **`Options.web` — the WINTER leg's web-tool configuration** (agent SDK 0.0.17, user ruling
 * 2026-09-18). ALWAYS set on this leg, because every field of it is a decision this daemon has an
 * opinion about and the SDK's absent-means-default is a different opinion:
 *
 *  - `search.authRef` — the Exa key's Keychain LOCATOR, never the key. Omitted when none is stored,
 *    which is exactly the SDK's "anonymous-only" state: an exhausted free quota then comes back as a
 *    result saying so, never an error that ends the turn. `search.enabled` is deliberately NOT set —
 *    the backend's anonymous tier works without a key, so there is no session in which the daemon
 *    wants the tool advertised-but-dead. (The two per-call BOUNDS are left at the SDK's defaults:
 *    they are the backend's own economics, not a Winter policy.)
 *  - `fetch.digestModel` / `fetch.authRef` — `pins.research` (see `WinterOptionsInput.digestModel`).
 *  - `fetch.privateAddressPolicy` — `"ask"` in CODE, `"deny"` in chat and dispatch, and `"deny"` for
 *    a dispatch CHILD (P8b-26: a code-mode child spawned by dispatch can never answer a card, so an
 *    `ask` there is a hang or a fail-closed refusal with a card nobody sees). `WebFetch` is the only
 *    door a Winter child has to a local service — its Bash sandbox has no network at all — so silent
 *    reach would ADD power claude's own design does not grant.
 *
 *    **`"ask"` MEANS A CARD BECAUSE THE BRIDGE MAKES IT ONE** (whole-branch review B1, 2026-09-18).
 *    The runtime's private-address ask arrives at `canUseTool` with no machine-readable signal, and
 *    Winter's gate answers the web class `allow` under every policy — so for one release this option
 *    resolved to a SILENT YES and the child reached `192.168.x.x`/`127.0.0.1`/`*.local` with no card
 *    at all. `approval-bridge.ts`'s `privateWebFetchTarget` is what makes the word true: it escalates
 *    such a call to a real card in code mode (every policy, `bypass` and `plan` included) and to a
 *    typed deny wherever nobody can answer one. Do not read this field as self-enforcing — it is one
 *    half of a two-part arrangement, and the other half is leg-agnostic on purpose, because the
 *    official leg is sent no `web` block and would otherwise have no private-address floor at all.
 *  - `blockedDomains` — the dangerous-domain floor, verbatim (see `dangerousDomains`). This is an
 *    EXECUTOR-level refusal in the child, not an approval: a floor domain is refused even in code
 *    mode, where the retired daemon tool used to raise a card that could be approved once. That is
 *    the ruling ("dangerous domains are hard-blocked"), and it is the same answer chat and dispatch
 *    have always had.
 *
 * NOTHING HERE IS SET ON THE OFFICIAL LEG: `official-options.ts` sends no `web` at all, because
 * claude owns its own web tools' behaviour and the ruling keeps it.
 */
function webOptionsFor(input: WinterOptionsInput): WebToolsConfig {
  const privateAddressPolicy = input.mode === "code" && input.origin !== "dispatch-child" ? "ask" : "deny";
  const digest = digestOptionsFor(input);
  return {
    ...(input.exaKeyPresent === false ? {} : { search: { authRef: exaAuthRefFor(input.home) } }),
    fetch: { ...digest, privateAddressPolicy },
    blockedDomains: [...(input.dangerousDomains ?? [])],
  };
}

/** `fetch.digestModel` + its own `authRef`, or nothing at all — see `WinterOptionsInput.digestModel`. */
function digestOptionsFor(input: WinterOptionsInput): Pick<WebFetchConfig, "digestModel" | "authRef"> {
  const digest = input.digestModel;
  if (digest === undefined || digest === input.model) return {};
  // A `winter-test/*` digest model would be a reserved-namespace tag the child's own selection
  // refuses — and every winter-test session's pins default to the primary double anyway, which the
  // `=== input.model` check above has already dropped. Never stated.
  if (digest.startsWith(WINTER_TEST_PREFIX)) return {};
  const digestProvider = providerFor(digest, input.home);
  // No provider, or no Keychain locator for it (`console/*`, whose credential lives in an `ant`
  // profile a digest route never sees): the model is NOT stated, so the digest runs on the session's
  // own model — the SDK's documented default — rather than becoming a typed refusal on every call.
  // `session-driver.ts` logs the setting once when it drops a pin for this reason.
  if (digestProvider?.authRef === undefined) return {};
  return { digestModel: digest, authRef: digestProvider.authRef };
}

/**
 * The Exa key as a `CredentialRef` — a LOCATOR, and the daemon never reads the value (the same rule
 * `Options.provider.authRef` follows). `service` is spelled explicitly, as it is for every provider
 * ref: the child would otherwise resolve the BRAND's Keychain service, which is the dist service even
 * for a dev-profile daemon. The SDK's tool-secret resolver accepts either a bare key string or
 * `{"kind":"api-key",…}` in that item, which is what lets this daemon keep storing Exa's key raw (as
 * `winter credentials set exa` and `winter login --exa-key` always have).
 */
function exaAuthRefFor(home: string): CredentialRef {
  return { kind: "keychain", account: EXA_API_KEY_SECRET, service: keychainService(undefined, home) };
}
