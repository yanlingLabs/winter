import { WINTER_DEFAULT_TOOL_DEFINITIONS } from "@yanlinglabs/winter-agent-sdk/tools";

/**
 * **The runtime ↔ host tool-name pairs** (P8b-25) — ONE literal table, both directions derived
 * from it so they can never drift.
 *
 * The gate's four class sets (`agent/gate.ts`) are keyed by the HOST's tool names — `bash`, `read`,
 * `write`, `web_fetch`, `Search`, `browser`, `docs`… — because every caller it has today hands it a
 * name off the host's own `ToolRegistry`. A Winter child calls the SAME actions under DIFFERENT names,
 * so feeding the raw Winter name to the gate is wrong in both directions and SILENTLY:
 *
 *  - `mcp__winter__research__Search` is not in `NETWORK`, so chat's gate branch ("allow READ_ONLY /
 *    NETWORK, deny everything else") would DENY chat's only search tool — chat's Search dies with
 *    every unit test green.
 *  - `"Bash"` is not in `MUTATING`, so it falls to the unclassified fail-closed `"ask"` branch —
 *    which under `auto` is a card where today there is silence, and under dispatch/chat a typed
 *    deny (P8b-7/P8b-26) where today the command runs.
 *  - `approvalCardSummary` / `approvalOptionsFor` (`agent/approvals.ts`) both switch on the literal
 *    `"bash"`, so a card for `"Bash"` would lose its command text AND its "always allow
 *    `Bash(git push:*)`" options — the rules-store "remember this" path would have nothing to
 *    remember.
 *
 * **Failing to map a name is SAFE, by construction:** `hostToolNameFor` answers `undefined`, every
 * caller falls back to the name it was given, and an unknown name lands on `isGateClassified`'s
 * `false` branch and fails closed to `"ask"`. That is why this table may be incomplete without
 * being dangerous — completeness across the capability surface is the parity tripwire's job
 * (P8b-12), not this module's.
 *
 * **Source of the rows:** the "WS-06 §5 successor" column of the Winter Phase 8b codebase map
 * §5.1/§5.3 (the class-(a) and class-(c) disposition tables) — one row per host tool, read off the
 * map rather than recalled. `AskUserQuestion` is pinned separately by the SDK surface map §5.6.
 * Names the map gives no successor (`ls`, `skill_write` — map §5.4) have no row here either.
 */
export const RUNTIME_HOST_TOOL_PAIRS: ReadonlyArray<readonly [runtime: string, host: string]> = [
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
  // ⚠️ THE TWO LOAD-BEARING ROWS (2026-09-18). The daemon no longer HAS a `web_fetch`/`web_search` tool —
  // both retired with the web-tools ruling — but these mappings are how the runtime's own `WebFetch`/
  // `WebSearch` reach `gate.ts`'s `NETWORK` class and `approvals.ts`'s card text. Delete either and its
  // tool falls to the unclassified fail-closed `"ask"` branch: a card under `auto` where there is silence
  // today, and a typed deny in chat and dispatch. The host NAMES they map onto are now classification
  // data (and the name old session JSONLs carry), not tools.
  ["WebFetch", "web_fetch"],
  ["WebSearch", "web_search"],
  ["EnterPlanMode", "enter_plan_mode"],
  ["ExitPlanMode", "exit_plan_mode"],
  ["EnterWorktree", "enter_worktree"],
  ["ExitWorktree", "exit_worktree"],
  ["ListMcpResourcesTool", "list_mcp_resources"],
  ["ReadMcpResourceTool", "read_mcp_resource"],
  ["PushNotification", "push_notification"],
  // The three cron names collapse onto the host's single `schedule` tool, which is how `gate.ts`
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
  // class (d) — THE DAEMON'S OWN CAPABILITY TOOLS UNDER THEIR PLAIN NAMES (the 2026-10-01 tool-surface
  // ruling). The model, the transcript, hook inputs and `canUseTool` all carry these now (the agent SDK's
  // `toolNames`), so each maps onto the SAME host name its `mcp__winter__<key>__<tool>` spelling strips to
  // — the gate's class, the card text and the Mac/phone rows are unchanged. ⚠️ LOAD-BEARING like the web
  // pair above: without a row, chat's `Browser` would fall to the unclassified fail-closed branch and be
  // a typed deny. The old spellings keep stripping below (`WINTER_CAPABILITY_SERVER_KEYS`) for old
  // transcripts and for a call the runtime reports under the old spelling (a rule or matcher named it).
  ["SpawnSession", "session_spawn"],
  ["ListSessions", "list_sessions"],
  ["ManageSession", "manage_session"], // retired from Dispatch 2026-10-02; kept so an old transcript's calls still map
  ["Computer", "computer"],
  // ComputerV2 (2026-10-08): the script-based computer tool. Its host name `computer_v2` is what the
  // renderers key their tool rows on and what `gate.ts` classifies (`SELF_GATED`: the call itself is
  // allowed under every code/dispatch policy — the policy is per APP, inside the call).
  ["ComputerV2", "computer_v2"],
  ["Browser", "browser"],
  // `Search` — Exa answer mode, the agent SDK's built-in since 2026-10-01 (it was the daemon's
  // `mcp__winter__research__Search`, which strips to the same host name): `gate.ts`'s NETWORK class.
  ["Search", "Search"],
];

/**
 * Winter's OWN default tools, by the built-in name a host binds them under (R-8-1: the router owns
 * no tool; Winter's defaults are Winter's, pulled by the router and bound under Claude's built-in
 * names). **Derived from the SDK at module load, never hand-copied** — the four literals are pinned
 * by a test instead, so the SDK adding a fifth widens this set automatically and the test says so.
 *
 * P8b-28: these four are allowed SILENTLY in every mode that has them (chat no longer has SendMessage,
 * ListAgents or ReadNotifications — user ruling 2026-10-02). Since agent SDK 0.0.39 a silent SendMessage can
 * resume and drive ANOTHER code session at that session's own policy — a deliberate user decision
 * (the host predicate also reserves future Cowork participation; Cowork itself is unavailable today)
 * (the reviewer's HIGH #1 policy-escalation finding, accepted), see `agent/gate.ts`. Two of them (`SendMessage`, `ListAgents`)
 * also have host names in the pair table above, and both of those land in `gate.ts`'s `READ_ONLY`
 * — so the gate would allow them anyway. `ReadNotifications` and `advisor` have NO host
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
 * temp home and `CORE_BRAND`'s names. 31 tools, verbatim and sorted as the child sent them.
 *
 * **This, not the host's pair table, is what `disallowedTools` must be derived from** (review F4). The
 * brief's instruction to build the list from `WINTER_DEFAULT_TOOL_DEFINITIONS` rests on a wrong
 * premise — that export is only Winter's own four — and the host's pair table is a different set
 * again: it has rows for tools the child does NOT advertise (`LSP`, `ToolSearch`, the two
 * MCP-resource tools) and, more importantly, MISSES three the child DOES
 * advertise (`Monitor`, `ReportFindings`, `ScheduleWakeup`). Deriving chat's exclusions from the
 * pair table therefore left three tools advertised to a chat model that is supposed to have no
 * fs/shell/repo surface at all.
 *
 * Two measured facts worth keeping:
 *  - **`WebFetch`/`WebSearch` were NOT advertised at 0.0.3 — AT 0.0.17 THEY ARE**, in every default
 *    `init.tools`, because that release gives the Winter runtime its own copies (on by default). The
 *    base list below is left exactly as it was measured: it is a 0.0.3 measurement and re-pinning it
 *    from a later release would erase the one fact it exists to record. The consequence for the two
 *    consumers is spelled where each of them lives — `CHAT_DISALLOWED_BUILTINS` excludes both names
 *    from its derivation (their exposure is `disallowedToolsFor`'s per-leg decision now, not a
 *    constant's), and the chat/code e2e tripwires add them to the union they expect.
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
 * every Winter mode will, because the capability servers ARE MCP servers.
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

/** What a Winter child actually advertises: the measured base set PLUS the `winter.mcp` family, since
 *  every Winter mode declares capability servers. **Task 16's e2e compares live `system/init.tools`
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
 *    structured review result channel, not a scanner" → gated as `task_create`, the host's own
 *    READ_ONLY class for in-session bookkeeping.
 *  - `ScheduleWakeup` — `permissionClass: "task"` (`descriptors/schedule-wakeup.ts:41`), an
 *    in-session self-wake with its delay clamped to 60-3600s. Deliberately NOT the host's `schedule`
 *    (MUTATING): that is the persistent cron surface, which is `CronCreate`/`CronDelete`/`CronList`
 *    in the pair table above, and a standing prompt-injection surface in a way a self-wake is not.
 *
 * The value is the HOST name the gate should classify by — never what the card or the transcript
 * displays, which stays `gateToolNameFor`'s answer.
 */
export const WINTER_TOOL_GATE_CLASS: ReadonlyMap<string, string> = new Map([
  ["Monitor", "bash"],
  ["ReportFindings", "task_create"],
  ["ScheduleWakeup", "task_create"],
  // --- the `winter.mcp` housekeeping trio the pair table has no row for ------------------------
  // All three are read-only bookkeeping over ALREADY-CONNECTED MCP servers, and none of them can
  // reach a server the session has not already declared. Classified as `list_mcp_resources` /
  // `ToolSearch`, which are the host's own `NETWORK` and `READ_ONLY` classes for exactly that work, so
  // code and dispatch get them silently while chat — which has no MCP resources beyond the host's own
  // capability servers — keeps them in its disallow set.
  //
  //  - `ReadMcpResourceDirTool` — "Direct children of a directory resource."
  //    (`descriptors/read-mcp-resource-dir-tool.ts:14`). The same family as `ReadMcpResourceTool`,
  //    so it takes the same host name the pair table already gives that one.
  ["ReadMcpResourceDirTool", "read_mcp_resource"],
  //  - `RefreshMcpTools` — "Re-queries connected servers' tool lists; **never establishes a
  //    disconnected connection**" (`descriptors/refresh-mcp-tools.ts:13`). Purely a re-read of the
  //    in-memory tool index, which is what the host's own `ToolSearch` does.
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
export function gateClassFor(winterToolName: string, liveKeys?: ReadonlySet<string>): string {
  return WINTER_TOOL_GATE_CLASS.get(winterToolName) ?? gateToolNameFor(winterToolName, liveKeys);
}

/** `mcp__winter__` — the prefix every daemon-owned capability tool carries under R-1 / P8b-12
 *  (`mcp__winter__<serverKey>__<tool>`, minted by Task 6-7's `capabilityToolName`). Spelled out
 *  literally rather than derived from Task 5's `CORE_BRAND.mcpServerName`: that module lands in a
 *  different lane, and the brand's `mcpServerName` is itself pinned to `"winter"` by the Interfaces
 *  block, so the two cannot disagree without the interfaces block changing first. */
export const WINTER_CAPABILITY_TOOL_PREFIX = "mcp__winter__";

/**
 * **The five capability server keys, and the ONLY ones whose `mcp__winter__<key>__<tool>` names are
 * stripped to a bare Winter tool name** (P8b-12's set: `sessions`, `computer`, `browser`, `office`,
 * `research`).
 *
 * Without this check the prefix strip is a NAME-SPOOF PATH straight into Winter's tool classes. A
 * third-party MCP server named `winter__x` — or a server named `winter` with a tool whose own name
 * contains `__` — produces `mcp__winter__x__read`, which a bare-suffix strip turns into `read` →
 * `READ_ONLY` → a SILENT ALLOW under every policy, `plan`, `chat` and `dont-ask` included. Without
 * the strip that name keeps its `mcp__` prefix and `isExternalToolName` gives it the external class
 * a third-party MCP tool is supposed to get (a card under `ask`, a deny under `plan`).
 *
 * Spelled out literally beside the prefix for the same reason the prefix is: Task 7's server keys
 * land in another lane, and the integration parity test diffs them.
 */
export const WINTER_CAPABILITY_SERVER_KEYS: ReadonlySet<string> = new Set([
  // ⚠️ `web` IS RETAINED ON PURPOSE (2026-09-18). Its capability SERVER is gone — `web_fetch`/
  // `web_search` retired with the web-tools ruling and `CAPABILITY_SERVER_KEYS` no longer lists the key
  // — but this set is what `hostToolNameFor` STRIPS through, and the Mac and the phone still render
  // historical session JSONLs full of `mcp__winter__web__web_fetch` rows. Drop the key and every one of
  // those names stops stripping: `isExternalToolName` claims it, the row loses its host name in the
  // renderers, and (for anything that replayed through the gate) it would take the MUTATING/external
  // branch — a CARD under `ask`/`accept-edits`, a DENY under `plan`/`dont-ask`, where the web class is
  // `NETWORK` and allowed under every policy. That was the original review-NEW-1 bug when the key was
  // MISSING; removing it now would recreate it for every past session.
  // `research` IS RETAINED ON PURPOSE TOO (2026-10-01), for the same reason: its server is gone (`Search`
  // is the agent SDK's built-in) but old JSONLs replay `mcp__winter__research__Search`. Both retired
  // keys stay RESERVED server names (`capabilities/names.ts`'s `RETIRED_CAPABILITY_SERVER_KEYS`, refused by
  // the write door and, for every origin, by the agent SDK's `reservedMcpServerNames`), and a LIVE caller
  // strips only the keys its incarnation built (`hostToolNameFor`'s `liveKeys`) — so these two strip on
  // REPLAY only.
  "sessions", "computer", "browser", "office", "research", "web",
  // The SEVENTH key, `lsp` (fix wave, review F7): `mcp__winter__lsp__lsp` strips to `lsp`, which
  // `gate.ts` classifies READ_ONLY — the class the registry-door tool always had.
  "lsp",
  // ComputerV2 (2026-10-08): `mcp__winter__computer_v2__script` strips to `computer_v2` (a live call only
  // when this incarnation built the key, like every other).
  "computer_v2",
]);

/**
 * **The tools each capability server key has EVER served** — the only `<tool>` an `mcp__winter__<key>__<tool>`
 * name strips to (2026-10-01 review). A bare key match was not enough: the projector's tool name feeds LIVE
 * side effects (`sinks.ts` creates a routine for `schedule`, notifies for `push_notification`), so a server
 * that somehow wore a retired or unbuilt capability name (`winter__web`, `winter__computer` with computer use
 * off) and served a tool called `schedule` would have stripped onto the host's own scheduling verb. Exact names
 * close that: the retired ones (`research`'s `Search`/`ReadPage`, `web`'s pair) keep stripping for old
 * transcripts, and nothing else does. `mode-matrix.test.ts` pins this against `WINTER_CAPABILITY_TOOLS`.
 */
export const CAPABILITY_TOOLS_BY_KEY: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["sessions", new Set(["session_spawn", "list_sessions", "manage_session"])],
  ["computer", new Set(["computer"])],
  // The server's tool is `script`, but its HOST name is `computer_v2` — the pair table's name for
  // `ComputerV2` — so the old spelling and the plain name land on one gate class and one renderer row.
  ["computer_v2", new Set(["script"])],
  ["browser", new Set(["browser"])],
  ["office", new Set(["docs", "sheets", "slides"])],
  ["lsp", new Set(["lsp"])],
  ["research", new Set(["Search", "ReadPage"])],
  ["web", new Set(["web_fetch", "web_search"])],
]);

const RUNTIME_TO_HOST = new Map<string, string>(RUNTIME_HOST_TOOL_PAIRS.map(([w, n]) => [w, n]));
const HOST_TO_RUNTIME = ((): ReadonlyMap<string, string> => {
  const m = new Map<string, string>();
  for (const [w, n] of RUNTIME_HOST_TOOL_PAIRS) if (!m.has(n)) m.set(n, w);   // first pair wins
  return m;
})();

/**
 * The HOST name for a tool a Winter child just called, or `undefined` when nothing claims it.
 *
 * Three cases, in order:
 *  1. a host capability tool — `mcp__winter__<key>__<tool>` whose `<key>` is one of the FIVE
 *     capability server keys — → the BARE `<tool>` name, which is exactly how `gate.ts` already
 *     classifies every server's tools (`Search` in `NETWORK`, `browser` in `NETWORK`,
 *     `computer`/`docs`/`sheets`/`slides`/`session_spawn` in `MUTATING`,
 *     `list_sessions`/`manage_session` in `READ_ONLY`);
 *  2. a mapped Winter built-in → its host name (the pair table);
 *  3. anything else → `undefined`. A third-party `mcp__…`/`plugin__…` name has no host name — and
 *     that INCLUDES an `mcp__winter__…` name whose server key is not one of the five, which is the
 *     spoof `WINTER_CAPABILITY_SERVER_KEYS` exists to refuse. Callers that fall back to the original
 *     keep its prefix, so `isExternalToolName` still classifies it as external; every other unknown
 *     name stays unknown and fails closed.
 *
 * **`liveKeys` — the LIVE paths' narrowing (2026-10-01 review).** A LIVE call (the approval bridge, the
 * hooks) passes the capability server keys THIS incarnation actually built: an `mcp__winter__<key>__…`
 * name is the daemon's own only when its `<key>` server exists in the session right now. A retired key
 * (`research`, `web`) or one not built this time (`computer` with computer use off) then strips to
 * nothing and stays an ordinary MCP name — so a server that somehow took such a name (the agent SDK's
 * `reservedMcpServerNames` refuses every origin, and this is the second fence) can never mint a host
 * name. Only REPLAY (the projector rendering a stored transcript) omits it and strips every key.
 *
 * Pure; no I/O; safe to call on every permission request.
 */
export function hostToolNameFor(winterToolName: string, liveKeys?: ReadonlySet<string>): string | undefined {
  if (winterToolName.startsWith(WINTER_CAPABILITY_TOOL_PREFIX)) {
    const rest = winterToolName.slice(WINTER_CAPABILITY_TOOL_PREFIX.length);
    // `<serverKey>__<tool>` — split at the FIRST `__`, so a tool name that itself contains `__`
    // survives intact. Claimed ONLY when `<serverKey>` is one of the host's own five: a malformed
    // entry, or a third-party server spoofing the prefix, stays `mcp__`-prefixed for its caller and
    // is therefore still classified as an external MCP tool, never silently widened.
    const sep = rest.indexOf("__");
    if (sep <= 0 || sep + 2 >= rest.length) return undefined;
    const key = rest.slice(0, sep);
    if (!WINTER_CAPABILITY_SERVER_KEYS.has(key)) return undefined;
    if (liveKeys !== undefined && !liveKeys.has(key)) return undefined;
    const tool = rest.slice(sep + 2);
    if (CAPABILITY_TOOLS_BY_KEY.get(key)?.has(tool) !== true) return undefined;
    return CAPABILITY_HOST_NAMES.get(`${key}__${tool}`) ?? tool;
  }
  return RUNTIME_TO_HOST.get(winterToolName);
}

/** The capability tools whose HOST name is not their server-side tool name — `mcp__winter__computer_v2__script`
 *  is `computer_v2`, the same name `ComputerV2` maps to in the pair table (a bare `script` would be a host
 *  name nothing classifies or renders). */
const CAPABILITY_HOST_NAMES: ReadonlyMap<string, string> = new Map([["computer_v2__script", "computer_v2"]]);

/** The inverse: the WINTER (runtime) name for one of the host's tool names, or `undefined`.
 *  Capability tools have no single runtime spelling here (their `mcp__winter__<key>__<tool>` name
 *  depends on which server owns them — Task 7's `capabilityToolName` mints those), so this answers
 *  only for the built-in pairs. Where several runtime names share one host name (the three cron
 *  verbs) the FIRST pair wins. */
export function winterToolNameFor(hostToolName: string): string | undefined {
  return HOST_TO_RUNTIME.get(hostToolName);
}

/** The name to hand `PermissionGate.evaluate` — the host name when one exists, otherwise the
 *  runtime name unchanged, which fails closed. The bridge's one-liner, kept here so the projector
 *  lane and the bridge cannot disagree about the fallback. */
export function gateToolNameFor(winterToolName: string, liveKeys?: ReadonlySet<string>): string {
  return hostToolNameFor(winterToolName, liveKeys) ?? winterToolName;
}
