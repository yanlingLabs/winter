# Cowork N2: the launcher side of the retained-receipt MAC (text version 2)

Status: SOURCE ONLY, 2026-10-18. Branch `cowork/n2-launcher-receipt-mac`, STACKED on #57 (`cowork/n2-launcher`, the signed Swift launcher), merged with `cowork/output-integration` at
`8b52ef83` (merge commit `35c8e0f5`), which carries the daemon side (#74). Nothing here is wired; no VM, no Keychain, no file under `~/.winter*`.

## What the daemon side expects (docs/cowork-native-worker.md, section 7.1) and what this slice does

| Contract | Launcher |
| --- | --- |
| Every L1 line and every stop receipt is text version 2 (`"v":2`); a `"v":1` line is refused with `version` | `WireLimits.textVersion`; the line codec and both receipt classes. The binary headers (L2 `WEV1`, mux `WMX1`) and the bootstrap/runtime JSON inside mux frames stay at version 1 |
| `begin` ends with `receiptKey`: canonical padded base64 of exactly 32 bytes; hex, unpadded, 31 or 33 bytes, `null`, empty are `bad_field`; a misplaced key is `malformed` | `ReceiptKey.decode`, `LineToLauncher.begin(..., receiptKey:)` |
| The key is a secret: memory only, never on disk, never in a log | `ReceiptKey` (below); a static check bans every print/log/stderr call in the library except the argument parser's usage line and allows exactly two readers of the key's text |
| A Class A receipt ends with `mac` = base64(HMAC-SHA256(key, canonical text without `mac`, no newline)) | `OrderlyReceipt.macInput()` / `signed(with:)`; the authority signs last, over everything else; an unsigned receipt can be neither serialized nor stored; no key means no Class A (`launcher-fault`) |
| Class B carries no MAC | unchanged; text version 2 |
| A retained Class A counts only if its MAC verifies | `DurableReceiptStore.load(_:key:)` verifies and throws `macInvalid` for a forged, edited, other-key, or unsigned file. There is no key-less read |

## The key

`ReceiptKey` is a class around one malloc'd 32-byte block. `zeroize()` and `deinit` overwrite it with `memset_s`; the session zeroizes it the moment the verdict is signed, durable and
recorded. Every printed form (description, debug description, mirror, `dump`) is `[redacted]`; equality is constant time. Swift cannot promise more: the parsed L1 line, the base64 `String`, the
`Data` and the CryptoKit `SymmetricKey` made for one HMAC each keep a copy until their own storage is released, and those are not zeroed here. The block is the long-lived copy and it is zeroed.

## Vectors

Re-copied byte-identically from the merged tree (`launcher-lines.json`, `stop-receipts.json` changed; the other six are identical); `PINS.json` records the merged head they came from. The golden tests
run S1's SYNTHETIC key through every positive MAC vector (exact MAC input bytes, base64 and hex tags, re-signing the unsigned receipt reproduces the vector) and every negative one (`mac-valid`,
`mac-invalid`, and the strict-parser codes). The blind-relay test is unchanged and green: the MAC lives in L1 receipts, never in a mux frame.

## Evidence

- Swift: 228 tests normal, 233 with `-Xswiftc -DWINTER_COWORK_TEST_BUILD`, 0 failures (the flagged run's real-binary tests mint and read back a signed Class A under the key). bun: `scripts/embed-cowork-native.test.ts`, 21 tests.
- Mutations: 33 new guards (wrong key, truncated or padded tag, one flipped bit, v1 text and v1 line accepted, non-canonical spellings, key logged through description, debug description, mirror or a `print`,
  key not zeroed, zeroed key still signing, MAC input including the MAC or a newline, MAC key order, unsigned receipt serialized, no signing, key kept after the verdict, the read path skipping the MAC, ...);
  32 killed. The one survivor, `authority-unsigned-when-key-gone`, is covered by a second guard (an unsigned receipt cannot be serialized, so the persist fails and the verdict is demoted to `launcher-fault`
  anyway). The earlier catalogue (139 Swift/C) was re-run on this branch: 134 killed, the same five documented survivors as #57. Equivalent mutants found and removed rather than counted: a 44-character
  length gate that re-encoding already implies (the gate was deleted), and a `begin` key-order table that the byte-for-byte re-serialization compare supersedes.

## Open

Nothing new. The retained-receipt DAEMON port (S7) still has to supply the key from its Keychain slot and run both guard probes; this slice only gives it receipts it can verify.
