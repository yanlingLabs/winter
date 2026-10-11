# Synthetic native launch/key fixture

Implemented fixture, production launch remains blocked. Swift6.2/macOS26; no
external dependency, actual Keychain item/API, VM, daemon or live home access.
SwiftPM builds ad-hoc fixture code signatures automatically; these are not
production team/hardened/library-validation evidence.

The native broker alone holds a random in-memory synthetic master. HKDF contexts
use explicit domain separation and length-prefixed home ID/path/dev/inode,
workspace, volume, creation, purpose, format and key-version identities. Record
integrity uses a separate derived HMAC key. The broker requires both a valid MAC
and its current sealed identity/version; changing a plaintext row cannot release
material. Its current-record map is volatile, not a durable rollback protocol.
The ordinary canonical runtime-state DB is unchanged and outside this package.

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
zero key deliveries. Only the target32-byte unlock key goes over that child's
private inherited pipe. The worker closes bootstrap before its proof/test phase;
no generic worker key-request endpoint survives. HMAC possession proof is
verified only inside the broker; the client receives only a one-byte ACK.

Seven unit tests pass: identity/purpose key separation, metadata tampering,
current-version freshness after valid old seals, PID/nonce/record binding, replay
on success or failure, exact nested schema, canonical spelling and default
production refusal. The actual process fixture passes with two workspace key
identities and a separate sequential replay-channel worker. It checks:

- A's proof cannot validate under B's key using the same challenge.
- Cross-home/workspace/volume/creation/key-version/token, supplied PID/executable, and generic derive/decrypt
  requests fail without extra key delivery.
- Two actual duplicate request packets produce one admitted launch; the replay
  is refused. The independent client exits71 without receiving material.
- 160 open parent fixture FDs do not appear in workers; bootstrap is closed and
  /dev/fd enumeration finds only0/1/2 in the post-bootstrap test phase.
- Actual deny-default Seatbelt prevents reading the disposable sibling sentinel,
  loopback connection and child exec. A security-service policy check has an
  unsandboxed positive control; no actual Keychain request is made.

```
swift test --package-path apple/Cowork/WinterCoworkKeyBroker --jobs 4
apple/Cowork/WinterCoworkKeyBroker/.build/debug/cowork-key-broker-fixture \
  --fixture "$PWD/apple/Cowork/WinterCoworkKeyBroker/.build/debug"
```

Evidence: /tmp/cowork-keybroker-tests.log (7 pass) and
/tmp/cowork-keybroker-process-smoke.log (actual JSON completion receipt).
No raw material is written to logs, environment, argv, manifests or fixture
files. Pipes, processes, deadlines and reaping remain broker-owned. This is
synthetic process/descriptor evidence, not encrypted-disk read/write/cold restore.

Darwin LOCAL_PEERPID reports the last sender, not an atomic per-message,
nondelegable audit identity. The private channel and single admitted owner limit
this fixture; deliberate capability forwarding/colluding writers are not proved
excluded. Native app/Core launch authentication, saved-schedule authority,
canonical authority/lease integration and exact production channel attestation
remain gates. Code signing here verifies ad-hoc fixture images, not a hardened
signed bundle or denial of debugger/library injection by a hostile same-user
process. The deprecated sandbox_init/private sandbox_check APIs are fixture
probes, not a supported complete production VMM sandbox policy.

ProductionKeyBroker.launch always throws productionBlocked. There is no real
Keychain provider or generic decrypt API. Master durability, sealed-record
recovery/replay across restart, real signing/sandbox/key custody, authenticated
disk format/sector integrity, active RAM return and worker integration remain
unimplemented. No source/policy DB encryption is implied. Do not enable Cowork
from this fixture or treat the key/storage gate as passed.
