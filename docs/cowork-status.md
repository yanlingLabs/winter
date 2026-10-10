# Cowork implementation map

As of 2026-10-10, Winter cannot create or run a supported Cowork session. Code, Chat, and Dispatch are the implemented daemon modes. Cowork has visible UI placeholders, reserved names, and reusable infrastructure. A reserved predicate or a passing synthetic test does not make it a working product mode.

This map covers the Winter host and its sibling agent SDK, runtime SDK, and iOS repositories. It describes source behavior; the unavailable Cowork mode has no end-to-end execution to validate. Outstanding work is tracked in [Follow-ups](../follow_up.md#cowork).

## What already exists

| Area | Implemented today | Cowork boundary | Source |
| --- | --- | --- | --- |
| Mac navigation | Cowork sidebar destination and an unavailable landing page. | No session list or creation door on that landing. | [ShellNavigation](../apple/Winter/Sources/AppShell/ShellNavigation.swift), [CoworkPlaceholder](../apple/Winter/Sources/AppShell/CoworkPlaceholder.swift) |
| Mac composer preview | Chat/Cowork selector, Cowork idea prefills, dedicated composer styling, and folder/approval chips. Cowork can be selected for preview. | Sending is blocked; the folder and approval chips are not wired. | [NewChatPage](../apple/Winter/Sources/AppShell/NewChatPage.swift), [ComposerChrome](../apple/Winter/Sources/AppShell/ComposerChrome.swift) |
| Dispatch command | `/spawn` parsing, an unavailable notice, and an optional `onSpawnCowork` callback. | Production wiring does not set that callback. Its test invokes an injected closure, not a Cowork window. | [DispatchPillController](../apple/Winter/Sources/DispatchPill/DispatchPillController.swift), [controller tests](../apple/Winter/Tests/WinterAppTests/DispatchPillControllerTests.swift) |
| Child orchestration | Dispatch creates Code sessions, tracks their work, relays cards, and receives completion updates. | `SpawnSession` accepts the reserved `cowork` argument only to reject it before creating anything. | [spawn schema](../packages/core/src/agent/tools/session-spawn.ts), [DispatchChildren](../packages/core/src/agent/dispatch-children.ts) |
| Lifecycle | Active/background/idle/archived derivation and setters are implemented. `participatesInActivity` includes `code` and the reserved `cowork` value. | Supported work sessions are Code. Cowork-shaped setter fixtures bypass supported creation. | [activity](../packages/core/src/sessions/activity.ts), [setActivity](../packages/core/src/sessions/set-activity.ts), [tests](../packages/core/test/ipc/session-set-activity.test.ts) |
| Working directories | Ordered directories, canonical paths, locking, and the shared `setSessionDirs` operation. | It shares the reserved lifecycle predicate; no Cowork folder picker is connected to a real session. | [dirs](../packages/core/src/sessions/dirs.ts), [setDirs](../packages/core/src/sessions/set-dirs.ts), [tests](../packages/core/test/ipc/session-set-dirs.test.ts) |
| Outputs | Per-session output paths, artifact enumeration, an outputs box, and side-viewer integration. | The eligibility helper accepts `cowork` for future use; live sessions reach this through Code. | [OutputsBox](../apple/Winter/Sources/AppShell/OutputsBox.swift), [ShellSessionHost](../apple/Winter/Sources/AppShell/ShellSessionHost.swift), [tests](../apple/Winter/Tests/WinterAppTests/OutputsBoxTests.swift) |
| Workspace and memory | Project/workdir-less workspace rules, output-directory handling, and assistant memory selection. Chat/Dispatch use assistant memory; workdir-less Code can use the assistant bucket. | These are shared facilities. Cowork has no prompt assembly or runtime mode mapping of its own. | [ContextAssembler](../packages/core/src/agent/context.ts), [system prompt](../packages/core/src/runtime-sdk/system-prompt.ts) |
| Session messaging | Host-backed SendMessage, ListAgents, TaskStop, and Dispatch's ListSessions are implemented for supported Code targets. | Their participation predicate reserves Cowork, but no supported Cowork target can be created. | [SessionMessaging](../packages/core/src/agent/session-messaging.ts), [ListSessions](../packages/core/src/agent/tools/list-sessions.ts) |
| Remote filtering | The daemon includes only eligible modes for remote clients and rejects operations on excluded modes. | Tests inject Cowork-shaped database rows to prove this filter. They do not demonstrate a working Mac or iOS Cowork session. | [IPC server](../packages/core/src/ipc/server.ts), [remote gate tests](../packages/core/test/ipc/remote-chat-gate.test.ts) |

## Repository boundaries

| Repository | Relevant completed work | Missing Cowork support |
| --- | --- | --- |
| `winter` | The host infrastructure and Mac scaffolding above. | Supported creation, persisted event identity, runtime mode, tool/prompt/permission policy, functional Cowork UI, and end-to-end coverage. |
| `winter-agent-sdk` | Generic agent execution and a host messaging bridge. `HostReachableSession.mode` is a host-supplied product-mode string. | No Cowork product implementation. Catalog comments about Cowork eligibility and reference-adapter mode placeholders are not evidence of one. |
| `winter-runtime-sdk` | Runtime routing and per-run homes for `code`, `dispatch`, and `chat`. | `RunMode` and `buildRunHome` validation do not accept Cowork. |
| `winter-ios` | Cowork navigation, icon, unavailable flag, and Coming Soon view. | Cowork has no functional screen, session-list backend, or creation flow. |

Sibling source references at the audited revisions:

- Agent SDK `bc7e128f`: [host session contract](https://github.com/yanlingLabs/winter-agent-sdk/blob/bc7e128f2af855741dd38a0a45fdd03eae4a44b3/packages/sdk/src/protocol/config.ts#L365), [host bridge](https://github.com/yanlingLabs/winter-agent-sdk/blob/bc7e128f2af855741dd38a0a45fdd03eae4a44b3/packages/runtime/src/messaging/host-port.ts).
- Runtime SDK `c5424202`: [RunMode](https://github.com/yanlingLabs/winter-runtime-sdk/blob/c5424202619cc8df2c8d18b832bfc52ad6fa35f7/src/run-home/types.ts#L29), [mode validation](https://github.com/yanlingLabs/winter-runtime-sdk/blob/c5424202619cc8df2c8d18b832bfc52ad6fa35f7/src/run-home/build.ts#L134).
- iOS `8435d0a4`: [availability](https://github.com/yanlingLabs/winter-ios/blob/8435d0a4b8ff0ac0ddd8a9e5b4b40893e46adca0/Winter/App/SessionMode.swift#L37), [placeholder route](https://github.com/yanlingLabs/winter-ios/blob/8435d0a4b8ff0ac0ddd8a9e5b4b40893e46adca0/Winter/App/AppShellView.swift#L305), [list filtering](https://github.com/yanlingLabs/winter-ios/blob/8435d0a4b8ff0ac0ddd8a9e5b4b40893e46adca0/Winter/Code/SessionListModel.swift#L74).

## What still blocks a functional mode

1. **Session identity and creation.** The [create schema](../packages/protocol/src/methods.ts), [session event schema](../packages/protocol/src/events.ts), [store](../packages/core/src/sessions/store.ts), and [daemon runtime type](../packages/core/src/runtime-sdk/create.ts) support only Code, Dispatch, and Chat. Dispatch separately refuses its reserved Cowork argument.
2. **Runtime and capabilities.** The [tool registry](../packages/core/src/agent/tools/registry.ts), [capability table](../packages/core/src/runtime-sdk/mode-options.ts), and runtime SDK have no Cowork mode. Its prompts, tools, permissions, and execution topology still need an explicit product contract.
3. **Connected surfaces.** The Mac composer controls and `/spawn` callback are placeholders. iOS also remains a placeholder, and the remote gate excludes a Cowork-shaped row. UI availability flags alone cannot close these gaps.
4. **Real execution coverage.** Tests for reserved predicates, injected database rows, and callback closures establish those helpers' behavior only. A functional mode needs tests through supported create, send, tools, resume, and its chosen client surfaces.

## Reading existing references correctly

- **Supported product modes and permission modes are different axes.** The SDK's older reference adapters expose permission-mode values where future product-mode metadata was anticipated. The current host messaging contract has a separate host-supplied product-mode string; neither implements Cowork.
- **There is no supported Cowork fallback.** The old `engine.ts` is gone. Current [session-driver](../packages/core/src/runtime-sdk/session-driver.ts) and [handoff](../packages/core/src/runtime-sdk/handoff.ts) helpers map an unknown raw mode to Code, while supported creation rejects Cowork. Old comments predicting a Chat fallback are obsolete; the Code fallback is not a way to enable Cowork.
- **Tool deferral is not roadmap deferral.** `deferred` in tool registration means schema loading through ToolSearch. It does not indicate that the tool or Cowork is waiting to be implemented.
- **Claude Cowork is an external comparison.** Mentions of that product in comparison notes or old vendor metadata do not describe a shipped Winter feature. Dated research and release notes remain historical records.

## Validation scope

The implementation map is based on source inspection. The cleanup changes documentation, comments, test names/wording fixtures, and model-facing availability wording; it does not add a mode or alter routing, schemas, lifecycle predicates, or UI availability.

Cleanup checks on 2026-10-10:

- Core: **248 tests passed**, zero failures, across session messaging/listing/spawning, lifecycle, directory and remote-gate IPC, workspace/assistant memory, system-prompt assembly, and Dispatch configuration (11 files).
- CLI: **201 tests passed**, zero failures, across mode handling, the session roster, and TUI commands (3 files).
- Core, Protocol, and CLI TypeScript checks passed.
- Protocol generation completed with no generated schema or fixture changes.
- Local links and repository diffs checked; Swift production edits are comments only. Agent SDK TypeScript edits are comments only.

Native Swift suites/builds and the full runtime end-to-end suite were not run. The changed Swift error fixtures retain the existing pass-through assertions. These checks validate the cleanup and existing helpers, not Cowork end-to-end execution.
