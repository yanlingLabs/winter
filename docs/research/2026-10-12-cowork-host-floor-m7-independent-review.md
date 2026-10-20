# Independent review: host-floor enrollment, daemon consumers and child progress

Date: 2026-10-12. **Scoped acceptance: no blocking defect found in the submitted H1/H2 interim, H3 or M7 changes.** This does not accept full embedded filesystem coverage, the complete Cowork security gate, cold-restart continuity or production integration.

The reviewed changes are SDK `8ff82c6648121ca12935906dc593fdcbdee3d9c3`, Winter H3 `79779a1c8a0164c54487d44218d785b4e11a011d`, and Winter M7 `2654426181f1ad611df7f5542490587a9d6af620`. They were read through their exact commit diffs and surrounding call sites. During review, the H3 checkout advanced through test cleanup `b4d100b9` and the unchanged M7 cherry-pick `8e049648`. The root agent separately began additional mandatory-floor tests and an ancestor flags/xattr change in the SDK. Those new changes are outside this acceptance.

## H1/H2 interim assessment

- `winter-agent-sdk/packages/runtime/src/embedded-host.ts:116–119` rejects a required floor before Worker construction, including the trusted spawn marker and an existing native `sandbox-exec` wrapper that a Worker adapter would otherwise discard.
- `packages/runtime/src/embedded.ts:240–244` rejects a required floor before config parsing, protected-store acquisition, engine execution or tool startup. Ordinary embedding remains available. This is a refusal path, not an implemented per-session kernel floor for Bun Workers.
- `packages/runtime/src/sandbox/host-code-process.ts:22–30` keeps broker requirement ownership independent of client installation. `sandbox/spawn.ts:308–312` rejects a missing required broker before local command execution. A present broker's refusal is propagated through the brokered path without a local retry.
- The trusted Worker lifecycle carries `brokerRequired`; untrusted config/environment values do not remove it. `embedded.ts` releases ownership in terminal cleanup, including startup failure. Nested requirement releases are idempotent.
- `packages/sdk/src/mandatory-floor.ts:82–104` refuses a required empty floor, captures a copied floor, wraps the resolved native command and marks the spawn. Arbitrary host-supplied transports remain trusted code: they must preserve the actual native launch or refuse. The marker alone is not enforcement.

The command broker remains a realm-scoped capability. The supported topology uses one runtime process or Worker realm per session; this review does not approve concurrent independent direct embedded sessions sharing one mutable module realm. Full H2 file access, extension subprocesses and transition-drain coverage remain open as documented in `winter-agent-sdk/docs/host-code-authority.md`.

## H3 assessment

Production consumers receive the daemon-owned home, including Office/LSP capability construction (`packages/core/src/daemon.ts:1449,1462`), HookRunner (`:1873`), initial LSP manager (`:2459`) and hot recreation (`:2676`). Standalone tests may omit it; no production omission was found among the modified call sites.

`packages/core/src/runtime-sdk/daemon-path-fence.ts:12–33` applies current canonical/alias-aware policy, opens a resolved regular file without following a final-component symlink, checks descriptor/named identity and rechecks before reading. LSP argument/previews, auto-diagnostics, pre/post diff reads, Office dispatch and upload copy paths use it or its assertion. Rechecking after awaited LSP acquisition handles protection changes while waiting. Office remains an asynchronous external consumer: its pre-dispatch check is not app-side kernel confinement or a proof against queued path replacement.

Real HookRunner and LSP spawn points pass the SDK-prepared command/arguments to the OS. `daemon-path-fence.ts:46–59` refuses when active storage requires an unavailable SDK capability; ordinary inactive launches need no floor. The native fixture exercises the actual modified spawn paths rather than only inspecting profile strings.

`host-storage-fence.ts:35–40,147–174` is conservative about late registration. Live and retired child floor records are retained; direct-child close only removes a stop callback, not evidence of potentially surviving descendants. A new registration requiring protection absent from a historical floor is rolled back and rejected. A stop request does not count as termination proof. Existing protected roots cover additional workspaces without pretending to have covered a new root. This acceptance does not supply a native descendant-drain receipt.

One non-blocking comment correction is advisable: `daemon-path-fence.ts:10` says directory scans/server roots include ancestors, but current LSP root callers use the default `read` mode rather than `scan`. Broad ordinary roots therefore remain permitted; inherited child floors protect the relevant descendants. Document that actual division instead of implying those root calls reject ancestor scans.

## M7 assessment

`packages/core/src/runtime-sdk/winter-session.ts:502,1114,1456–1486` keeps progress lineage in the incarnation, records immediate parents at start, removes a child's link at completion and propagates progress through known ancestors with a visited set. Grandchild activity resets a waiting ancestor's stall window; unrelated children do not receive that refresh. Late frames from a completed child no longer traverse its removed parent link. A malformed cycle terminates after one visit per thread.

The existing same-driver `open()` waits for `lastDone`; the new map is constructed afresh for the new incarnation. Ending an old incarnation does not share this map with a replacement driver. This is progress bookkeeping only. It does not persist ancestry, reopen completed roster rows, or prove SDK child identity/history recovery after a cold restart; those mechanisms require their own integration evidence.

## Independent execution evidence

| Run | Observed result |
| --- | --- |
| SDK `embedded.test.ts`, `embedded-guards.test.ts`, `sandbox/host-floor-enrollment.test.ts` | **33 passed, 0 failed, 126 expectations**, three files; ordinary concurrent Workers, Bash, abort/cleanup, workflow command restoration and required enrollment covered. |
| H3 `daemon-child-floor`, `daemon-path-fence`, LSP tools/capability/manager, Office capability and HookRunner suites | **73 passed, 0 failed, 265 expectations**, seven files; explicit candidate SDK floor path supplied to the isolated native fixture. |
| M7 `winter-session.test.ts`, selected ancestry/incarnation/late/predecessor lifecycle cases | **36 passed, 0 failed, 260 expectations**, 50 filtered; includes both new ancestry tests and existing end/resume lifecycle behavior. |

These were review-checkout runs, not a claim of exact clean-head release verification: concurrent parent edits were observed at the end, including the SDK ancestor flags/xattr change. The accepted source scope remains the three commits above. The root agent's reported broader counts and typechecks were not rerun or promoted to independent results here.

Tests used the repositories' isolated preload guards and disposable fixtures. No live app, daemon, home, VM or Keychain was accessed. No implementation file was edited, no commit was made and nothing was pushed. This report is the only intentional repository write from this review.
