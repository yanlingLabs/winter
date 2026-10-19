# Cowork session door D3: the driver and the stand-in route seam

Status: draft PR, stacked on D2 (#89, D1 #88 merged in) and APPROVALS (#84, `876b1a630` merged in). Nothing here makes a Cowork session creatable or runnable in production. Every Cowork verb refuses `provider_unavailable` unless code injects four things: a provider route, a native starter, the image's runtime offer and an approval port. Production injects none of them, and nothing in `src` constructs the driver table.

## What D3 adds

| Module | Role |
|---|---|
| `cowork/conversation-set.ts` | The ONE builder of a conversation's entry in the incarnation's conversation set (design 2.3), and the policy encoding. |
| `cowork/runtime-channel.ts` | The supervisor's `GuestRuntimeChannel` over the native runtime class (mux class 2, conversation 0). Bytes only. |
| `cowork/approval-ports.ts` | The host ports the APPROVALS projection reads for one conversation: identity, a per-conversation `CoworkPolicyTransitionMachine` snapshot, `classifyPath`, `planViewInstalled`. |
| `cowork/session-driver.ts` | `createCoworkSessionDrivers`: the Cowork driver table (`CoworkSessionDrivers`), one `WinterSession` per conversation over the host agent SDK's own `query()`. |
| `cowork/repository.ts` | `binding()` refuses an outputs row typed (`unsupported_topology`). New: `conversationLocation`, `conversationBackend`, and the write-once `assignConversationBackend`. |
| `cowork/guest-runtime.ts`, `cowork/guest-query.ts` | The launch's mode is the guest's (default or plan). Bypass flags are literals. One shared `coworkGuestOfferedTools`. The cwd comes from the set builder. |
| `runtime-sdk/winter-session.ts`, `projector/types.ts`, `runtime-sdk/session-driver.ts` | `mode` is `DrivableSessionMode`. A Cowork session never attaches to the router directory. `messaging` is required for every runnable mode and absent for Cowork. |
| `cowork/service.ts` | `CoworkGuestStartPort.start(workspaceId, request?)` carries the conversation-set request, matching S7B's `CoworkNativeWiring` (#87). |
| `cowork/session-ports.ts` | `CoworkLegSession.coworkEpoch` (PEER-INBOX's `PeerEpoch`), `CoworkApprovalPort` input `cowork`/`cwd`/`turnOrigin`, `CoworkGuestRun.ended`, and `CoworkGuestStarter`. |

## The policy encoding (owner decision, option A)

The conversation set carries `policy: "plan"` for plan and `"ask"` for every other policy. The guest supervisor builds its runtime config from the set, never from the host query's Options. Its own map (agent SDK `linux-supervisor.py` `host_query_config`, at main `80bca246fdaf`, unchanged since `093fb3ea`) is `{auto: default, ask: default, plan: plan, accept-edits: acceptEdits, dont-ask: dontAsk, bypass: bypassPermissions}`.

So the guest runtime only ever runs `default` or `plan`. Under `default`, every call that is not built-in read-only reaches the host's `canUseTool`. There the APPROVALS projection applies the binding's real policy, which stays host-side in the binding and the transition machine. `bypassPermissions`, `acceptEdits` and `dontAsk` would resolve calls inside the guest without asking the host, and a host-query guest can run no host hook.

The host launch states the same mode: `coworkGuestPermissionModeFor`, `allowDangerouslySkipPermissions: false` and `disableBypassPermissionsMode: true`, all as literals. The driver refuses to run when the launch and the set disagree on cwd, tools, model or mode, and it stops the incarnation.

Pins:
- `conversation-set.test.ts` mirrors the SDK map verbatim with its citation. For all six policies it asserts that the guest runs `default` or `plan`, never a self-resolving mode, and that the launch mode is the same.
- `session-driver.test.ts` repeats this through a real start for every policy.

NEEDS (B), for the agent SDK supervisor lane: map every non-plan policy to `default` in `host_query_config`, so the set can carry the real policy (the guest-recorded policy reads "ask" today for a non-plan conversation).

## CONDITION: no auto-allowed read can reach a protected path

**Which reads are auto-allowed.** In the SDK evaluator, `default` and `dontAsk` auto-allow only two kinds of call (evaluator mode stage):
- built-in read-only calls (`isBuiltInReadOnly` is `isBashCallReadOnly || isReadWithinBounds`);
- the task class, which has no filesystem reach.

A sandbox auto-allow (`bashRunsSandboxed`) needs `autoAllowBashIfSandboxed` from settings. `host_query_config` sets `settingSources: []`, no sandbox settings, no `autoClassifier` and no `additionalDirectories`, so it never applies. That makes the Read bounds exactly the cwd, which is the root. Anything else is unresolved and goes to the host's `canUseTool`, where `classifyPath` decides (table below).

**Where those reads run.** Never in the runtime's own view:
- Read, Edit and Write run in `file-worker.c` ("MUST be launched in the caller's tool compartment, never as runtime/root").
- Bash runs in the process worker in the same compartment.

The compartment (`linux-tool-compartment.c`) works as follows:
1. It unshares the mount, IPC, UTS, network and PID namespaces and starts from a fresh tmpfs root.
2. It attaches ONLY the conversation's roots, plus `/run/winter/shared-instructions` and the `WINTER.md` alias in guided mode only.
3. In process mode it adds:
   - `bin`, `lib`, `lib64` and `usr` from `/opt/winter/environment/base` (immutable pinned package bytes, `image.py`);
   - a private `/tmp`;
   - a private `/proc` in its own PID namespace;
   - a minimal `/dev`, and `/dev/shm`.
4. Finally it remounts read-only, chroots, drops capabilities and runs as `toolUid`.

**What the roots are.**
- **The builder.** It sends exactly one root, and its `source` IS its `guestPath`: the source's canonical guest root plus the binding's relative cwd (`/workspace/folders/<grant>` or `/workspace/repos/<id>`, below).
- **The native wire validator** (`native/protocol.ts` `conversationOf`, the supervisor's own rules mirrored) refuses:
  - any view outside folders, repos, memory and the conversation's own scratch and outputs;
  - for host-query, anything at or under `/workspace/.winter`;
  - nested roots, and a writable root under plan.
- **The guest** refuses the same in `host_query_config` (`host_query_roots`).

| Protected item | Reachable by an auto-allowed read? | Evidence |
|---|---|---|
| This conversation's SDK store `/workspace/.winter/conversations/<sid>` | No: not mounted in the compartment; only the runtime process (not a tool) sees it | compartment mounts roots only; `.winter` refused as a root (test `CONDITION`) |
| Other conversations' stores `/workspace/.winter/conversations/*` | No: not mounted | same |
| Run homes `/run/winter/conversations/<sid>`, the provider socket `.control/provider.sock` | No: not under `/workspace`, so never a root; the compartment has no `/run` | wire validator refuses non-`/workspace` roots (test) |
| `.winter` skeleton, memory, `WINTER.md`, every scratch | No for host-query: `.winter` is never a host-query root | test; `host_query_roots` |
| Other conversations' outputs `/workspace/outputs/<other>` | No: refused as a view (allowed views are the conversation's OWN outputs only) | test; and denied for every tool by `classifyPath` (O1) |
| The workspace's other sources, the source above the cwd | No: not attached (one root, the cwd itself) | builder test |
| Supervisor config, control, environment and artifacts directories | No: not roots; `source_directory` refuses overlap with them | supervisor |
| The runtime process's memory, `/proc/<runtime>` | No: private `/proc` in the tool's own PID namespace | compartment |
| The Mac host, the network | No: no NIC, no vsock route, network namespace unshared | compartment; design |

Fine and recorded:
- Auto-allowed reads of OS files. They are the environment base's immutable, pinned package bytes, mounted read-only.
- Auto-allowed reads of the conversation's own outputs and scratch, once mounted (D3b).
- An out-of-bounds Read is not auto-allowed: it reaches the host, which classifies it.

**Findings:**
- **NEEDS, guest lane and S7B:** a root's `source` is not checked against the allowed views. The guest checks the guest path against its allowed views. It checks `source` only for symlinks and for overlap with its own supervisor, environment and artifact directories (`source_directory`); it does not check `source` against the allowed views or `.winter`. The host builder always sends `source === guestPath` (pinned by test). Even so, a host bug could mount a protected directory under an allowed `guestPath`. Ask that the guest supervisor and `native/protocol.ts` `conversationOf` require `source` to pass the same view rule, or simply require `source === guestPath`.
- **Not executed here:** the compartment is cited from the SDK's C source, not run. D5's real-host run is the execution proof.

`classifyPath` (the host's class for a guest path the projection resolved; pinned by `approval-ports.test.ts`):

| Path | Class |
|---|---|
| the conversation's root and below; `/workspace/.winter/memory` and below | `admitted` |
| `/workspace/.winter/WINTER.md` | `shared-instructions` |
| `/workspace/outputs/<own sid>` and below | `outputs` |
| `/workspace/.winter/scratch/<own sid>` and below | `scratch` |
| everything else under `/workspace/.winter`, `/workspace/outputs`, `/run/winter`; `/workspace` itself; a relative or NUL path | `protected` |
| anything else (the rest of the source, other sources, the OS) | `outside` |

Through the real approval bridge, under every policy including bypass:
- a protected path or another conversation's outputs is denied for Read and Write;
- bypass runs a write to its own source;
- plan denies one.

## The host-query guest's inbound frames

The agent SDK's `linux-host-query-profile.ts` `checkLinuxHostQueryFrame` (main `80bca246fdaf`) accepts:
- `user` text that does not begin with `/`;
- `control_request` `end_input` or `interrupt` with an EMPTY payload;
- closed permission answers: `{behavior: "allow", updatedInput}` or `{behavior: "deny", message, interrupt?}`.

Anything else is a guest refusal that ends the runtime. The driver keeps every such frame off the link:

- **Answers are cut to the closed shape.** The approval bridge returns `decisionClassification` and, after a saved-rule option, `updatedPermissions`. The guest would refuse both (`coworkGuestPermissionAnswer`).
- **Refused on the host, typed `unsupported_topology`:**
  - model, policy and compaction changes;
  - `interrupt`. The host SDK's `Query.interrupt()` sends `{scope: "turn"}`. NEEDS, agent SDK lane: accept that payload, or send none.
- **Refused `invalid_request`:** slash-leading text, images and files.

The scripted guest in `session-driver.test.ts` checks every inbound frame with a copy of the profile's own check. The suite asserts the guest refused nothing, including after a human allow and a human deny of a card.

## Driver behaviour

- **`ensure` refuses typed, never silently fresh:**
  - an outputs row: `unsupported_topology`;
  - a recorded backend identity with no live driver: `cold_resume_unavailable`. The guest store exists, and cold resume is D10.
  - an uncertain workspace: `recovery_required`;
  - a running guest, or another live conversation in the workspace: `conversation_limit` (N2: one host-query conversation per guest);
  - shutdown: `daemon_shutting_down`.
- **The guest starts at the conversation's first open.**
  1. The native start asks for the set once, at `mounted`.
  2. The set is built.
  3. Only then is the backend identity recorded (write-once).

  A set refused before it was sent surfaces its own typed refusal, records nothing and leaves the conversation startable. That test injects a route whose selection names another model.
- **One incarnation per driver.** When the run ends, the driver closes. Its handle then refuses `send`, `deliver` and `open` with `cold_resume_unavailable`, before anything reaches the log.
- **The `system/init` check.** A guest whose `system/init` offers a tool the launch withheld is refused with `tool_surface_unenforced`, and its incarnation is stopped. This uses `WinterSession`'s existing check.
- **Shutdown.** `evict` stops the run with `user`. `beginShutdown` stops every run with `shutdown` and never rejects.
- **Never idles out; never enters the router directory.** `idleTimeoutMs` is Infinity, and `attachMessaging` returns for Cowork.
- **The runtime adapter is the agent SDK's own `query`.** No router selection, no run home, no messaging. `WinterSession` otherwise calls `runtime.sdk.query`, the router's query, which production builds with `requireRunHome: true`.
- **The stand-in route is a seam production never supplies.** Its kind is `scripted-standin`. A route plan may describe the selection, but it may not change the scope or the model, and it may carry public metadata only. Nothing here uses the provider class (mux 3) or the network.

## Spec gaps

- **G3/shares:** the prompt promises workspace memory, but a host-query guest cannot see `/workspace/.winter/memory`. The host-query view excludes `.winter`. `classifyPath` calls memory `admitted`, but it is not mounted.

## NEEDS FROM OTHER LANES

- **Agent SDK supervisor lane:**
  - (B) map non-plan policies to `default` (or accept the real policy and run `default`);
  - accept the host SDK's `interrupt` payload `{scope: "turn"}`;
  - check root `source` like `guestPath`.
- **APPROVALS (#84):** widen `CanUseToolDeps.mode` to `DrivableSessionMode` (from `sessions/session-mode.ts`). The DOOR's port adapter then passes `mode: "cowork"`; it lands in D4's door composition. Until then the tests pass `mode: "code"` with `cowork` set, which only those tests do. The port's input carries `cowork`, `cwd` and `turnOrigin`. Its return is the bridge's own `CanUseTool & {withdrawPending}`, and its `emit` returns void, both as the real bridge does. Design section 7.5's older sketch (`emit` returning `SessionEvent`, `withdrawPending` in the input) is superseded. The pins `cowork-approval.test.ts` and `policy-transition.test.ts` were updated in this branch (see the PR body for the exact diff).
- **S7B (#87):** the twin pins land with whichever merges second (exact lines in the PR body):
  - `CoworkNativeWiring` is assignable to `CoworkGuestStarter`;
  - `CoworkGuestRuntimeLink` and `CoworkNativeRuntimeLink` are assignable both ways;
  - `CoworkGuestRun` is satisfied by `CoworkNativeRunning`;
  - `COWORK_HOME_BINDING_DDL === COWORK_HOME_BINDING_TABLE`.

  Also: check root `source` in `conversationOf`.
- **File channel (#91), later:**
  - `CoworkGuestRuntimeLink.files`;
  - root ids as location ids (the builder sends the source id today);
  - a synchronous authority composition.

## Owner decisions

1. **The backend identity is recorded at `mounted`.** It is recorded when the guest receives the set, not when the runtime is ready. So a boot that faults after `mounted` but before `runtime_ready` leaves the conversation permanently `cold_resume_unavailable`. Recommendation: accept. The guest may have created its store, and resuming without D10 would be a silent fresh start.
2. **`interrupt` refuses typed in D3.** A user cannot stop a running guest turn until the agent SDK lane accepts the host SDK's `{scope: "turn"}` payload. Ending the conversation still stops the incarnation. Recommendation: accept for D3 (nothing is reachable in production), and fix in the SDK lane before D5.
3. **Slash-leading text refuses `invalid_request`.** It is not escaped. Recommendation: accept. Rewriting the user's text would change what they asked.
4. **`ensure`'s outputs check is redundant.** It duplicates `CoworkRepository.binding()`'s own refusal (the mutation survivor below). Recommendation: keep it as the driver's stated intent for D3b, where `binding()` widens.

## Tests and mutations

New suites:

| Suite | Tests |
|---|---|
| `conversation-set` | 7 |
| `runtime-channel` | 7 |
| `approval-ports` | 3 |
| `session-driver` | 15 |
| `conversation-backend` | 2 |

Changed suites:

| Suite | Tests |
|---|---|
| `session-ports` | 4 (15 compile-time pins) |
| `session-door-off` | 14 |
| `guest-query` | 19 |
| `guest-runtime` | 38 |
| `policy-transition` | 24 |
| `session-profile` | 138 |
| `cowork-approval` | 22 |
| `winter-session` | 85 |

`test/cowork`, `test/runtime-sdk`, `test/projector`, `test/ipc` and `test/sessions` all pass, and so does `bun run typecheck`.

Mutations: 53 mutants, 52 killed. They cover:
- the encoding and the set builder (15);
- the path table and the ports (7);
- the runtime channel (8);
- the driver's refusals, answers, verbs, drain window, retry, agreement, close and shutdown (19);
- the supervisor and query mode (2);
- the messaging requirement (1);
- the write-once repository (2).

The one survivor is equivalent: the driver's outputs-row check (owner decision 4).
