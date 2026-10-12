# GitHub read transport

Production `availability()` remains false and `read()` refuses before authorization,
secret lookup or network work unless the **host-only** `isolatedFixture` constructor
option is present. Current pkt-line/pack parsing runs in-process and must move into
an admitted resource-confined worker/helper before production activation. Merely
wiring the class or removing the fixture guard is not production acceptance.

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
body read and final completion rechecks the grant; a periodic single-flight check
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
