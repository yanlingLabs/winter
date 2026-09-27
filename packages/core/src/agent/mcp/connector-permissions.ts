// WS-26 — CONNECTOR PERMISSIONS: one permission per action of a user-configured MCP server
// ("connector"), set by the user to Always allow / Always ask / Always deny, valid in EVERY mode.
//
// ── What a connector action is ────────────────────────────────────────────────────────────────────
// A tool a session's child calls as `mcp__<server>__<tool>`, where `<server>` is an MCP server the USER
// configured — the user, local or project scope (`sdk/.winter.json`, a trusted project's
// `.winter/mcp.json`) — or one an enabled claude-format PLUGIN ships in its own `.mcp.json`: the runtime
// keys a plugin's servers by their raw names (`pluginMcpServerSources` in the agent runtime), so their
// tools are byte-identical on the wire to a user server's and there is nothing to tell them apart by.
// NOT a connector action:
//  - the daemon's own capability tools, `mcp__winter__<key>__<tool>` — including `external`, which is
//    how Winter's extras-tier `plugin__<id>__<tool>` tools reach a child (`capabilities/external.ts`);
//    a `plugin__…` name itself never reaches a child at all;
//  - a user server literally named `winter` (its tools would read `mcp__winter__<tool>`, inside the
//    capability prefix): excluded rather than guessed at, so it keeps today's external-tool treatment;
//  - every built-in.
// `gate.ts`'s `isExternalToolName` lumps all `mcp__`/`plugin__` names together; `isConnectorToolName`
// is the narrower predicate, and the ONLY one the chat exception below keys on.
//
// ── The store, and why it is Winter's own ─────────────────────────────────────────────────────────
// `settings.json` → `mcp.toolPermissions: { [server]: { [tool | "*"]: "allow" | "ask" | "deny" } }`,
// beside `mcp.disabled`, written through the same `loadSettings`/`saveSettings` door and read LIVE on
// every decision (the settings watcher swaps the daemon's in-memory copy; nothing snapshots it).
//
// Claude-grammar rules in `sdk/settings.json` (`permissions.allow/ask/deny`) were the alternative, and
// they cannot meet "a flip takes effect on the next call without a respawn": the router writes each
// child's run-folder `settings.json` ONCE, at incarnation (`buildEffectiveSettings`, `flag: "wx"`), and
// the runtime evaluates deny rules at stage 2 of `evaluateStages` — after only the PreToolUse hooks,
// and nothing a hook answers can undo a deny rule. A stored deny flipped to allow would keep denying in
// every live session until it respawned. So Winter keeps its own table and enforces it itself (the hook
// and the bridge below); rules the user or a "saved answer → everywhere" already wrote to
// `sdk/settings.json` still bind natively and are REPORTED beside it (`sdkRulesFor`), never folded in.
//
// ── Enforcement is two-sided ──────────────────────────────────────────────────────────────────────
// `connectorVerdict` below is the one matrix. It is applied twice, from the same live facts:
//  1. `runtime-sdk/hooks.ts`'s connector-permission PreToolUse hook — the FLOOR, in every mode. It is the
//     only layer that sees a call the child decides natively: a deny (under `bypass` too), an allow
//     under `dont-ask` (whose runtime denies an unresolved MCP call without ever calling `canUseTool`),
//     and an explicit ask over a saved allow rule or `bypass` (a hook `ask` is evaluated before both).
//  2. `runtime-sdk/approval-bridge.ts` — for every call that does reach `canUseTool`, the verdict's DENY
//     and ASK (never its allow: the floor is the one layer that allows, and a call that reached the bridge
//     anyway was sent there by another layer's mandatory prompt), and a chat or dispatch session (never a
//     dispatch child) CARDS a connector action instead of refusing it.
//
// ── The matrix (policy × stored setting), stated once — `connectorVerdict` is its code ──────────────
//   stored deny     deny, every policy and mode, `bypass` included.
//   stored allow    allow, every mode; under `plan` only a READ-ONLY action (anything else: deny —
//                   plan mutates nothing, and the child cannot hold an MCP call back itself: a hook allow
//                   is withheld under plan only for write-shaped calls, which an MCP call never is).
//   stored ask      a card in code (ask / accept-edits / auto / bypass — the hook's `ask` makes a bypass
//                   child reach `canUseTool`, where the bridge cards it), chat and dispatch; deny under
//                   `dont-ask` (it declines every card); under `plan`, a card for a READ-ONLY action and
//                   a deny otherwise (the brief left this cell open: an explicit "ask me" on something
//                   that only reads is honoured, while plan's own rule — nothing mutates — still holds).
//   unset           READ-ONLY → allow in every mode and policy, plan and dont-ask included;
//                   otherwise → a card in chat and dispatch, and in code exactly today's per-policy
//                   answer (`gate.ts`: plan deny, dont-ask deny, ask/accept-edits card, auto and bypass
//                   allow) — the verdict is `"gate"`, meaning "the gate decides, as before".
//   dispatch child  (a CODE session with `origin: "dispatch-child"`) keeps today's never-prompt rule:
//                   allow and deny apply as above, an "ask" is the bridge's typed never-prompts deny,
//                   and unset follows today's gate (its `auto` policy allows).
//
// READ-ONLY comes from the daemon's own probe (`McpManager`'s per-server `tools/list`): an action is
// read-only only when the server's `annotations.readOnlyHint === true` in the last listing that named it.
// An unknown server, an unprobed tool or a missing annotation is NOT read-only — it fails toward ask.

import type { SessionApprovalPolicy } from "../gate";
import type { Mode as SessionMode } from "../tools/registry";

/** The three things a user can say about an action. "Default" is the ABSENCE of a stored value. */
export type ConnectorPermission = "allow" | "ask" | "deny";
export const CONNECTOR_PERMISSIONS: readonly ConnectorPermission[] = ["allow", "ask", "deny"];
/** The per-server key that applies to every action of the server without its own value. */
export const CONNECTOR_ALL_TOOLS = "*";

/** `settings.mcp.toolPermissions`, as stored: server → (tool | "*") → permission. */
export type ConnectorPermissionTable = Record<string, Record<string, ConnectorPermission>>;

const MCP_PREFIX = "mcp__";
/** The daemon's own capability tools (`runtime-sdk/tool-names.ts`'s `WINTER_CAPABILITY_TOOL_PREFIX`). */
const CAPABILITY_PREFIX = "mcp__winter__";

/**
 * EVERY way `mcp__<server>__<tool>` can be split into a server and a tool, first split first — or `[]`
 * for anything that is not a connector action (see this file's header).
 *
 * WHY EVERY SPLIT (review r1, CRITICAL 1): the runtime names a tool `mcp__${server}__${tool.name}` and
 * neither half is forbidden to contain `__` — `winter mcp add` accepts a server named `cf__prod`, and a
 * hand-edited `sdk/.winter.json` or a project's `.winter/mcp.json` can name anything. So
 * `mcp__cf__prod__delete_worker` is EITHER server `cf` + tool `prod__delete_worker` OR server `cf__prod` +
 * tool `delete_worker`, and nothing in the name says which. Splitting at the first `__` alone let a stored
 * deny on `cf__prod` never match (the call ran under `bypass`) while `mcp.tools`, which looks up by the
 * real name, reported it denied. `resolveConnector` below weighs every candidate.
 */
export function connectorCandidates(name: string): Array<{ server: string; tool: string }> {
  if (typeof name !== "string" || !name.startsWith(MCP_PREFIX) || name.startsWith(CAPABILITY_PREFIX)) return [];
  const rest = name.slice(MCP_PREFIX.length);
  const out: Array<{ server: string; tool: string }> = [];
  for (let sep = rest.indexOf("__"); sep !== -1; sep = rest.indexOf("__", sep + 1)) {
    if (sep <= 0 || sep + 2 >= rest.length) continue;
    const server = rest.slice(0, sep);
    if (server === "winter") continue;
    out.push({ server, tool: rest.slice(sep + 2) });
  }
  return out;
}

/** The FIRST split (a server name without `__`), or `undefined` for a non-connector name. Display and
 *  messages only — every decision goes through `resolveConnector`, which weighs every split. */
export function parseConnectorToolName(name: string): { server: string; tool: string } | undefined {
  return connectorCandidates(name)[0];
}

/** Is `name` a connector action? The narrow predicate the chat exception keys on (never `isExternalToolName`). */
export function isConnectorToolName(name: string): boolean {
  return parseConnectorToolName(name) !== undefined;
}

/** The wire name of a server's action. */
export function connectorToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/**
 * A stored table read defensively: the settings schema keeps `toolPermissions` loose (one mistyped value
 * must not roll the WHOLE settings file back to keep-last-good), so an unrecognised value is read here as
 * `"ask"` — never as "unset", which could silently allow, and never as a crash.
 */
export function normalizeConnectorTable(raw: unknown): ConnectorPermissionTable {
  const out: ConnectorPermissionTable = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [server, tools] of Object.entries(raw as Record<string, unknown>)) {
    // A row that is not an object (`"cf": "deny"`, a hand edit) is read as `{"*": "ask"}`: toward ask for
    // every action of the server — never as unset, which could silently allow (review r1, minor 3).
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) { out[server] = { [CONNECTOR_ALL_TOOLS]: "ask" }; continue; }
    const row: Record<string, ConnectorPermission> = {};
    for (const [tool, value] of Object.entries(tools as Record<string, unknown>)) {
      row[tool] = value === "allow" || value === "ask" || value === "deny" ? value : "ask";
    }
    if (Object.keys(row).length > 0) out[server] = row;
  }
  return out;
}

/** Where a stored value came from: the action's own entry, or its server's `"*"`. */
export type ConnectorSettingSource = "tool" | "server";

/** The stored value that applies to one action (its own entry wins over its server's `"*"`), or `undefined`. */
export function connectorSettingFor(table: ConnectorPermissionTable, server: string, tool: string): { permission: ConnectorPermission; source: ConnectorSettingSource } | undefined {
  const row = Object.hasOwn(table, server) ? table[server] : undefined;
  if (row === undefined) return undefined;
  if (Object.hasOwn(row, tool) && tool !== CONNECTOR_ALL_TOOLS) return { permission: row[tool]!, source: "tool" };
  if (Object.hasOwn(row, CONNECTOR_ALL_TOOLS)) return { permission: row[CONNECTOR_ALL_TOOLS]!, source: "server" };
  return undefined;
}

/** What `connectorVerdict` answers. `"gate"`: no connector opinion — `gate.ts` decides, as it always did. */
export type ConnectorVerdict = "allow" | "ask" | "deny" | "gate";

export interface ConnectorVerdictInput {
  /** The stored value that applies (`connectorSettingFor`), or `undefined` for "never set". */
  setting: ConnectorPermission | undefined;
  /** `true` only when the daemon's probe saw `readOnlyHint: true` for this action. */
  readOnly: boolean;
  policy: SessionApprovalPolicy;
  mode: SessionMode;
  /** `SessionMeta.origin`; `"dispatch-child"` keeps the never-prompt rule. */
  origin?: string;
}

/** The matrix in this file's header, as code. Pure. */
export function connectorVerdict(i: ConnectorVerdictInput): ConnectorVerdict {
  if (i.setting === "deny") return "deny";
  if (i.setting === "allow") return i.policy === "plan" && !i.readOnly ? "deny" : "allow";
  if (i.setting === "ask") {
    if (i.policy === "plan" && !i.readOnly) return "deny";
    if (i.policy === "dont-ask") return "deny";
    return "ask";
  }
  if (i.readOnly) return "allow";
  // Unset and not known to be read-only: chat and dispatch card it (their gate answers would be a chat
  // deny and a silent dispatch `auto` allow); code and a dispatch child keep today's gate verdict.
  if (i.mode !== "code" && i.origin !== "dispatch-child") return "ask";
  return "gate";
}

/** The model-facing reason for a connector deny — names the action, the setting and the way out. */
export function connectorDenialMessage(server: string, tool: string, i: Pick<ConnectorVerdictInput, "setting" | "policy">): string {
  const action = `${tool} (the ${server} connector)`;
  if (i.setting === "deny") {
    return `${action} was not run — the user set this action to "Always deny" in Winter's connector permissions. Do not retry it; tell the user if you need it.`;
  }
  if (i.policy === "plan") {
    return `${action} was not run — plan mode makes no changes, and this action is not marked read-only by its server. When your plan is ready, call exit_plan_mode to present it for approval.`;
  }
  return `${action} was not run — it is set to "Always ask", and this session's dont-ask policy declines every approval. Switch the session to ask or auto to be prompted.`;
}

/** The reason a hook `ask` carries (the child passes it to `canUseTool` as `decisionReason`). */
export function connectorAskReason(server: string, tool: string, setting: ConnectorPermission | undefined): string {
  return setting === "ask"
    ? `${tool} (the ${server} connector) is set to "Always ask" in Winter's connector permissions — the user decides.`
    : `${tool} (the ${server} connector) is not marked read-only by its server — the user decides.`;
}

/**
 * The live facts one decision needs, from wherever the caller keeps them. The daemon's implementation
 * reads `settings.mcp.toolPermissions` from its in-memory settings and read-only from `McpManager`'s probe
 * cache — both synchronous, neither ever waits on a probe (a miss may START one in the background).
 */
export interface ConnectorPermissionSource {
  /** The live stored table. */
  table(): ConnectorPermissionTable;
  /** The probe's `readOnlyHint` for this action: `true`/`false` when a listing named it, else `undefined`. */
  readOnly(server: string, tool: string, cwd?: string): boolean | undefined;
}

export interface ConnectorFacts {
  /** The split the decision is about (the one whose setting won, else the one whose listing names the
   *  tool, else the first split) — what messages and cards name. */
  server: string;
  tool: string;
  setting?: ConnectorPermission;
  settingSource?: ConnectorSettingSource;
  readOnly: boolean;
}

const STRICTNESS: Record<ConnectorPermission, number> = { deny: 3, ask: 2, allow: 0 };

/**
 * `toolName` → the live facts about it, weighing EVERY split (`connectorCandidates`), or `undefined` when
 * it is not a connector action. The one resolver: the hook, the bridge and `mcp.tools` all call it.
 *
 * One split (the ordinary case, no `__` in the server name): that split's stored value and listing, as is.
 *
 * Several splits — ambiguous, so fail toward the stricter answer:
 *  - a candidate is CONFIRMED when its server's listing names the tool (`source.readOnly` answers
 *    `true`/`false`, never `undefined`);
 *  - a stored `deny` or `ask` from ANY candidate counts (a `"*"` on `cf` also covers `cf__prod`'s tools
 *    — over-strict at worst, never a silent run);
 *  - a stored `allow` counts only from a confirmed candidate or from an entry that names the tool exactly
 *    (never from an unconfirmed server's `"*"`, which may be a different server's blanket allow);
 *  - a confirmed candidate with nothing stored contributes the DEFAULT, which outranks an allow;
 *  - the strictest wins: deny > ask > default > allow;
 *  - read-only only when at least one candidate is confirmed and every confirmed listing says read-only.
 */
export function connectorFactsFor(source: ConnectorPermissionSource, toolName: string, cwd?: string): ConnectorFacts | undefined {
  const candidates = connectorCandidates(toolName);
  if (candidates.length === 0) return undefined;
  const table = source.table();
  const weighed = candidates.map((c) => ({ ...c, stored: connectorSettingFor(table, c.server, c.tool), listed: source.readOnly(c.server, c.tool, cwd) }));
  if (weighed.length === 1) {
    const only = weighed[0]!;
    return {
      server: only.server, tool: only.tool,
      ...(only.stored === undefined ? {} : { setting: only.stored.permission, settingSource: only.stored.source }),
      readOnly: only.listed === true,
    };
  }
  const confirmed = weighed.filter((c) => c.listed !== undefined);
  type Vote = { rank: number; c: (typeof weighed)[number]; setting?: ConnectorPermission };
  const votes: Vote[] = [];
  for (const c of weighed) {
    const isConfirmed = c.listed !== undefined;
    if (c.stored !== undefined) {
      const p = c.stored.permission;
      if (p !== "allow" || isConfirmed || c.stored.source === "tool") votes.push({ rank: STRICTNESS[p], c, setting: p });
    } else if (isConfirmed) {
      votes.push({ rank: 1, c });   // the default
    }
  }
  const winner = votes.sort((a, b) => b.rank - a.rank)[0];
  const named = winner?.c ?? confirmed[0] ?? weighed[0]!;
  const readOnly = confirmed.length > 0 && confirmed.every((c) => c.listed === true);
  return {
    server: named.server, tool: named.tool,
    ...(winner?.setting === undefined ? {} : { setting: winner.setting, settingSource: winner.c.stored!.source }),
    readOnly,
  };
}

// ── Claude-grammar rules in `sdk/settings.json`, REPORTED, never folded in ───────────────────────────
//
// They bind natively inside the child, from the run folder's snapshot: a `deny` in every mode (the
// router's `stripForMode` keeps `permissions.deny` for chat/dispatch) and an `allow`/`ask` in CODE only
// (stripped for chat/dispatch). The matching mirrors the pinned runtime exactly (`toolNameMatches` /
// `parseRule`): a name without `*` matches only itself — so a bare `mcp__cf` names NO action of `cf`
// (the runtime diverges from claude there) — a `*` is a glob, an ALLOW glob counts only when anchored past
// its server (`mcp__cf__*`, `isAnchoredMcpAllowGlob`), and a parenthesised specifier on an MCP name is
// invalid except the bare-equivalent `()` / `(*)`.

export type SdkRuleBehavior = "allow" | "ask" | "deny";
export interface SdkRuleHit { behavior: SdkRuleBehavior; rule: string }

function ruleToolName(raw: string): string | undefined {
  const trimmed = raw.trim();
  const open = trimmed.indexOf("(");
  if (open === -1) return trimmed;
  if (!trimmed.endsWith(")")) return trimmed;
  const content = trimmed.slice(open + 1, -1);
  return content === "" || content === "*" ? trimmed.slice(0, open) : undefined;
}

function globMatches(pattern: string, name: string): boolean {
  const source = pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "s").test(name);
}

function anchoredMcpAllowGlob(name: string): boolean {
  const star = name.indexOf("*");
  const prefix = star === -1 ? name : name.slice(0, star);
  return prefix.slice(MCP_PREFIX.length).includes("__");
}

function sdkRuleMatches(rule: string, behavior: SdkRuleBehavior, callName: string): boolean {
  const name = ruleToolName(rule);
  if (name === undefined || !name.startsWith(MCP_PREFIX)) return false;
  if (!name.includes("*")) return name === callName;
  if (behavior === "allow" && !anchoredMcpAllowGlob(name)) return false;
  return globMatches(name, callName);
}

/** Every `sdk/settings.json` rule that names this action, strongest first (deny, ask, allow — the runtime's own order). */
export function sdkRulesFor(permissions: { allow?: unknown; ask?: unknown; deny?: unknown } | undefined, toolName: string): SdkRuleHit[] {
  const out: SdkRuleHit[] = [];
  for (const behavior of ["deny", "ask", "allow"] as const) {
    const list = permissions?.[behavior];
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (typeof rule === "string" && sdkRuleMatches(rule, behavior, toolName)) out.push({ behavior, rule });
    }
  }
  return out;
}
