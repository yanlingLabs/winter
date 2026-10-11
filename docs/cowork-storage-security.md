# Cowork private storage confidentiality

Status: product decision recorded 2026-10-11; implementation and validation open.
The independent reviewer relayed the user's choice, **"Encrypt at rest"**, for
private VM data. The alternatives were a documented fence-only boundary or
blocking Code escapes while Cowork storage exists. Neither was selected.

## Required boundary

Private writable VM data and environment images are encrypted at rest. Reading
their host backing files as the same macOS user must yield ciphertext. Keys
live in the Keychain and are available only to a separately signed, hardened
Winter storage/key helper, never `winter-core`, a Bun runtime, a tool process,
an environment variable, a manifest or a transcript. The subsequent approved
topology is one sandboxed VMM worker per workspace, orchestrated by the daemon.
This does not settle the active RAM-return gate. Guest unlock material may be
held by that admitted worker and the immutable guest bootstrap; the master key
must remain outside the worker. The running-guest exclusion below applies.

Key custody is a security boundary; path fences and IPC restrictions are
defense in depth. Keep ordinary Code escape behavior subject to its existing
approval policy. Do not claim that path matching, modes owned by the same user,
or a finite list of blocked delegation services makes Cowork data inaccessible
to every same-user process. Such a process can still delete or corrupt backing
files; detection and recovery are required, prevention is not promised.

The on-disk format must provide authenticated integrity as well as encryption
before claiming tamper detection. Validate headers, workspace/volume identity,
versions and integrity metadata before guest use; authenticate sectors when
read and refuse corrupted data without plaintext fallback. This is not a claim
that boot scans and authenticates every sector of a multi-gigabyte volume.
Refuse unknown, damaged or incomplete headers/state. An inaccessible key is a locked
or recovery-required workspace, never permission to create empty replacement
data. Corruption detection is not a claim to prevent rollback of an otherwise
valid old snapshot; rollback/replay handling needs its own validated protocol.

The reviewer corrected an earlier over-extension about private control records:
this decision does **not** require encrypting grants/source IDs/policy or replacing
the runtime-state DB with a helper-backed encrypted transactional store. Retain
its existing single canonical authority and transaction/outbox semantics. Apply
integrity protection to records the key broker or worker consumes: the manifest,
sealed workspace/volume identity, format and key version. A plaintext DB row or
manifest alone must never release a key or authorize a launch. Admission requires
an authenticated daemon request plus the broker's own sealed identity/key-version
record. Bind those records to the canonical home/workspace and volume; define
freshness and recovery before claiming protection from replay of old valid data.
This scope correction is the reviewer's clarification, not a new user choice.

## Scope and plaintext copies

Selected Mac folders remain ordinary direct host files. The accepted layout's
shared workspace instructions, Project memory and outputs also remain plaintext
host shares, with fences as defense in depth. The disk decision did not encrypt
them. Preserve their direct access and stopped-workspace availability.

Plaintext in a running guest and its memory is outside this at-rest guarantee.
Authorized exports and other plaintext copies are not protected by encrypting
the original disk. Host session transcripts, file diffs, tool results, staged
artifacts and diagnostics can contain private file content; their separate
storage policy and any redaction/encryption work must be explicit. Do not use
blanket wording such as "all Cowork files are hidden from other programs".

Requests through Winter's own authenticated API are another explicit residual.
An authorized caller can ask an admitted Cowork session to read guest files and
return plaintext. Today's Core signing identity can be launched in Bun interpreter
mode, and a same-user process with access to that identity's harness/admin token
can drive the daemon API. At-rest encryption does not prevent this route. The
guarantee here is that **direct reads of the backing files yield ciphertext**,
not that all same-user applications are denied every authorized Winter operation.

No decrypted host mount or generic helper decrypt/readback RPC may stand in for
the encrypted-disk boundary. The chosen block path must unlock only an admitted
guest instance using protected runtime/kernel artifacts, current ownership and
current workspace authority. Plaintext temporary images, crash dumps, logs and
backups must not silently bypass that path. The exact block format and unlock
transport remain implementation decisions requiring evidence.

## Proposed key and launch mechanism

A tiny separately signed native broker is the proposed sole Keychain master-key
custodian. It derives domain-separated workspace/volume keys using canonical
home, workspace, volume, creation and key-version identities. It launches a
fixed verified worker and sends only that worker's material over a one-shot
inherited private descriptor; close it before guest/tool execution. Workers
have no Keychain access, generic key-request interface or sibling-volume access.
Instances of the same signed worker share the same code identity: separate
Keychain item names plus worker-side checks do not isolate their keys. The
broker's exact-process launch/descriptor binding must provide that separation.
[Apple Keychain access models](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)

Authenticate the actual native UI/Core instance or a separately validated saved
schedule capability. Candidate: the signed native app or native launch broker
starts Core with a one-shot inherited capability descriptor, and the broker
accepts worker launch requests only on that admitted instance's channel. A
separately launched signed Core lacks this bootstrap capability. A same-user caller cannot register its chosen PID, run a
copied signed Core in interpreter mode, nominate another executable, or turn
wake into arbitrary guest execution. This launch/bootstrap and authority-record
protocol is an implementation gate, not solved by the proposed process diagram.
Worker compromise may expose its own live workspace/key, never another's key or
the broker master. Keep library validation and refuse debugger/unsandboxed paths.

The first block-format candidate is guest LUKS2 with authenticated dm-integrity,
using an immutable bootstrap and pinned kernel/userspace. It is not yet selected
or validated; existing probe kernels disable `CONFIG_MD` and require a new
profile. Authenticated LUKS2 support has compatibility/maturity constraints, and
sector integrity does not prevent replay of previously valid ciphertext.
[dm-crypt](https://www.kernel.org/doc/html/latest/admin-guide/device-mapper/dm-crypt.html),
[cryptsetup authenticated-encryption status](https://gitlab.com/cryptsetup/cryptsetup/-/blob/master/docs/v2.8.0-ReleaseNotes)

## Helper, recovery and acceptance

The helper must enforce its code-signing requirement, hardened runtime, library
validation and authenticated peer/launch binding. A same UID or a signature
check on `winter-core` alone is insufficient: test an independently launched
signed Core binary in interpreter mode, including `BUN_BE_BUN`, against key
access and helper requests. Reject forged, stale, cross-home, cross-workspace
and cross-incarnation requests. The daemon may orchestrate; it never receives
raw storage keys. Guest tools must not reach the key/unlock transport.

Copying a home does not transfer its Keychain authority. Migration, backup and
restore need explicit key availability or a user-authorized wrapped-key recovery
mechanism, with identity reconciliation and no plaintext key export. A missing
key or unreachable old owner remains visible recovery state. The existing
single-writer and uncertain-termination rules still apply to encrypted volumes.

Before enabling Cowork, prove real encrypted read/write/cold restore, key absence
from Core/tool memory inputs and serialized state, direct same-user ciphertext
reads, helper authentication, denied generic decryption, tamper/missing-key
refusals, crash consistency, and export/backup recovery. Use disposable keys,
homes and signed fixture identities in tests; never the user's live Keychain.
Existing plaintext VM probes establish their stated confinement/performance
observations only, not this new storage requirement.
