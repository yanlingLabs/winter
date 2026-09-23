// WS-21 CONTRACT A — a LOCAL MIRROR of the router's run-home types (`winter-runtime-sdk`
// `src/run-home/types.ts`, lane L2), for this lane branch, which builds against the published router
// 0.0.11 that does not export them yet. DELETED ON INTEGRATION: once the linked router exports these
// names, every import of this file switches to `@yanlinglabs/winter-runtime-sdk`.
//
// Types and constants only, mirrored field for field from L2's final Contract A (`ws21/router` at
// aa5201e, fix round 1, and the per-transcript recovery report of 7c57f9a: `src/run-home/{types,errors}.ts`, the lane-L2 report's "final signatures"). The functions —
// `buildRunHome`, `sdkHomeOf`, `fsRootAnchored`, `protectedPathRules` — are the router's; the daemon
// reaches `buildRunHome` only through feature detection (`run-home-support.ts`), and uses its own
// `fsRootAnchored` (`mode-options.ts`, ledger ruling 2).

/** The session modes a run home is built for (spec §3.2's columns). */
export type RunMode = "code" | "dispatch" | "chat";

/** Which runtime the generation runs on. `projects/` differs by leg (spec §3.3). */
export type RunLeg = "winter" | "official";

/** The brand fields the builder spells names from (`Pick<BrandProfile, …>` in the router). Absent = the
 *  Winter SDK's own profile; a Winter daemon never passes it (the router refuses another brand's run home). */
export interface RunHomeBrand {
  homeDirName: string;
  projectDirName: string;
  instructionsFile: string;
  envPrefix: string;
  mcpServerName: string;
}

export interface RunHomeInput {
  /** The daemon's home (`WINTER_HOME`). The shared runtime home is `sdkHomeOf(home)`. */
  home: string;
  mode: RunMode;
  /** A code-mode child of a dispatch session: its output style is skipped (spec §3.2). */
  dispatchChild: boolean;
  leg: RunLeg;
  /** The session's working directory. The router refuses to apply a run home to a different cwd. */
  cwd: string;
  /** `repoRootFor(cwd)` when the project is trusted, else `null` (no project tier at all). */
  trustedProjectRoot: string | null;
  /** The canonical git root — the local settings tier's anchor (F17). `null` outside a repository. */
  gitRoot: string | null;
  /** `mcp.disabled`: servers dropped from the generated `.winter.json`, and reported. */
  mcpDisabled: readonly string[];
  /** The daemon's capability-server names; a configured server under one is dropped and reported. */
  reservedMcpServerNames: readonly string[];
  /** The auto-memory directory for this incarnation (spec §3.7), pinned on both legs. */
  memoryDir: string;
  brand?: RunHomeBrand;
}

/** What the builder did not do, and why — surfaced by `winter doctor` (spec §8). */
export interface RunHomeReport {
  skippedLinks: { path: string; reason: "outside-root" | "missing" }[];
  externalUserLinks: string[];
  droppedMcpServers: { name: string; reason: "disabled" | "reserved-name" }[];
  unconditionalRules: string[];
  droppedImports: string[];
  /** Agent definitions not copied (L2 fix round 1, I1): the runtime's own frontmatter parse failed, the
   *  rewrite could not be proved to read back as intended, or the process has no `Bun.YAML`. */
  skippedAgents: { path: string; reason: "unparseable" | "no-yaml-parser" }[];
}

export interface RunHome {
  /** A random UUID. The folder's name, and the key `runHomeOutcome` answers for. */
  runId: string;
  /** `<home>/cache/runs/<runId>` — 0700, files 0600. */
  dir: string;
  /** `sdkHomeOf(input.home)`. */
  sdkHome: string;
  input: RunHomeInput;
  /** Exactly what `<dir>/settings.json` holds. */
  effectiveSettings: Record<string, unknown>;
  report: RunHomeReport;
  /** `rm -rf <dir>`: links are removed, their targets untouched. The caller reconciles first. Idempotent. */
  dispose(): Promise<void>;
}

/** The item directories whose writes are protected (spec §7.2) — under `sdk/` and a trusted project's
 *  `.winter/`. */
export const PROTECTED_ITEM_DIRS = ["skills", "commands", "rules", "output-styles"] as const;

/** `RunHomeError.code` (the router throws a `RunHomeError extends RuntimeSdkError`, synchronously, from
 *  `query()`); the host forwards it as the JSON-RPC error's `data.code`. */
export const RUN_HOME_ERROR_CODES = [
  "run_home_required", "run_home_foreign", "run_home_leg_mismatch", "run_home_cwd_mismatch",
  "run_home_brand_mismatch", "run_home_store_mismatch", "run_home_link_refused", "run_home_staging_not_bare",
  "setting_sources_refused", "router_owned_variable", "run_home_option_refused", "run_home_for_missing", "loop_refused",
] as const;
export type RunHomeErrorCode = (typeof RUN_HOME_ERROR_CODES)[number];

/** A `RunHomeError` (matched structurally — this lane links no router class of that name). */
export function isRunHomeError(err: unknown): err is Error & { code: RunHomeErrorCode } {
  if (!(err instanceof Error)) return false;
  const code = (err as unknown as { code?: unknown }).code;
  return typeof code === "string" && (RUN_HOME_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * The variables the ROUTER sets on the Winter leg when it applies a run home. Beside a run home each is
 * REFUSED from the host's `Options.env` (`router_owned_variable`), not overwritten — so the daemon must
 * never state one then.
 */
export const WINTER_ROUTER_OWNED_ENV = ["WINTER_HOME", "WINTER_STORE_HOME", "WINTER_PLUGIN_CACHE_DIR", "WINTER_PROVIDER_MANAGED_BY_HOST", "WINTER_DISABLE_CRON"] as const;

/**
 * The options a run home DECIDES (L2 fix round 1, M1): beside a run home, both legs refuse a caller's
 * `plugins`, `skills`, `agents`, `outputStyle` or `brand` (`run_home_option_refused`) — they come from
 * the run folder's items and effective settings, or from the router itself (the brand). The official
 * template's `policy.agents` is gone too.
 */
export const RUN_HOME_DECIDED_OPTIONS = ["plugins", "skills", "agents", "outputStyle", "brand"] as const;

/** Bumped when a field a host reads changes meaning. */
export const RUN_HOME_CONTRACT_VERSION = 1;

/** claude's persistent config-dir set (spec F18) — the same list as `SDK_PERSISTENT_ENTRIES`. */
export const RUN_HOME_PERSISTENT_ENTRIES = ["file-history", "tasks", "teams", "agent-memory", "workflows"] as const;

/** A run home's outcome, by run id. `pending` = the incarnation is still running (or unknown). */
export type RunHomeOutcome = "safe" | "quarantined" | "pending";

/** The context the router's own cold-resume path hands the host when it needs a run home. */
export interface RunHomeForContext {
  /** The Winter session id of the session being resumed. */
  sessionId: string;
  leg: RunLeg;
  cwd: string;
  mode: RunMode;
}

/** Registered at router creation (`RuntimeSdkOptions.runHomeFor`). */
export type RunHomeFor = (ctx: RunHomeForContext) => Promise<RunHome>;

/** The router MODULE's run-home export, as feature-detected. */
export interface RouterRunHomeModule {
  buildRunHome(input: RunHomeInput): Promise<RunHome>;
}

/**
 * Review I6 / `ws21/router`@7c57f9a: what `reconcileRootForRecovery` answers — per TRANSCRIPT, not per root.
 * `sessionId` is the store key's session id (the transcript's `.jsonl` name — the BACKEND session id);
 * `subpath` names a subagent transcript (`subagents/agent-<id>`). `canonical-ahead` needs nothing done (a
 * prefix copy holds nothing the canonical file lacks); only a `quarantined` transcript's file is copied to
 * the quarantine dir, and ITS session is the one that needs repair.
 */
export interface RecoveryTranscriptOutcome {
  projectKey: string;
  sessionId: string;
  subpath?: string;
  outcome: "clean" | "appended" | "canonical-ahead" | "quarantined";
  appended: number;
  reason?: string;
}
export interface RecoveryReport {
  /** `quarantined` if any transcript is, else `appended` if any is, else `clean`. */
  outcome: "clean" | "appended" | "quarantined";
  transcripts: RecoveryTranscriptOutcome[];
  /** `<home>/cache/quarantine/<ts>-<basename(root)>`, when anything was quarantined. */
  quarantine?: string;
}

/** The router HANDLE's run-home members (`createRuntimeSdk(...)`'s result) on a run-home router. */
export interface RouterRunHomeHandle {
  /** `safe` → the host may dispose; `quarantined` → the working copy was preserved under
   *  `<home>/cache/quarantine/`; `pending` → still running (or unknown). */
  runHomeOutcome(runId: string): RunHomeOutcome;
  /** The crash-recovery door for a recorded root (spec §3.8): recomputes the claude-ready decorations,
   *  reconciles through the router's own store, and answers what it did. */
  reconcileRootForRecovery(root: string): Promise<RecoveryReport>;
}

/** The `createRuntimeSdk` options a run-home router adds. */
export interface RunHomeSdkOptions {
  /** Refuse (`run_home_required`) any generation that carries no run home. */
  requireRunHome?: boolean;
  /** The host's builder for the router's own cold-resume path. */
  runHomeFor?: RunHomeFor;
}
