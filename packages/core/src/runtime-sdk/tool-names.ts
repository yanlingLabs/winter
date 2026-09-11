import { WINTER_DEFAULT_TOOL_DEFINITIONS } from "@yanlinglabs/winter-agent-sdk/tools";

/**
 * **The Winter ↔ Norma tool-name pairs** (P8b-25) — ONE literal table, both directions derived
 * from it so they can never drift.
 *
 * The gate's four class sets (`agent/gate.ts`) are keyed by NORMA's tool names — `bash`, `read`,
 * `write`, `web_fetch`, `Search`, `ReadPage`, `browser`, `docs`… — because every caller it has
 * today is the engine's dispatch loop, which hands it `call.name` straight off Norma's own
 * `ToolRegistry`. A Winter child calls the SAME actions under DIFFERENT names, so feeding the raw
 * Winter name to the gate is wrong in both directions and SILENTLY:
 *
 *  - `mcp__norma__research__Search` is not in `NETWORK`, so chat's gate branch ("allow READ_ONLY /
 *    NETWORK, deny everything else") would DENY chat's only research tool — chat's Search dies with
 *    every unit test green.
 *  - `"Bash"` is not in `MUTATING`, so it falls to the unclassified fail-closed `"ask"` branch —
 *    which under `auto` is a card where today there is silence, and under dispatch/chat a typed
 *    deny (P8b-7/P8b-26) where today the command runs.
 *  - `approvalCardSummary` / `approvalOptionsFor` (`agent/approvals.ts`) both switch on the literal
 *    `"bash"`, so a card for `"Bash"` would lose its command text AND its "always allow
 *    `Bash(git push:*)`" options — the rules-store "remember this" path would have nothing to
 *    remember.
 *
 * **Failing to map a name is SAFE, by construction:** `normaToolNameFor` answers `undefined`, every
 * caller falls back to the name it was given, and an unknown name lands on `isGateClassified`'s
 * `false` branch and fails closed to `"ask"`. That is why this table may be incomplete without
 * being dangerous — completeness across the capability surface is the parity tripwire's job
 * (P8b-12), not this module's.
 *
 * **Source of the rows:** the "WS-06 §5 successor" column of the Winter Phase 8b codebase map
 * §5.1/§5.3 (the class-(a) and class-(c) disposition tables) — one row per Norma tool, read off the
 * map rather than recalled. `AskUserQuestion` is pinned separately by the SDK surface map §5.6.
 * Names the map gives no successor (`ls`, `skill_write` — map §5.4) have no row here either.
 */
export const WINTER_NORMA_TOOL_PAIRS: ReadonlyArray<readonly [winter: string, norma: string]> = [
  // class (a) — CC-shaped tools the Winter SDK provides natively (map §5.1)
  ["Read", "read"],
  ["Glob", "glob"],
  ["Grep", "grep"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Bash", "bash"],
  // §5.1 lists `TaskOutput` as the successor of BOTH `bash_output` and `agent_output`. Mapped to
  // `agent_output` to stay identical to the projector lane's choice (review n4); both are
  // `READ_ONLY` and neither is special-cased in the card composers, so the verdict and the card
  // text are the same either way — the point is that the two lanes agree.
  ["TaskOutput", "agent_output"],
  ["NotebookEdit", "notebook_edit"],
  ["Skill", "Skill"],
  ["ToolSearch", "ToolSearch"],
  ["TaskCreate", "task_create"],
  ["TaskUpdate", "task_update"],
  ["TaskList", "task_list"],
  ["TaskGet", "task_get"],
  ["TaskStop", "task_stop"],
  ["LSP", "lsp"],
  ["WebFetch", "web_fetch"],
  ["WebSearch", "web_search"],
  ["EnterPlanMode", "enter_plan_mode"],
  ["ExitPlanMode", "exit_plan_mode"],
  ["EnterWorktree", "enter_worktree"],
  ["ExitWorktree", "exit_worktree"],
  ["ListMcpResourcesTool", "list_mcp_resources"],
  ["ReadMcpResourceTool", "read_mcp_resource"],
  ["PushNotification", "push_notification"],
  // The three cron names collapse onto Norma's single `schedule` tool, which is how `gate.ts`
  // already classifies every schedule op ("one tool, one gate decision, no op-dependent carve-out").
  // FIRST wins the reverse direction — `winterToolNameFor("schedule") === "CronCreate"` — which is
  // deterministic rather than meaningful; a caller needing a specific cron verb must not use the
  // reverse map for it. Pinned by a test so the choice cannot silently move.
  ["CronCreate", "schedule"],
  ["CronDelete", "schedule"],
  ["CronList", "schedule"],
  ["Agent", "spawn_agent"],
  ["Workflow", "Workflow"],
  // class (c) — bridged to Winter built-ins (map §5.3)
  ["ListAgents", "agent_list"],
  ["SendMessage", "send_message"],
  // `AskUserQuestion` never actually reaches the gate: `canUseToolFor` routes it to the question
  // bridge FIRST (it is a question, not a permission). Mapped anyway so the table reads honestly
  // and a future caller that DOES gate it lands on `ask_user`'s READ_ONLY classification — the
  // human IS the approval, so a gate card on top would double-ask (gate.ts's own reasoning).
  ["AskUserQuestion", "ask_user"],
];

/**
 * Winter's OWN default tools, by the built-in name a host binds them under (R-8-1: the router owns
 * no tool; Winter's defaults are Winter's, pulled by the router and bound under Claude's built-in
 * names). **Derived from the SDK at module load, never hand-copied** — the four literals are pinned
 * by a test instead, so the SDK adding a fifth widens this set automatically and the test says so.
 *
 * P8b-28: these four are allowed SILENTLY in every mode. Two of them (`SendMessage`, `ListAgents`)
 * also have Norma names in the pair table above, and both of those land in `gate.ts`'s `READ_ONLY`
 * — so the gate would allow them anyway. `ReadNotifications` and `advisor` have NO Norma
 * counterpart at all (there is no tool to map them to, and inventing one would be a lie), so
 * without this set they would fall to the unclassified fail-closed `"ask"` branch: a card under
 * `auto` in code, and a typed deny in dispatch/chat. Membership here is what makes P8b-28 true for
 * all four rather than for the two that happen to be classified.
 */
export const WINTER_OWN_TOOL_NAMES: ReadonlySet<string> = new Set(
  WINTER_DEFAULT_TOOL_DEFINITIONS.map((d) => d.builtinName ?? d.toolName),
);

/**
 * **What a Winter child at 0.0.3 actually advertises** — `system/init.tools`, MEASURED from the
 * built binary (`dist/winter`) driven through `query()` with `model: "winter-test/echo"` under a
 * temp home and `NORMA_BRAND`'s names. 31 tools, verbatim and sorted as the child sent them.
 *
 * **This, not Norma's pair table, is what `disallowedTools` must be derived from** (review F4). The
 * brief's instruction to build the list from `WINTER_DEFAULT_TOOL_DEFINITIONS` rests on a wrong
 * premise — that export is only Winter's own four — and Norma's pair table is a different set
 * again: it has rows for tools the child does NOT advertise (`LSP`, `ToolSearch`, `WebFetch`,
 * `WebSearch`, the two MCP-resource tools) and, more importantly, MISSES three the child DOES
 * advertise (`Monitor`, `ReportFindings`, `ScheduleWakeup`). Deriving chat's exclusions from the
 * pair table therefore left three tools advertised to a chat model that is supposed to have no
 * fs/shell/repo surface at all.
 *
 * Two measured facts worth keeping:
 *  - **`WebFetch`/`WebSearch` are NOT advertised at 0.0.3.** They are still disallowed in every mode
 *    (P8b-33) — belt and braces against an SDK bump that starts advertising them.
 *  - **`advisor` is not advertised either**, though it is one of Winter's four default tools: the
 *    host binds it, the runtime does not auto-register it.
 *
 * **Task 16's e2e must assert `system/init.tools` equals this list** — that is the tripwire for an
 * SDK bump, and the reason this is exported rather than inlined.
 */
export const WINTER_ADVERTISED_TOOLS_0_0_4_BASE: readonly string[] = [
  "Agent", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList", "Edit",
  "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "ListAgents",
  "Monitor", "NotebookEdit", "PushNotification", "Read", "ReadNotifications", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "Skill", "TaskCreate", "TaskGet", "TaskList", "TaskOutput",
  "TaskStop", "TaskUpdate", "Workflow", "Write",
];

/**
 * **The six more tools a child advertises as soon as the session declares ANY MCP server** — which
 * every Norma mode will, because the capability servers ARE MCP servers.
 *
 * `winter.mcp` is a DERIVED capability, not a host-supplied one: `RUNTIME_DERIVED_CAPABILITIES`
 * (`tools/registry.ts:1264`) grants it whenever `SessionCapabilityFacts.hasMcpServers` is true —
 * *"Gated ALSO on the session declaring at least one MCP server"*. Every descriptor below carries
 * `capabilityRequirements: ["winter.mcp"]` and `exposure: "eager"`, so all six appear in
 * `system/init.tools` the moment that fact flips.
 *
 * The measurement above was taken with NO MCP servers, so it could not see them. Listing them here
 * rather than re-pinning the base list keeps the two facts separable — and pre-empts the trap the
 * re-review named: Task 16's tripwire would fail by construction on the real host, and the pressure
 * would be to re-pin the measured list rather than re-derive chat's exclusions, which silently
 * widens chat.
 */
export const WINTER_ADVERTISED_MCP_TOOLS_0_0_4: readonly string[] = [
  "ListMcpResourcesTool",   // descriptors/list-mcp-resources-tool.ts:6,15,22 — permissionClass "mcp"
  "ReadMcpResourceDirTool", // descriptors/read-mcp-resource-dir-tool.ts:6,16,23 — permissionClass "mcp"
  "ReadMcpResourceTool",    // descriptors/read-mcp-resource-tool.ts:6,16,23 — permissionClass "mcp"
  "RefreshMcpTools",        // descriptors/refresh-mcp-tools.ts:6,15,22 — permissionClass "mcp"
  "ToolSearch",             // descriptors/tool-search.ts:7,22,36 — permissionClass "read"
  "WaitForMcpServers",      // descriptors/wait-for-mcp-servers.ts:15,24,26 — permissionClass "read"
];

/** What a Norma child actually advertises: the measured base set PLUS the `winter.mcp` family, since
 *  every Norma mode declares capability servers. **Task 16's e2e compares live `system/init.tools`
 *  against THIS union** (and against the base alone only for a deliberately server-less session). */
export const WINTER_ADVERTISED_TOOLS_0_0_4: readonly string[] =
  [...new Set([...WINTER_ADVERTISED_TOOLS_0_0_4_BASE, ...WINTER_ADVERTISED_MCP_TOOLS_0_0_4])].sort();

/**
 * **An explicit GATE CLASS for a Winter tool whose classification must not be inferred from its
 * display name** (review F5, ruling).
 *
 * The pair table above is consumed by two surfaces with opposite failure modes: a fail-OPEN label
 * surface (the projector's transcript rendering) and a fail-CLOSED gate. For an execute-class tool
 * one entry cannot serve both. `Monitor` is the case: the projector lane renders it as
 * `bash_output`, which is in `gate.ts`'s `READ_ONLY` set — so a shared `Monitor → bash_output` row
 * would make a tool whose "command half uses the Bash permission family" a **silent allow under
 * every policy, `plan` and `chat` included**.
 *
 * So classification is declared here, independently of the display mapping, and sourced from the
 * child's OWN `permissionClass` rather than from a name:
 *  - `Monitor` — `permissionClass: "execute"` (`descriptors/monitor.ts:49`) → gated as `bash`.
 *  - `ReportFindings` — `permissionClass: "task"` (`descriptors/report-findings.ts:36`), "a
 *    structured review result channel, not a scanner" → gated as `task_create`, Norma's own
 *    READ_ONLY class for in-session bookkeeping.
 *  - `ScheduleWakeup` — `permissionClass: "task"` (`descriptors/schedule-wakeup.ts:41`), an
 *    in-session self-wake with its delay clamped to 60-3600s. Deliberately NOT Norma's `schedule`
 *    (MUTATING): that is the persistent cron surface, which is `CronCreate`/`CronDelete`/`CronList`
 *    in the pair table above, and a standing prompt-injection surface in a way a self-wake is not.
 *
 * The value is the NORMA name the gate should classify by — never what the card or the transcript
 * displays, which stays `gateToolNameFor`'s answer.
 */
export const WINTER_TOOL_GATE_CLASS: ReadonlyMap<string, string> = new Map([
  ["Monitor", "bash"],
  ["ReportFindings", "task_create"],
  ["ScheduleWakeup", "task_create"],
  // --- the `winter.mcp` housekeeping trio the pair table has no row for ------------------------
  // All three are read-only bookkeeping over ALREADY-CONNECTED MCP servers, and none of them can
  // reach a server the session has not already declared. Classified as `list_mcp_resources` /
  // `ToolSearch`, which are Norma's own `NETWORK` and `READ_ONLY` classes for exactly that work, so
  // code and dispatch get them silently while chat — which has no MCP resources beyond Norma's own
  // capability servers — keeps them in its disallow set.
  //
  //  - `ReadMcpResourceDirTool` — "Direct children of a directory resource."
  //    (`descriptors/read-mcp-resource-dir-tool.ts:14`). The same family as `ReadMcpResourceTool`,
  //    so it takes the same Norma name the pair table already gives that one.
  ["ReadMcpResourceDirTool", "read_mcp_resource"],
  //  - `RefreshMcpTools` — "Re-queries connected servers' tool lists; **never establishes a
  //    disconnected connection**" (`descriptors/refresh-mcp-tools.ts:13`). Purely a re-read of the
  //    in-memory tool index, which is what Norma's own `ToolSearch` does.
  ["RefreshMcpTools", "ToolSearch"],
  //  - `WaitForMcpServers` — "Waits for connected MCP servers to finish handshaking"
  //    (`descriptors/wait-for-mcp-servers.ts:22`), and its own `permissionClass` is `"read"`. It
  //    blocks and returns; it mutates nothing.
  ["WaitForMcpServers", "ToolSearch"],
]);

/**
 * The name `PermissionGate.evaluate` should be asked about — the explicit gate class when one is
 * declared, otherwise the display name. Split from `gateToolNameFor` so an execute-class tool can be
 * gated correctly without its card or its transcript row being mislabelled.
 *
 * A `Map`, not an object literal (review n1): an object lookup walks the prototype chain, so
 * `gateClassFor("toString")` returned a FUNCTION rather than a string. That was fail-closed in
 * effect (a non-string is in none of the gate's Sets → unclassified → `ask` → deny in
 * chat/dispatch/plan) and no Winter tool is named that — but every other lookup in this module is a
 * `Map`/`Set`, and this one has no business being the exception.
 */
export function gateClassFor(winterToolName: string): string {
  return WINTER_TOOL_GATE_CLASS.get(winterToolName) ?? gateToolNameFor(winterToolName);
}

/** `mcp__norma__` — the prefix every daemon-owned capability tool carries under R-1 / P8b-12
 *  (`mcp__norma__<serverKey>__<tool>`, minted by Task 6-7's `capabilityToolName`). Spelled out
 *  literally rather than derived from Task 5's `NORMA_BRAND.mcpServerName`: that module lands in a
 *  different lane, and the brand's `mcpServerName` is itself pinned to `"norma"` by the Interfaces
 *  block, so the two cannot disagree without the interfaces block changing first. */
export const NORMA_CAPABILITY_TOOL_PREFIX = "mcp__norma__";

/**
 * **The five capability server keys, and the ONLY ones whose `mcp__norma__<key>__<tool>` names are
 * stripped to a bare Norma tool name** (P8b-12's set: `sessions`, `computer`, `browser`, `office`,
 * `research`).
 *
 * Without this check the prefix strip is a NAME-SPOOF PATH straight into Norma's tool classes. A
 * third-party MCP server named `norma__x` — or a server named `norma` with a tool whose own name
 * contains `__` — produces `mcp__norma__x__read`, which a bare-suffix strip turns into `read` →
 * `READ_ONLY` → a SILENT ALLOW under every policy, `plan`, `chat` and `dont-ask` included. Without
 * the strip that name keeps its `mcp__` prefix and `isExternalToolName` gives it the external class
 * a third-party MCP tool is supposed to get (a card under `ask`, a deny under `plan`).
 *
 * Spelled out literally beside the prefix for the same reason the prefix is: Task 7's server keys
 * land in another lane, and the integration parity test diffs them.
 */
export const NORMA_CAPABILITY_SERVER_KEYS: ReadonlySet<string> = new Set([
  // The SIXTH key, `web`, arrived with P8b-33's rows in `CAPABILITY_TOOL_MODES` and was missing here
  // (review NEW-1). The cost was not cosmetic: `mcp__norma__web__web_fetch` did not strip, so
  // `isExternalToolName` claimed it and it took the MUTATING/external branch — a CARD under
  // `ask`/`accept-edits` and a DENY under `plan`/`dont-ask`, where `web_fetch`/`web_search` are
  // `NETWORK` today and allowed under every policy including `plan`. The card would also have read
  // `mcp__norma__web__web_fetch` and lost its URL summary and "always allow" options (P8b-25).
  "sessions", "computer", "browser", "office", "research", "web",
  // The SEVENTH key, `lsp` (fix wave, review F7): `mcp__norma__lsp__lsp` strips to `lsp`, which
  // `gate.ts` classifies READ_ONLY — the class the registry-door tool always had.
  "lsp",
]);

const WINTER_TO_NORMA = new Map<string, string>(WINTER_NORMA_TOOL_PAIRS.map(([w, n]) => [w, n]));
const NORMA_TO_WINTER = ((): ReadonlyMap<string, string> => {
  const m = new Map<string, string>();
  for (const [w, n] of WINTER_NORMA_TOOL_PAIRS) if (!m.has(n)) m.set(n, w);   // first pair wins
  return m;
})();

/**
 * The NORMA name for a tool a Winter child just called, or `undefined` when nothing claims it.
 *
 * Three cases, in order:
 *  1. a Norma capability tool — `mcp__norma__<key>__<tool>` whose `<key>` is one of the FIVE
 *     capability server keys — → the BARE `<tool>` name, which is exactly how `gate.ts` already
 *     classifies all five servers' tools (`Search`/`ReadPage` in `NETWORK`, `browser` in `NETWORK`,
 *     `computer`/`docs`/`sheets`/`slides`/`session_spawn` in `MUTATING`,
 *     `list_sessions`/`manage_session` in `READ_ONLY`);
 *  2. a mapped Winter built-in → its Norma name (the pair table);
 *  3. anything else → `undefined`. A third-party `mcp__…`/`plugin__…` name has no Norma name — and
 *     that INCLUDES an `mcp__norma__…` name whose server key is not one of the five, which is the
 *     spoof `NORMA_CAPABILITY_SERVER_KEYS` exists to refuse. Callers that fall back to the original
 *     keep its prefix, so `isExternalToolName` still classifies it as external; every other unknown
 *     name stays unknown and fails closed.
 *
 * Pure; no I/O; safe to call on every permission request.
 */
export function normaToolNameFor(winterToolName: string): string | undefined {
  if (winterToolName.startsWith(NORMA_CAPABILITY_TOOL_PREFIX)) {
    const rest = winterToolName.slice(NORMA_CAPABILITY_TOOL_PREFIX.length);
    // `<serverKey>__<tool>` — split at the FIRST `__`, so a tool name that itself contains `__`
    // survives intact. Claimed ONLY when `<serverKey>` is one of Norma's own five: a malformed
    // entry, or a third-party server spoofing the prefix, stays `mcp__`-prefixed for its caller and
    // is therefore still classified as an external MCP tool, never silently widened.
    const sep = rest.indexOf("__");
    if (sep <= 0 || sep + 2 >= rest.length) return undefined;
    if (!NORMA_CAPABILITY_SERVER_KEYS.has(rest.slice(0, sep))) return undefined;
    return rest.slice(sep + 2);
  }
  return WINTER_TO_NORMA.get(winterToolName);
}

/** The inverse: the WINTER name for one of Norma's tool names, or `undefined`. Capability tools
 *  have no single Winter spelling here (their `mcp__norma__<key>__<tool>` name depends on which
 *  server owns them — Task 7's `capabilityToolName` mints those), so this answers only for the
 *  built-in pairs. Where several Winter names share one Norma name (the three cron verbs) the
 *  FIRST pair wins. */
export function winterToolNameFor(normaToolName: string): string | undefined {
  return NORMA_TO_WINTER.get(normaToolName);
}

/** The name to hand `PermissionGate.evaluate` — the Norma name when one exists, otherwise the
 *  Winter name unchanged, which fails closed. The bridge's one-liner, kept here so the projector
 *  lane and the bridge cannot disagree about the fallback. */
export function gateToolNameFor(winterToolName: string): string {
  return normaToolNameFor(winterToolName) ?? winterToolName;
}
