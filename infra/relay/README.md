# Norma relay infrastructure (SP2b Task 6)

Two Oracle Always-Free `iroh-relay` VMs in Frankfurt (`relay-1`/`relay-2.yanlinglabs.com`), the
production signed relay config the app bundles, and the tooling to provision/verify/bench/upgrade
them. Everything here is designed to run at **$0** within Oracle's Always-Free tier limits
(`VM.Standard.E2.1.Micro` x2, one VCN, Always-Free egress).

## Prerequisites

- **OCI credentials** in the login Keychain, service `com.norma.infra`:
  - `oci-config` (account): `key=value` lines — `tenancy`, `user`, `fingerprint`, `region`.
  - `oci-key-pem` (account): the API signing key's PEM, private half.

  Add them with `security add-generic-password -s com.norma.infra -a oci-config -w $'tenancy=...\nuser=...\nfingerprint=...\nregion=eu-frankfurt-1'`
  and similarly for `oci-key-pem`. **Gotcha** (verified empirically): `security find-generic-password
  -w` HEX-ENCODES a stored value that contains embedded newlines (a PEM always does) — `oci.ts`'s
  `decodeKeychainValue` handles this transparently; if you write your own reader, do the same:
  `/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? Buffer.from(raw, "hex").toString("utf8") : raw`.

- **Cloudflare API token** in the login Keychain, service `com.norma.cf`, account `api-token`
  (DNS-edit scope on zone `yanlinglabs.com`). **Not present as of this task's run** — `provision.ts`
  reads it lazily (only right before the DNS step) and throws a clean, actionable error if it's
  missing; add it with `security add-generic-password -s com.norma.cf -a api-token -w <token>`.

- **SSH key**: `provision.ts` uses `~/.ssh/id_ed25519.pub` if present (read-only, never modified).
  If absent, it generates a DEDICATED keypair at `~/.ssh/norma-relay{,.pub}` and uses that instead —
  your other SSH keys are never touched either way. During this task's run, `~/.ssh/id_ed25519.pub`
  already existed and was used as-is; no dedicated key was generated.

## Files

| File | Purpose |
|---|---|
| `oci.ts` | draft-cavage HTTP-signature signer for the OCI IaaS API + a thin `ociRequest()` wrapper. Self-verifies every signature locally before sending. |
| `provision.ts` | Idempotent provisioner: VCN, IGW, dual-stack subnet, security list, 2x instances, Cloudflare DNS. `--dry-run` prints the plan with zero network calls. |
| `cloud-init.yaml.tmpl` | Rendered per-instance: dedicated `iroh-relay` system user, hardened systemd unit, ufw, unattended-upgrades, sha256-verified binary install. |
| `relay-config.json` | Unsigned source config (`{version, relays}`) — sign with `scripts/sign-relay-config.ts` (exact invocation below). |
| `relay-config.signed.json` | Signed output (committed — public data). Identical copy lives at `apple/Norma/Resources/relay-config.signed.json` (the one actually embedded in the app bundle). |
| `health-check.ts` | DNS (dual-stack) + TLS cert + HTTPS identity + a real iroh connectivity probe, per relay. |
| `bench.ts` | N-parallel `norma-fake-phone probe-relay` burst against one relay; success rate + p50/p95; optional SSH-captured relay-side memory. |
| `upgrade-drill.md` | Exact steps + rollback path for rolling a new `iroh-relay` version onto a live box. |

## Running `provision.ts`

```sh
bun infra/relay/provision.ts --dry-run   # prints the full plan, touches no network at all
bun infra/relay/provision.ts             # live — idempotent, safe to re-run after a partial failure
```

Every resource it *creates* is looked up by display name first and reused if already present.
Security-list/route-table rules are always re-applied as the full desired state (a `PUT`, naturally
idempotent) rather than diffed. **Because that `PUT` replaces the whole rule set**, the desired
state must itself include the ICMP path-MTU-discovery rules Oracle's default list normally carries
(ICMP type 3 code 4 for IPv4, ICMPv6 type 2 "packet too big") — dropping them black-holes PMTUD
and shows up as intermittent TLS/SSH stalls on sub-1500-MTU paths. `provision.ts` includes both
(8 ingress + 2 egress rules total).

## Signing the relay config

The committed `relay-config.signed.json` (both copies) was produced with exactly:

```sh
bun scripts/sign-relay-config.ts --generate                      # ONCE — refuses if the key already exists
bun scripts/sign-relay-config.ts infra/relay/relay-config.json   # writes infra/relay/relay-config.signed.json
cp infra/relay/relay-config.signed.json apple/Norma/Resources/relay-config.signed.json
```

After changing `relay-config.json` (bump `version` — anti-rollback is strictly-increasing), re-run
the second and third commands, and update nothing else: the public key in
`RelayConfigTrust.productionPublicKey` stays the same for the key's whole lifetime.

## iroh-relay version + config schema (verified against the real v1.0.2 binary during this task)

- Pinned version: **v1.0.2** — the latest `n0-computer/iroh` release overall as of this task (not
  merely latest on the `>= 1.0.2` line iroh-ffi v1.1.0 requires), so this is not "silently taking a
  newer major." Binary: `iroh-relay-v1.0.2-x86_64-unknown-linux-musl.tar.gz`, sha256
  `3d6c37a66f8b21da620f9d83ce4682639aa2de9910bbf1e8e7981cf8478964ea` (computed directly from the
  downloaded release asset, not copied from anywhere).
- **Ports: 22/tcp (SSH), 443/tcp (relay HTTPS), 7842/udp (QUIC address discovery).** The task
  brief's own port sketch assumed `3478/udp` (traditional STUN) — that's wrong for this binary.
  Verified by reading `iroh-relay/src/defaults.rs` at tag v1.0.2: `DEFAULT_RELAY_QUIC_PORT = 7842`.
  iroh-relay's address-discovery protocol is QUIC-native, not RFC 5389 STUN. Port 80/tcp is
  deliberately NOT opened externally: the binary always binds an HTTP listener locally (needed only
  for the captive-portal detection path, which Norma's own clients never use), and ACME validation
  here uses **TLS-ALPN-01** (confirmed via the binary's embedded `acme-tls/1` ALPN string), which
  needs only 443 — not the HTTP-01 challenge's port 80.
- **`quic_bind_addr` is a field of `[tls]`, not top-level** — confirmed empirically while writing
  `cloud-init.yaml.tmpl`: a top-level `quic_bind_addr` is silently ignored by this config parser
  (unknown fields aren't rejected), leaving the server on its *default* QUIC port regardless of what
  you asked for. Verified fixed by locally running the real macOS `iroh-relay` binary against both
  the broken and corrected config and confirming `lsof`'s bound UDP port matched the config only
  after moving the field under `[tls]`.
- Full schema pinned by reading `iroh-relay/src/main.rs` at tag v1.0.2 (its `Config`/`TlsConfig`
  structs) rather than guessing — see `cloud-init.yaml.tmpl` for the actual rendered TOML.
- Dual-stack: `[::]` binds (IPv4 + IPv6 on the same socket — Ubuntu's default `bindv6only=0`).
- Access control: `access = "everyone"` (no allowlist) — deliberate. The relay is OUTSIDE Norma's
  trust boundary: it only ever relays already end-to-end-encrypted iroh QUIC traffic between pinned
  endpoint IDs (`RelayConfigTrust`/`RelayConfigStore` verify the CONFIG that names the relay, not
  anything the relay itself asserts), so anyone reaching it can at worst relay their own traffic
  through it.

## Oracle tenancy provisioning state (as of this task's run)

The user's OCI API key is verified working (a signed GET of the tenancy's own VCNs returns `200`).
**Compute is not fully live yet**: `GET /20160918/availabilityDomains?compartmentId=<tenancy>`
returns `404 NotAuthorizedOrNotFound` while `vcns`/`subnets`/`images`/`instances` all return `200` —
a narrower gap than "the whole tenancy 404s" (this task's brief's original framing). This is
Oracle's fresh-tenancy provisioning lag for the compute/availability-domain subsystem specifically.

**What was actually run live during this task** (idempotent — safe to re-run, real resources exist
in the tenancy right now, at $0 within Always-Free VCN limits):

- VCN `norma-relay-vcn` (`10.0.0.0/16`, IPv6-enabled — Oracle assigned a `/56` GUA prefix).
- Internet gateway `norma-relay-igw`, wired into the VCN's default route table for BOTH
  `0.0.0.0/0` and `::/0`.
- Default security list updated with exactly the 8 ingress rules above (SSH/HTTPS/QUIC v4+v6, plus
  the two ICMP/ICMPv6 PMTUD rules) + 2 allow-all egress — re-applied live after the review fix that
  added the PMTUD pair; verified by a direct GET of the live list.
- Public dual-stack subnet `norma-relay-subnet` (`10.0.1.0/24` + a `/64` carved from the VCN's `/56`).
- Ubuntu 24.04 image lookup (resolved to the current `Canonical-Ubuntu-24.04-2026.04.30-1` image,
  filtered by `shape=VM.Standard.E2.1.Micro`).

(OCIDs deliberately omitted from this file — not secret, but there's no reason to hardcode
tenancy-specific identifiers into a committed doc; look them up live via the OCI console or
`provision.ts`'s own output.)

**What is still pending** (blocked purely on the `availabilityDomains` 404 clearing — no code
changes needed, just re-run once Oracle's provisioning catches up):

1. `bun infra/relay/provision.ts` again — will proceed past the availability-domain lookup, launch
   both `VM.Standard.E2.1.Micro` instances, and (once the Cloudflare token above is added) upsert
   `A`/`AAAA` DNS.
2. `bun infra/relay/health-check.ts` — DNS/TLS/HTTPS/iroh-probe against both relays.
3. Forced-relay E2E, both directions:
   ```sh
   NORMA_RELAY_E2E=1 swift test --filter IrohRelayE2ETests   # relay-1 (default)
   NORMA_RELAY_E2E=1 NORMA_RELAY_E2E_URL="https://relay-2.yanlinglabs.com./" swift test --filter IrohRelayE2ETests
   ```
   Paste both runs' results below once executed.
4. `bun infra/relay/bench.ts --url https://relay-1.yanlinglabs.com./ --ssh-host ubuntu@relay-1.yanlinglabs.com`
   (and again for relay-2) — paste results below.
5. Execute `upgrade-drill.md` once against `norma-relay-2` (same-version reinstall counts).

### Forced-relay E2E results

_Pending — relays don't exist yet (see above)._

### Bench results

_Pending — relays don't exist yet._ Methodology once they do: `bench.ts --n 200` (default) against
each relay, capturing success rate, p50/p95 time-to-`Endpoint.online()`, and relay-side
`free -m` right after the burst. The **10k-connection scale target is a documented goal, not a
measured result**: extrapolate the per-connection memory delta observed at `--n 200` (or whatever
`ulimit -n`-bounded `--n` this Mac can drive) linearly to 10,000 and record both the measured
per-conn figure and the extrapolated 10k total here once the `--n 200` run exists. A
`VM.Standard.E2.1.Micro` has 1GB RAM — if the extrapolation exceeds what that leaves after the OS +
`iroh-relay`'s own baseline, that's the actual finding to report, not a number to paper over.

### Upgrade drill

_Pending — see `upgrade-drill.md`._
