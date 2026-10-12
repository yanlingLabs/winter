# Independent review: subprocess floors, Core refusal and key formats

Date: 2026-10-12. Reviewed SDK `802806b6` plus nested-owner correction `20ce6139` and Workflow follow-up `d76114b0`, Core `df98d871`, and synthetic key fixture `fecd004a` (root cherry-pick `1249e55c`). **Scoped acceptance: the identified Workflow no-fallback omission is resolved in `d76114b0`; no blocker remains in these reviewed increments.** No complete H2, storage-security or Cowork production gate is accepted.

## Finding resolved: required Workflow broker could fall back locally

At SDK `20ce6139`, `winter-agent-sdk/packages/runtime/src/workflows/runtime.ts:143–158`, `realWorkerSpawner` checked only `currentHostCodeProcessClient()`. When that client was absent, it constructed the ordinary local worker and called `spawnProcess`, without checking `hostCodeProcessBrokerRequired()`.

The same condition at that revision's `runtime.ts:349` dropped `hostCodeScope` and `runId` when the client disappeared. `WorkflowRuntime.launch` had no required-broker check before `persistWorkflowScript` at `:317`, transcript creation or task registration. Thus a still-enrolled engine whose broker client was removed—or a trusted embedded lifecycle requiring a broker before one was installed—refused local Bash at `sandbox/spawn.ts:311` but could launch a local Workflow worker. Its ordinary Workflow sandbox does not replace host broker admission, owned transport or authority.

This was a concrete existing Workflow door missed by the initial engine-lifetime enrollment; it was not a demonstrated bypass of Core's new protected Chat/Dispatch refusal.

`d76114b042dba42ec768c8e9e99325dd3280bb84` resolves it with a shared `assertRequiredWorkflowBroker` at `runtime.ts:130–134`, invoked at launch entry `:312` before persistence/tasks and again at the real spawner `:149` before either normal or `sandbox:false` local execution. The latter protects direct callers independently of launch admission. Both checks are synchronous and use the same lifetime ownership as Bash. Ordinary unenrolled local Workflow execution remains unchanged. The new actual-WorkflowRuntime test proves empty persistence directories, no task/spawn side effects, both real-spawner modes refusing, and ordinary success after enrollment release. Independent execution passed **1 test, 9 expectations**. No additional native process fixture was run.

## SDK scope otherwise accepted

`sandbox/host-child-floor.ts:9–26` freezes rendered policy, unions nested owners' denies, refuses out-of-order removal, and restores the outer owner on normal nested release. The `20ce6139` correction prevents a nested registration from weakening an existing floor. Shared-realm overlapping session lifetimes remain unsupported; refusal on such an ownership mismatch is conservative, not a complete concurrent-owner API.

`prepareHostChildLaunch` is used at the actual hook-shell, MCP stdio, Git context/root/worktree and image-converter call sites. Both returned executable and arguments reach each OS launch. Bash and Workflow compose floor denies into their existing native profile, avoiding an inner sandbox invocation that could discard the intended combination. Absent registration preserves the previous command/argument path. Direct in-process file/context access remains explicitly outside this increment.

`engine.ts:2568–2616` now retains command-broker enrollment independently from the installed client for the full engine body and terminal cleanup; the release is in `finally`. The missing-client Bash test exercises the actual engine lifecycle rather than only an unused helper. Workflow now consumes that same requirement at both of its relevant doors.

## Core actual-use refusal accepted

`packages/core/src/runtime-sdk/create.ts:417–424` refuses active protected Chat/Dispatch topology. `host-code-broker.ts:369–379` wraps captured embedded spawners so later registration or a refresh prevents their use. `runtime-sdk/embedded.ts:275–299` independently refuses at the Core host, including a second check after host preparation, before calling an older SDK that may ignore new flags. `daemon.ts:1527` supplies the trusted home after fixture dependency overrides.

`embedded.ts:301–312` records the inactive Worker's actual empty floor in H3's retained-child ledger. Direct Worker closure retires only its stop callback; it cannot discharge the descendant obligation and permit newly protected roots. These checks are present at production use points. Core deliberately does not activate the SDK subprocess-only capability as a substitute for complete embedded containment, and does not silently switch to a native runtime.

## Synthetic key-format scope accepted

`apple/Cowork/WinterCoworkKeyBroker/Sources/KeyBrokerCore/KeyFormat.swift:7–45` admits only named 32-byte fixture and 96-byte XTS/HMAC profiles, derives lengths/layouts from the enum, generates independent 32-byte random components and rejects equal AES halves. `Identity.swift:29–34` binds the format ID, layout and length into domain-versioned AAD. Seal/unseal validates exact material, and relocation/KEK rotation preserve format and DEK bytes while rejecting old records in the volatile store.

`WorkerKeyFrame.swift:24–36` checks magic/version, bounded header and closed key lengths, exact total frame length, decoded identity/declared-length agreement and material validity. The real worker consumes that codec; versioned READY is checked before delivery. The inherited private descriptor and broker-selected record remain the authority; this frame is not a general authenticated external protocol. Old anonymous shapes, unknown fields/formats and cross-format transitions refuse.

No production custody, disk encryption, header/geometry authentication, guest transport, durable recovery or lifetime budget is implemented by this increment. Explicit buffer wiping does not prove all Swift/CryptoKit copies erased. The already documented `kb_wait_owned` post-kill blocking wait and premature `OwnedChild.waitStatus` reaped marking remain open; this review does not credit strictly bounded timeout cleanup.

## Independent evidence and limits

- Core actual-host/refusal/use-point tests: **3 passed, 7 expectations**, with the three subprocess fixture cases filtered out.
- SDK engine enrollment/startup-cleanup tests: **2 passed, 8 expectations**, six unrelated cases filtered out.
- SDK `d76114b0` actual Workflow missing-broker regression: **1 passed, 9 expectations**, 64 unrelated cases filtered out. The SDK worktree was clean at this check.
- All **nine** recorded key-fixture source hashes match the reviewed worktree. All **three** retained native binary hashes match the receipt in the root Winter checkout's `.build/debug`; the key worktree itself has no built binaries.
- The root's broader SDK/Core counts, Swift 20-test result and one synthetic process run were not repeated or relabeled as independent executions. No new process fixture, VM, real credential, live Winter state or Keychain access was used. Implementation files were not edited; this report is the only intentional repository write. The concurrently developed native-stream adapter is outside this review.
