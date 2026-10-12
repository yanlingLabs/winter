# Cowork conversation supervisor transport slice

Implemented on `cowork/guest-supervisor`, a separate worktree based on output integration `f9fcbe5e`, then fast-forwarded to coherent composition `3eb4d229` (schema 9 and accepted raw-volume primitives). No SDK edits, package pin, release, VM run or live-state access occurred.

## Implemented executor

`packages/core/src/cowork/guest-runtime.ts` is a host-side executable conversation bridge for an injected authenticated native supervisor channel. It reads the existing canonical Cowork repository, source grant resolver and host session-identity resolver. No second authority/store database, disk lease or volume owner record is created. Launch records bind home, authenticated guest boot, workspace incarnation/lease epoch, config/grant/instruction/policy/binding revisions, logical session, backend identity and a unique launch ID. Native stream protocol version 1 and the bounds are fixed in the descriptor/channel handshake. Immutable descriptors contain no arbitrary command, argv, host path, caller environment or credential field.

The frozen runtime config always requests `confined-guest`, persistent SDK stores and the host-selected model/backend identity. Stores use `/workspace/.winter/conversations/<session-id>` on the accepted data-volume mount. Folder cwd uses `/workspace/folders/<grant-id>`, repository cwd `/workspace/repos/<repo-id>`, followed by the canonical validated relative cwd. The generated runtime home is ephemeral under `/run/winter/conversations/<session-id>`. The bridge never stats these guest paths on the Mac. Protected native preparation must materialize them and enforce the accepted mount/storage skeleton.

The returned `SpawnedRuntimeProcess` is directly consumed by the real SDK query/parser. Split init/result frames, user input and the SDK set-model request/response work through it. Streams are already demultiplexed/authenticated by the worker/helper port; Core does not parse guest packets or take arbitrary descriptor requests. The bridge caps decoded output chunks at 256 KiB, incomplete NDJSON frames at 1 MiB, and queued unacknowledged input at 2 MiB. Input is serialized with private-channel acknowledgment; loss stops subsequent queued input without replay. Output iteration performs no prefetch; the native port must preserve bounded upstream queues/backpressure as part of its implementation.

Current source grants, source readiness and captured authority/identity revisions are rechecked before launch returns, before queued input is sent and before output is relayed. Policy changes during launch stop and retain that attempt. Changes to canonical resume identity never rewrite an active lifetime's captured identity. Two conversations cannot accidentally share one backend lifetime in this executor.

Primary stream EOF closes new input admission and requests native drain. Runtime exit, EOF, kill, a timeout or a PID alone never release conversation admission. A separate port result must confirm stopped descendants and released protected SDK-store ownership for the exact original scope/launch. Missing, uncertain, rejected or mismatched evidence retains recovery debt. This is a trusted native contract, not proof established by an acknowledgment string or JavaScript map. Confirmed evidence enables a new cold descriptor with the same host-owned backend identity, explicit resume and unchanged durable store path. Shutdown closes new starts and asks native owners to drain; it does not manufacture termination proof.

## Required production adapter and boundaries

No production port ships here. The native worker owner must authenticate the channel, immutable runtime image and admitted boot; supply actual complete tool compartment coverage; integrate the SDK `ProtectedStoreOwnershipPort`; and coordinate with the existing `CoworkVolumes` owner, disk claims and native stop evidence. Conversation SDK-store release is separate from release of the workspace's two volumes. This executor never calls volume release and must not be used to infer workspace disk safety.

Absent a port or complete negotiated runtime support, the executor refuses before launch. The actual current SDK advertises `supportsConfinedGuestExecution:false` and rejects the posture before settings/providers/tools or durable stores start. Its existing guest foundations have protected store capability interfaces and confined Read/Write/Edit/foreground Bash routes, with unsupported routes refusing. Complete confinement, native ownership and durable guest boot are still missing. No Cowork session mode, availability switch or daemon fallback was enabled.

Host provider/approval/connector routes, explicit shared instruction injection, real guest source preparation, full tool routes, saved-authority/subagent restoration, signed runtime installation and VM process/device integration remain required. The tested continuation is host descriptor/lifetime mechanics, not a real saved guest transcript or cold parent/child restoration. These boundaries preserve the accepted first-version plaintext-image and same-user residual policy without adding outer floors to normal native Code.

## Evidence

The isolated actual SDK startup fixture at SDK `bbab87d9` calls its production `runEmbeddedSession` with `confined-guest` in a subprocess. It redirects every potentially writable home/store path to disposable directories. It observes exit 1, empty runtime stdout (no init), the posture refusal on stderr, and no durable store creation. This proves the current refusal boundary, not confinement enforcement. Test paths, bytes, DBs and coordination are disposable; the test does not launch a VM, call native confinement workers or access Keychain.

Focused supervisor tests exercise actual SDK frame decoding and control roundtrip plus absent support/port, source revocation/stale ACK, policy change during launch, backend collision/change, EOF/runtime-exit/kill retention, mismatched boot and teardown proof, input ACK failure, bounds, shutdown and cold descriptor continuation. Validation: **86 pass, zero failures, 943 expectations in five suites**, including 18 supervisor tests and the opt-in actual SDK subprocess refusal fixture. `pnpm typecheck:core` and `git diff --check` pass. The focused command from `packages/core` is:

```sh
WINTER_TEST_GUEST_SDK=/absolute/path/to/winter-agent-sdk bun test test/cowork/guest-runtime.test.ts test/cowork/repository.test.ts test/cowork/admission.test.ts test/cowork/session-messaging.test.ts test/ipc/cowork-workspace-api.test.ts
```

Runtime support remains false and no production native port is registered. The executor is exercised through the real SDK transport seam in tests; daemon Cowork creation and the actual guest Linux supervisor remain refused/unimplemented. This is a bounded integration foundation, not completion of production guest execution or the Cowork gates.
