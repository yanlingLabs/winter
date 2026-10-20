# Synthetic native launch/key fixture

Per-workspace encryption was deferred from the first version by user choice on
2026-10-12. This fixture and its crypto work are preserved for that later feature;
it is not a prerequisite for first-version RAW workspace execution. General
native process ownership lessons remain applicable.

Implemented fixture, production launch remains blocked. Swift6.2/macOS26; no
external dependency, actual Keychain item/API, VM, daemon or live home access.
SwiftPM builds ad-hoc fixture code signatures automatically; these are not
production team/hardened/library-validation evidence.

The native broker alone holds a random in-memory synthetic wrapping key (KEK).
The closed format registry maps `fixture-raw-256-v1` to 32 bytes and
`luks2-aes256-xts-random-hmac-sha256-v1` to 96 bytes: independent native random
AES data 32, AES tweak 32 and HMAC-SHA256 32 components. Equal AES halves refuse.
The retained 32-byte profile is a synthetic direct-material profile, not the
rejected GCM production default. The whole material is sealed with AES-GCM
under the existing 32-byte KEK. No old 32-byte key is a seed/passphrase or
automatically replaced. Missing/unknown serialized format IDs refuse.
The length-prefixed home ID/path/dev/inode, workspace, volume, creation, purpose,
explicit format ID, exact key length/layout and wrapping-version identity
(under a version 2 canonical domain) is authenticated associated data, never KDF
input. Re-provisioning an existing volume refuses. Explicit native fixture
relocation re-seals the same DEK, and KEK rotation re-wraps every current DEK;
neither changes disk keys or their format. Cross-format rebind refuses.
Relocation preserves the logical home ID; transfer to
a different Winter home requires separate authority and is not exposed here.
Tests verify this across changed home locations and
two wrapping-key rotations. The current-record map is volatile; the fixture is
not a durable rollback/recovery protocol. The ordinary canonical runtime-state
DB is unchanged and outside this package.

The fixture launcher creates a private inherited one-shot daemon channel and
registers the OS-returned child PID itself. It sends a scope-specific random
capability, accepts only bounded exact-schema launch messages, observes Darwin's
kernel peer PID after the request while the client stays alive, rechecks executed
code, and ACKs only that channel. Generic signed code identity or a supplied PID,
executable, home/workspace/key selector, derive/decrypt field cannot create
admission. Independent fixture clients without a real channel fail. Raw storage
keys never enter this daemon/client protocol.

The broker pins worker SHA/dev/inode and ad-hoc CodeDirectory identity. It starts
the fixed child suspended, checks the actual guest code object through Security
framework, resumes it, and rechecks code after sandbox readiness before sending
any material. A deterministic replacement AFTER path checking is rejected with
zero key deliveries. Only the selected 32/96-byte material goes over that child's
private inherited pipe. READY must advertise frame version 2 before delivery.
The key frame starts with WKB/version 2 magic, a bounded UInt32 header length
and UInt16 key length, followed by exact-schema versioned metadata and the
raw bytes. Format-derived length/layout checks reject old/unknown/truncated
frames, unknown fields and mismatched declarations; the worker also refuses
equal AES halves. Public receipt fields bind version, format and length.
The worker closes bootstrap before its proof/test phase;
no generic worker key-request endpoint survives. HMAC possession proof is
verified only inside the broker; the client receives only a one-byte ACK.

Twenty unit tests pass: random volume keys and duplicate-provision refusal, AAD and
wrapped-key tampering, relocation and KEK rotation preserving DEKs, stale-record
refusal, failed-rotation atomicity in memory, PID/nonce/record echo binding, replay
on failure, exact nested schema, canonical spelling and default production refusal. The actual process fixture passes with two workspace key
identities (32-byte fixture and 96-byte XTS/HMAC candidate) and a separate
sequential replay-channel worker. New tests check independent components,
full 96-byte wrapping, wrong lengths/format/AAD, mixed-format rotation and
relocation, old/unknown/truncated frames and exact versioned READY/header
shapes. The one authorized process run passed in 1.32 s and checks:

- Both exact 32/96-byte profiles reach their scoped real workers; A's proof
  cannot validate under B's key using the same challenge.
- Cross-format echo changes fail in both directions; unknown formats fail
  without additional delivery.
- Changes to the broker-selected bootstrap identity/token, supplied PID/executable,
  and generic derive/decrypt fields fail without extra key delivery. The broker
  chooses the record before it asks the client to echo that identity. This checks
  echo tampering, not how a real daemon is authorized for a workspace.
- Two actual duplicate request packets produce one admitted launch; the replay
  is refused. The independent client exits71 without receiving material.
- 160 inheritable parent fixture FDs (FD_CLOEXEC explicitly absent) do not appear in workers; bootstrap is closed and
  /dev/fd enumeration finds only0/1/2 in the post-bootstrap test phase.
- Actual deny-default Seatbelt prevents reading the disposable sibling sentinel,
  loopback connection and child exec. A security-service policy check has an
  unsandboxed positive control; no actual Keychain request is made.

```
swift test --package-path apple/Cowork/WinterCoworkKeyBroker --jobs 4
apple/Cowork/WinterCoworkKeyBroker/.build/debug/cowork-key-broker-fixture \
  --fixture "$PWD/apple/Cowork/WinterCoworkKeyBroker/.build/debug"
```

Evidence: [nonsecret format/process result](results/2026-10-12-key-formats.json),
`/tmp/cowork-key-broker-format-tests.log` (20 pass), and
`/tmp/cowork-key-broker-format-process.json` (exit 0 actual completion receipt).
The process run used disposable HOME/TMPDIR and a sanitized environment.
The process receipt names owned-worker key delivery and echo-tampering checks;
`daemonWorkspaceAuthorizationVerified` remains false.
No raw material is written to logs, environment, argv, manifests or fixture
files. Pipes, processes, deadlines and reaping remain broker-owned. This is
synthetic process/descriptor evidence, not encrypted-disk read/write/cold restore.

Darwin LOCAL_PEERPID reports the last sender, not an atomic per-message,
nondelegable audit identity. The private channel and single admitted owner limit
this fixture; deliberate capability forwarding/colluding writers are not proved
excluded. Native app/Core launch authentication, saved-schedule authority,
daemon workspace request authorization/mapping, canonical authority/lease integration
and exact production channel attestation
remain gates. Code signing here verifies ad-hoc fixture images, not a hardened
signed bundle or denial of debugger/library injection by a hostile same-user
process. The deprecated sandbox_init/private sandbox_check APIs are fixture
probes, not a supported complete production VMM sandbox policy.

ProductionKeyBroker.launch always throws productionBlocked. There is no real
Keychain provider or generic decrypt API. KEK durability, sealed-record
recovery/replay across restart, real signing/sandbox/key custody, authenticated
disk format/sector integrity, active RAM return and worker integration remain
unimplemented. No source/policy DB encryption is implied. Do not enable Cowork
from this fixture or treat the key/storage gate as passed.

The 96-byte profile is selected only as the bounded encryption candidate in
[the independent review](../../../docs/research/2026-10-12-cowork-encryption-format-review.md).
No LUKS volume, header/geometry record binding, guest unlock transport or
production key-lifetime/migration policy is implemented by this package.
The draft-informed 1 TiB recommendation has not become a production budget.
Anonymous old identity/frame shapes are rejected; durable migration requires
explicit review and never silent re-provisioning. Swift/Data/CryptoKit
wiping is best-effort for explicit fixture buffers; this fixture does not
prove eradication of every internal key copy or denial of debugger access.

Native lifecycle now uses opaque spawn-owned handles, with serialized
`WNOHANG` probes before `SIGCONT`/`SIGKILL`. Construction refuses a non-default
`SIGCHLD` disposition or `SA_NOCLDWAIT`; each signal checks that policy again.
Normal waits use a monotonic 2,000 ms deadline and a separate 250 ms post-kill
reap window. Initializer failure/deinit uses an immediate termination attempt
with the same 250 ms reap window. No teardown path uses blocking
`waitpid(..., 0)`. Interrupted waits do not restart either deadline.

A successful native reap records `confirmedExit` and the exact status;
a timeout still throws even if the killed child was successfully reaped.
`ECHILD` records `lostOwnership`, while other unconfirmed results record
`terminationUncertain`. Neither is represented as reaped or gone. Subsequent
resume/wait/deinit cannot signal either state. An in-process ledger retains
the native handle and nonsecret debt record, including failed construction or
deinit. Its 16 slots count active admissions plus debt; exhausted capacity
refuses admission and never evicts debt. There is no incoming PID, generic
kill/decrypt RPC, or automatic debt-reconciliation mechanism.

This fixture must remain the sole reaper of its children. The default-signal
precondition is enforced, but an unrelated thread calling `waitpid(-1, ...)`
or changing the signal policy concurrently cannot be prohibited by this
library. Under that contract an unreaped child reserves its PID, including
a zombie, until this owner confirms the reap. `ECHILD`/failed ownership
probes refuse signals. These Darwin PID operations do not provide atomic
pidfd-style protection against a competing external reaper; embedding them
in a process with a global child reaper is unsupported. Ledger debt is
process-local, not durable custody or a production worker-admission receipt.
Long-term debt recovery and production integration still require review.

The deadline limits the polling and post-kill **attempt**. OS scheduling or
syscall stalls can exceed its elapsed wall-clock budget. The successful
no-key `/bin/sleep` fixture measured 2.0022 s for its 2,000 ms timeout, confirmed
status 137 after `SIGKILL`, and zero debt; its whole process took 2.464 s.
The updated 32/96-byte delivery fixture exited 0 in 1.076 s, including
swapped-image cleanup and zero unresolved ownership debt. All 29 Swift tests
passed, including 15 injected native wait/error scenarios and Swift ownership,
capacity and deinit cases. The original format receipt remains unchanged;
[new lifecycle evidence](results/2026-10-12-lifecycle.json) records the new
binaries and the original absent `/usr/bin/sleep` path erratum.

Reproduce the bounded process probes using the newly built artifacts:

```sh
swift test --package-path apple/Cowork/WinterCoworkKeyBroker --jobs 2
python3 apple/Cowork/WinterCoworkKeyBroker/scripts/verify-lifecycle.py \
  --artifacts apple/Cowork/WinterCoworkKeyBroker/.build/debug \
  --output /tmp/winter-key-lifecycle-receipt.json
```

The Python runner creates disposable 0700 homes and temporary directories,
passes a closed environment, records failures before parsing receipts, and
stops without retrying. It runs only the fixed no-key timeout fixture and
the existing synthetic key-delivery fixture. Neither opens a VM, Keychain,
live Winter home or daemon. See Apple's [wait manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/wait.2.html)
for `WNOHANG`, `ECHILD`, `EINTR`, and status semantics. These fixture results
remain separate from production storage custody and encrypted volume I/O.

Receive operations now retain one monotonic deadline across interrupted polls
and reads. Budgets must be 1–10,000 ms and buffers 1–4,096 bytes. A clock failure,
invalid poll descriptor or error refuses; EOF still terminates the bounded frame.
The private channels have one reader per endpoint. Readiness does not protect
against another thread consuming the bytes first, nor make arbitrary blocking
descriptors safe for concurrent consumers. This change does not bound the existing
write/send calls or establish a whole-launch deadline.

Datagram reception uses `recvmsg` and rejects returned `MSG_TRUNC`/`MSG_CTRUNC`.
The regression first reproduced a 5-byte datagram being accepted as a 4-byte
prefix by the previous `recv(..., MSG_TRUNC)` call on this Mac. Apple's
[receive manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/recvmsg.2.html)
documents truncation as an output flag on `msghdr`; the rejected packet is consumed
and never decoded. Tests also check that an exactly sized next packet succeeds.
The frozen format/lifecycle receipts describe their original binaries and remain
unchanged; they are not evidence for these later receive changes.
