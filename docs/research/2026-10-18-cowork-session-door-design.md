# Cowork session door: design (no code)

Status: DESIGN ONLY, 2026-10-18, DOOR lane, Phase 0. Nothing in this document is built, and no code changes with it. `session.create {mode: "cowork"}` still answers `unsupported_topology` for every role, and nothing here changes that. The base is `cowork/output-integration` at `8b52ef83`. The sibling repositories were read at `yanlingLabs/winter-agent-sdk@68e57c64` (main) and `yanlingLabs/winter-runtime-sdk@5c762d2b` (main). Sections 1 to 9 answer the nine questions of the DOOR brief, in its order. Section 0 is the summary. Section 10 lists what this lane needs from other lanes, section 11 the owner decisions, and section 12 the docs owed.

## 0. Summary

1. A Cowork turn is the existing host `query()` driving a guest runtime over the native runtime streams. The agent loop runs in the guest; the host projects its SDK messages into `SessionEvent`s exactly as today. This reuses `WinterSession`, the projector and `buildCoworkGuestQueryOptions` (`cowork/guest-query.ts`).
2. Cowork gets its own driver table beside Code's, keyed by stored mode. `cowork` stays out of `RunnableSessionMode`. A new `DrivableSessionMode` admits it only where the session is driven (`WinterSessionDeps.mode`, `ProjectorDeps.mode`), never where host `Options`, prompts, tool lists or run homes are built.
3. The router needs no Cowork `RunMode` and no runtime-sdk release. A Cowork session never calls `selectRuntimeFor`, `buildRunHome` or the router's messaging attach; the guest supervisor builds the run home, and the provider selection is a host decision carried as public metadata.
4. The tool list and the prompt both come from `coworkOfferedTools`. The guest profile `host-query-v1` admits only `Read`, `Write`, `Edit` and `Bash`, an empty `mcpServers` and no system-prompt key, so the first session offers at most those four tools, builds no `winter__<key>` server, and cannot deliver the Cowork prompt.
5. N2 carries one host-query conversation per guest, a conversation set fixed for the incarnation, no virtio-fs and no network. So the first session is one conversation per running workspace, with no Mac folder mounted and no cold resume.
6. **Blocker A:** no workspace source can honestly become `ready` in N2, and `bindConversation` requires a ready source. The first session needs an owner decision on its working root (section 9, G1).
7. **Blocker B:** the scripted stand-in's answers have no legal home under the current rules. In the guest, it needs a test-only image that serves `provider.sock` (an image build). On the host, it needs mux class 3, which is the provider bridge's transport. Both are outside this lane. I stopped that part and report it (section 5).
8. The stand-in's *selection* is host-side and in this lane: an injected `CoworkProviderRoute` that production never supplies. With no route, creation and sends refuse `provider_unavailable`.
9. Provisioning becomes an injected `CoworkProvisioningPort` that S7B's production environment supplies. `requireProvisioning` stays a refusing gate until it exists, and `workspace.capabilities.get` reports what that port says.
10. A standalone workspace reserves its conversation id in the store's `s_<12 hex>` shape (today it is `session_<uuid>`, which can never match), and `session.create` binds exactly that reservation.
11. The single activation switch is the presence of the `CoworkSessionDoor` port in `startIpcServer`'s options. Today nothing constructs it. The flip is the one `daemon.ts` line that constructs it, which is a cross-lane edit.
12. The off-test runs a production-shaped daemon against a fixture workspace with a ready source and checks every role and every side effect. It is paired with a positive control through an injected door.
13. The spine (section 7) is the protocol fields, the new error codes, `cowork/session-ports.ts` (types only), the runtime-link seam on the native host, and the provisioning, approval and provider ports.
14. The slices are D1 spine, D2 tool surface, D3 driver and stand-in selection, D4 provisioning and CLI create, D5 end-to-end with fakes, and D6 the flip. D1 and D2 can run in parallel, and so can D3 and D4.
15. Eleven spec gaps are listed with recommendations (section 9). Blockers A and B and the host/guest SDK version pairing (G8) gate a real VM session. Prompt delivery (G3) gates the flip. None of them gates D1 to D5.

## 1. Creation path

### 1.1 What exists today

| Step | Code | What it does now |
| --- | --- | --- |
| Workspace creation | `cowork/service.ts` `CoworkWorkspaceService.execute`, case `workspace.create`/`project.create` | Validates, replays, then calls `this.host.requireProvisioning(principal)` before `records.create`. |
| The provisioning gate | `CoworkHostPorts.requireProvisioning` (`cowork/service.ts`); `disabledCoworkHost` and `createMacCoworkHost` (`cowork/mac-host.ts`, which spreads `disabledCoworkHost`) | **It provisions nothing.** It is a gate that throws `CoworkError("unsupported_topology")` in every production daemon, so no workspace can be created there. It is also called before `workspace.source.addFolder`/`addRepository`. |
| Capability report | `execute`, case `workspace.capabilities.get` | Hard-coded `repositoryPreparation: false, provisioning: false, execution: false`. |
| Workspace record | `cowork/repository.ts` `CoworkRepository.create` | Mints `workspaceId`, and an `ownerId` of `session_<uuid>` (standalone) or `project_<uuid>` (Project). Writes the workspace, its policy, its sources (state `preparing`) and an operation/outbox entry. No storage is allocated and no image is pinned. |
| Conversation binding | `CoworkRepository.bindConversation` | Requires a committed session index row (`CoworkCommittedSessions.hasCommittedSession`), then refuses unless the source is `ready` and `desired: "present"`. For a standalone workspace it also requires `sessionId === ownerId`. Nothing in `src/` calls it. |
| Session row | `sessions/store.ts` `SessionStore.createSession` | Mints `s_<12 hex>` and throws `CoworkError("unsupported_topology")` for an unrunnable mode. |
| Session door | `ipc/server.ts`, case `METHODS.sessionCreate` | `isUnrunnableSessionMode(p.mode)` refuses first, through `coworkSessionUnsupported()`, before any model resolution, row, run folder or child. `createSessionInternal` (the transaction behind `session.create` and `SpawnSession`) is typed so `cowork` cannot reach it. |
| Driver start | `runtime-sdk/session-driver.ts` `createWinterSessionDrivers` (`refuseUnrunnableMode`, `modeOf`) | Refuses a stored `cowork` row with `unsupported_topology` at `create`, `resume` and `ensure`. |
| Native start | `CoworkWorkspaceService.startNative` → `CoworkGuestStartPort.start(workspaceId)` → `cowork/native-wiring.ts` `CoworkNativeWiring.start` → `cowork/native/host.ts` `CoworkNativeHost.start` | Reachable from no RPC. The port is injected only when `startDaemon` gets `opts.coworkNative.environment`; production passes none. |
| Source readiness | `CoworkRepository.acknowledgeSource(epoch, …)` | **Nothing in `src/` calls it.** No source can ever become `ready` (see section 9, G1). |
| CLI | `packages/cli/src/cowork-cli.ts` | Workspace and Project metadata commands only. There is no session command. |

### 1.2 The designed path (D4, behind the door)

```
Mac composer / CLI
  │ workspace.create {ownership, title, selections}      (standalone, or project.create)
  ▼
CoworkWorkspaceService.execute ─ host.provisioning.admit(principal)   ← CoworkProvisioningPort (S7B); absent → unsupported_topology
  │ records.create(...)        workspace + policy + sources(preparing) + outbox, standalone ownerId = s_<12 hex> reservation
  │ host.provisioning.provision(workspaceId, operationId)    after COMMIT: allocate data/env images (backup excluded), pin images,
  │                                                            create shared dirs; reported through workspace_operation_changed
  ▼
session.create {mode:"cowork", cowork:{workspaceId, location, requestId}}
  │ ipc/server.ts: no door → coworkSessionUnsupported()  (TODAY, and until D6)
  │ door present → CoworkSessionDoor.create(input, caller)
  ▼
CoworkSessionDoor.create
  1. route = deps.provider; absent → CoworkError("provider_unavailable"), nothing written
  2. resolve workspace; standalone: sessionId = workspace.ownerId (must not exist yet); project: fresh s_<12 hex>
  3. store.createSession({mode:"cowork", reservedSessionId, approvalPolicy: workspace default, model: route.model})
  4. records.bindConversation(context(requestId), workspaceId, {sessionId, location}, store)
     on throw → the existing createCoworkSessionDeletionHook rollback deletes the row (as the session.create refusal rollbacks do)
  5. return {sessionId}; nothing boots here
  ▼
first session.send → section 2
```

Rules:

- **Order: store row, then binding, then any incarnation.** `bindConversation` needs the committed index row, and the conversation set is read from the binding at `mounted`.
- **The reservation id.** Today `CoworkRepository.create` mints `session_<uuid>`, so the standalone check `current.ownerId !== normalized.sessionId` can never pass for a store-minted `s_<12 hex>`. D4 mints the reservation in the store's shape (an injected minter in `repository.ts`). It also adds a `reservedSessionId` option to `SessionStore.createSession`, accepted only with `mode: "cowork"` and only when the id is a live reservation with no row. Production has no standalone rows to migrate, because `requireProvisioning` refused every creation.
- **No Mac cwd.** A Cowork row stores `cwd: null` and `dirs: []`. The binding's location is the only working-directory fact, and `session.setCwd`/`setDirs` stay Code-only (`docs/cowork-host-protocol.md`).
- **Policy.** The binding's policy is canonical (the workspace default at bind time). The store's `approval_policy` column mirrors it for display only.
- **Model.** It is fixed by the provider route. `session.setModel` keeps refusing a `cowork` row (`handoff.ts` `planAndApplySwitch`).
- **Remote.** A paired client cannot create a Cowork session until the remote set and the per-record gates exist. `REMOTE_ELIGIBLE_SESSION_MODES` is unchanged.

**What `requireProvisioning` should mean (D4).** It becomes `host.provisioning?.admit(principal)`, refusing `unsupported_topology` when the port is absent. It is an admission check only: the port is present, the principal is a local user, the native environment is built, and the pinned guest image is installed and verifiable. The effects run after COMMIT in `provision()`. The native `CoworkVolumeAuthority` refuses `allocate` ("provisioning is not on the launch path", `docs/cowork-native-worker.md` section 10), so `provision()` needs its own allocate authority from S7B. `workspace.capabilities.get` then reports `provisioning: !!host.provisioning?.available()` and `execution: !!door`, never a constant.

**CLI (D4).**

- `winter cowork session create --workspace <id> [--source <id> --cwd <relative>] [--request-id <id>]` calls `session.create {mode:"cowork", cowork:{…}}` and prints the session id.
- `winter cowork session list --workspace <id>` filters `session.list` by the new `cowork.workspaceId`.
- Sending uses the existing session commands (`-p`, attach) by session id.
- The commands refuse with the daemon's typed code. Until D6 that code is `unsupported_topology`.

## 2. The session driver

### 2.1 What runs where

```
host (winter-core)                                                                   guest (Linux VM)
WinterSession ── query(options) ── spawnClaudeCodeProcess ── CoworkGuestRuntimeSupervisor.prepareQuery(sid).spawn()
   ▲                                                                │ GuestRuntimeSupervisorPort.open(launch)
   │ SDK messages                                                   ▼
projector ──► SessionEvents       GuestRuntimeChannel adapter (NEW, D3) ◄─► CoworkGuestRuntimeLink (NEW seam; CoworkNativeHost implements it)
   │                                         runtime class 2, conversation 0, IN / OUT / ERR
   ▼                                                                │ L1 mux_down/mux_up → launcher → worker → virtio-console
log + hub                                                           ▼
                                                     PID 1 relay → linux-supervisor.py → winter-host-query (runEmbeddedSession)
                                                                                          └─ provider: <home>/.control/provider.sock (section 5)
```

The guest entry is the agent SDK's `packages/runtime/src/guest/linux-host-query-main.ts`, compiled into the image as `/opt/winter/runtime/winter-host-query`. It runs `runEmbeddedSession` over the SDK's own frame codec (`decodeFrame`), so the host side is the ordinary SDK `query()`. `test/cowork/guest-query.test.ts` already drives the pinned `query()` and the real projector through a scripted `GuestRuntimeChannel` and gets the right `SessionEvent` sequence. D3 keeps that composition and replaces the scripted channel with the native one.

### 2.2 A turn, step by step

1. `session.send(sessionId, text)`. For a stored `cowork` row, `ipc/server.ts` routes to `door.drivers.ensure(sessionId)` instead of the Code table. The Code table keeps refusing a `cowork` row (`refuseUnrunnableMode`), and that refusal is pinned.
2. `CoworkSessionDrivers.ensure` (new `cowork/session-driver.ts`):
   - Refuse unless the binding is `active` and a provider route is present (`provider_unavailable`).
   - Then branch on the workspace's power:
     - **`stopped`.** Register this conversation as the incarnation's set and call `native.start(workspaceId, {conversations})`. The `conversations` callback runs at `mounted` and returns one host-query conversation (section 2.3). The start resolves after `runtime_ready`, which the host waits for, up to 60 s.
     - **`running` and serving this conversation.** Reuse the live driver.
     - **`running` and serving another conversation.** Refuse `conversation_limit`. This is the N2 limit of one host-query conversation per guest (`docs/cowork-native-worker.md` section 6.1). It is a refusal, not a queue.
     - **`starting`, `draining` or `uncertain`.** Refuse `recovery_required` with the power state as the reason, or wait for an in-flight start this driver began.
3. The driver builds a `WinterSession` with:
   - `mode: "cowork"`, typed `DrivableSessionMode`;
   - `options: () => buildCoworkGuestQueryOptions(supervisor, sessionId, {canUseTool, abortController})`;
   - a projector created with `mode: "cowork"`;
   - a `messaging.attach` that attaches nothing (no router directory entry; section 3);
   - the runtime SDK only for `trackQuery`/`untrack`, so shutdown ordering is unchanged.
4. `prepareQuery` admits the canonical launch (binding, epoch, source, capabilities, boot id) and `spawn()` opens the channel. `GuestRuntimeSupervisorDeps` gets:
   - `identity(sessionId)`, which returns `{backendSessionId, model, resume}` from the binding row (section 7.3);
   - `bootId(workspaceId)`, the guest boot id the `conversations` callback received;
   - `runtimeCapability`, from the native environment's guest offer, never a constant in DOOR code;
   - `port: { open: launch => runtimeChannel(link, launch) }`.
5. The user's text goes down IN as a `user` frame. The guest runtime calls its provider (section 5) and streams SDK frames up OUT.
   - The host `query()` yields SDK messages, and the projector turns them into `turn_started`, `assistant_message`, `tool_call`, `tool_result`, `turn_completed`, and so on. `WinterSession` appends them to the log and broadcasts them.
   - ERR is carried, not dropped. It goes to the session log line sink, bounded, and never into the transcript.
6. **Approvals.** The guest's only permitted outbound control subtype is `permission` (`engine.ts` `allowedSubtypes: ["permission"]` for `host-query-v1`).
   - It reaches the host `canUseTool`, which is the APPROVALS lane's Cowork bridge (section 7.5). Cards are keyed by `callId` on the conversation's own log.
   - The answer goes down IN as a `control_response`.
   - A revoked grant withdraws the pending card first, as in the existing `guest-query.test.ts` case.
7. **Flow control.** The channel adapter enforces the contract's host rule: at most 1 MiB of IN payload in flight with no OUT/ERR bytes back (`COWORK_NATIVE_LIMITS.runtimeInFlightBytes`), sent in chunks of at most 256 KiB. `CoworkNativeRuntimeStreams` is the shared state machine.

### 2.3 The conversation set entry

One function, `coworkConversationFor(binding, workspace, epoch, guestBootId, route, offer)`, builds both:

- the native `CoworkNativeConversation` sent at `mounted`;
- the `GuestRuntimeLaunch` that `CoworkGuestRuntimeSupervisor` admits.

A test asserts that the two agree on session ids, cwd, policy and permission mode, model, roots and tools/toolClasses. Today they are built in two places (`guest-runtime.ts` `descriptor` and nothing on the native side), which is exactly where drift would start.

| Field | Value |
| --- | --- |
| `logicalSessionId` | the Winter session id (`s_<12 hex>`) |
| `authority` | `{workspaceId, sessionId: backendSessionId, incarnationId, leaseEpoch, configRevision, grantRevision, policyRevision}` from `refreshEpoch` and the policy |
| `runtimeUid`, `toolUid`, `workspaceGid` | fixed host picks for index 0 inside 1000 to 65533, with the gid equal to neither uid |
| `policy` | `binding.policy` |
| `roots` | the binding's location as one root (section 9, G1), read-only under `plan` |
| `runtime` | `{model: route.model, timeoutMs, toolClasses: classes of the offered guest tools (section 4), provider: route plan, guided: null}` |
| profile | `host-query-v1` (Track A's `host-query-guided-v1` comes later) |

### 2.4 Resume, stop and end

- **Within one incarnation.** `ensure` returns the live driver, and a reattach replays the host log as today. N2 starts the runtime once per incarnation and the set cannot be re-sent. The supervisor's `launch_runtime` refuses `runtime_fresh_only` unless the runtime is still `configured` (agent SDK `linux-supervisor.py`). So the driver must not end the guest runtime while the conversation may continue. For Cowork the driver therefore never arms the idle end. It passes `idleTimeoutMs: () => Infinity`, which `WinterSession.armIdleTimer` treats as "arm nothing" (`!Number.isFinite(ms) || ms <= 0` returns before `timers.set`; a test pins that guard). Normally the setting-driven `idleTimeoutSec` ends an idle child. This stays until cold resume exists.
- **Interrupt.** `session.interrupt` goes to `WinterSession.interrupt`, which sends the SDK `interrupt` control request down IN. TaskStop is not offered (section 4).
- **End.** Archive, delete, `evict` or daemon stop runs `endInput` and waits for the runtime's stream ends. Then it calls `native.stop(workspaceId, reason)`, because the guest serves only this conversation. Only a valid orderly receipt releases the disks (existing D1 policy in `native/recovery.ts`). The channel's `termination` resolves `confirmed-stopped` with `storeOwnerReleased: true` only from that release; anything else leaves `uncertain`.
- **After a stop: no cold resume in N2** (D10; `docs/research/2026-10-17-cowork-n2-guest-boot.md` section 10). The next `session.send` refuses `cold_resume_unavailable`, visibly. It never starts a fresh conversation silently and never resumes without the guidance load the spec requires on resume. When cold resume lands, `identity().resume` becomes true for a conversation whose host log has a completed turn, and the next incarnation passes `resume: backendSessionId`.
- **Automatic cold stop** after two minutes of quiescence is not wired in the first version. It would end the only runtime and turn every idle conversation into `cold_resume_unavailable`. It waits for cold resume (owner decision O4).
- **Daemon stop.** `daemon.stop()` drains the Cowork table (`beginShutdown`) before `coworkNative.beginShutdown()`, so no turn is mid-flight when the guests drain (section 10, a `daemon.ts` item).

## 3. The runtime-sdk `RunMode` question

**Answer: no router change and no runtime-sdk release, for the first session or for v1.** `RunMode` (`src/run-home/types.ts`: `"code" | "dispatch" | "chat"`) is read in three places, and a Cowork session reaches none of them:

| Router entry | Where Winter calls it | Why Cowork never does |
| --- | --- | --- |
| `SelectionInput.mode` (`src/selection/runtime-selection.ts`) | `runtime-sdk/create.ts` `selectRuntimeFor`, from `session-driver.ts` `decideRuntime` | The guest runtime is fixed: the image's `winter-host-query`. The model and provider are the provider route's public metadata (section 5), so there is no runtime row to select. |
| `buildRunHome` mode check (`src/run-home/build.ts`, line 134) | per-run folders under `<home>/sdk` | PID 1 materializes the guest run home `/run/winter/conversations/<sid>`, and `buildCoworkGuestQueryOptions` already says guest run homes "never [belong] to the ordinary host run-home builder". |
| `messaging/winter-adapter.ts` (`runHomeFor({mode: entry.mode as RunMode})`) | `WinterSession.attachMessaging` → `deps.messaging.attach(runtime, {mode})` | The Cowork driver passes an attach that registers nothing. Same-Project messaging goes through the host peer inbox (PEER-INBOX lane), not router mailboxes. |

The costs, written down so nobody trips on them:

- **`cowork` stays out of `RunnableSessionMode` permanently.** The new `DrivableSessionMode = RunnableSessionMode | "cowork"` is admitted only by `WinterSessionDeps.mode`, `ProjectorDeps.mode` (a debug line today) and the Cowork driver. Every `Options`/prompt/tool/run-home builder keeps `RunnableSessionMode`, and a compile-time pin in `sessions/session-mode.ts` keeps it that way.
- **No `mode: "code"` stand-in anywhere in `src/`.** `guest-query.test.ts` passes `mode: "code"` to `createProjector` and `canUseToolFor` as a test harness. Doing that in the driver would be the silent Code mapping `session-mode.ts` forbids. The projector takes `"cowork"`, and the approval bridge takes the APPROVALS port.
- **A pin test.** A fake `WinterRuntimeSdk` whose `selectRuntimeFor`, run-home and messaging members throw proves a full Cowork turn never calls them.
- **If a later version ever needs the router**, for example host-side subagent selection, the minimal change is:
  - `RunMode` and `SelectionInput.mode` gain `"cowork"`;
  - `buildRunHome` refuses it explicitly, since no host run home should be built for it;
  - runtime-sdk 0.0.17 is released and Winter's `^0.0.16` pin is bumped.
  
  Nothing in v1 needs it.

## 4. The tool surface

`docs/cowork-prompt-and-tools.md` makes `coworkOfferedTools` (`cowork/session-profile.ts`) the one function the prompt and the host both call. D2 wires the host half.

### 4.1 Inputs, each from its one owner

| Input | Source |
| --- | --- |
| `approvalPolicy` | `binding.policy` |
| `toolClasses`, `network` | `CoworkAuthority.effectiveCapabilities(sessionId)` |
| `exposure` | `mcpServers: false` (strict, empty) and `toolSearch: true`. Exa presence is irrelevant while `host-provider-transport` is undeclared. |
| `readiness` | `offer.readiness`, declared by the native environment from the pinned image's verified capabilities (section 7.2). **DOOR code never declares a key.** Production declares none, so nothing fails open. |
| `withheldTools` | the allowlisted names the guest profile cannot carry (section 4.2) |

### 4.2 The guest profile caps the list

`assertLinuxHostQueryConfig` (agent SDK `packages/runtime/src/guest/linux-host-query-profile.ts`) refuses a runtime config unless all of these hold:

- `tools` is a subset of `Read`, `Write`, `Edit`, `Bash`, and `Edit` requires both `Read` and `Write`;
- `allowedTools`, `settingSources`, `skills` and `plugins` are empty;
- `mcpServers` is empty and `strictMcpConfig` is true;
- the only keys are `executionPosture`, `sessionId`, `model`, `cwd`, `winterHome`, `storeHome`, `persistSession`, `settingSources`, `tools`, `allowedTools`, `skills`, `plugins`, `strictMcpConfig`, `mcpServers`, `permissionMode`, `permissions`, `allowDangerouslySkipPermissions` and `contextWindowTokens`. There is no system-prompt key and no `disallowedTools` key.

The engine allows only the `permission` control subtype outbound. So the host brokers the doc lists as "offered by default" cannot function in `host-query-v1`: `SendMessage`, `ListAgents`, `TaskStop`, `AskUserQuestion`, `TaskCreate`/`Get`/`List`/`Update` and `TaskOutput`. Those would need `host_message_*` or `ask_user` subtypes, or tools the profile refuses.

D2 therefore adds `COWORK_GUEST_PROFILE_TOOLS = {"host-query-v1": ["Bash", "Edit", "Read", "Write"]}` to `session-profile.ts`. The host passes `withheldTools` = every allowlisted name not in the profile's set. That keeps one call for the prompt and the list, uses the existing "the host removes" input honestly, and changes no decision. The generated doc blocks stay as they are, and a new test pins the profile set against the SDK source shape.

The offered list is then `coworkOfferedTools(...)`, which is `⊆ {Read, Write, Edit, Bash}`. The pieces that must agree with it:

- **`confinedToolVisibility(toolClasses)`** (`guest-runtime.ts`) must equal the offered list. It is `{Read, Edit, Write, Bash}` gated by classes, with `guest-compartment` declared. When `guest-compartment` is not declared the offered list is empty, so the conversation's `runtime.toolClasses` must be `[]` too. D2 makes `confinedToolVisibility` take the offered list rather than re-deriving it, and a test proves the two agree across every class, policy and readiness combination.
- **`Options.tools`** is the offered list, set by `buildCoworkGuestQueryOptions` from `launch.runtime.tools`. It is an allowed list, which is stronger than a `disallowedTools` derived from the denylist. That derivation stays possible later, because no name is on both lists.
- **At `system/init`** the host runs the existing `toolSurfaceViolations(init.tools, offered, new Set())` (`runtime-sdk/mode-options.ts`) and aborts with `agent_error` `code: "tool_surface_unenforced"` on any extra tool, exactly as for chat and dispatch.

### 4.3 Capability servers: none

`COWORK_UNBUILT_CAPABILITY_SERVERS` already classifies all seven `CAPABILITY_SERVER_KEYS` as not offered, and the guest refuses a non-empty `mcpServers`. D2 adds two things to `mode-options.ts`, which DOOR owns:

- `export const COWORK_CAPABILITY_SERVERS: readonly CapabilityServerKey[] = []`, with a test that it equals the profile's built set (empty) and that no `winter__<key>` server is built for a Cowork incarnation;
- `export function coworkToolsFor(input: CoworkToolInputs & { profile: "host-query-v1" }): string[]`, the composition above.

`CAPABILITY_TOOL_MODES` and `toolsFor(mode)` stay typed `RunnableSessionMode`. Cowork does not enter the Code/chat/dispatch tables.

### 4.4 Honest readiness for the first session

`guest-compartment` is the only key the N2 image can back: the image carries `file-worker`, `process-worker` and `linux-tool-compartment` (`scripts/cowork-guest-artifact/image.py`). The native environment declares it only from that verified pin. Every other key stays undeclared:

- `guest-tool-families`, `linux-workflow`, `guest-lsp`, `skill-surface` and `plan-transition`;
- `scheduler-bridge`;
- `host-provider-transport`, which is the bridge;
- `host-network-endpoint`, which is the egress broker and owner-held.

The first session is offered `Read`, `Write`, `Edit` and `Bash`, gated by the ceiling. **The prompt is not delivered**; see section 9, G3.

## 5. The scripted stand-in provider

### 5.1 Where the guest's model calls go

The guest runtime's provider client is `createGuestProviderClient` over `createLinuxProviderPort("<winterHome>/.control/provider.sock")` (agent SDK `linux-session-admission.ts`). It has no HTTP fallback. **Nothing in the N2 image serves that socket**: `image.py` says so, and `refuse_provider_bridge` refuses a provider-worker-named file. The mux's `provider` class 3 is reserved and refused at the header by every parser. So a model call from a real guest session fails at `provider.sock` today. That is the D10 boundary (`docs/research/2026-10-17-cowork-n2-guest-boot.md` section 14).

### 5.2 Where the stand-in's answers can live

The stand-in has two halves. The **selection** (which provider and model the guest is told it has) is host-side and in this lane. The **answers** (something answering `provider.sock`) have two possible homes, and neither is in this lane:

| Home for the answers | What it needs | Verdict |
| --- | --- | --- |
| **Guest-side, test-only image profile.** A fourth runtime artifact `providerWorker` runs the runtime-sdk guided stub (`scripts/guest-guided-provider/stub.ts`, `createGuidedFixturePort`) behind a small runner that serves `/run/winter/conversations/<sid>/.control/provider.sock`. | <ul><li>A separately pinned stand-in image digest; production keeps the three-artifact image and `refuse_provider_bridge`.</li><li>An `image.py`/PID 1 change in the N2 guest lane.</li><li>The stub's runner, which its README calls "a later, separately reviewed slice".</li><li>An image build, which is a run this wave forbids.</li></ul> | **Recommended.** It is where the guided packet already places `providerWorker`, so it reuses an existing stub, and it adds no host channel. |
| **Host-side.** A scripted `ResolvedModel` adapter behind the existing `CoworkProviderBroker` (`cowork/provider-broker.ts`), reached over mux class 3. | Lifting the class-3 reservation in `native/protocol.ts`, the vectors, the C worker and the guest relay, plus a guest-side `provider.sock` relay. | **Not now.** That transport *is* the provider bridge, which the owner said is not built now. Wave 4 says to stop and report such a part. |

Per wave 4 ("If your slice needs network egress or the provider bridge, stop that part and report it"), I stopped the answer half. D3 builds the selection half, and D5 uses a scripted guest double. **A real VM session with canned answers needs the guest-side work above, owned by another lane (section 10).**

### 5.3 How a test or the first session selects it; why production never can

- **The selection** is a new `CoworkProviderRoute` (section 7.4), injected only into `createCoworkSessionDoor({ provider })`. Like `coworkNative`, no setting, environment variable or RPC reads it. Production's door, after D6, is constructed with no route, so `create` and every send refuse `provider_unavailable` before any row or boot.
- **The plan has no secrets.** The route's plan is the public `{scope, selection}` metadata the conversation set carries, plus `model`. It has no endpoint, credential or URL key, and the supervisor's own `public_metadata` check refuses those keys anyway.
- **The stand-in selection names a reserved provider id** (`winter-standin`) that no catalog row has. A mis-injected route therefore can never name a real provider. Recommendation O2: the guided stub's fixed `SELECTION` reproduces public `openai/gpt-5.6` metadata, so a reserved stand-in selection needs a one-line stub parameter in runtime-sdk. Otherwise the host must emit `openai/gpt-5.6` for a scripted guest, which is misleading.
- **Even a mis-injected route cannot reach a network.** The production image serves nothing on `provider.sock`, so the worst case is a guest model-call failure.
- **A pin test** checks two things: `standin-provider.ts` is imported by no `src/` module except the door factory's test-only entry, and the production construction path in `daemon.ts` passes no route.

### 5.4 Why it gives the guest no network

- The N2 device inventory has no network device, no vsock and no virtio-fs (`docs/cowork-native-worker.md` section 8).
- The stub creates no socket, listener, process, credential lookup, filesystem read or external request on import (its README).
- The runner serves one Unix socket inside the guest run home.
- Class 3 stays reserved.
- The host never contacts a provider for a stand-in session: no broker is opened, no credential is resolved, no request is made.

The stub's limits, as merged:

- exactly two serial `begin`s per port;
- text responses only, with no tool events;
- marker matching on the current system and user context (empty marker lists must be confirmed acceptable);
- its fixed selection.

So the first session is at most two canned model turns, with no tool calls driven by the model.

## 6. The single activation switch

**The switch:** whether `startIpcServer` receives a `CoworkSessionDoor` (`IpcServerOptions.coworkSessions`). In `ipc/server.ts`, `session.create` becomes:

```ts
if (isUnrunnableSessionMode(p.mode)) {
  if (!opts.coworkSessions) throw coworkSessionUnsupported();   // today's behavior, kept until D6
  return await opts.coworkSessions.create(parseCoworkCreate(p), caller);
}
```

Every other refusal stays in place for the Code path, so none of them is "flipped":

- `SessionStore.createSession` without a reservation;
- `refuseUnrunnableMode` in the Code driver table;
- `handoff.ts`;
- `session.setModel`, `workflow.run`;
- computer use and the peripheral lease;
- the remote mode set.

A stored `cowork` row is routed to the door's driver table, or refused when there is no door. This is not "enabling a placeholder by an availability flag" (spec, "Resource policy and product surfaces"): the port exists only once the real pieces behind it do. Before D6, `startDaemon` passes the door only from a host-only `opts.coworkSessions`, which only tests can supply. At D6 the one `daemon.ts` line that constructs it from production parts is the flip. `daemon.ts` is S7B's file, so the flip is a cross-lane edit; see section 10.

**The test that proves it is off** (`packages/core/test/cowork/session-door-off.test.ts`, D1, kept and inverted at D6):

1. **A production-shaped daemon refuses.** Start `startDaemon` with a temp home and the preload Keychain, and none of `coworkHost`, `coworkNative` or `coworkSessions`. Seed a fixture workspace with a source in state `ready` directly in its runtime-state DB, so a refusal cannot come from a missing source. Send a well-formed `session.create {mode:"cowork", cowork:{workspaceId, location:{kind:"source", sourceId}, requestId}}` as each of `harness`, `admin`, `plugin` and `remote`. Each must answer `INVALID_PARAMS` with `data.code: "unsupported_topology"`, and the test must then find:
   - no `sessions` row and no `cowork_conversations` row;
   - `incarnation_id` still null and power still `stopped`;
   - the daemon's `coworkNative.built === false`;
   - `workspace.capabilities.get` reporting `execution: false`.
2. **Positive control.** The same request succeeds with an injected stub door: a row exists, the binding is `active`, and a fake launcher is called only at the first send. Without this, case 1 could pass on a schema refusal. D1 runs it through `startIpcServer` directly. It moves onto `startDaemon` once S7B's pass-through (section 10 item 4) exists.
3. **Source pins.**
   - `packages/cli/src` never names `coworkSessions`.
   - In `daemon.ts`, `coworkSessions` appears only as the pass-through of `opts.coworkSessions`.
   - No `src/` module constructs `CoworkSessionDoor` (anti-wiring).

## 7. The spine

D1 lands these as types and protocol fields only. They are unwired, sit behind the refusal, and are added to the anti-wiring pins. That lets the other lanes build against them without editing DOOR's files.

**What the existing modules expose today.** The following was copied verbatim from the source at `8b52ef83`. It is the base the new ports below sit on.

**Approvals.** `cowork/host-policy.ts` is pure, with no ports. Its only importer is `policy-transition.ts`.

```ts
export function coworkHostDecision(input: CoworkHostDecisionInput): CoworkHostDecision
export interface CoworkHostDecisionInput { readonly policy: ApprovalPolicy; readonly tool: string; readonly path: string; readonly ceiling: CapabilityCeiling; readonly alreadyAuthorized?: boolean; readonly explicitDeny?: boolean; }
export interface CoworkHostDecision { readonly verdict: CoworkHostVerdict; readonly reason: CoworkHostReason; readonly bashReview: boolean; }
export function coworkConnectorVerdict(setting: ConnectorPermission | undefined, readOnly: boolean, policy: ApprovalPolicy): CoworkVerdict
```

`cowork/policy-transition.ts` has no importers. Its three ports are required.

```ts
export class CoworkPolicyTransitionMachine {
  constructor(initial: CoworkPolicyState, private readonly ports: CoworkTransitionPorts, epoch = 0)
  snapshot(): CoworkTransitionSnapshot
  subscribe(listener: (snapshot: CoworkTransitionSnapshot) => void): () => void
  async request(target: CoworkPolicyState): Promise<CoworkTransitionResult>
  async retry(): Promise<CoworkTransitionResult>
}
export interface CoworkTransitionPorts {
  closeAdmission(plan: CoworkTransitionPlan): Promise<void>;
  drain(plan: CoworkTransitionPlan): Promise<CoworkDrainOutcome>;
  installView(plan: CoworkTransitionPlan): Promise<void>;
}
```

`runtime-sdk/approval-bridge.ts` mentions Cowork nowhere.

```ts
export function canUseToolFor(deps: CanUseToolDeps): ApprovalBridge
export type ApprovalBridge = CanUseTool & { withdrawPending(callId: string): boolean };
// CanUseToolDeps required: sessionId, mode: SessionMode, policy, approvals, questions, gate: PermissionGate, emit
```

It has two seams:

- `connectorVerdict({ setting, readOnly, policy, mode, origin })`, which `coworkConnectorVerdict` is written to replace;
- the gate/policy path, which `coworkHostDecision` would supply.

`mode` is typed `RunnableSessionMode`. That is why the Cowork side needs its own port (section 7.5) rather than `mode: "code"`.

**Peer inbox.** `cowork/peer-inbox.ts`; `SqlitePeerInboxStore` in `peer-inbox-sqlite.ts` (schema 17). Neither is imported by anything wired.

```ts
export class CoworkPeerInbox {
  constructor(options: CoworkPeerInboxOptions)   // { records: CoworkMessagingRecords | undefined; store: PeerInboxStore; now?; newReceiptId?; limits? }
  accept(request: PeerSendRequest): PeerAcceptResult
  offer(recipientSessionId: string, epoch: PeerEpoch): PeerOffer | undefined
  ack(request: PeerAck): PeerReceipt
  block(receiptId: string, epoch: PeerEpoch, reason: Exclude<PeerBlockReason, "authority">): PeerReceipt
  cancel(identity: PeerSendIdentity): PeerReceipt
  discard(receiptId: string, by: PeerDiscardAuthority): PeerReceipt
  pending(recipientSessionId: string): PeerReceipt[]; owed(recipientSessionId: string): { runnable: number; blocked: number }
}
export type PeerEpoch = Pick<GuestEpoch, "incarnationId" | "leaseEpoch">;
export class SqlitePeerInboxStore implements PeerInboxStore { constructor(private readonly rs: RuntimeStateDb) }
// agent/session-messaging.ts (PEER-INBOX lane's file); constructed in daemon.ts:
export interface SessionMessagingDeps {
  cowork?: CoworkMessagingRecords;
  sessions: { get(sessionId: string): MessagingDriverHandle | undefined; ensure(sessionId: string): Promise<MessagingDriverHandle | undefined> };
  /* store, derive, working, followUp?, now?, log? */
}
export function mayContactCoworkPeer(records: CoworkMessagingRecords | undefined, callerSessionId: string, targetSessionId: string, operation: CoworkPeerOperation): boolean
```

**Schedules.** The port is types only (`schedule-dispatch.ts`). `CoworkSchedules` is built in `service.ts` with no port, and an AST pin keeps that position empty.

```ts
export interface CoworkScheduleDispatchPort {
  start(occurrence: CoworkScheduleDispatchInput, token: string): CoworkScheduleStartResult | Promise<CoworkScheduleStartResult>;
}
export interface CoworkScheduleDispatchInput { readonly schedule: CoworkSchedule; readonly occurrence: CoworkScheduleOccurrence; readonly effective: CapabilityCeiling; }
export type CoworkScheduleStartResult = { kind: "started"; receipt: CoworkScheduleStartReceipt } | { kind: "not-started" } | { kind: "uncertain" };
export interface CoworkScheduleStartReceipt { readonly occurrenceId: string; readonly token: string; readonly runRef: string }
// CoworkSchedules.beginDispatch(occurrenceId, token) throws CoworkError("unsupported_topology") SYNCHRONOUSLY without a port.
```

**Guest file channel and guided reader.** Both are unwired. Both ports are required, and each refuses synchronously when they are absent.

```ts
export function createCoworkGuestFileClient(deps: CoworkGuestFileClientDeps): CoworkGuestFileClient
export interface CoworkGuestFileClientDeps { readonly frames: CoworkGuestFileFramePort; readonly authority: CoworkGuestFileAuthorityPort; readonly requestId?: () => string; }
export interface CoworkGuestFileFramePort { send(frame: string, signal: AbortSignal): Promise<string> }
export function createCoworkGuidedRuntimeContextHandler(deps: CoworkGuidedReaderDeps): CoworkRuntimeContextHandler
export interface CoworkGuidedFramePort { readFrame(signal: AbortSignal): Promise<string> }
export type CoworkRuntimeContextHandler = (request: Readonly<CoworkRuntimeContextRequest>, options: { signal: AbortSignal; trustedQuerySessionId: string }) => Promise<Readonly<CoworkCurrentContextSnapshot>>;
export interface CoworkCurrentContextSnapshot { revision: string; facts: string; instructions: string }
```

**Exports and restore.** There is no restore door; `validateImport` grants nothing. The authority port is mandatory.

```ts
export class CoworkExports {
  constructor(private readonly rs: RuntimeStateDb, private readonly authority: CoworkLifecycleAuthority, private readonly now = ..., private readonly mintId = ...)
  prepare(workspaceId: string, proof: unknown): PreparedExport
  complete(exportId: string, proof: unknown): CoworkExportRecord
  fail(exportId: string, proof: unknown): CoworkExportRecord
  validateImport(input: string | Uint8Array, proof: unknown): ValidatedImport
}
export interface CoworkLifecycleAuthority { authorize(action: LifecycleAction, workspaceId: string, homeId: string, proof: unknown): boolean; }
export function assertAtRest(facts: WorkspaceFacts): void   // volume_busy | recovery_required
```

**Git.** Nothing outside `cowork/git/` imports it. `availability()` is always false without `isolatedFixture`.

```ts
export interface PublicationAuthority { authorize(publisher: Publisher, request: Readonly<PublicationRequest>): Promise<PublicationGrant>; }
export interface PublicationTransport { observe(grant, ref: string, signal?): Promise<RemoteObservation>; push(grant, plan: Readonly<PushPlan>, signal?): Promise<"applied" | "rejected" | "uncertain">; }
export interface GitReadAuthority { authorize(caller: Readonly<GitReadCaller>, request: Readonly<GitReadRequest>): GitReadGrant; }
export class CoworkGitPublicationBroker { constructor(options: BrokerOptions); availability(): { available: false; reason: "host_auth_and_service_integration_required" }; publish(publisher: Publisher, incoming: PublicationRequest, signal?): Promise<PublicationReceipt> }
export class CoworkGitHubReadTransport { /* … */ availability(): { available: false; reason: "integration_unavailable" }; revoke(workspaceId: string, sourceId?: string): void; read(caller, request, signal?): Promise<GitReadResponse> }
```

**Current host context.** This chain produces the block the prompt points at. It is unwired.

```ts
export function planCoworkCurrentContext(value: CoworkContextRecords, requested: CoworkContextLookup, signal?: AbortSignal): Readonly<CoworkCurrentContextPlan>
export class CoworkCurrentContextResolver { constructor(deps: CoworkCurrentContextResolverDeps); resolve(lookup, options = {}): Promise<Readonly<CoworkCurrentContextSnapshot>> }
export function createCoworkRuntimeContextHandler(deps: CoworkCurrentContextResolverDeps): CoworkRuntimeContextHandler
export class CoworkGuestContextOwners { constructor(deps: CoworkGuestContextOwnersDeps); prepare(capture): CoworkGuestContextOwner; stop(): void }
export function captureCoworkGuestOwner(deps: CoworkGuestOwnerDeps, launch: Readonly<GuestRuntimeLaunch>, reader?: CoworkGuestOwnerReaderPlan): CoworkGuestOwnerCapture
```

**The pins the slices must update in the same change.** Every anti-wiring test bans plain substrings in all `packages/*/src` files; comments and type-only imports count.

- **D2** imports `session-profile` from `mode-options.ts`, so `session-profile.test.ts`'s pin moves to "wired behind the refusal" with a refusal proof.
- **D3** must not import `cowork/native/*` from anywhere but `native-wiring.ts` (`native/anti-wiring.test.ts`). That is why every native-facing type in section 7.6 is declared structurally in `session-ports.ts`, and a *test* asserts equality with the native types.
- `git/*`, `exports`, `storage-lifecycle`, `current-context*` and `workspace-events` have no pin and are not touched in v1.

### 7.1 Protocol (`packages/protocol/**`, DOOR; `pnpm protocol:generate`; Swift mirrors synced)

```ts
// methods.ts
export const CoworkSessionLocation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), sourceId: CoworkId, relativeCwd: z.string().max(1024).optional() }).strict(),
  // Reserved for owner decision O1 (section 9, G1); refused until chosen:
  z.object({ kind: z.literal("outputs") }).strict(),
]);
export const CoworkSessionCreate = z.object({ workspaceId: CoworkId, location: CoworkSessionLocation, requestId: CoworkRequestId }).strict();
// SessionCreateParams gains:  cowork: CoworkSessionCreate.optional()
//   superRefine: present iff mode === "cowork"; with it, cwd/model/effort/origin must be absent (host-derived).
//   approvalPolicy carries .default("ask"), so it is never absent on the parsed value: the handler checks the RAW params
//   for it, as the remote-role check in ipc/server.ts already does, and ignores the parsed default.
// SessionRow (session.list) gains:  cowork?: { workspaceId: string; projectId: string | null }

// events.ts — session_created gains (durable; still outside HISTORY_EVENT_TYPES, as today):
//   cowork?: { workspaceId: string; projectId: string | null; location: "source" | "outputs"; sourceId: string | null; policyRevision: number }
```

Users:

- **Mac UI:** composer send (two calls, `workspace.create` then `session.create`), session windows and the sidebar's Cowork list.
- **CLI:** `winter cowork session create|list`.
- **APPROVALS and PEER-INBOX:** use the host's `cowork_conversations` row to know a session is a Cowork conversation. `session_created.cowork` is a display fact, never authority: only the daemon's own create writes it, `sync.push` and `appendSynced` refuse it at any seq, and no consumer trusts the log field alone.

No new event variant is needed for the first session. VM power already reaches the Mac through `workspace.watch` snapshots (the `power` field of `CoworkWorkspaceRecord`). Field changes trip no compile-time trap, so D1 sweeps their producers in both languages, per `docs/claude/protocol-and-remote.md`.

### 7.2 Error codes (`cowork/types.ts`, DOOR)

```ts
// CoworkErrorCode gains:
| "provider_unavailable"     // no provider route injected (production); refused before any row or boot
| "conversation_limit"       // N2: the running guest already serves its one host-query conversation
| "cold_resume_unavailable"  // the conversation's incarnation ended and cold resume (D10) is not built
```

They map through `rpcFromWinterRefusal` to `INVALID_PARAMS` with `data.code`, like every Cowork refusal. Users: the Mac UI (composer and session window states), the CLI, and PEER-INBOX (a delivery to a Cowork target reports the same codes).

### 7.3 Session and driver ports (new `cowork/session-ports.ts`, DOOR, types only in D1)

```ts
import type { LegSession } from "../runtime-sdk/session-driver";
import type { CoworkConnection } from "./service";
import type { CoworkErrorCode } from "./types";

export interface CoworkSessionCreateInput {
  workspaceId: string; requestId: string;
  location: { kind: "source"; sourceId: string; relativeCwd?: string } | { kind: "outputs" };
}
/** The single activation switch (section 6). ipc/server.ts consumes it; only daemon.ts constructs it, at D6. */
export interface CoworkSessionDoor {
  create(input: CoworkSessionCreateInput, caller: CoworkConnection): Promise<{ sessionId: string }>;
  readonly drivers: CoworkSessionDrivers;
}
/** The Cowork driver table. Same verbs ipc/server.ts and SessionMessaging already call on the Code table. */
export interface CoworkSessionDrivers {
  get(sessionId: string): LegSession | undefined;
  /** Refuses typed (CoworkError): provider_unavailable, conversation_limit, cold_resume_unavailable, recovery_required, unsupported_topology. */
  ensure(sessionId: string): Promise<LegSession>;
  /** One headless turn (the CLI's -p path), awaited to the end. Same refusals as ensure. */
  runTurn(sessionId: string, text: string, clientName: string): Promise<void>;
  evict(sessionId: string): Promise<void>;
  list(): LegSession[];
  /** daemon.stop(): before coworkNative.beginShutdown(). Never rejects. */
  beginShutdown(): Promise<void>;
}
/** Durable backend identity of a bound conversation (stored with the binding, D4; section 10 item 3). */
export interface CoworkConversationRuntimeIdentity { backendSessionId: string; model: string; resume: boolean }
```

Users:

- **PEER-INBOX:** `session-messaging.ts` delivers to a Cowork target through `drivers.get ?? drivers.ensure` and steer/send on the `LegSession`.
- **Schedule port:** a `CoworkScheduleDispatchPort.start` implementation calls `drivers.ensure(sessionId)`, then `send(text, "schedule")`, and returns `{kind:"started", receipt:{…, runRef: sessionId}}` once the send is accepted. It does not await the turn. A typed refusal maps to `not-started`, and a lost answer to `uncertain`. Note that `CoworkSchedules.beginDispatch` throws synchronously when no port is present.
- **APPROVALS:** reads the binding the driver passes (section 7.5).
- **Mac UI:** reads the refusal codes.

### 7.4 Provider route (`cowork/session-ports.ts`, DOOR)

```ts
/** Public metadata only. No endpoint, credential, header or URL key at any depth (the supervisor refuses them too). */
export interface CoworkProviderSelection {
  providerId: string; modelKey: string; providerModelId: string; family: string; protocol: string;
  capabilities: readonly string[]; continuationDomain?: string;
}
export interface CoworkProviderRouteInput {
  scope: CoworkProviderScope;        // cowork/provider-broker.ts, existing: homeId … modelRevision
}
export interface CoworkProviderRoute {
  readonly kind: "scripted-standin";  // the bridge adds "host-provider" later, with readiness host-provider-transport
  readonly model: string;
  plan(input: CoworkProviderRouteInput): { model: string; provider: { scope: CoworkProviderScope; selection: CoworkProviderSelection } };
}
```

Users: the guest lane (the selection the stand-in image's runner must accept), D5 fakes, and later the bridge.

### 7.5 Approval port (APPROVALS lane implements; `runtime-sdk/approval-bridge.ts` is theirs)

```ts
import type { CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { ConversationBinding } from "./types";
export interface CoworkApprovalPort {
  /** One bridge per incarnation. Cards on the conversation's own log, keyed by callId; never mode "code". */
  canUseToolFor(input: {
    sessionId: string; binding: Readonly<ConversationBinding>; policyRevision: number;
    emit(event: NewSessionEvent): SessionEvent; withdrawPending(callId: string): void;
  }): CanUseTool;
}
```

The driver passes it to `buildCoworkGuestQueryOptions` as `canUseTool`, and the projector's `onToolResults` calls `withdrawPending`. The `policy-transition`/`host-policy` modules feed it: see the existing signatures in the block above.

### 7.6 Native seams (S7B / N2; consumed through `native-wiring.ts`)

`native/anti-wiring.test.ts` lets only `native-wiring.ts` import `cowork/native/*`, type-only imports included. So these are declared **structurally** in `cowork/session-ports.ts` (DOOR). `native/host.ts` and `native-wiring.ts` satisfy them, and a test (tests may import both) asserts they are assignable both ways to the native types: `CoworkNativeConversationSet`, `CoworkNativeConversationContext` and `CoworkNativeStopOutcome`.

```ts
// cowork/session-ports.ts (DOOR) — structural copies, pinned equal to native/host.ts + native/protocol.ts by a test:
export interface CoworkGuestConversationContext { readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string }
export interface CoworkGuestConversationSet { readonly profile: "host-query-v1" | "host-query-guided-v1" | null; readonly conversations: readonly CoworkGuestConversation[] } // CoworkGuestConversation mirrors CoworkNativeConversation field for field
export type CoworkGuestStopOutcome = { readonly released: true; readonly evidence: string } | { readonly released: false; readonly reason: string };
export interface CoworkGuestStartRequest {
  /** Called once at `mounted`; returns this incarnation's set (N2: at most one host-query conversation). */
  conversations(context: CoworkGuestConversationContext): CoworkGuestConversationSet | null;
}
export interface CoworkGuestRun {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number; readonly guestBootId: string;
  /** Runtime class 2 for conversation index 0, available after runtime_ready. */
  runtime(conversation: 0): CoworkGuestRuntimeLink;
  stop(reason: "user" | "shutdown" | "restart" | "update"): Promise<CoworkGuestStopOutcome>;
}
/** Today `native/host.ts`'s SessionInbox drops runtime frames ("no consumer in this slice"); section 10 item 1. */
export interface CoworkGuestRuntimeLink {
  /** Bounded by runtimeInFlightBytes (1 MiB unanswered); chunks ≤ 256 KiB; resolves when the frame is handed to L1. */
  send(bytes: Uint8Array, end?: boolean): Promise<void>;
  /** OUT and ERR bytes in order; end=true once per stream. Returns an unsubscribe. */
  onData(handler: (stream: "out" | "err", bytes: Uint8Array, end: boolean) => void): () => void;
  /** Resolves when the incarnation's stop outcome is known (released or not). */
  readonly ended: Promise<CoworkGuestStopOutcome>;
}
/** The guest offer, from the native environment (S7B), derived from the verified image pin — never a DOOR constant. */
export interface CoworkGuestRuntimeOffer {
  readonly profile: "host-query-v1";
  readonly readiness: readonly CoworkReadinessKey[];          // N2 image: at most ["guest-compartment"]
  readonly runtimeCapability: { protocolVersion: 1; capabilities: readonly string[]; supportsConfinedGuestExecution: boolean };
}
// cowork/service.ts (DOOR) — the existing start port (`start(workspaceId: string): Promise<unknown>`) becomes:
export interface CoworkGuestStartPort { start(workspaceId: string, request?: CoworkGuestStartRequest): Promise<CoworkGuestRun> }
```

Users: D3's driver and its `GuestRuntimeChannel` adapter (`cowork/runtime-channel.ts`). S7B implements them in the production environment, and the native host and `native-wiring.ts` implement them (section 10 item 1).

### 7.7 Provisioning port (S7B implements; `cowork/service.ts` consumes)

```ts
export interface CoworkProvisioningPort {
  /** True only when the production native environment, the installed image pin and the allocate authority exist. */
  available(): boolean;
  /** Admission only, inside workspace.create / source additions. Throws CoworkError("unsupported_topology") when unavailable. */
  admit(principal: CoworkPrincipal): void;
  /** After COMMIT: allocate data/env images (backup excluded), pin base/runtime digests, create shared dirs. Idempotent per operation. */
  provision(workspaceId: string, operationId: string): Promise<{ status: "applied" | "failed"; reason?: string }>;
}
// CoworkHostPorts gains:  provisioning?: CoworkProvisioningPort   (requireProvisioning remains as the refusing default until D4 replaces its callers)
```

### 7.8 Git, exports, schedules, file channel, guided reader

Their existing ports are listed verbatim in the block above. The session door adds nothing to them in v1:

- **Git.** No guest Git transport exists in `host-query-v1` (no outbound subtype) and no clone can run (no network), so the git gateway has no caller from a session yet.
- **Exports and restore.** They operate on a stopped workspace and need only the power state the driver leaves (`stopped` after an orderly stop).
- **Schedules.** `drivers.ensure` plus `send`, as above.
- **The guest file channel and the guided reader adapter.** They are Track A's, and they enter through `host-query-guided-v1` and `onRuntimeContext` (section 9, G3).

### 7.9 Mac UI touchpoints (other lane; protocol shape from 7.1)

| Surface | Where today | What it uses from the spine |
| --- | --- | --- |
| Composer send | `apple/Winter/Sources/AppShell/NewChatPage.swift` `newChatSendBlockedReason(draft:mode:)` returns "… isn't built yet" while `SessionMode.cowork.isAvailable` is false (`ShellNavigation.swift`). | `workspace.capabilities.get` (`provisioning`, `execution`), then `workspace.create`/`project.create`, then `session.create {mode:"cowork", cowork}`. Every refusal code in section 7.2 gets its own visible state. `isAvailable` follows `execution`, never a constant. |
| Folder and approval chips | `ComposerChrome.swift` `CoworkComposerStrip` shows two placeholder chips, "Working folder (not wired yet)" and "Approval mode (not wired yet)". | Folder: `workspace.selection.prepareFolder`, then the selection id in `workspace.create`. Approval: the workspace default policy (`workspace.setDefaultPolicy`); the binding takes it at creation. O1 decides what the folder chip may honestly say in N2. |
| Session windows | `ShellSessionHost` and the event reducer | `session_created.cowork` and `SessionRow.cowork`; VM power from `workspace.watch`. On a cold first turn the host waits up to 90 s for the guest's `hello` and up to 60 s more for `runtime_ready`, so the window shows the workspace's `starting` state. |
| Dispatch `/spawn` | `DispatchPillController.swift` `onSpawnCowork` is never assigned, so `/spawn` shows "not available yet". | Stays unassigned in v1. Guest and Dispatch spawn are denied (D11), and a host-to-Cowork delegation grant is not built. |
| Library "withheld in cowork" | `Library/LibraryMcpTab.swift` builds "withheld in …" from the `exposure` keys. `capabilities.list` in `ipc/server.ts` deliberately sends only `code`, `dispatch` and `chat`, because a `false` for a mode that cannot run would read as "withheld in cowork" on every row. | **D6 (DOOR):** add `cowork: false` with the flip, not before. Cowork builds no capability server in v1 (section 4.3), so every row then says "withheld in cowork", truthfully. The Mac lane adds `cowork` to the tab's mode order. The `session-mode.test.ts` pin moves in the same change. |
| "Guidance unavailable" | none | `workspace.instructions.get` stays readable while stopped. The session window shows "guidance not loaded in this version" until `host-query-guided-v1` (G3), so it never implies the model read the file. |
| Outputs (G11, owner 2026-10-18) | the outputs list and file viewer over `workspace.output.list` and `workspace.file.read` | In N2 those read the host's shared outputs folder, while the guest writes to its own data image, so a guest's files never show there. The session window says "outputs appear after the workspace's file sharing ships" instead of an empty list. `workspace.file.*` stays local-only and truthful. |

## 8. Slice plan (DOOR)

| Slice | Size | Files | Lands | Parallel with |
| --- | --- | --- | --- | --- |
| **D1 spine** | M | `packages/protocol/src/{methods,events}.ts` (+ generated schema/fixtures), Swift mirrors (`apple/WinterProtocol`, `apple/WinterKit` call sites; `WinterClient` switches unchanged because no variant is added), `cowork/types.ts` (three codes), new `cowork/session-ports.ts`, `sessions/session-mode.ts` (`DrivableSessionMode` type and pin, no behavior), `ipc/server.ts` (parse the `cowork` param; refuse without a door; take `opts.coworkSessions`), tests: protocol round trip, anti-wiring pins, and `session-door-off.test.ts` cases 1 and 3, plus case 2's positive control with a stub door through `startIpcServer` directly. Moving case 2 onto `startDaemon` waits for section 10 item 4. | first | D2; other lanes start against it |
| **D2 tool surface** | M | `cowork/session-profile.ts` (`COWORK_GUEST_PROFILE_TOOLS`), `runtime-sdk/mode-options.ts` (`coworkToolsFor`, `COWORK_CAPABILITY_SERVERS`), `cowork/guest-runtime.ts` (`confinedToolVisibility` from the offered list), generated doc blocks (`COWORK_PROFILE_DOC_UPDATE=1`), tests across every class, policy and readiness combination | with D1 | D1 |
| **D3 driver and stand-in selection** | L | new `cowork/session-driver.ts`, new `cowork/conversation-set.ts` (one builder for the native entry and the launch), new `cowork/runtime-channel.ts` (`GuestRuntimeChannel` over `CoworkGuestRuntimeLink`), new `cowork/standin-provider.ts` (route, public metadata only), `cowork/guest-query.ts` (callbacks unchanged), `runtime-sdk/winter-session.ts` and `projector/types.ts` (`DrivableSessionMode`), tests over the existing fake launcher (`test/cowork/native/fake-launcher.ts`) and a scripted guest double | after D1 and D2; needs section 10 item 1 (or a fake link) | D4 |
| **D4 provisioning and CLI create** | M–L | `cowork/service.ts` (`provisioning` port, truthful capabilities), `cowork/repository.ts` (`s_` reservation minter, binding identity column, location kind if O1 picks it), `cowork/schema.ts` (migration body), `sessions/store.ts` (`reservedSessionId`), `ipc/server.ts` (route `cowork` rows to the door; create via the door), `packages/cli/src/cowork-cli.ts` (`session create|list`), tests | after D1; needs section 10 item 3 for the migration | D3 |
| **D5 end to end with fakes** | M | tests only: `session.create` → `send` → fake launcher and scripted guest → events → approval card → interrupt → stop/receipt → `cold_resume_unavailable`; `conversation_limit`; `provider_unavailable`; a Code driver never touched; the RunMode pin (section 3); the refusal still holding in production shape | after D3 and D4 | other lanes' fakes |
| **D6 the flip** | S | `ipc/server.ts` (the `capabilities.list` `cowork` exposure key; remote notes), the `daemon.ts` construction line (section 10 item 5), `session-door-off.test.ts` inverted to a production-on test, docs owed | last, only on the owner's word | nothing |

**Merges.** Main→integration sync 4 lands in parallel. Each slice merges `origin/cowork/output-integration` into its branch first, as a merge commit.

**Other lanes in parallel once D1 is merged:**

- **APPROVALS:** `CoworkApprovalPort`;
- **PEER-INBOX:** delivery through `CoworkSessionDrivers`;
- **S7B:** `CoworkGuestRuntimeOffer`, the runtime link and `CoworkProvisioningPort`;
- **Mac UI:** protocol fields and the refusal codes;
- **the N2 guest lane:** the stand-in image profile, if the owner approves it.

## 9. Spec gaps and contradictions

| # | Gap | Blocks | Recommendation |
| --- | --- | --- | --- |
| **G1** | **No source can honestly be `ready` in N2.** The N2 device inventory has no virtio-fs (no Mac folder mount) and no network (no clone), and nothing calls `acknowledgeSource`. But `bindConversation` refuses a source that is not ready, and the spec requires "at least one explicitly allowed host directory or one selected GitHub repository". Presenting an empty directory on `data.ext4` at `/workspace/folders/<id>` as the user's folder would contradict the spec and the prompt ("the user's real Mac folder … not a copy"). | a real session (D4's bind) | **Owner decision O1.** Recommended: the first session binds to its own outputs location (`/workspace/outputs/<sid>`, already an admitted host-query root and a per-conversation spec location), with source state `preparing` and reason `share_unavailable`. The minimum-source rule is unchanged. Cost: the binding's `source_id` becomes nullable with a `location` kind (a table rebuild in migration 18), and in N2 the outputs live on `data.ext4`, so the Mac outputs box is empty until the outputs share ships. Alternative: wait for host-backed folder shares (L, needs virtio-fs and its gates). |
| **G2** | **The stand-in's answers have no home in the current rules** (section 5.2). | a real session | **Owner decision O2.** Recommended: a guest-side, separately pinned stand-in image profile running the runtime-sdk guided stub, owned by the N2 guest lane, with an image-build approval. A small runtime-sdk change to give the stub a reserved stand-in selection instead of `openai/gpt-5.6`. Confirm that its two-begin, text-only and marker rules fit (empty markers). |
| **G3** | **The Cowork prompt and the host-context block cannot reach the model in `host-query-v1`.** The config has no system-prompt key, and inbound frames are only `user` text, `end_input`/`interrupt` and permission answers (`checkLinuxHostQueryFrame`). The spec and `docs/cowork-prompt-and-tools.md` require both. The guided profile can carry them: `onRuntimeContext` returns `{revision, facts, instructions}` up to 128 KiB per generation (agent SDK `packages/sdk/src/runtime-context.ts`). | the flip (D6) | Deliver `coworkSystemPrompt(...)` and the `CoworkCurrentContextPlanner` block as `facts` through `host-query-guided-v1` once Track A lands. The first session runs with the guest runtime's default prompt; canned answers make that moot, and the record says so. **The flip waits for prompt delivery.** |
| **G4** | **The host brokers listed as "offered by default" cannot function in `host-query-v1`** (`SendMessage`, `ListAgents`, `TaskStop`, `AskUserQuestion`, `Task*`, `TaskOutput`). The engine allows only the `permission` subtype, and the profile admits four tools. | no | Withhold them by profile (section 4.2), so the prompt never names them. Same-Project messaging *into* a conversation still works host-side (PEER-INBOX). Agent-to-agent SendMessage *from* the guest needs a guest-profile subtype, which is an agent-SDK change and release. |
| **G5** | **N2 serves one host-query conversation per guest, with a fixed set.** The spec's "separate conversations may run concurrently against the same workspace" is not reachable in N2. | no (first session is one conversation) | A second Project conversation is created but refused at its first turn with `conversation_limit`. This is visible and is not a queue, which the spec rejects. Lifting it is a contract change (the prefix keeps the index byte for it). |
| **G6** | **No cold resume in N2 (D10).** The spec prefers a cold stop after two minutes of quiescence, with the logical conversation continuing. | no | No automatic cold stop in the first version; after any stop the next send refuses `cold_resume_unavailable` (owner decision O4). Cold resume lands with the shares and the guidance load-on-resume. |
| **G7** | **Reservation id shape.** The repository reserves `session_<uuid>` and the store mints `s_<12 hex>`, so a standalone binding can never match. SendMessage addressing also assumes `s_…`. | D4 | Mint the reservation in the store's shape, and let `createSession` take it only for `mode: "cowork"` (section 1.2). No production rows exist to migrate. |
| **G8** | **Host and guest SDK versions are unpaired.** Winter pins `winter-agent-sdk` 0.0.53 (`v0.0.53` = `bc7e128f`), which predates the guest host-query profile and `runtime-context`. The image builds its guest runtime from a later SDK commit. Host↔guest frame compatibility is proven only against scripted channels. | a real session | Pin the pairing at the Track A repin: one SDK release whose host `query()` and guest `winter-host-query` come from the same commit, checked by a test that compares the image pin with `REQUIRED_WINTER_AGENT_SDK`. |
| **G9** | **The backend identity has no durable home.** `GuestRuntimeSupervisorDeps.identity` needs `backendSessionId` and `model` "from the canonical session directory", but a Cowork conversation must not get a `RuntimeSessionRecord`: it has a router `selection`, a host `backendRoot` and project keys, and Migration C's `hostRuntimePredicate` keeps guest sessions out of those tables. | D4 | A `backend_session_id` column on `cowork_conversations`, minted at bind. It needs migration 18, registered in `runtime-state/db.ts` (S7B). |
| **G10** | **The flip and "production supplies no provider" interact.** After D6, a production Cowork session would be creatable but every create and send refuses `provider_unavailable` until the bridge ships. | the flip | **Owner decision O3.** Sequence the flip after a real provider path exists, or accept a visible "model unavailable" state. Recommended: flip after the bridge. |
| **G11** | **Outputs and the host readers diverge in N2.** `workspace.output.list`/`file.read` read `<home>/cowork/workspaces/<id>/shared/outputs/<sid>/`, while a guest in N2 writes `data.ext4`. | no | State it in the Mac UI ("outputs appear after the workspace's file sharing ships"), and keep `workspace.file.*` local-only and truthful. |

## 10. NEEDS FROM OTHER LANE

1. **N2 / S7B: runtime streams on the native host.** `cowork/native/host.ts`'s `SessionInbox` drops every runtime frame ("runtime frames have no consumer in this slice"). D3 needs the host to satisfy `CoworkGuestRun.runtime(0)` and `CoworkGuestRuntimeLink` (section 7.6), declared structurally in `cowork/session-ports.ts` because of the native anti-wiring pin:
   - on IN, `serializeCoworkNativeMuxFrame` of class `runtime`, stream `in`, through `session.send({t:"mux_down"})`, with a `CoworkNativeRuntimeStreams` instance per run;
   - on OUT/ERR, routing `mux_up` runtime frames to `onData` before the inbox's sealed filter.

   Also `CoworkNativeHost.start(workspaceId, {conversations})`, so the set comes from the caller rather than only from `deps.conversations`, and `CoworkNativeWiring.start` forwarding it. If S7B is not touching `host.ts`, I recommend DOOR takes this as part of D3 with the controller's assignment.
2. **S7B: production environment facts.**
   - `CoworkGuestRuntimeOffer` (section 7.6) from the verified image pin;
   - `CoworkProvisioningPort` (section 7.7), including an allocate authority, since the native `CoworkVolumeAuthority` refuses `allocate`;
   - the guest boot id on the run.
3. **S7B: `runtime-state/db.ts` migration 18.** Add `{ version: 18, up: migrateCoworkSessionSchema }` (body in DOOR's `cowork/schema.ts`) and set `RUNTIME_STATE_SCHEMA_VERSION = 18`. The body adds `backend_session_id`, plus, if O1 picks the outputs location, `location_kind` and a nullable `source_id` through a table rebuild. The existing downgrade refusal with Cowork data present stays as is.
4. **S7B: `daemon.ts` pass-through before D6.**
   - `startDaemon` opts gains `coworkSessions?: (deps: CoworkSessionDoorDeps) => CoworkSessionDoor`, host-only like `coworkNative`;
   - it passes `coworkSessions: opts.coworkSessions?.(…)` to `startIpcServer`;
   - `stop()` awaits `door.drivers.beginShutdown()` before `coworkNative?.beginShutdown()`.
   - The `SessionMessaging` construction (`daemon.ts`, `sessions: {get, ensure}`) composes the two tables: `get: id => door?.drivers.get(id) ?? drivers.get(id)`. Its `ensure` sends a stored `cowork` row to `door.drivers.ensure`. That is the hook PEER-INBOX needs; mapping a Cowork `CoworkError` to its `SendAnswer` stays theirs.
5. **S7B or the controller: the D6 flip line in `daemon.ts`.** It constructs `createCoworkSessionDoor({...production parts})`. It lands only on the owner's word.
6. **APPROVALS: `CoworkApprovalPort`** (section 7.5) in or beside `runtime-sdk/approval-bridge.ts`, never `mode: "code"`.
7. **PEER-INBOX: delivery to a Cowork target through `CoworkSessionDrivers`** (section 7.3) and the new codes.
8. **N2 guest lane, plus runtime-sdk: the stand-in image profile and the stub's runner** (section 5.2), if O2 is approved. It needs an image build, which is a run.
9. **Track A: the guided profile and an SDK release** that pairs host and guest (G3, G8).

## 11. Owner decisions (each with my recommendation)

- **O1 (G1), the first session's working root.** Recommended: its own outputs location, with sources left honestly `preparing`. Alternative: wait for folder shares.
- **O2 (G2), the stand-in's home.** Recommended: a guest-side, separately pinned stand-in image running the runtime-sdk guided stub with a reserved selection. That needs an image build approval and the N2 guest lane.
- **O3 (G10), the flip.** Recommended: flip after a real provider path exists.
- **O4 (G6), automatic cold stop.** Recommended: off until cold resume exists; after a stop, sends refuse `cold_resume_unavailable`.
- **O5, the branch name.** `cowork/session-door` was used by merged PR #44, and wave 4 forbids reusing a merged branch, so this work is on `cowork/session-door-2`. I recommend keeping it.

## 12. Docs owed (for the controller's doc pass)

- `docs/claude/cowork.md`: the session door design exists (this file). Still nothing is creatable or runnable, and the activation switch is the `CoworkSessionDoor` port (section 6).
- `docs/cowork-status.md`: under "Still open", add blockers G1, G2, G3 and G8, and the N2 limits (one conversation per guest, no cold resume, four guest tools).
- `docs/cowork-prompt-and-tools.md` (commentary, not a generated block): the `host-query-v1` profile withholds the host-broker tools, and the prompt is delivered only through the guided profile.
- `docs/claude/runtime-and-sessions.md`: `DrivableSessionMode` versus `RunnableSessionMode` (lands with D3).
