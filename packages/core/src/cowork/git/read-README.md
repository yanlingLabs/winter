# GitHub read transport

Production `availability()` remains false and `read()` refuses before authorization,
secret lookup or network work unless the **host-only** `isolatedFixture` constructor
option is present. The fixture can now supply `activation.parser`, an actually inspected confined
helper running the exact shared validators. Omitting it retains the historical
in-process fixture validation. Production activation remains closed pending
independent helper review and complete authenticated channel/authority assembly;
merely wiring the class or removing the fixture guard is not acceptance.

`CoworkGitHubReadTransport` implements host-held authenticated smart-HTTP reads:
only `info/refs?service=git-upload-pack` and `git-upload-pack`, at a canonical
`https://github.com/<owner>/<repository>.git` host-resolved destination. It has
no push/receive-pack, generic URL/header route, token response, credential helper,
submodule traversal or LFS route. Protocol v0 SHA-1 advertisement/negotiation is
validated; v2, shallow and partial clone requests are refused. Clients use
`protocol.version=0`, disable recurse-submodules/LFS, and retain a credential-free
broker remote. Invalid remote refs/capabilities and pack envelopes/checksums,
entry compression, declared object/delta sizes are refused through PR17's shared
`checkPackBudget`. This preflight does not replace Git graph validation or native
process resource confinement.

Default limits are 1 MiB requests/advertisements, 8 MiB read responses, 10,000
objects, 64 MiB reconstructed objects, four concurrent reads, and 30 seconds.
The response buffer, parser work and asynchronous zlib output are bounded. Full
validated response bytes are released only after final current-authority checks.
Unsupported/oversized repositories fail visibly; this is not arbitrary-repository
scalability or production parser/resource acceptance. Live revocation stops pending
host requests, including reads stalled before more body chunks arrive. A completed
read cannot retract bytes already delivered; guest source readiness still requires
its own exact current-revision/incarnation ACK. No read mutates source state.

`CurrentCoworkGitReadAuthority` binds canonical workspace/config/grant/source and
incarnation/lease, current host account/repository identity/revision, and runtime
binding/policy/task-source scope where present. Runtime requests require a ready
source and `read` + `git.read`; host preparation may read a preparing source. A
missing session ID is **host preparation authority**, never a guest-selected
option. The daemon/native channel must inject the caller from its authenticated
owner records and host source operation. `GitHubReadGrantResolver` must resolve
synchronous protected current repository/account/task-scope snapshots (network/refresh
runs outside authorization). The authority/recheck interface is synchronous, with no Promise fallback. No await
follows the final canonical snapshot before returning response bytes. Account grant revisions advance on changes and restored
contents. SecretStore slot names come only from those host records. Every auth await,
body read and final completion rechecks the grant; a periodic synchronous check
also cancels stalled streams. Host revocation handlers call `revoke` immediately.
No credential refresh/replay is attempted by this transport: current expiration or
401/403 is refused and host account authorization/refresh remains composition work.

The default HTTPS adapter uses a dedicated agent, verified TLS, no ambient proxy
helper, and no redirect following. The test adapter maps that same canonical
URL to a private local fake upstream. Two real fixture Git processes clone and
incrementally fetch over the same transport, with fake SecretStore credentials,
config/helper poisoning and strict fsck checks. This is an isolated fixture, not
a Linux guest or signed worker acceptance result. Public Cowork activation and
publication remain closed until account selection/storage/revocation, authenticated
worker channel, source operations and actual guest completion are connected and
independently accepted. Root owns persisted grant/schema/RPC/daemon wiring; this
slice introduces no parallel authority database.

Protocol sources: [smart HTTP](https://git-scm.com/docs/http-protocol),
[pack protocol](https://git-scm.com/docs/pack-protocol),
[pack format](https://git-scm.com/docs/pack-format).


## Confined parser helper

`ConfinedGitReadParser.admit` checks both native bootstrap and self-contained Node
runtime against host-owned static code requirements, hardened-runtime flags, and
absence of JIT/unsigned-memory/library-validation/debugger exceptions. Payload
SHA-256 and file identity changes refuse admission/use; protected immutable bundle
staging remains the host packaging responsibility. The running Node code identity
is checked before any packet bytes are sent. Configuration paths and requirements
are host dependencies, never guest input, and there is no ambient Node/Git fallback.

The dedicated Seatbelt denies default access, network, process fork and all writes;
only literal helper/runtime/payload files, required system libraries/dyld cache,
devices and root directory reads are allowed. Metadata is readable, not arbitrary
file data. The signed native bootstrap inspects actual sandbox denial of Keychain
services, user file data, writes, network and fork before reading stdin or exec.
It sets and verifies hard RLIMIT_CPU=2 seconds, NOFILE=64, CORE=0 and FSIZE=0;
closes inherited descriptors above stdio; and execs Node with `--jitless`, no addons,
no global module search and a 128 MiB V8 heap ceiling. This is a Winter-owned helper
floor and does not modify ordinary Code commands or their sandboxes.

Each request uses a fixed 20-byte header plus bounded raw bytes; no credentials,
URLs, paths or runtime authority cross this parser channel. A fixed 45-byte ready/
verdict/SHA-256 receipt is checked against the original bytes. Host wall timeout,
output cap, cancellation, process-group teardown and per-helper concurrency apply.
Capacity is held until the owned exit event confirms termination. If kill/drain
cannot confirm termination, the request fails and capacity remains occupied.

RSS is sampled every 20 ms with libproc and stopped at 256 MiB by default. This is
**reactive termination**, with possible sampling/in-flight overshoot, not a kernel
memory reservation or universal memory guarantee. Structural byte/object/zlib
bounds remain independent; native allocators/runtime overhead still exist. The
low-threshold RSS test proves stopping on an observed excess, not realistic worst
case overshoot at the production threshold. CPU stress and denial probes use
separately declared fixture payloads; malformed-pack tests and clone/fetch use the
exact parser bundle. These proofs do not establish full VM/resource acceptance.

Opt in to the Mac fixture tests by supplying a self-contained Node executable via
`WINTER_GIT_READ_NODE_FIXTURE`. The fixture copies it into disposable storage,
signs only those copies ad hoc with hardened runtime and no entitlements, compiles
the native bootstrap and exact JS bundle, then cleans them up. Actual validation
used official Node v26.7.0 darwin-arm64, archive SHA-256
`7ee659a7768e641bbfd5360940660b8e8fd0052f77488f365562bac522fc15d4`,
from [Node's release checksums](https://nodejs.org/dist/v26.7.0/SHASUMS256.txt).
No production signing key, live Winter home, real account or VM is used.
