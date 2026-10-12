# Cowork host query composition candidate

Source base: Winter `62c0bcf6`. The dependency pin remains Winter agent SDK
`0.0.53`. This patch adds an isolated host composition entry; the daemon, session
creation, runtime mode/router, UI, provisioning and availability are unchanged.

`packages/core/src/cowork/guest-query.ts` builds SDK query options from
`CoworkGuestRuntimeSupervisor.prepareQuery`. It accepts a canonical logical
conversation ID and explicit host permission/abort/diagnostic callbacks, never an
ordinary host options/configuration bag. Canonical model/backend/cwd/policy/resume
facts are captured with the fixed guest run-home/store locations in the existing
supervisor launch descriptor. The one-use closure checks the current canonical
snapshot and refuses an aborted query before opening the port. SDK argv/env do
not reach the port. Preparing a query does not start a process or reserve a disk.

Only the existing confined Read/Edit/Write/foreground Bash visibility slice is
derived from the admitted tool-class ceiling. The builder supplies fixed empty
environment, settings-source, plugin, skill and MCP selections. `allowedTools` is
empty: a visibility ceiling is not pre-approval. Ordinary host credential
resolvers, hooks, host messaging, provider connection configuration and run-home
construction are absent. Compatible guest context/extension/subagent routing is
still separate work.

The existing Winter policy mapping is retained: `auto` and `ask` map to SDK
`default`, leaving policy decisions in the explicitly supplied host bridge.
Passing product `auto` directly to the SDK would invoke a different internal
classifier path. The regression supplies a scripted permission request containing
Winter's actual reviewer escalation reason and checks that the host `auto` bridge
creates a card and returns the user's denial. It does not execute that classifier.

The installed SDK does not declare or serialize `executionPosture`. This builder
retains an explicitly typed posture field for compatible future SDKs, while the
existing fixed supervisor descriptor independently carries `confined-guest`.
This is not a replacement SDK capability or permission to use local startup.
Unsupported/absent supervisor capabilities still refuse options preparation.

`packages/core/test/cowork/guest-query.test.ts` runs the installed SDK's actual
`query()` parser against disposable scripted supervisor streams. It composes
the real `canUseToolFor`, approval/question brokers, permission gate, projector
and SQLite projection checkpoints. The harness stamps approval events as the
host append boundary would; it does not launch a daemon. The existing projector
and bridge use Code semantics in this harness because production Cowork mode is
not yet implemented. No mode fallback is registered.

Covered behavior: canonical/frozen options; rejected extra callback fields;
visibility without pre-approval; stale model/resume/source/policy/instructions;
aborted startup; one-use spawn and ignored SDK launch parameters; prompt/frame
delivery; permission card/denial; interrupted-call withdrawal before tool-result
projection; assistant/terminal projection; revocation preventing a delayed
permission response; malformed JSON/discriminators and output bounds; and
ownership retention through EOF/exit until an independent matching receipt.
Scripted receipt flags are test-double values, never OS termination evidence.

Validation commands (from this isolated worktree):

```sh
cd packages/core
bun test test/cowork/guest-query.test.ts test/cowork/guest-runtime.test.ts
cd ../..
bun run typecheck:core
git diff --check
```

Focused result: **55 passed, one existing opt-in candidate-SDK check skipped,
234 assertions** across the two files. Core typecheck and whitespace checks pass.

The existing candidate-SDK confined-startup refusal test is skipped unless
`WINTER_TEST_GUEST_SDK` is explicitly supplied. It tests SDK rejection, not Linux
execution. The new composition tests run against the installed SDK without that
environment override. No candidate SDK, native helper, Linux engine, VM, live
home, Keychain or real provider is executed by this patch's validation. There is
no signed worker/stream port, native provider bridge, egress implementation,
durable guest continuation or production activation proof. Both held native
lanes remain untouched and all production provisioning/capability gates remain
false.
