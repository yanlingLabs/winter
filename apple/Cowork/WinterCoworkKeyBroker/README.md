# Synthetic native launch/key fixture

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

Native lifecycle follow-up remains open: `kb_wait_owned` kills on timeout and
then uses blocking `waitpid(..., 0)`, and `OwnedChild.waitStatus` marks the child
reaped even when the wait returns a negative result. The successful 1.323 s
fixture receipt remains valid, but timeout cleanup/teardown is not proved
strictly bounded or production-ready. This format increment does not change
that pre-existing lifecycle behavior; it requires separate review and repair.
