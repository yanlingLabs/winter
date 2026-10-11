# Embedded native Cowork controller groundwork

This macOS 26 / Swift 6.2 package contains a tested asynchronous controller,
bounded native transport and thin Node-API binding. It is not an enabled Cowork
mode or a passed execution gate. It does not launch a Winter-owned host helper
process. VZ and its Apple-managed services remain in their normal topology.

`WinterCoworkPrimitives` is the single shared source of the probe's reviewed
event queue, device-operation gate, process cleanup, share graph validation and
native diagnostic helpers. Those files were moved from `spikes/cowork-vm/native`
and the legacy probe imports this product; its 15 tests still pass. This is an
extraction, not a silent second implementation of the reviewed mechanics.
`WinterCoworkNative` supplies the controller and concrete VZ backend. The root
Swift package/iOS products and production daemon packaging are unchanged.

## Ownership and authority

Each controller owns one registered `NativeScope`: `protocolVersion` (1),
`workspaceId`, `incarnationId`, `grantRevision`, and `leaseEpoch`. Every request
and event carries that scope. Operational requests cannot change it, register
new source paths or mint grants. JavaScript-facing revision/epoch values must
fit safe integers; operation IDs are returned as BigInt and encoded as decimal
strings in events. Event sequences are monotonic per controller.

The real `VZWorkspaceBackend` accepts a host-created `HostLaunchDescriptor` and
an injected `HostLaunchAdmission` owner. The latter must authenticate canonical
DB/home/daemon/lease/source/policy state, hold the durable disk owner, enforce
feasibility admission, and independently confirm backing termination. A mutable
manifest or guest JSON is never this authority. Its default implementation
refuses before reading any artifact or source. Trusted runtime/bootstrap
process authorization is a separate callback that also defaults to refusal.

The descriptor records exact artifact hashes, device/inode identities, source
identities/read-only policy, owned storage, immutable supervisor arguments and
internal resource bounds. Native checks those identities, kernel/init hashes,
rootfs ownership path, disjoint share graph, and actual VZ read-only flags. It
never chooses NAT: the concrete backend has no NIC until the reviewed native
host-owned network endpoint is connected. `authorizeProcess` is for trusted
supervisor/runtime bootstrap; privileged native exec is not a model tool or
replacement for confined guest file/shell execution.

The exported C/Node-API factory currently creates only an explicitly requested
fake backend or a production-blocked backend. The concrete real VZ backend is
implemented and compiled, but the authenticated host admission/store composition,
runtime bootstrap, networking and passed-gate enablement are not wired to that
factory. No JSON `approved:true`, environment toggle or mutable instructions
can enable a real VM through it. Root authority integration remains required;
the protocol interface is not a claim that a signed descriptor or live DB
validator has been implemented by this package.

## Async lifecycle and transport

Requests are at most 64 KiB. At most 128 ordinary operations may be outstanding
including unconsumed terminal events, with 16 separate input/cancel control slots
and one reserved stop/shutdown slot. Embedding cleanup also closes admission and
starts cleanup without an event slot; it cannot fabricate a receipt or release
unconsumed ownership. Each accepted operation owns exactly one terminal outcome:
completed, cancelled, failed, or uncertain. A terminal slot is reserved before
work starts. Allocation retry and output saturation cannot erase a terminal.
Events include accepted/processRegistered/stdout/stderr/terminal, scoped IDs,
sequence and bounded payloads. `processRegistered` indicates an input-owning
handle, not a Linux PID, agent readiness or successful runtime restoration.

Output chunks are at most 16 KiB with a 4 MiB / 4096-event native bound. A full
queue fails visibly and cancels the relevant real process rather than quietly
truncating its output. The Node-API callback queue adds at most 64 events. Input
is at most 16 KiB per operation, with a four-chunk real guest queue; overflow
returns backpressure and closed input refuses. Callers wait for registration
and serialize a process's input/closeInput by awaiting each acknowledgment.
Parallel execs and stats/balloon remain permitted. Input/cancel requires the
target operation's recorded task owner; authenticated conversation/delegation
authorization above that task binding belongs to the host integration.

Stop/shutdown closes all new execution/input/start admission before waiting. It
drains pending start/process creation and queued device work, cancels owned
processes and invokes backend cleanup. A budget expiry produces one uncertain
terminal while retaining cleanup/ownership; it does not abandon an in-flight
VZ call or authorize reattachment. Late confirmed cleanup updates controller
state but does not rewrite or duplicate the earlier terminal. Release requires
confirmed closure, no owned process opening/running, and consumed terminal
events. The real backend delegates durable release to the host proof service,
not a dead PID or VZ state alone. No daemon-crash recovery result is implied.

Native wakeups use a nonblocking socket FD. The C addon blocks one native event
thread in `poll(2)` and forwards through a bounded Node-API thread-safe function;
JavaScript executes only on its own thread. VZ callbacks never call JavaScript
directly. There is no additional host process. Bun 1.3.14 does not support
`uv_poll_init`; an initial fake test exposed that limitation, so the binding
uses no libuv calls. [Bun Node-API](https://bun.com/docs/runtime/node-api),
[Bun libuv support tracking](https://github.com/oven-sh/bun/issues/18546),
[Node-API thread-safe callbacks](https://nodejs.org/api/n-api.html#asynchronous-thread-safe-function-calls)

The addon retains its JS/native owner while callbacks are pending, stops the
reader before release, and pins the library for the embedding process lifetime.
Manual poll cannot steal subscribed events. Explicit host shutdown/drain is
required before `close()`. An environment cleanup hook requests best-effort
shutdown and retains unresolved native ownership; it is not a substitute for
the daemon's reviewed graceful shutdown sequence or a proved force-stop path.

## Local no-VM validation

```sh
swift test --package-path apple/Cowork/WinterCoworkVM --jobs 4
swift test --package-path spikes/cowork-vm/native --jobs 4
/bin/sh apple/Cowork/WinterCoworkVM/node-api/build.sh
bun run apple/Cowork/WinterCoworkVM/node-api/smoke.ts
bun run apple/Cowork/WinterCoworkVM/node-api/client-smoke.ts
```

The build reads existing Node headers (`WINTER_NODE_API_HEADERS` overrides the
default Homebrew path); it installs nothing globally and signs nothing. Each
adapter/library output is copied into a unique `node-api/out/build-*` directory
so a later build does not overwrite a running artifact. `latest-build.txt` is
test discovery only. Production must load verified packaged paths, not this
mutable development pointer. All tests use the fake backend, and no live
Winter app/home/daemon/Keychain, selected folder or VM is accessed.

Tests cover scope/epoch rejection, concurrent execution, independent task
cancellation, bounded stdin/output, terminal reservations, allocation retry,
release ownership, uncertain stop, pending-start drain and late-cleanup budget
behavior. The addon smoke proves those selected flows through real Bun Node-API
and native FD delivery; it does not prove real guest cancellation or production
signing. The concrete VZ path has compiled, not launched in this package.

An independent review found and corrected cancellation masking cleanup
uncertainty, execution saturation denying shutdown, unrelated request failures
poisoning pending start, and repeated output failures spawning unlimited cleanup
tasks. The 37 native tests now include those regressions and the later review fixes below. Current grant revision
is still part of this groundwork's immutable scope; production integration must
separate transport incarnation identity from per-operation current authority so
live source changes do not poison existing processes or retain obsolete grants.

Both addon and typed-client smoke were also compiled with Bun's two autoload
features disabled and run against a unique adapter/library directory. Those
fake compiled executables exited successfully. This is compiled-Bun embedding
evidence, not the hardened, team-signed production `winter-core` packaging gate.

Remaining integration: signed daemon/library/addon packaging and verification;
canonical host authority/admission and disk ownership; protected guest bootstrap
and authenticated stream; root task/delegation checks; every production tool
compartment; host network endpoint; signed folder grants/revocation; suspend,
crash and shutdown ownership proof; actual memory return; SDK durability; and
the protocol/UI/scheduler acceptance gates. Production spawn stays blocked.

## PR review lifecycle and isolation corrections

Native admission is consumed in submission order; exec ownership/opening state
is registered before asynchronous backend work can start. Waiting for input
registration does not serialize the lifetime of independent execs. Stop closes
admission, cancels live processes concurrently (at most128 admitted execs), drains
opening and exec completion, then calls backend.stop. Confirmed termination is
monotonic: no late process error can restore uncertain power or disk ownership.
Real cancellation sends TERM, escalates to KILL after2s if still running, and
acknowledges only after the owning run finishes wait/delete. A pending-construction
cancellation also waits for the target terminal and propagates cleanup uncertainty. Its caller's stop
budget can expire while this cleanup remains owned; that expiry is not an ACK.

Each operation has its own reserved output quota (default32KiB/32 events with128
ordinary slots), so a flood cancels only its owner rather than consuming another
operation's capacity. Terminal slots remain separate. Guest stdin ACK means a
bounded chunk was queued, not that a guest application consumed it.

Shares reject host root, host-home ancestors, overlap with explicitly protected
Winter homes, duplicate/overlapping sources, and noncanonical guest mount paths.
The real host descriptor now requires currentHostHome(path/homeId/dev/inode)
and protectedHomes; host admission must supply the complete supported Winter
home inventory. Native checks validate their identities before constructing VZ.
Only declared fixed production/fixture guest mount roots or a bounded
/workspace/sources/<source-id> destination are accepted. ProbeFailure codes
survive terminal mapping. Launch errors before VZ construction are explicitly
classified never-created; post-construction uncertainty keeps ownership. The
VZInstanceExtension.didCreate hook records the actual construction boundary.

The Node event reader now has its own wake pipe, so cleanup wakes the blocking
poll immediately rather than joining a one-second timeout on JavaScript's
thread. TSFN thread-start failure records both reference releases and cannot
repeat the JavaScript release during finalization. Callbacks keep context alive
until TSFN finalization joins the reader. Error messages are UTF8-byte bounded.

Pinned upstream Containerization LinuxProcess.waitIoComplete catches its own3s
timeout and does not expose verified stdout/stderr EOF. Default builds retain it
and real launch refuses that profile. The verified-eof build profile applies a
hash-pinned local source patch and awaits independent EOF/error evidence before
deleting a process; only successful proof returns outputCompletion=verified-eof.
A failure stays typed output_completion_unproven. See dependency-patches/README.md
for exact preparation, pins, packaging and no-VM tests. This API compiled and
passed synthetic state tests; real guest transport remains unvalidated. Fake
backend metadata is explicitly verified-fake. No real VZ launch was used.

An explicit host-owned managedSharedDirectories record permits only an exact
sourceId/path/role/dev/inode directory for instructions, memory or outputs under
a protected Winter home. The share must independently declare its same role,
canonical guest destination and expected read-only policy. A directory label
alone is insufficient; roots/ancestors, wrong identities and broad home
exemptions remain refused. Tests cover accepted exact memory records and each
refusal. Host admission must authenticate those records from protected authority.
Launch descriptors also pin NativeCompiledGraph.identity; packaged native bytes
and signature verification remain the host's responsibility.

Native release also requires confirmed flush. Observed termination with unknown
flush reports uncertain and keeps the controller owned for recovery. Host durable
ownership and journal/flush disposition remain separate admission responsibilities.

## Independent escalation and reservation rollback

The normal stop drain still owns every start, device operation, process run and
cancellation receipt. A caller deadline now also starts a separately owned
backend.forceStop task, which can execute while guest TERM/wait is hung. Cleanup
without a reserved stop receipt has its own default30s deadline (short injectable
host budgets support no-VM tests). Timeout produces one uncertain receipt, never
abandons the normal drain, and never authorizes disk reattachment. Native release
requires both tasks to settle plus termination, flush/recovery and effect proof.

The VZ implementation invokes the public VZVirtualMachine.stop completion API on
its vmQueue directly; it bypasses guest-agent/container/NIO shutdown waits. This
is a destructive hardware stop, not a guest flush. It watches pending startup so
an initially stopped object cannot become a later running VM after a deadline.
Forced termination reports flushConfirmed=false, retains host ownership and
requires separate dirty-disk/recovery proof. No real VZ force-stop was run here.
An already-clean stopped VM's in-flight host confirmation remains owned and is
shared with escalation; it cannot be replaced by a late uncertainty write.

Successful host authorize transfers a reservation. If validation fails before
the actual didCreate boundary, abortUnstartedReservation must acknowledge release
before the launch is classified release-safe. This callback is distinct from
confirmStopped (backing termination plus clean flush/recovery and external-effect
proof). Abort failures retain uncertainty; stop retries abort only. Concurrent
abort calls coalesce into one owned callback; implementations must remain
idempotent across crash/retry. Constructed VMs can never use this no-VM abort.
FeatureBlockedAdmission acquires no reservation and provides a safe no-op abort.
A failed guest flush never invokes confirmStopped or clears the real VM owner.

37 default-profile native tests pass, including the root's registered-cancel
completion and drain-before-stdin-EOF regressions; new barrier-driven tests prove
independent escalation while cancel/run are stuck, cleanup with saturated receipt
capacity, reservation acquisition/abort/retry/coalescing, constructed-state abort
refusal and prevention of release without flush. These test fake host proof and
compile the VZ path; they do not prove real guest cancellation, VZ backing-service
termination, dirty-disk recovery, active RAM return or production integration.
