# Cowork private storage

Status: first-version scope changed directly by the user on 2026-10-12.
**Separate per-workspace encryption is deferred for the first version.** This
supersedes the earlier encryption-before-activation requirement. The accepted
tradeoff is weaker protection against direct same-user reads and copied images.
VM isolation, selected-folder boundaries, host credential custody and active RAM
return remain required.

## First-version boundary and gates

Private data/environment images contain plaintext guest filesystems. FileVault,
when enabled on the host volume, protects offline access to that volume; it does
not protect a copied image, an unencrypted backup destination, or reads by an
already authorized process on the unlocked Mac. Check and report host protection
rather than claiming FileVault is enabled on every installation. The product and
escape approval copy must say that images are plaintext and approved escaped
commands run as the user and may read them. Selected folders, shared instructions,
memory, outputs and host transcripts also remain plaintext.
[Apple's FileVault boundary](https://support.apple.com/guide/security/sec4c6dc1b6e/web)

Create workspace/volume directories as 0700 and images as 0600. Every admission
and image open checks current owner, exact modes, no-follow file identity and
recorded device/inode; refuse drift instead of silently repairing permissions.
One confirmed worker owns a writable volume. Uncertain termination retains that
ownership. Manifest/imported descriptors cannot grant authority: validate against
canonical host records and the authenticated launch request, binding workspace,
volume, incarnation and runtime image. Preserve existing data on recovery errors.

The first-version [raw backing-image primitive](cowork-raw-volumes.md) now records
volume geometry, creation/file identity and durable native-owner bindings in
runtime-state schema 9 and verifies sticky backup exclusions. It allocates only
unformatted sparse files; authenticated production worker wiring, filesystem
formatting and guest readiness remain open. It does not enable provisioning.

The first-version merge gates include protected Cowork/image/socket paths in the
ONE existing Bash sandbox's denyRead/denyWrite lists, Read/Glob/Grep and write-tool
path checks, and write-shaped escape denials. These guard enrolled Winter routes;
they do not constrain arbitrary same-user processes or approved escaped reads.
Keep ordinary Code, hooks, LSP and third-party tool behavior, with no extra outer
floor or injected sandbox-disabling flags. Purpose-built worker/bridge sandboxes
and guest tool compartments remain enforced boundaries.

Activation has an explicit residual: live policy updates cover subsequent file
checks and newly launched sandboxed commands, not commands already running with
an earlier sandbox profile. A pre-existing Dispatch Bash command or background
task may therefore read Cowork files created after provisioning. Native Code's
idle/restart boundary reduces this window but does not stop background tasks that
outlive the turn. First-version activation does not claim to revoke those
processes or scrub their prior context; retaining live host sessions accepts this
window alongside the same-user and approved-escape residuals above.

Exclude private images and their backing-store paths from automatic Time Machine
backup at creation, and verify the exclusion before activation. Use the supported
sticky item exclusion (`tmutil addexclusion` without `-p`), which travels
with the file and does not require root. Reapply and verify it whenever an image
is created or replaced; tests inject disposable paths and never change the
user's backup settings. Offer an explicit quiescent export/restore path instead of
claiming a live sparse-image copy is consistent. Shared instructions, memory and
outputs remain eligible for the user's normal backups; they are plaintext and
backup protection depends on the destination. Preserve that choice on relocation.
[Apple backup encryption guidance](https://support.apple.com/guide/mac-help/mh21241/mac)

Each volume record has an explicit format/version (initially `raw-ext4-v1`),
identity, purpose and geometry. Unknown formats refuse. A later encrypted format
requires an explicit recorded conversion with recovery/rollback and adequate disk
space; never reinterpret an existing raw image or silently replace its data.
No crypto kernel, storage-key broker, LUKS unlock, key rotation or encrypted-volume
benchmark blocks the first version. Preserve their existing research and fixtures
for the deferred work below.

The stream channel's first-version purpose is guest control/runtime transport,
with an authenticated workspace/incarnation binding and bounded framing. There is
no guest disk-key delivery in this version. Its lifetime follows admitted control
sessions; one-shot key-delivery rules apply only to the deferred encrypted boot
path, not ordinary control messages. Provider/GitHub/MCP credentials stay in host
brokers; plaintext disk images are not permission to persist those secrets there.

## Deferred encrypted-storage design

The remainder records the earlier design and its future acceptance requirements.
It is preserved research, not a first-version activation gate or implemented
confidentiality claim.

## Deferred confidentiality boundary

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

A tiny separately signed native broker is the proposed sole Keychain wrapping-key
custodian. Each private volume receives a random data-encryption key (DEK),
wrapped under the broker's key-encryption key (KEK). Canonical home, workspace,
volume, creation, purpose, explicit format ID, exact key length/layout and
wrapping-version identities are authenticated
as associated data; they do not determine the disk key. In particular, home path,
device and inode changes after an approved move or restore must not change the
DEK. An explicitly authorized relocation preserves the logical home ID and
re-seals the same DEK with the reconciled path/device/inode. A transfer to a
different Winter home is a separate operation requiring explicit authority.
KEK rotation re-wraps existing DEKs, with a new wrapping version; it does
not re-encrypt disk contents. Existing volume identities cannot be silently
re-provisioned. Durable record/KEK transactions, rollback protection and recovery
must be validated before this mechanism is enabled. It launches a
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

The selected **bounded fixture candidate**, following the 2026-10-12 independent
review, is guest LUKS2 `aes/xts-random` + `hmac(sha256)` with authenticated
dm-integrity sectors and journal mode. Its 96-byte native random volume material
is AES data key32, AES tweak key32 and HMAC key 32; the AES halves must differ.
It is not a passphrase or a derivation from an existing 32-byte key. The synthetic
native broker supports the explicit versioned 96-byte profile alongside its
retained 32-byte fixture profile, wraps all bytes under the 32-byte KEK with full
identity AAD, and uses a strict version 2 worker frame. Unknown formats/lengths,
old frames, cross-format relocation and duplicate provisioning refuse. This is
volatile synthetic custody/descriptor evidence, not production Keychain custody
or encrypted I/O. Existing anonymous 32-byte serialized identities/frames are
rejected rather than silently assigned a new meaning; durable migration is open.

The crypto-capable comparison kernel and neutral cryptsetup 2.8.8 toolset have
been built; the kernel remains unbooted. Immutable guest bootstrap, exact
header/geometry/generation authentication without TOCTOU, real encrypted
read/write/crash/recovery behavior and crypto I/O during active reclaim remain
gates. Authenticated LUKS2 support is experimental, and sector integrity does
not prevent replay of previously valid ciphertext. The review's conservative
1 TiB key-generation exposure budget is a proposal, **not an adopted production
limit**; lifetime accounting and replacement-volume migration still require
review and implementation. Relocation and KEK rotation preserve exact DEK bytes,
format and any future consumed budget; they are not fresh disk-key generations.
[Independent candidate review](research/2026-10-12-cowork-encryption-format-review.md),
[synthetic native broker](../apple/Cowork/WinterCoworkKeyBroker/README.md).
[dm-crypt](https://www.kernel.org/doc/html/latest/admin-guide/device-mapper/dm-crypt.html),
[cryptsetup authenticated-encryption status](https://gitlab.com/cryptsetup/cryptsetup/-/raw/v2.8.8/man/cryptsetup.8.adoc)

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

Before enabling the later encrypted-volume format, prove real encrypted read/write/cold restore, key absence
from Core/tool memory inputs and serialized state, direct same-user ciphertext
reads, helper authentication, denied generic decryption, tamper/missing-key
refusals, crash consistency, and export/backup recovery. Use disposable keys,
homes and signed fixture identities in tests; never the user's live Keychain.
Existing plaintext VM probes establish their stated confinement/performance
observations only, not this new storage requirement.
