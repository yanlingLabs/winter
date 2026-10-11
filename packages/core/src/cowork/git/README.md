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
is exposed. The broker rejects main/master/default/protected refs.

The initial object format is deliberately full SHA-1 v2 bundles only. Quarantine
is fresh and host private. Git verifies pack integrity, strict object connectivity,
commit object types and old-to-new ancestry. A single explicit refspec uses an
exact old-ref lease only after independently rejecting non-fast-forward updates;
an empty lease expectation binds branch creation to absence. Ambient system/global
Git config, hooks, helpers, replacement objects, lookup environment and network
protocols are disabled in the local executor. Object count/expanded size, bundle
size, output, duration, directory size and available disk are bounded. The 10 ms
disk monitor is a fixture budget, not a kernel hard quota or a memory limit for
untrusted Git parsing; production requires host-enforced subprocess/resource
confinement and allocation bounds before enabling this boundary.

`CanonicalPublicationJournal` implements atomic claim and transition in the
protected runtime-state operations/outbox tables. Dispatched and uncertain
effects remain blocked and cannot transition back to prepared. Status changes
and notifications commit together. The digest binds principal/session/task/workspace/source, grant
identity/revisions, repository/destination, branch old/new and bundle digest.
Retries recheck authority and never redispatch any existing operation. A crash
after dispatch or missing/ambiguous server response requires reconciliation;
`dispatched` must not be treated as a proven rejection or success. Cancellation
after dispatch and credential-bearing transport errors become safe uncertain
receipts. Only explicit authoritative server evidence can report rejection.
Observing the requested OID later alone does not attribute a push to this
operation; another publisher may have applied it. Journal/database failure after
dispatch likewise leaves an operation requiring recovery, never safe replay.

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
