# MCP: replace the hand-rolled stdio client with the official SDK, then add background tasks

Date: 2026-08-18
Status: design approved, not yet implemented
Scope: `packages/core/src/agent/mcp/*`, `packages/core/package.json`, MCP tests

## Problem

`packages/core/src/agent/mcp/client.ts` is a 125-line hand-rolled JSON-RPC-over-stdio MCP
client. `manager.ts` (lifecycle, trust gating, namespacing) is good code and is NOT the problem.
The client is, in four measurable ways:

1. **No pagination.** `tools/list` and `resources/list` ignore `nextCursor` (client.ts:48, :68).
   A server with more tools than one page silently exposes only the first page.
2. **Cancellation is local-only.** `callTool` races an `AbortSignal` (client.ts:58) but never
   sends `notifications/cancelled`; the server keeps working and the pending map entry leaks.
3. **No per-request timeout.** The 10s budget covers only the handshake (client.ts:50-52). A
   live-but-hung server makes `tools/call` hang forever.
4. **Non-text results are dropped** as `[non-text content omitted]` (client.ts:60) — images,
   audio, `resource_link`, `structuredContent` never reach the model.

Plus: `protocolVersion` pinned to `"2024-11-05"` (client.ts:44), server→client messages ignored
with no `-32601` reply (client.ts:116), stderr captured then discarded (client.ts:41).

Separately, MCP now has **tasks** (protocol revision `2025-11-25`): a tool call returns a durable
handle immediately and completes later. Norma already has the delivery mechanism for exactly this
shape — `task_notification` — used by backgrounded bash and detached subagents.

## Decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| SDK line | `@modelcontextprotocol/sdk@1.30.0` (v1) | **Only line with a task runtime.** v2 (`@modelcontextprotocol/client@2.0.0`) marks every task type `@deprecated … no SDK runtime` and fails the conformance tasks suite by design. |
| Delivery | Two stacked PRs | Migration is behaviour-preserving and provable; tasks are new behaviour. Separable review risk. |
| Task opt-in | Server-directed, SDK-native | Norma never mutates a server-authored schema. A tool opts in via its own `execution.taskSupport`. If a server wants to expose a background flag, that is the server's job. |
| In scope | Non-text content, stderr→log | Chosen explicitly. |
| Out of scope | `tools/list_changed`, elicitation wiring | Follow-ups. |

### Why v1 despite 93 transitive packages

Measured, not assumed:

| | v1 `sdk@1.30.0` | v2 `client@2.0.0` |
|---|---|---|
| Task runtime | **yes** (`experimental.tasks.*`) | no — types only |
| Bundle (`bun build`, client-only) | **0.51 MB**, 232 modules | 0.76 MB |
| `express`/`hono`/`cors`/`express-rate-limit` in bundle | **0 refs — tree-shaken** | n/a |
| `bun build --compile` + run | verified | verified |
| Transitive install | 93 pkgs | 13 pkgs |

The server stack never ships. The 93 packages are install/audit surface only. An official
`npx @modelcontextprotocol/codemod@beta v1-to-v2` exists, and the migration guide supports
side-by-side installation, so the v2 hop later is mechanical.

## Architecture

### The seam

`McpStdioClient` keeps its **exact public shape**. Only internals change.

Preserved surface (4 exports, 3 consumers):

    McpStdioClient       -> manager.ts, test/agent/mcp/client.test.ts
    McpToolInfo          -> manager.ts (via client.tools())
    McpResourceInfo      -> tools/mcp-resources.ts (type-only)
    McpResourceContent   -> tools/mcp-resources.ts (type-only)

Preserved behaviour: `start()`, `tools()`, `callTool()`, `listResources()`, `readResource()`,
`stop()`, `dead`, `resourcesCapable()`, and the `NORMA_MCP_START_TIMEOUT_MS` env var.

**Deletion safety (verified).** Norma has three independent JSON-RPC implementations sharing
zero code: `packages/protocol/src/jsonrpc.ts` (own daemon<->app vocabulary, zod-schema'd, carries
`commandId`; used by `ipc/server.ts`, `cli/client.ts`, `plugin-sdk`, `provider-link.ts`),
`agent/lsp/client.ts` (LSP framing), and `agent/mcp/client.ts`. The MCP client imports only
`node:child_process` and has zero references to `@norma/protocol`. Every piece of JSON-RPC
machinery being deleted (`request`, `notify`, `onData`, `die`, `pending`, `buf`, `nextId`) is a
`private` class member unreachable from outside the file.

## PR 1 — migrate to the SDK

### Commit 1: pure swap

Replace the transport internals with `Client` + `StdioClientTransport`. Delete ~60 lines of
private JSON-RPC plumbing.

**Proof of no regression: every existing MCP test assertion passes unmodified.**

Inherited for free (verified against v1's source, not assumed):

- `notifications/cancelled` sent on abort (`shared/protocol.js:674-683`) — real upstream
  cancellation, closing defect 2.
- `-32601` replies to unknown server->client requests (`shared/protocol.js:295`).
- Version negotiation `2024-11-05` -> `2025-11-25`; zod-validated responses; no shell injection.

**Pagination is NOT free and is an explicit work item.** v1's `listTools` issues a single
`tools/list` and returns; it exposes `nextCursor` in the result type but never follows it. Commit
1 must loop on `nextCursor` for both `tools/list` and `resources/list` (a small loop over an
SDK-provided field, but code we own). Closing defect 1 is deliberate work, not a side effect of
adopting the SDK.

**Three silent behaviour deltas that MUST be neutralised explicitly.** Each was measured; each
breaks real users if inherited by accident:

| Delta | SDK default | Today | Action in commit 1 |
|---|---|---|---|
| Request timeout | `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` | unbounded | New `NORMA_MCP_CALL_TIMEOUT_MS`, default **600000 (10 min)**, passed explicitly with `resetTimeoutOnProgress: true`. See rationale below. |
| Stdio env | `getDefaultEnvironment()` -> 6 keys (`HOME LOGNAME PATH SHELL TERM USER`) | all 38 of `process.env` | Explicitly pass `{...process.env, ...cfg.env}`. Servers relying on inherited API keys must not break. |
| Malformed line | **No delta — verified.** The SDK surfaces a bare `null` line as a non-fatal zod error via `onerror`; the connection survives and `tools/list` still succeeds | tolerant skip (client.ts:110) | Fixture and test BOTH unchanged. Requirement: install an `onerror` handler that logs rather than propagates. |
| Server stderr | SDK default is `"inherit"` — server stderr leaks into the daemon's own stderr | piped, then discarded | Set `stderr: "pipe"` explicitly and route to the daemon log. |

**Timeout rationale (decided, not deferred).** Three options were on the table: inherit the SDK's
60s (breaks any tool legally running longer today), keep it unbounded (preserves behaviour but
leaves defect 3 — the infinite hang — alive), or set a large finite bound. We take the third:
`NORMA_MCP_CALL_TIMEOUT_MS`, default 10 minutes, mirroring the existing
`NORMA_MCP_START_TIMEOUT_MS` convention and overridable per deployment. It preserves every
realistic call, closes the infinite hang, and is the right shape going into PR 2 — once tasks
exist, genuinely long operations should be *tasks*, not synchronous calls holding a turn open.

Worth stating in the PR body: "no request timeout" is listed above as a defect, but *silently
gaining* a 60s one is a regression. The bound is chosen deliberately, not inherited.

### Commit 2: non-text content + stderr

- New `callToolContent()` returns structured `McpContentBlock[]` alongside the existing
  `callTool()` string method. Images route through the existing `attach-image.ts` path instead of
  becoming `[non-text content omitted]`.
- stderr -> daemon log, closing the `/* could log to daemon log */` TODO at client.ts:41.

**The registry contract does NOT change** (corrected from the original design). `ToolRunResult` is
`string | { output, fileDiff? }`, and images attach through the side channel `ctx.attachImage` via
`attachImageGuarded`, not through the return value. So `callTool()` keeps its exact signature for
every existing caller, `callToolContent()` is purely additive, and the only `manager.ts` change is
its `run` closure. Materially smaller blast radius than first assumed.

## PR 2 — background tasks

### Mechanism

Task support is server-directed. A tool declares `execution.taskSupport` (`required` | `optional`);
the SDK's private `isToolTask` reads it. Norma advertises support and never modifies a schema.

    callTool(name, args)
      |- not task-capable -> today's synchronous path, unchanged
      \- task-capable     -> client.experimental.tasks.callToolStream()
             |- tool_result: "started, task <id>"   (turn continues)
             |- McpTaskRegistry tracks it            (mirrors bg-agent-registry.ts)
             \- settles -> takeForNotification() -> engine -> hub.append({type:"task_notification"})

Available API: `client.experimental.tasks.{callToolStream, getTask, getTaskResult, listTasks,
cancelTask, requestStream}`.

### New unit: `packages/core/src/agent/mcp/task-registry.ts`

Mirrors `bg-agent-registry.ts` deliberately — same lifecycle shape, same exactly-once discipline,
same "map-backed, never throws" contract. Every task call is confined to this one file so that an
experimental API change has a one-file blast radius.

| Concern | Behaviour |
|---|---|
| Exactly-once | `takeForNotification()` + `notified` flag, identical to `bg-agent-registry` |
| Abort (`ctx.signal`) | `cancelTask(id)` — real upstream cancellation |
| Server process death | Task fails with exactly one notification; never a silent hang |
| `input_required` | Park + notify. NOT wired to `QuestionBroker` in this PR; that is the future elicitation path |
| Unknown/duplicate ids | No-op, never throws (registry contract) |

### Test story — zero new dependencies

The task-capable test server is built from the **same** `@modelcontextprotocol/sdk` package's
server half, already present via the 93-package install. `examples/server/simpleTaskInteractive.js`
ships in the box as a reference implementation.

## Packaging

`bun install` installs; `pnpm` orchestrates workspaces (CLAUDE.md). Therefore **both `bun.lock`
and `pnpm-lock.yaml` move together**, and `version-consistency.test.ts` must stay green.

## Testing

- Commit 1: all existing MCP test assertions unmodified — that is the proof.
  (`test/agent/mcp/client.test.ts` 63 lines, `manager.test.ts` 255, `mcp-resources.test.ts` 186,
  plus `engine-mcp.test.ts`.)
- Commit 1 additions: a paginated fixture (`tools/list` returning `nextCursor`) proving all pages
  are collected — the one defect whose fix is ours, not the SDK's.
- Commit 2: new cases for image/audio/`resource_link` passthrough and stderr capture.
- PR 2: task lifecycle — created, completed, failed, cancelled, server-death, exactly-once
  notification, abort -> `cancelTask`.
- `bun run verify:workflow` against the real compiled `dist/norma-core`, not just a probe.

## Risks

1. **v2 is the SDK's future** and has already deprecated the `2025-11-25` task vocabulary.
   Accepted: official codemod + side-by-side install make the hop manageable.
2. **Tasks are experimental** — the API can move under a minor bump. Mitigated by confining every
   task call to `task-registry.ts`.
3. **`bun --compile`** verified on a probe (0.51 MB, server stack tree-shaken); must be re-verified
   against the real artifact via `bun run verify:workflow`.

## Explicitly out of scope

- `tools/list_changed` live registry updates
- Elicitation / sampling wiring (`QuestionBroker` exists but nothing consumes MCP elicitation)
- Streamable HTTP / SSE transports (Norma is stdio-only today)
- Migrating `agent/lsp/client.ts`, which is the same hand-rolled pattern against a different
  protocol — the obvious next candidate if this lands well
