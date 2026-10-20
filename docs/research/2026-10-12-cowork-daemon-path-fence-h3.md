# Daemon file consumers: H3 follow-up

Implementation base: `65bab476` on `cowork/host-authority`. This is a focused implementation and fixture report, not a production Cowork acceptance record.

## Implemented boundaries

`packages/core/src/runtime-sdk/daemon-path-fence.ts:12` applies the existing `homeFenceFor` / `hostStorageReadTarget` / `homeFenceTarget` policy to Core-owned consumers. Home identity comes from daemon dependency wiring, never model tool arguments. Direct reads retain ordinary project and Cowork shared-content access. Read/write self-grant behavior stays in the existing permission policy; this helper does not grant extra access.

| Consumer | Actual checks |
| --- | --- |
| LSP capability | Argument and server root checked before manager contact (`agent/tools/lsp.ts:235`); file content rechecked after awaited server acquisition (`:277`); every returned definition/implementation preview uses the same checked reader (`:99`). |
| Office capability | Docs, sheets and slides check their resolved path before app reach/dispatch (`agent/tools/docs.ts:600`, `sheets.ts:718`, `slides.ts:561`). Read/info use the read fence; mutation verbs also use the write fence. |
| Browser uploads | `computer-use/browser/upload-paths.ts:65` checks registered storage independently of the sandbox's wildcard list; `:104` and `:109` check again at source opening/copying. Existing O_NOFOLLOW and device/inode checks remain. |
| File-diff hooks | Snapshot precheck and checked descriptor read (`runtime-sdk/hooks.ts:1445`, `:1454`); post-call checked read (`:1483`). Protected paths produce no stored diff or model context. |
| Auto-diagnostics | File and root checked before LSP contact, content checked afterward (`agent/lsp/auto-diagnostics.ts:137`). |
| Plugin hooks / LSP server processes | Their real spawn points use the SDK's `applyMandatoryFloorToSpawnOptions` after executable resolution (`plugins/hook-runner.ts:114`, `agent/lsp/client.ts:245`). Returned command/args preserve the inherited kernel floor for descendants. Missing installed capability refuses protected launches, with no unprotected fallback. |

`readDaemonTextFile` resolves permissible symlinks, checks the resulting target, opens with O_NOFOLLOW, compares the opened descriptor to the current named regular file, checks the fence again and reads the descriptor. This preserves normal in-root symlink reads while blocking registered sensitive aliases. These checks remain defense in depth against path races; they are not equivalent to kernel confinement of the credential daemon.

Daemon bootstrap/hot LSP-manager wiring and capability construction supply `winterHome`. Optional homes and the optional native floor adapter retain standalone test fixtures; production wiring supplies the home and uses only the installed SDK adapter.

## Registration and descendant evidence

`host-storage-fence.ts:38` rejects a registration if any current or retired daemon child inherited a weaker floor than the newly required registered roots. The record is captured from the exact prepared spawn descriptor before process creation; parent close removes its live stop callback but retains descendant evidence for the daemon lifetime (`:152`). A stop request never counts as descendant-stop proof.

The descriptor already protects whole registered Cowork/runtime-authority/coordination roots, so adding workspaces beneath existing roots changes no floor and remains usable. Bootstrap registration before child launches also works. Introducing a genuinely new protected root after unprotected hooks/LSP servers ran requires a fresh daemon or a future independently verified native descendant-drain receipt. Registration rolls back and storage provisioning must remain blocked on an uncertain descendant lifetime. This change does not invent a descendant receipt.

## Verification

Focused command from `packages/core`:

```sh
WINTER_TEST_FLOOR_SDK=/absolute/path/to/candidate/packages/sdk/src/mandatory-floor.ts bun test test/runtime-sdk/daemon-child-floor.test.ts test/runtime-sdk/daemon-path-fence.test.ts test/runtime-sdk/hooks.test.ts test/agent/tools/lsp.test.ts test/agent/tools/docs.test.ts test/agent/tools/sheets.test.ts test/agent/tools/slides.test.ts test/capabilities/lsp.test.ts test/capabilities/office.test.ts test/plugins/hook-runner.test.ts test/agent/lsp/manager.test.ts test/runtime-sdk/cowork-host-fences.test.ts test/runtime-sdk/host-code-broker.test.ts
```

Observed: **383 pass, 0 fail, 1480 expectations, 13 files**. `pnpm typecheck:core` passed. `git diff --check` passed.

The explicitly supplied candidate was the workspace SDK checkout at `8ff82c6648121ca12935906dc593fdcbdee3d9c3`. The native fixture uses the modified real HookRunner/LSP spawn paths and the candidate SDK API, with disposable homes and only fixture bytes. Both children refuse private-volume reads while ordinary hook writes work. A second isolated process proves retired hook parent exit does not permit activation of a previously unprotected root. No VM, live app/daemon/home or Keychain was used. This does not prove the installed/released SDK carries the capability; that SDK remains unpinned and fails closed for active protection.

## Boundaries still requiring separate acceptance

- Office executes asynchronously in the Mac app after the Core pre-dispatch check. This report does not establish app-side kernel confinement or immunity to adversarial concurrent path replacement while an office command is queued.
- Arbitrary same-user deletion/corruption, service delegation and authenticated Winter API plaintext access are outside the selected disk encryption protection. No same-user confidentiality claim is made.
- Repository search found no Core shell recognizer for `!` messages. The SDK command seam recognizes slash commands; its actual Bash/Monitor execution uses `runCommand`, handled in the independent SDK H2 work. This change does not claim an invented `!` call site was fixed.
- Native descendant-drain receipts, SDK release/pin, worker/VM integration and full production end-to-end gates remain separate work.
