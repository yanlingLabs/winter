# RAW volume backup-check lock and plist correction

Date: 2026-10-12. Base: `ca0d5316abfe7d0275115446f20c21c9dd88e82b` on `cowork/v1-raw-volumes`. This addresses the queued MED backup subprocess lock duration and LOW serialization-fragility follow-ups. It is implementation evidence pending independent re-review, not native worker or production acceptance.

## Backup subprocess boundary

Previously `plan` re-admission, `claim`, `open` and `release` called the combined named `tmutil isexcluded` check from their `IMMEDIATE` transaction callbacks. Each subprocess could wait for its five-second timeout while holding the runtime-state writer lock.

Allocated images are now opened and checked by the named backup adapter before entering that transaction, with descriptors pinned until the decision completes. The locked operation reauthorizes and rereads the current canonical rows, repeats ownership/state checks, rewalks the recorded directory/image identity, and verifies geometry and sticky metadata on the pinned descriptors through a new mandatory `verifyDescriptorExcluded(fd)` adapter method. The default is descriptor-only `fgetxattr` plus bounded plist parsing; it performs no subprocess or named-item operation. The trusted adapter contract forbids those effects in this method. Named exclusion/cross-checks also have a central `db.inTransaction` refusal, protecting future accidental use inside a transaction.

`plan` now rejects caller-owned transactions before admission, as the other public allocation/lifecycle methods already do. Its existing allocated-image re-admission can therefore never run a named helper under a caller's outer transaction. Creation checks sticky metadata again inside its sizing/publication transaction. Canonical owner and immutable creation bindings are not accepted from a stale preflight snapshot. Pending descriptors close on preflight failure, failed locked revalidation or transaction-completion failure; successful `open` publishes its local handle count only after transaction success. The R1 guards and the earlier completion-error cleanup remain covered.

Tests assert `!db.inTransaction` in both named backup helpers across allocation, re-plan, claim, open and release, and observe the cheap descriptor check inside locked operations. Three boundary regressions mutate sticky exclusion, replace the named image, or change canonical ownership after external preflight but before transaction acquisition. Each is refused at locked revalidation; the pending real descriptor reports `EBADF`. The replacement bytes and original ownership are preserved when applicable. These fixtures inject metadata policy to exercise the seam and do not claim a hostile concurrent native process was tested.

## Bounded metadata decoding

The sticky xattr is no longer compared with one exact serialized byte sequence. At most 256 bytes of `bplist00` metadata are passed to CoreFoundation's native `CFPropertyListCreateWithData`; only a string root with the exact length and bytes of `com.apple.backupd` is accepted. This handles equivalent ASCII/Unicode strings and integer/offset widths. Malformed/truncated data, other scalar/root types, incorrect or NUL-containing values, oversized metadata, XML and unknown binary versions refuse. Native data/plist objects are released on every path. No external `plutil`, package dependency or custom recursive parser is added.

FFI signatures were checked against the installed SDK's `CoreFoundation` headers (`CFPropertyList.h:131`, `CFData.h:25`, `CFString.h:294`). Apple's binary plist format describes ASCII and Unicode string encodings and variable integer/offset widths, which motivated parsing the value rather than comparing serialization. [Apple CoreFoundation binary plist format](https://raw.githubusercontent.com/apple-oss-distributions/CF/main/CFBinaryPList.c)

The fixture test accepts 18 equivalent string encodings and rejects malformed and incorrect roots/values. The real disposable tmutil exclusion test also passes using native descriptor-read metadata, including sticky exclusion surviving rename and no item marker applied to shared outputs.

## Validation and limits

Tests/typechecks were held until the root agent reported the concurrent native VM run complete and workers reaped. Recreated the exact isolated dependency links documented by the preceding correction, then ran:

```sh
pnpm typecheck:core
bun test packages/core/test/cowork/volumes.test.ts
bun test packages/core/test/cowork/volumes.test.ts packages/core/test/cowork/repository.test.ts packages/core/test/cowork/admission.test.ts packages/core/test/runtime-state/db-run-folder.test.ts
git diff --check
```

Core typecheck passed. Volume tests: **25 passed, 0 failed, 333 expect calls**. Focused four-file coverage: **73 passed, 0 failed, 669 expect calls**, Bun `1.3.14 (0d9b296a)`, approximately 3.24 seconds. No broader 27-file suite or native build is claimed. Temporary dependency links were removed before commit; no dependency, lockfile or SDK-pin changes were made.

Named tmutil operations remain non-atomic against transient same-user path swaps; identity bracketing detects persistent drift without promising no metadata side effect on a transiently substituted name. Plaintext v1 storage/encryption deferral is unchanged. No relocation, missing-image enrollment, replacement, cleanup or auto-adoption path is added. Controlled relocation/recovery, physical disk admission, actual authenticated worker/descriptor transfer/native stop, guest formatting/readiness and production resource/security gates remain separate work. No live Winter app/daemon/home, credentials, Keychain, global/volume backup policy, VM, push, merge, release or pin was touched.
