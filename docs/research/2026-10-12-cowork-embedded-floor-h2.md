# Core embedded floor refusal: H2 follow-up

Base: `4257a8ad` on `cowork/host-authority`. This implements Core's interim refusal of protected embedded execution. It does not implement or claim complete containment of an in-process runtime.

## Runtime wiring

- `packages/core/src/runtime-sdk/create.ts:417` checks host-owned registered storage at Chat/Dispatch topology selection and returns `EmbeddedRuntimeUnavailable` when a persistent floor is required. It keeps the embedded topology and never silently resolves a subprocess binary.
- `runtime-sdk/host-code-broker.ts:369` now returns a guarded captured spawn closure. Every invocation checks current protected storage, refresh state and a supplied `requireHostFloor` / native-floor spawn command before calling the embedded host. A closure obtained while storage was inactive cannot launch after later activation. `assertQueryOptions` also rejects registered embedded closures under active protection (`:362`).
- `runtime-sdk/embedded.ts:275` independently checks the actual Core host before invoking the SDK's Worker bridge, then checks again after host command preparation at `:296`. It refuses both explicit floor requirements and active registered storage itself. This is Core enforcement and works with the installed older SDK, whose Worker bridge need not understand the new flag.
- `daemon.ts:1527` supplies `winterHome` after the optional fixture dependency spread, so production embedded hosts cannot omit or replace the trusted home. The test override type excludes that field.
- Inactive embedded Workers record their actual inherited empty floor at `embedded.ts:305` using H3's daemon child ledger. Live and retired Workers both retain descendant activation debt; Worker close and best-effort process-group kills do not prove all descendants stopped. Introducing new protected roots after these Workers ran refuses coordinator registration. Retiring the live callback does not erase the ledger.

Ordinary inactive Chat/Dispatch remain embedded. Standalone transport fixtures may omit a daemon home; production always supplies it. No model selection, credentials, runtime topology or SDK pin changed.

## Verification

From `packages/core`:

```sh
bun test test/runtime-sdk/embedded-floor.test.ts test/runtime-sdk/embedded.test.ts test/runtime-sdk/create.test.ts test/runtime-sdk/host-code-broker.test.ts test/runtime-sdk/cowork-host-fences.test.ts test/runtime-sdk/daemon-path-fence.test.ts test/runtime-sdk/daemon-child-floor.test.ts
```

Observed: **109 pass, 1 skip, 0 fail, 499 expectations, 7 files**. The skipped test is H3's optional native child-floor candidate test because this run did not supply `WINTER_TEST_FLOOR_SDK`; its earlier native evidence remains in the H3 report. `pnpm typecheck:core` and `git diff --check` passed.

New tests exercise active Cowork topology refusal and a previously captured spawn closure through a real router handle. Actual Core host tests use an older Worker seam that would ignore new flags and prove it is never called. Another test activates protection during host preparation and proves the final use-point recheck refuses before constructing a Worker.

Three separate subprocess fixtures prevent historical global floor evidence from contaminating unrelated in-process test homes:

1. A real live embedded Worker refuses new storage registration; requesting its kill does not count as descendant-stop proof.
2. A real completed embedded Worker still refuses new storage registration after its own close.
3. A real `startDaemon` on a disposable home refuses protected Chat/Dispatch topology, direct `daemon.embedded.spawn` and its captured topology closure, proving the trusted-home production wiring is effective.

Fixtures use test models, disposable homes, isolated coordination and injected file secrets. No live Winter app/daemon/home, real credentials, real Keychain, VM, release or pin was touched.

## Separate remaining work

The SDK candidate's independent broker requirement and trusted `hostChildFloor` subprocess coverage are a separate change. This Core patch deliberately remains fail closed until complete embedded containment is accepted; adding descendant floors alone is not permission to run the in-process runtime with active protection. SDK release/pin and full Cowork production end-to-end gates remain open.
