# Core integration of live embedded path protection

Base `983e350b`, branch `cowork/host-authority`. SDK API source reviewed at `8892eaff138e80b1405e4d477e4370c061b026a8`; capability declaration at `bf5daf701ae427a42a4920dbea65ee98613b8ddc` is unchanged in the SDK evidence handoff `d7d4688b5a2f824d02e470831f6dc05468d5b985`. No SDK release or Winter pin changed.

## Implemented integration

`packages/core/src/runtime-sdk/embedded-path-protection.ts` maps the existing canonical fences into immutable, sorted `HostCodeProtection` snapshots. Read paths cover participating-home runtime/run/socket roots, coordination, Cowork controls and workspace manifest/volume/control entries. Write paths use the existing home fence. Generated run homes under cache and SDK memory/transcripts are not blanket read-denied. Ordinary native Code retains its reviewed execution behavior; no native process floor or sandbox-disabling/GPU/LSP overrides were introduced.

The snapshot travels as trusted `spawnEmbeddedWorker.hostCodeProtection`, never RuntimeConfig, model arguments or environment. `embedded.ts` detects the installed namespace's exact v1 capability and coverage declaration. Policy revisions advance only on changed path arrays. Its trusted `refreshProtectedPaths` control awaits every live Worker's private `updateHostCodeProtection` revision acknowledgment. A mismatch or rejected/timed-out SDK acknowledgment prevents successful policy activation; there is no synthetic receipt.

Complete coverage uses live acknowledgment without killing/recreating the Worker. The driver callback delegates Chat/Dispatch updates to that Worker host when the complete contract is available. For cold protected embedding, a separate held `startAfter` barrier waits for the Worker's matching acknowledgment before releasing the engine. Failed acknowledgment leaves that barrier unresolved and closes the Worker. Lifecycle `start` is emitted only after the barrier releases. This also avoids trusting an older Worker that silently ignores new snapshot options.

**Source advertisement is not independent acceptance.** The installed SDK has no capability marker. The `8892eaff` / `bf5daf70` candidate advertises six file tools and command guarantees with context version 0. The subsequent `32b9b753740fc35d64c7cea999a2399ca8aa2250` context-source candidate advertises version 1 and nine explicit source-reader families, but its independent review found a cached-source provenance bug after symlink retargeting. Core therefore retains `ACCEPTED_EMBEDDED_CONTEXT_VERSION=0`. Complete support requires both the advertised exact v1/family contract and a separately reviewed Core acceptance version 1; source metadata alone cannot open the gate. New/captured protected Chat/Dispatch embedding remains refused. Existing uncovered Workers still require actual closure before provisioning.

Acknowledgments apply to subsequent guarded operation checks/new sandboxed launches. They do not cancel an already checked/in-flight operation, erase previously loaded context or prove native child termination. No claim of atomic filesystem or same-user confidentiality is made.

## Context/source audit

The original `8892eaff` SDK change guards Read, Write, Edit, NotebookEdit, Glob, Grep and shared scan pruning, plus path additions to the existing Bash/Monitor profile. It did not establish direct source/context reader coverage. Its uncovered inventory was: Confirmed examples in `winter-agent-sdk/packages/runtime/src`:

| Reader | Direct use points in the reviewed source |
| --- | --- |
| Instruction/context injection | `context/injection.ts:74`, `:95`, `:110` |
| Instruction imports | `context/imports.ts:207` |
| Rules/output styles | `context/rules.ts:131`, `context/output-styles.ts:165`, `:216` |
| MCP settings | `settings/loaders/mcp-config.ts:85`, `:203` |
| Skill bodies/header reads | `skills/loader.ts:209`, `:234` |
| Agent definitions | `subagents/definitions.ts:334` |
| Plugin sources/config | `plugins/loader.ts:167`, `:231`, `:338`, `:398`, `:444`; `plugins/manifest.ts:124`; `plugins/installed.ts:62`, `:118`, `:151` |

The later `32b9b753` candidate routes these families plus settings/startup, commands and workflow source readers through a shared reader, rechecks async content and invalidates instruction caches. Static inspection confirmed those new boundaries and the narrow own-MCP control exception. Independent acceptance remains pending the symlink-retargeted cached provenance fix; this report does not accept that candidate as complete. Trusted fixed store/control operations must remain distinct from arbitrary model-selected source aliases; a path named settings.json or located under a run home is not an exemption to read a protected symlink target. The SDK author has the exact Core read mapping; it excludes own generated run homes and legitimate SDK config files from blanket read denial.

## Verification

With an explicit local SDK checkout binding:

```sh
WINTER_TEST_PATH_PROTECTION_SDK=/absolute/path/to/winter-agent-sdk bun test test/runtime-sdk/embedded-live-path-protection.test.ts test/runtime-sdk/embedded-path-protection.test.ts test/runtime-sdk/embedded-floor.test.ts test/runtime-sdk/embedded.test.ts test/runtime-sdk/create.test.ts test/runtime-sdk/host-code-broker.test.ts test/runtime-sdk/session-driver.test.ts test/runtime-sdk/winter-session.test.ts
```

Observed initial focused regression: **281 pass, zero failures, eight files, 1311 expectations**. The additional bootstrap-failure case passed separately in the six-test protection suite. Final four-suite guard regression: **78 pass, zero failures, 271 expectations**. Core typecheck and diff checks passed.

The isolated actual candidate Worker tests exercised `bf5daf70` and then `32b9b753` through the Core mapper/control and real SDK private channel: first Read is permitted before fixture registration, the host then receives a live policy acknowledgment, the next Write is denied and the fixture bytes remain unchanged. An environment request to disable protection has no authority. The test asserts protected context execution remains unavailable through the independent Core acceptance gate and makes no production/whole-context claim. Synthetic complete-contract tests separately check live Worker preservation, exact revision mismatch refusal, held cold bootstrap and refusal before engine start; they do not independently accept a real SDK context-version-1 implementation. The final seven-test mapping/channel/bootstrap suite passed with 32 expectations against the local context candidate, keeping Core acceptance zero.

All homes, coordination and bytes are disposable fixtures. No VM, live Winter app/daemon/home, real Keychain or credentials were used. Platform Swift/SourceKit/Chromium parity remains the independently recorded SDK evidence, not a claim established by this Core Write test.

The user subsequently deferred per-workspace encryption for the first usable version. Private disk images are plaintext at that stage, relying on file permissions and macOS/FileVault where enabled, with weaker same-user/copied-image protection explicitly accepted. VM isolation, host credential separation and active RAM return remain required. This path policy is defense in depth and does not restore a persistent outer floor around approved native Code or make native key custody/encryption a first-version activation prerequisite.
