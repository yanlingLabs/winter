# Credential-free provider turn slice

The bounded provider path runs real provider-runtime adapters inside Core and the
existing SDK fold through a private guest proxy. It does not register a daemon
RPC, create a credential-transfer route or enable confined guest startup. Core is
based on composition `4453509b`; its companion SDK branch starts from clean main
`1816df72`. No schema, pin, release or production credential changed.

Core `cowork/provider-broker.ts` receives an already decoded request from a trusted
native/helper port. It does not parse guest packet streams in the credential
process. Host admission supplies canonical home/workspace/logical conversation,
SDK backend, task, boot/incarnation/lease and grant/account/model revisions, a
resolved adapter, fixed account slot and connection. The current-authority check
runs before admission, credential resolution and after asynchronous reads/pulls.
A guest may supply bounded turn content/tools, never a credential ref, headers,
connection, endpoint or larger scope. Explicit user/local endpoints additionally
require a host-service grant. Account/model/destination resolution and final
canonical/native channel admission remain root integration responsibilities.

The broker uses the existing CredentialStore over SecretStore. Refresh is a
host-only callback with generation/single-flight tracking, not a guest token grant.
It never retries/replays a turn. The underlying adapters retain their reviewed
pre-stream retry rules. Full native-state, thinking, signatures, tool event triples,
usage and progress pass to the SDK fold. Error prose is replaced, typed error
flags survive, and terminal errors are not marked retryable. Auth-status output
and error prose are suppressed. Known credential/header material in any outgoing
event is refused; logs contain only admitted provider/model and byte counts.

Pull-per-event flow bounds memory/backpressure: at most eight host turns, one
pending adapter operation per turn, 2 MiB turn input, 256 KiB event, 16 MiB total
output and 8192 events. Channel polls return pending after five seconds while retaining the same adapter
operation; valid model reasoning is not aborted by that poll deadline. Idle admission expires
at thirty seconds and total turn lifetime at ten minutes. Cancellation aborts the
exact adapter and retains admission until pending work and iterator finalization
complete with `done:true`; ignored or failed finalization never becomes cleanup
proof. Request IDs cannot replay and exhausted tracking refuses new effects.

SDK `guest/provider-client.ts` copies the trusted bootstrap scope/model metadata,
uses bounded private length-prefixed bytes and has no local provider/credential
fallback. Its sealed binding is an internal SessionProviderOptions field, absent
from RuntimeConfig/environment/control frames. The real buildProvider route calls
adapterAsProvider with the proxy, so native state/domain stamping and ordinary
reasoning/sidecar rules are reused. Logical conversation IDs and SDK backend IDs
are distinct, and a mismatched session refuses before credential wiring. Global
`supportsConfinedGuestExecution` remains false.

## Current verified roundtrip

Two actual shipped-adapter cases pass: OpenAI Responses and Anthropic Messages.
A host-held fixture SecretStore authenticates fake upstream HTTP; a dedicated
fixture Worker parses actual private bytes, while the credential host receives
structured requests. The actual SDK buildSessionProvider/fold consumes events,
its real sidecar append/read reconstructs continuation, and a tool-result second
turn replays Responses opaque state/summary or Anthropic signed thinking exactly.
The fixture key is absent from guest frames/errors/logs/sinks/stores. The tool
result is scripted; this does not prove Linux tool dispatch or native helper
confinement. The Worker has no production sandbox/admission claim.

Run the companion source through an isolated test binding (this environment
variable is used only by the test loader, never by production authorization):

```sh
COWORK_PROVIDER_PROXY_CANDIDATE=<clean-sdk-candidate> \
  bun test packages/core/test/cowork/provider-broker.test.ts \
  packages/core/test/cowork/provider-broker.integration.test.ts
```

Final focused evidence: **13 Core tests, zero failures, 109 assertions**, including
both real two-turn cases and actual Responses partial-output failure without replay.
The broker tests include one shared refresh with a revoked waiting channel, an
actual five-second pending poll for a valid slow model, concurrent-pull/oversize
refusal, malformed input and nonterminal finalizer retention. SDK proxy tests
measure the actual six-second ignored-transport deadline and response byte bounds.
**166 SDK proxy/posture/bridge/session-provider/credential regressions, zero
failures, 513 assertions** pass. Core typecheck and both SDK typecheck projects
pass using each worktree's own frozen dependency installation. Lockfiles, scripts,
SDK pins and release versions were not changed. Another 28 existing Core
host-credential/provider regressions pass (120 assertions). An unset candidate skips
the cross-repository test explicitly; the installed SDK consumer pin stays unchanged.

Production authentication/demultiplexing in a signed sandboxed native helper,
canonical model/account/grant resolution and invalidation, child-task bindings,
provider grant persistence/daemon registration, complete guest bootstrap/tool/store
ownership and source readiness remain unconnected. This slice does not claim
full Cowork, at-rest confidentiality, encryption or durable guest execution.

## Concurrent invocation and cancellation correction

Independent review of SDK PR7 identified that single-flight state and whole-client
abort would reject parallel work and prevent a conversation continuing after Stop.
The corrected guest client and host broker maintain independent invocation maps.
The host retains its global eight-turn bound and each invocation's pending adapter
operation/finalizer debt; canceling one turn does not retire another. Credential
refresh generation observations are now per invocation while refresh work remains
shared by host account.

Scoped cancel is idempotent and fences a delayed begin, even when independent
channel exchanges arrive out of order. Late canceled output never becomes an event.
Capacity exhaustion reports `capacity_busy`, which the SDK exposes as a retryable
rate-limit error without closing the binding; it does not automatically replay a
turn. Host pending responses must arrive inside the guest six-second exchange
budget (the broker's existing poll budget is five seconds). Binding/protocol faults
and explicit session close still fence the binding.

Correction validation: 13 Core broker tests/113 assertions and three actual
adapter/SDK bridge tests/48 assertions passed with the corrected SDK candidate.
Ten SDK client tests/54 assertions and both SDK typecheck projects passed; Core
typecheck passed. Coverage includes parallel turns, abort-one/continue-other/new
turn, cancel-before-begin, early consumer return and exactly-once capacity release
with eight outstanding operations. The native transport and full guest engine
remain separate validation gates. Existing artifact manifests are unchanged.
