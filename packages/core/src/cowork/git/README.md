# Host Git publication boundary

This is an isolated, local-fixture implementation prerequisite. `availability()`
is always blocked and `publish()` requires explicit host-only fixture opt-in.
It is not wired to RPC, the daemon, a guest transport, real GitHub auth or Keychain.

The guest supplies bounded bundle bytes, a source ID/revision, publication
revision and one explicit branch old/new update. The host injects authenticated
publisher identity. It supplies no remote URL, executable, shell command, flags,
environment, working tree or credential helper. The trusted authority adapter
must enforce canonical workspace/source readiness, GitHub-only membership,
current account/repository grants, conversation capability/approval bounds,
task-specific no-push instructions and explicit subagent publication delegation.
The trusted transport resolves destination identity from the grant, not guest
input, and reads current default/protection/ruleset metadata. Unknown policy
fails closed. No delete, tag, multi-ref, merge API or unrestricted force operation
is exposed. The broker admits only ASCII `[A-Za-z0-9._/-]` branch names and forbids
`HEAD` components. Main/master/default comparisons are case-insensitive; protected
refs are refused regardless of the spelling supplied by the guest.

`CurrentCoworkPublicationAuthority` independently requires both effective
`hostServices: git.publish` and `toolClasses: write`; an allowing task resolver
cannot widen that ceiling. Its mandatory host-owned `sourceScope` resolver returns
an explicit allowed-source set or `null` for designated workspace-wide access.
The conversation's source/cwd identifies its starting directory, not an authority
restriction. Missing scope fails closed. Scope revision must advance on every
change, including changing away and back, and the scope is normalized, rechecked
after asynchronous task resolution, included in the publication digest and
revalidated before dispatch. The production host must implement canonical task/
conversation scope and delegation records; this interface is not guest JSON.
The grant also binds canonical conversation and workspace policy revisions plus
the effective-capability digest. Restoring the same effective set after narrowing
does not restore an earlier publication's authority epoch.

The initial object format is deliberately full SHA-1 v2 bundles only. Quarantine
is fresh and host private. Git verifies pack integrity, strict object connectivity,
commit object types and old-to-new ancestry. A single explicit refspec uses an
exact old-ref lease only after independently rejecting non-fast-forward updates;
an empty lease expectation binds branch creation to absence. Ambient system/global
Git config, hooks, helpers, replacement objects, lookup environment and network
protocols are disabled in the local executor. macOS resolves a real installed
toolchain Git executable once without invoking the `/usr/bin/git` xcrun shim or
CLT installer. The fixture receive-pack server is separately configured to disable
its hooks: Git does not propagate a client's command configuration to a server.
Real GitHub server hooks/rules remain server policy and are not disabled by this
broker.

Before invoking Git on a pack, `checkPackBudget` checks the SHA-1 pack envelope,
object count, each compressed-entry length and each delta's declared source and
result sizes. Zlib output is bounded by the entry header, and aggregate delta
program bytes and reconstructed result sizes are capped separately. This rejects
small packs advertising explosive delta results before `unbundle`/`index-pack`;
it does not replace Git graph/fsck checks, native process RSS limits or CPU quotas.
The scanner never applies a delta or allocates its declared reconstructed result.

The subsequent object count/reconstructed size check uses compact
`cat-file --batch-all-objects --batch-check=%(objectsize)` output. `verify-pack -v`
reports delta-program sizes for deltified objects, so summing its size column is
not an expansion bound. Bundle size, output, duration, directory size and available
disk are also bounded. Asynchronous directory scans run at most once concurrently,
every 250 ms during a command and before/after commands. Timeout/cancellation kills
the owned process group and bounds waiting for output pipes to close; an escaped
descendant is still a resource-confinement gap, not proven killed by that timeout.
This monitor is a fixture budget, not a kernel hard quota or a memory limit for
untrusted Git parsing; production requires host-enforced subprocess/resource
confinement and allocation bounds before enabling this boundary.

The default full-bundle 8 MiB, 10,000-object, 64 MiB reconstructed-object and 32 MiB
quarantine limits are deliberate fixture design limits. They do not establish
scalable publication for production repositories. Production needs a separately
reviewed bounded transport/object negotiation design and resource enforcement;
raising these constants alone does not supply either.

`CanonicalPublicationJournal` implements atomic claim and transition in the
protected runtime-state operations/outbox tables. Opening another handle never
changes pending work. A prepared operation records its authenticated host-owner
incarnation, shared by that host's handles. Explicit `recoverPrepared` requires
host proof that the previous immutable owner terminated; it skips current and
unknown/legacy owners, and rechecks exact operation/digest/owner/phase after the
proof awaits. A malformed row or unavailable proof is reported per candidate
without preventing recovery of independent proven rows. Production must supply this owner from the canonical admission
lifecycle, with termination evidence; a PID or stale heartbeat is insufficient.
The current foundation does not invent such proof. During a live owner,
explicitly rejected unsent claims retain bounded in-memory completion evidence
across journal handles; a later claim retries a failed rejection write. Still-active
claims are unaffected, and an attempted dispatch never acquires this proof. A
persistent DB failure remains a visible error; a restarted process instead needs
the owner-loss path. The live tracking cap is 1,024 prepared operations per
workspace/owner, not unlimited concurrency. Once proven, recovery rejects
unsent preparations atomically with outbox notifications, and an older caller
loses its dispatch transition. Retries reauthorize before returning a receipt.
Dispatched and uncertain effects remain blocked and cannot transition back to
prepared. Status changes
and notifications commit together. The digest binds principal/session/task/workspace/source, grant
identity/revisions, repository/destination, branch old/new and bundle digest.
Retries recheck authority and never redispatch any existing operation. The current
idempotency digest deliberately binds authority epochs: even an unrelated policy
revision requires a new request ID rather than reusing an old approval epoch.
Use the separate operation-status read path to inspect a prior receipt. A crash
after dispatch or missing/ambiguous server response requires reconciliation;
`dispatched` must not be treated as a proven rejection or success. Cancellation
after dispatch and credential-bearing transport errors become safe uncertain
receipts. Only explicit authoritative server evidence can report rejection.
Observing the requested OID later alone does not attribute a push to this
operation; another publisher may have applied it. Journal/database failure after
dispatch likewise leaves an operation requiring recovery, never safe replay.
A dispatch-transition acknowledgement failure never fabricates a rejection;
failure to persist a pre-dispatch rejection leaves the pending evidence observable
until recovery. Failure to remove quarantine is a host diagnostic and cannot
replace a confirmed applied receipt with a publication failure.

Production integration must still implement GitHub repository/account selection,
host-only credential storage/refresh/revocation, the durable journal's service
wiring and the receive-pack smart-HTTP inventory in the execution contract.
This bundle broker rejects multi-ref input; it is not a receive-pack parser or
an unrestricted token-injection tunnel. Clone/fetch, redirects, private
repositories, submodules and LFS require separately scoped adapters.

An exact lease closes ref-tip races. It cannot atomically bind GitHub default
branch/ruleset changes to a push or recall already sent bytes after live grant
revocation. Current metadata rechecks are necessary but do not eliminate this
TOCTOU. Production needs a concrete enforcement/authority-drain strategy and
tests for these races; remote GitHub protection is additional enforcement, not
a substitute. The same applies to host agents: directory modes alone are not
the host read/write/escape fences required by the Cowork contract.

Git semantics: [bundle verification](https://git-scm.com/docs/git-bundle),
[explicit lease expectations](https://git-scm.com/docs/git-push), and
[pack validation](https://git-scm.com/docs/git-index-pack).
