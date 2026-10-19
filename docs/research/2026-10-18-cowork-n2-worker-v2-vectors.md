# Cowork N2 S3: the worker re-pinned to contract text version 2

Status: source and VM-free tests, 2026-10-18. No worker, VM, sandbox call or Hypervisor call was run. This note extends `2026-10-17-cowork-n2-worker.md`.

## What moved

Integration `8b52ef83` carries two contract changes since the worker's last pin (`6c1f04e8`):

* **Text version 2 (the retained-receipt MAC, `324eb08da`).** Every L1 line and every stop receipt carries `"v":2`; the L1 `begin` line gains a last key `receiptKey` (the installation's 32-byte HMAC-SHA256 key, base64); a Class A receipt gains a last key `mac`. The binary headers (L2 `WEV1`, L3/L4 `WMX1`, both version 1) and the JSON inside mux frames (`"v":1`) are unchanged.
* **The empty OUT/ERR rule (`7b8114b32`).** Only an OUT or ERR runtime frame carrying payload bytes clears the host's IN in-flight count; an empty end-flag frame does not. `runtime-flow.json` gained two vectors.

## Result for the worker: three vector files change, the worker's code and tests do not

| Vector file | Layer | Changed | Worker uses it |
| --- | --- | --- | --- |
| `launcher-lines.json` | L1, daemon and launcher | yes (version 2, `receiptKey`) | no, carried for drift only |
| `stop-receipts.json` | the launcher's receipts | yes (version 2, `mac`) | no, carried for drift only |
| `runtime-flow.json` | host-side IN flow control | yes (two vectors) | no, the worker relays runtime frames blind |
| `envelopes.json`, `mux-frames.json`, `guest-stop.json`, `runtime-image.json` | the worker's layers | no | byte-identical to the 6c1f04e8 copies |
| `bootstrap-order.json` | host bootstrap sequencing (the worker is blind to bootstrap payloads) | no | no, carried for drift only |

The worker has no L1 channel, mints no receipt and never sees the key: it receives SCOPE, VOLUMES and DRAIN on L2 and speaks mux on L3/L4. So nothing in the re-pin depends on the launcher (#57), which keeps its pre-#74 pin. The launcher is the component that must move to version 2 (accept `begin.receiptKey`, sign Class A receipts); this slice neither needs nor blocks that.

All eight files are copied byte-identically from `packages/core/test/cowork/native/vectors/` at `8b52ef83` and pinned by SHA-256 in `Tests/fixtures/PINS.json` (source branch now `cowork/output-integration`, last commit touching the contract `324eb08da`).

## New guards

* **The worker-layer vectors are frozen** (`bootstrap-order.json` is the host's and is pinned only). The four worker-layer files above are asserted against hashes written into the guard itself, not only against `PINS.json`, so refreshing a pin cannot silently change the worker's contract. The guard also asserts that the `begin` vectors carry `receiptKey`, that the receipt vectors are version 2, and that every positive mux control payload still starts with `{"v":1,`.
* **The worker never handles the key or a MAC.** No worker source may contain `receiptKey`, `receipt_key`, `hmac`/`HMAC`, `CCHmac`, `SecKey` or `Keychain`.
* **Anti-wiring (a pre-existing break, fixed here).** On the untouched `8b52ef83` tree this package's own anti-wiring guard already failed, because the merged contract document names `winter-cowork-worker`; CI does not run that guard, so nobody saw it. The contract document `docs/cowork-native-worker.md` (which now lives on integration and names the worker by definition) and this note are allowed referrers; nothing else may name the worker.

## Verification

13 C test binaries, 48,644 checks (unchanged: no worker behaviour moved), the same under ASAN+UBSan, and 27 Python guards, all passing against the vendored libkrun archive `e4433efe` (unchanged on integration). Mutation: 23 of 23 new-guard mutants killed (the frozen set itself is asserted, and dropping or adding an entry is killed; the key identifiers in four spellings, each of the four worker-layer files edited and re-pinned, the host-side files edited without a re-pin, `receiptKey` and version 2 removed from the host-side vectors, a control payload at text version 2, the pin head and last commit moved, a stray referrer, the contract-document allowance removed). The earlier catalogue is unaffected because no worker source changed.

## NEEDS FROM OTHER LANE

None.

## Docs owed

`docs/claude/cowork.md` and the ledgers should say: the HVF worker's pinned vectors are the contract at `8b52ef83` (text version 2); the worker is unaffected by the receipt MAC because it has no L1 and signs nothing; the launcher (#57) must re-pin to version 2 before it is wired.
