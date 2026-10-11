# Cowork host network endpoint

Implemented native component, not an integrated or passed VM gate. All packet,
userspace TCP/UDP stack, and host socket work stays on a dedicated pthread inside
the caller process. Production placement is unresolved: putting a C packet
parser in the credential daemon expands its attack surface. This component
must remain unavailable until the reviewed process/connection-broker boundary
is implemented. No helper process, VZ NAT attachment, bridge, host port
forward, guest exec service, or global firewall change is exposed.

## Interface and ownership

`CoworkNetworkEndpoint(scope:policy:syntheticNoOutbound:)` requires host-supplied
workspace/incarnation/lease identity. `NetworkEndpointPolicy.revision` is the
current **grant revision**, independent of conversation/config changes. The caller
must authenticate that scope and policy against protected host authority before
construction and before each policy update. This module does not authenticate
JSON or read the authority DB. Never construct it from a guest request.

- `attachment()` duplicates its connected AF_UNIX datagram socket into an owned
  `VZFileHandleNetworkDeviceAttachment`, MTU 1500. The endpoint must outlive the VM.
- The C API `wc_network_guest_fd` borrows the same L2 endpoint, allowing another
  host-owned VM backend to attach it. A duplicate is still only a transport.
- `replacePolicy(_:expectedRevision:)` drains on the native thread, destroys the
  old stack and all its flows, rebuilds with the new policy, then acknowledges.
  Stale/concurrent revisions are refused. It advances grant revision only.
- `statistics()` returns bounded counters, not destination traffic contents.
- `shutdown()` joins only the owned worker and closes only owned descriptors.
  Close the VM device before destroying its endpoint; shutdown is not proof the
  VM stopped. The host controller retains its independent uncertain-stop fence.
  C callers must exclude new calls and concurrent statistics/FD borrows before
  destroying the endpoint; destroy drains an already admitted policy replacement.

Static guest settings: MAC `02:77:69:00:00:01`, IPv4 `10.0.2.15/24`, gateway
`10.0.2.2`, DNS `10.0.2.3`; IPv6 `fd00:77::15/64`, gateway `fd00:77::2`, DNS
`fd00:77::3`. The Linux guest must receive these settings from trusted boot setup.

## Enforcement

A bounded ingress parser admits ARP/DHCP/NDP infrastructure and unfragmented
TCP/UDP; unsupported/raw IP, IPv4 options, fragments and IPv6 extension headers
fail closed. The final patched libslirp hooks run after destination translation,
immediately before TCP connect or UDP sendto. Actual translated loopback,
private, link-local, multicast, reserved and connected host/LAN destinations are
denied by default. Mapped IPv6 addresses are normalized. Exact IP/port/transport
host grants can allow private unicast; grants expire against monotonic time.
Gateway aliases resolve only to loopback and require that exact loopback grant.
The upstream broad IPv6 virtual-prefix-to-loopback alias is narrowed to the
specific gateway. No network name or DNS answer is authority: each resulting
IP destination is checked again, including after DNS rebinding.

`SystemDNSConfiguration.current()` reads the host OS DNS configuration. Nothing
silently chooses a third-party resolver. The optional resolver exception allows
only configured resolver IP:53 TCP/UDP reached via the virtual DNS service while
public internet access is enabled. It gives no generic private-network grant.
The UDP query parser rejects non-query/opcode traffic, but this is a fixed DNS
service exception, not a full DNS application firewall. Host integration must
watch system DNS changes and replace the resolver policy before resuming work;
automatic resolver-change observation is not implemented yet. Host interface and
routing inventories are cached for 200ms rather than captured on each packet
wake. A failed route refresh retains the last complete snapshot and its host/LAN
fences, denies every new public tuple, and permits previously admitted, pinned
public tuples for at most two seconds from the first failure. Repeated failures
do not extend that grace. An unknown or changed host-interface identity denies
public continuation immediately after observation; a complete identity change
also closes previously pinned public flows. Current grant/DNS authority is
rechecked throughout; expiry, revocation and disabled internet authority never
inherit grace. A snapshot that has never succeeded gives no public authority.

Public connections require one unambiguous effective default interface and are
bound with `IP_BOUND_IF`/`IPV6_BOUND_IF`. Multiple default routers on the same
interface are accepted; defaults on different interfaces remain ambiguous.
Two usable, unscoped /1 routes covering an address family on the same interface
form an effective full-tunnel default, superseding an ordinary /0. Missing,
restricted or ambiguous split halves remain denial prefixes. More specific
routes (including private/static/VPN routes) still require an exact grant. Exact grants and the configured DNS exception use the
host's ordinary route selection. A grant is authority for its exact destination.

This does not detect a router's public WAN address or upstream NAT hairpinning.
Known external-address policy or controlled egress is still needed before
claiming complete denial of host/LAN access. Route binding alone is insufficient.

UDP responses must match one of at most 16 admitted exact peers per socket and
current policy; a peer expires after 120 seconds without an outbound send.
Expiry closes only a flow with no remaining peers; a denied or expired peer
cannot discard another admitted peer's response. A UDP socket cannot mix route
interface bindings; a different binding requires a distinct guest socket.
TCP read/send checks its recorded admitted tuple and current policy. A reset
still drains/closes the socket; failure of `getpeername` does not leave a busy
polling socket behind. Policy replacement resets all flows, while periodic
revalidation closes only affected sockets. No unsolicited listener or
forwarding API is reachable through the wrapper. Internet ping/raw sockets are
explicitly disabled in the vendored paths as defense in depth.

Limits: 256 sockets, 64 grants, 128 supplied/observed prefixes, MTU1500, one native
worker, 128KiB send / 512KiB receive kernel queues per endpoint, nonblocking
writes with visible drop counters, ingress burst64 and 1024 packets/s, at most64
frames processed per poll turn. Idle flow revalidation waits at most100ms plus
scheduled thread time; inventory changes are observed at the next 200ms refresh
and poll turn (up to another100ms plus scheduled thread time). The cache is a
bounded observation window, not atomic route-change notification. During a
route-only failure, retained flows keep their original kernel interface binding;
that cannot prove the host kernel's route within that interface remained the
same. Final outbound tuple/grant checks are synchronous. These bounds are
implemented; CPU/latency under hostile sustained load is not yet benchmarked.
The 1024pps development limit is deliberately conservative and needs product
performance validation. It is not a user's RAM/CPU allocation control.

## Dependency and distribution state

Vendored libslirp v4.9.5, commit
`390848f47391f412451b2d259d8527fabb51e5e3`, with original per-file notices,
LICENSE and COPYRIGHT. See `vendor/libslirp/WINTER-PATCHES.md`. Public callbacks
in upstream libslirp do **not** provide destination filtering; the local hooks
are mandatory. Missing hooks deny. Review and maintain the patch on upgrades.

Build currently uses existing local GLib2.90.0 via pkg-config, and transitively
libintl1.0 and PCRE2 10.49; no global installation was performed. These are
runtime dependencies, not optional developer-only dependencies. Current output
still links Homebrew absolute paths. The separate `../packaging` recipe has
built and relocated GLib/libintl/PCRE2 from pinned sources and verified a release
network package plus its relocated synthetic smoke; see its `VALIDATION.md`.
The default developer build and that isolated package are separate artifacts. Production
availability must remain blocked until the exact native
closure is packaged with relative load paths, verified provenance and notices,
corresponding GLib/libintl source/build material and LGPL replacement/relinking
rights. GLib and libintl use LGPL2.1-or-later; PCRE2 uses BSD3 plus its retained
individual notices. Statically absorbing LGPL libraries is not this design.

Primary references: [libslirp source/tag](https://gitlab.freedesktop.org/slirp/libslirp/-/tree/v4.9.5),
[GLib license](https://docs.gtk.org/glib/),
[LGPL2.1 terms](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html),
[Apple file-handle attachment](https://developer.apple.com/documentation/virtualization/vzfilehandlenetworkdeviceattachment).

## Verification

```
swift build --package-path apple/Cowork/WinterCoworkNetwork --jobs 4
swift test --package-path apple/Cowork/WinterCoworkNetwork --jobs 4
```

45 Swift Testing tests passed on 2026-10-11: public/private/mapped IPv6 and LAN
policy, tuple/expiry grants, configured DNS exception, gateway final tuple,
malformed/raw/fragment denial, policy ACK/stale revision, real libslirp TCP
connect and UDP send to scoped ephemeral loopback listeners, unsolicited UDP
peer rejection, multi-peer UDP replies and selective expiry, TCP payload in
both directions and RST cleanup, flow closure on revocation, direct private
IPv6 denial, and a
full supplied-prefix inventory failing closed instead of skipping observed host
interfaces. The latter regression came from independent security review and
exercises final translated-tuple policy without performing a public send.
Route tests cover Darwin sockaddr alignment/short masks, malformed and bounded
inventories, generated versus static routes, ambiguous/missing defaults,
mapped-prefix normalization, final routed admission and kernel interface-bind
options. Cache tests cover new admission denial, bounded continuation without
renewing the failure window, retained LAN fences, current grant revocation and
expiry, host identity/generation changes, and the 200ms refresh TTL. Packet wakes
exercise that TTL in the real worker. An injected host snapshot drives actual
libslirp TCP and UDP public-route admission and kernel socket binding to `lo0`;
the mandatory synthetic policy refuses before `connect`/`sendto`, and its fixture
constructor and policy replacement cannot enable transmission. This proves the
routed binding path without changing host routes or sending public/LAN traffic.
The read-only live snapshot test logs counts and readiness only.
Tests use disposable local socket fixtures; no VM, real public connection,
provider credential, global service or host pressure is involved. This does not
prove DNS end-to-end, guest DHCP/IPv6 negotiation, VZ
integration, persistent policy crash recovery, or production security readiness.

## Next integration requirements

Host authority must bind immutable workspace/incarnation/lease scope separately
from mutable grant revision. The existing VM groundwork's immutable grant-equality
check must not become a consumer requirement: use per-operation current authority
validation, reject stale grants individually, and host-authorize source/share
transitions. Native transport ACKs do not substitute for DB fences. The root
service must own endpoint lifecycle and resolver change policy, package all
runtime dependencies, and pass independent review plus an isolated VM network
suite before exposing this backend. Active-work RAM return remains a separate
open requirement; this endpoint makes no memory-return claim.
