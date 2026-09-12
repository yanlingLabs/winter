export { startDaemon, CORE_VERSION, type RunningDaemon } from "./daemon";
export { bootstrapNormaDir, resolveNormaHome } from "./norma-dir";
export { resolveNormaProfile, keychainService, profileDisplayName, type NormaProfile } from "./profile";
export { FileSecretStore, KeychainSecretStore } from "./auth/secret-store";
export { TOKEN_NAMES } from "./auth/tokens";
export {
  loadSettings, saveSettings, loadPermissionDirs, addLocalDir,
  REASONING_EFFORTS, setProviderModel, setReasoningEffort, setOutputStyle, setAdvisorModel, memoryEnabledFrom,
  workflowsEnabledFrom, keywordTriggerEnabledFrom,
  type Settings,
} from "./settings";
// Winter Phase 8d (Task 4.3): `norma model --advisor <slug>` validates against the SAME pinned
// catalog `session.setModel`'s handler consults (`catalogRowsFor`, `runtime-sdk/provider-
// selection.ts`) — the CLI runs with no live daemon/RPC for this command (direct settings.json
// read/write, `case "model"`'s own doc comment), so the STATIC compiled-in catalog, not a
// `sync.config` round trip, is the only thing it can validate against without one.
export { catalogRowsFor } from "./runtime-sdk/provider-selection";
export { runWorkflowSubprocess } from "./workflows/subprocess-entry";
// P8b-18: reached only by the CLI's static `__runtime-state-probe` argv route, which imports it
// from THIS barrel — the same shape `runWorkflowSubprocess` above uses, and the only shape that
// survives `bun build --compile` (a dynamic import keyed on a string does not resolve in $bunfs).
export { runRuntimeStateProbe, type RuntimeStateProbeResult } from "./runtime-state/probe";
export { runRuntimesProbe, type RuntimesProbeResult } from "./runtime-sdk/runtimes-probe";
export { diagnoseRuntimes, type RuntimesReport } from "./runtime-sdk/runtimes-doctor";
export { RUNTIME_BUNDLE_LAYOUT, bundleRuntimePath, parseVersionsJson, type VersionsJson, type RuntimeBundleEntry } from "./runtime-sdk/bundle-layout";
export { WorkflowRuntime, type WorkflowRuntimeDeps, type WorkflowRuntimeEvent, type WorkflowLaunch } from "./workflows/runtime";
export { WorkflowStore, type ResolvedWorkflow } from "./workflows/store";
export {
  deriveInstallName,
  resolvePluginTarget,
  installPluginFromDir,
  setPluginEnabled,
  missingConsents,
  buildConsentBlock,
  grantPluginConsents,
  applyFreshPluginConsent,
  stripPluginConsents,
  removePluginFromSettings,
  removePluginDir,
  type InstallPluginResult,
  type ConsentBlockPlugin,
} from "./plugins/lifecycle";
export { createProvider, OPENAI_API_KEY_SECRET, type ActiveProvider, type LiveModelSelection } from "./providers/manager";
export {
  CREDENTIAL_MATERIAL_NAMES,
  readCredentialMaterial, writeCredentialMaterial, clearCredentialMaterial,
  readOpenAiApiKey, writeOpenAiApiKey,
  migrateLegacyCredentialMaterial,
  // P8d-13: relocated here from the now-deleted `providers/codex-oauth.ts` — see
  // `CodexAuthStore`'s own doc comment in `auth/credential-material.ts`.
  CodexAuthStore, CODEX_SECRET_NAMES,
  type CredentialMaterial, type ApiKeyMaterial, type OauthMaterial, type BearerMaterial, type CredentialMigrationReport,
} from "./auth/credential-material";
export { runLoginFlow } from "./providers/pkce";
// P8c-10: `norma login --anthropic-key` (cli/main.ts) writes through this door.
export { writeAnthropicApiKey, ANTHROPIC_CREDENTIAL_SECRET_NAME } from "./runtime-sdk/keychain";
export { CODEX, CODEX_MODELS, DEFAULT_CODEX_MODEL } from "./providers/codex-config";
// WS-16 §15's `norma doctor` runs IN-PROCESS against NORMA_HOME — no RPC, because the whole point
// is to work when the daemon does not — so the CLI reaches these two through the package barrel.
export {
  diagnoseRuntimeState,
  repairRuntimeState,
  isDaemonLockHeld,
  DAEMON_RUNNING_REFUSAL,
  type Finding,
  type FindingKind,
  type RepairOp,
  type RepairResult,
} from "./runtime-state/doctor";
export { FakeProvider } from "./agent/fake-provider";
export { ToolRegistry, type ToolDefinition, type ToolContext, type ToolOutcome } from "./agent/tools/registry";
export { registerWebTools, WEB_SEARCH_API_KEY_SECRET, type WebToolDeps } from "./agent/tools/web";
export { registerSearchTool, EXA_API_KEY_SECRET, type SearchToolDeps } from "./agent/tools/search";
export { registerReadPageTool, type ReadPageDeps, type ResearchRunner, type ResearchQuery } from "./agent/tools/read-page";
export { notifyHeadless, type OsascriptSpawnFn } from "./agent/notify-fallback";
export { TaskStore } from "./agent/task-store";
export { buildSeatbeltProfile, sandboxAvailable } from "./agent/sandbox";
export { PermissionGate, type GateDecision, type SessionApprovalPolicy } from "./agent/gate";
export { ApprovalBroker, type ApprovalOutcome } from "./agent/approvals";
export { QuestionBroker, type AskOutcome } from "./agent/questions";
export { PlanBroker, type PlanOutcome } from "./agent/plans";
export { SessionDirectories } from "./agent/dirs";
export { sessionTmpDir } from "./agent/session-tmp";
export { TrustStore } from "./agent/trust";
export { ContextAssembler, BASE_PROMPT } from "./agent/context";
export { SkillStore, type SkillMeta, type SkillResult } from "./agent/skills";
export { OutputStyleStore, BUILTIN_STYLE_NAMES } from "./agent/output-styles";
export {
  MemoryStore,
  type MemoryScope,
  type MemoryType,
  type MemoryFactMeta,
  type MemoryFact,
  type MemoryAuditLine,
  type MemoryResult,
} from "./agent/memory";
export {
  repoRootFor,
  sanitizeProjectKey,
  memoryDirFor,
  memoryDirForRecord,
  memoryProjectKeyFor,
  type MemoryDirOptions,
} from "./agent/memory-dir";
export { PluginStore, PluginManifest, type PluginInfo } from "./agent/plugins";
export { BackgroundTaskRegistry, type BgDeps } from "./agent/bg-registry";
export { Compactor, SUMMARIZE_INSTRUCTION } from "./agent/compactor";
export { bashLooksSafe, BashReviewer, REVIEW_INSTRUCTION, type ReviewVerdict } from "./agent/reviewer";
export { McpManager, type McpServerStatus, type McpServerConfig } from "./agent/mcp/manager";
export { WorktreeManager, type ActiveWorktree } from "./agent/worktree";
