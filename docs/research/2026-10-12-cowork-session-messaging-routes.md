# Cowork session messaging route audit

This is a source audit of the Project messaging integration on 2026-10-12. It
does not demonstrate a guest runtime, worker launch, delegation, or complete
Cowork end-to-end execution. The normative matrix remains
`docs/cowork-execution-contracts.md:97` and the RPC inventory remains
`docs/cowork-host-protocol.md:97`.

## Caller binding and implemented discovery gate

Runtime host messaging derives the caller from the incarnation closure in
`packages/core/src/runtime-sdk/session-driver.ts:1879`, attached to the final
Options at line 1275. SendMessage/ListAgents/TaskStop requests do not select a
sender. Capability tools derive their caller from the per-session server:
`packages/core/src/capabilities/server.ts:274` constructs ToolContext with the
host-owned session ID at line 287, overriding context extras.

ListSessions now takes that ToolContext and calls the same live authority gate
as SessionMessaging before activity, count, query, or path projection:
`packages/core/src/agent/tools/list-sessions.ts`. Production wiring is
`packages/core/src/daemon.ts:1411`. Cowork discovery returns IDs, titles,
activity and dates; it omits host cwd/transcript paths and does not search the
first-message or edited-files indexes. The optional legacy fallback only allows
known host Code/Dispatch callers to discover non-Cowork targets.

`packages/core/test/agent/list-sessions.test.ts` covers scoped filtering before
metadata reads, counts and query ranking; caller identity comes from context
despite injected arguments; policy is read on each call; Cowork path/content
redaction; and missing-authority refusal. The focused run passed 25 tests with
118 assertions. This evidence is separate from broader integration gates.

Combined scoped validation after the canonical-mode review correction passed
85 tests with 400 assertions across `test/agent/session-messaging.test.ts`,
`test/agent/list-sessions.test.ts`, `test/cowork/session-messaging.test.ts` and
`test/cowork/repository.test.ts`. The added regression proves that a stale
session-index mode cannot downgrade a canonical Cowork binding to broad host
authority; a canonical record failure also refuses send, list and stop instead
of selecting host compatibility behavior.

## Remaining routes and concrete integration points

| Route | Current source and authority | Required integration |
| --- | --- | --- |
| ListSessions aliases | `capabilities/sessions.ts:41`, `runtime-sdk/mode-options.ts:94`, shared `tools/list-sessions.ts` definition | Keep one definition and one caller/target predicate. Cowork tool availability is still absent; do not enable it through an alias alone. |
| Indexed session files and first message | `sessions/store.ts:608` and `:615`; no separate RPC; ListSessions query was the consuming agent route | Cowork discovery deliberately skips these indexes. Add a guest-safe metadata projection before any future file search. |
| Raw transcript path/read | `sessions/store.ts:500` and `:888` place logs at `<home>/sessions/<scope>/<sessionId>.jsonl`; `sessions/history.ts:199` reads pages | Before storing guest events as supported sessions, prevent raw host agent file reads of Cowork logs and provide a caller/target-authorized transcript/output port. Preserve ordinary host Code transcript reads. |
| User history and live stream | `ipc/server.ts:2326` (`session.history`), `:2246` (`session.attach`), remote guard `:832` | Extend the authenticated user workspace gate, including stream delivery rechecks. Never use runtime peer authority as paired-user authority. |
| `thread.list` | `ipc/server.ts:3566`; `daemon.ts:2197` creates the thread view from the owning session roster | Remains a local user-control RPC. If exposed to a guest runtime, bind a runtime principal outside params and gate before reading roster metadata. |
| `thread.send` and `agent.stop` | `ipc/server.ts:3579` and `:3586`; `runtime-sdk/children-rpc.ts:45` resolves only within the supplied owner's registry/facet | Remain local user-control RPCs. A runtime alias must verify owner/descendant authority before name resolution and cold resume; the supplied `sessionId` is a target owner, never caller identity. Same-Project membership does not grant sibling stop authority. |
| Dispatch SpawnSession | `agent/dispatch-children.ts:314`; caller mode checked at `:326`, Cowork refused at `:328`; tool context at `tools/session-spawn.ts:59` | Keep Cowork unsupported until an existing authorized workspace, explicit delegation, source readiness, policy ceiling and guest topology can be enforced together. A `dir` string cannot grant a workspace. |
| SDK own-child tools | Runtime owns descendant roster and child facets; daemon mirrors at `runtime-sdk/children-rpc.ts` and `agent/bg-agent-registry.ts` | Future guest supervisor must authenticate logical child identity and its restrictions. Do not claim top-level SessionMessaging implements guest descendant confinement or durable cold continuation. |

The socket authenticates a role token (`auth/tokens.ts:36` and
`ipc/server.ts:2047`), while ConnState (`ipc/server.ts:172`) has no runtime
session principal. Harness/Admin are user-control roles; Remote and Plugin use
method allowlists. `clientName`, a parameter session ID and hub attachment do
not authenticate an agent caller. Current child-control RPCs are not on remote
or plugin allowlists. `agents.list` at `ipc/server.ts:3081` lists agent
definitions, not the ListAgents runtime peer roster.

No guest toolport implementation is present in this checkout. The smallest
coherent future surface is a host-created runtime principal, bound to session,
incarnation and logical descendant, plus a common operation-specific
caller/target gate used by messaging, discovery, transcript/output, stop and
spawn ports. Forwarding guest requests to the local socket as Harness would
discard that authority boundary. User RPCs retain their separate authenticated
user authorization and workspace projection path.

## Host-only schema and startup follow-up

Fresh and legacy-v7 host-only homes now have an explicit messaging regression:
the writable runtime-state open applies the Cowork schema before SessionMessaging
construction, no Cowork rows exist, and ordinary host Code messaging/stop still
works. Unexpected canonical-store failures emit one nonsecret
`session_authority_unavailable` diagnostic per service lifetime while access
remains refused. Startup before the messaging service exists reports a retry
error rather than claiming an empty ListSessions inventory.
