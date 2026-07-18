#!/usr/bin/env bun
/**
 * Provisions the Oracle Always-Free relay pair (SP2b Task 6): a VCN + internet gateway + public
 * dual-stack (IPv4 + IPv6) subnet + security list, two `VM.Standard.E2.1.Micro` instances
 * (`norma-relay-1`/`norma-relay-2`, Ubuntu 24.04, running `iroh-relay` via the rendered
 * `cloud-init.yaml.tmpl`), then Cloudflare `A`/`AAAA` records for `relay-1`/`relay-2.yanlinglabs.com`.
 *
 * IDEMPOTENT: every resource this script *creates* is looked up by display name first and reused
 * if present -- safe to re-run after a partial failure (e.g. the tenancy 404s partway through).
 * Security-list/route-table rules are expressed as the full desired state and simply re-applied
 * (`Update*`) each run, which is naturally idempotent without a separate existence check.
 *
 * `--dry-run`: prints the plan (what would be checked/created, in order) and makes NO network
 * calls at all -- not even read-only GETs. Useful to eyeball the plan without live OCI/Cloudflare
 * credentials, and safe to run at any time.
 *
 * Credentials: OCI from the login Keychain (`oci.ts`'s `loadOCIConfig()`, service
 * `com.norma.infra`); Cloudflare token from the login Keychain, service `com.norma.cf`, account
 * `api-token` -- read lazily, only right before the DNS step, with a clean error if absent (this
 * item may not exist yet; see README.md).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadOCIConfig, ociRequest, rootCompartmentId, type OCIConfig } from "./oci.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Fixed plan constants
// ---------------------------------------------------------------------------

const VCN_NAME = "norma-relay-vcn";
const VCN_CIDR = "10.0.0.0/16";
const SUBNET_NAME = "norma-relay-subnet";
const SUBNET_CIDR = "10.0.1.0/24";
const IGW_NAME = "norma-relay-igw";
const SHAPE = "VM.Standard.E2.1.Micro";
const INSTANCE_NAMES = ["norma-relay-1", "norma-relay-2"] as const;
const DOMAIN_BASE = "yanlinglabs.com";
const RELAY_HOSTNAMES = ["relay-1", "relay-2"] as const;

// iroh-relay pin (SP2b Task 6): latest release on the `>= 1.0.2` line iroh-ffi v1.1.0 (this
// repo's pinned client binding) itself requires -- see apple/NormaKit/vendor/README.md. Verified
// against https://github.com/n0-computer/iroh/releases: v1.0.2 published 2026-07-06 IS the
// latest release overall (not just latest on this line), so this is not "silently taking a newer
// major" -- there is no newer release yet.
const IROH_RELAY_VERSION = "1.0.2";
// sha256 of iroh-relay-v1.0.2-x86_64-unknown-linux-musl.tar.gz, computed directly from the
// downloaded release asset during this task (not copied from anywhere) -- baked into cloud-init
// so a compromised/rotated release asset fails the boot's checksum check loudly instead of
// silently installing different binaries.
const IROH_RELAY_SHA256 = "3d6c37a66f8b21da620f9d83ce4682639aa2de9910bbf1e8e7981cf8478964ea";
// The QUIC address-discovery ("QAD") port iroh-relay's own code pins as its default
// (`DEFAULT_RELAY_QUIC_PORT` in iroh-relay/src/defaults.rs, tag v1.0.2) -- NOT 3478 (traditional
// STUN); iroh-relay's own protocol is QUIC-native, not RFC 5389 STUN. Confirmed by reading the
// pinned tag's actual source rather than assuming a generic STUN port.
const QUIC_ADDR_DISCOVERY_PORT = 7842;

interface Plan {
  log(msg: string): void;
}

function log(msg: string): void {
  console.log(msg);
}

// ---------------------------------------------------------------------------
// SSH key
// ---------------------------------------------------------------------------

const HOME = process.env.HOME ?? "";
const DEFAULT_SSH_PUB = join(HOME, ".ssh/id_ed25519.pub");
const DEDICATED_SSH_PRIV = join(HOME, ".ssh/norma-relay");
const DEDICATED_SSH_PUB = join(HOME, ".ssh/norma-relay.pub");

/**
 * Uses `~/.ssh/id_ed25519.pub` if present (never touched/modified -- read-only). Otherwise
 * generates a DEDICATED keypair at `~/.ssh/norma-relay{,.pub}` -- the user's own keys are never
 * touched in that case either. Returns the public key text to inject via cloud-init.
 */
function ensureSSHPublicKey(): { path: string; publicKey: string; generated: boolean } {
  try {
    const key = readFileSync(DEFAULT_SSH_PUB, "utf8").trim();
    return { path: DEFAULT_SSH_PUB, publicKey: key, generated: false };
  } catch {
    // fall through to the dedicated keypair path
  }
  try {
    const key = readFileSync(DEDICATED_SSH_PUB, "utf8").trim();
    return { path: DEDICATED_SSH_PUB, publicKey: key, generated: false };
  } catch {
    // doesn't exist yet -- generate it now (`-N ""` -- no passphrase, matching a service keypair's
    // usage: this key exists purely so `provision.ts`/the health-check/bench scripts can SSH into
    // the relay boxes non-interactively).
  }
  if (DRY_RUN) {
    return { path: DEDICATED_SSH_PUB, publicKey: "<would be generated: ~/.ssh/norma-relay(.pub)>", generated: true };
  }
  execFileSync("ssh-keygen", ["-t", "ed25519", "-f", DEDICATED_SSH_PRIV, "-N", "", "-C", "norma-relay-provisioning"]);
  const key = readFileSync(DEDICATED_SSH_PUB, "utf8").trim();
  return { path: DEDICATED_SSH_PUB, publicKey: key, generated: true };
}

// ---------------------------------------------------------------------------
// Small OCI helpers
// ---------------------------------------------------------------------------

async function findByDisplayName(cfg: OCIConfig, listPath: string, displayName: string): Promise<any | null> {
  const res = await ociRequest(cfg, "GET", listPath);
  if (res.status !== 200) {
    throw new Error(`GET ${listPath} -> ${res.status}: ${res.raw.slice(0, 500)}`);
  }
  const items = Array.isArray(res.json) ? (res.json as any[]) : [];
  const match = items.find((i) => i.displayName === displayName && i.lifecycleState !== "TERMINATED" && i.lifecycleState !== "TERMINATING");
  return match ?? null;
}

async function pollUntil(
  cfg: OCIConfig,
  getPath: string,
  wantState: string,
  what: string,
  timeoutMs = 5 * 60_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await ociRequest(cfg, "GET", getPath);
    if (res.status !== 200) throw new Error(`GET ${getPath} -> ${res.status}: ${res.raw.slice(0, 300)}`);
    const obj = res.json as any;
    if (obj.lifecycleState === wantState) return obj;
    if (obj.lifecycleState && /FAILED|TERMINAT/.test(obj.lifecycleState)) {
      throw new Error(`${what} entered lifecycleState ${obj.lifecycleState} while waiting for ${wantState}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`timed out waiting for ${what} to reach ${wantState}`);
}

// ---------------------------------------------------------------------------
// Step 1: VCN
// ---------------------------------------------------------------------------

async function ensureVcn(cfg: OCIConfig): Promise<any> {
  const compartmentId = rootCompartmentId(cfg);
  if (DRY_RUN) {
    log(`[dry-run] GET vcns?displayName=${VCN_NAME} -- create if absent:`);
    log(`  POST /20160918/vcns { compartmentId, displayName: "${VCN_NAME}", cidrBlocks: ["${VCN_CIDR}"], isIpv6Enabled: true }`);
    return { id: "<dry-run-vcn-id>", defaultRouteTableId: "<dry-run-rt-id>", defaultSecurityListId: "<dry-run-sl-id>", ipv6CidrBlocks: ["2603:c020:xxxx:xx00::/56"] };
  }
  const existing = await findByDisplayName(cfg, `/20160918/vcns?compartmentId=${compartmentId}`, VCN_NAME);
  if (existing) {
    log(`VCN "${VCN_NAME}" already exists (${existing.id}), reusing.`);
    return existing;
  }
  log(`Creating VCN "${VCN_NAME}" (${VCN_CIDR}, IPv6 enabled)...`);
  const created = await ociRequest(cfg, "POST", "/20160918/vcns", {
    compartmentId,
    displayName: VCN_NAME,
    cidrBlocks: [VCN_CIDR],
    isIpv6Enabled: true,
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`POST /vcns -> ${created.status}: ${created.raw.slice(0, 500)}`);
  }
  const vcn = created.json as any;
  return pollUntil(cfg, `/20160918/vcns/${vcn.id}`, "AVAILABLE", "VCN");
}

// ---------------------------------------------------------------------------
// Step 2: Internet gateway + default route table
// ---------------------------------------------------------------------------

async function ensureInternetGateway(cfg: OCIConfig, vcnId: string): Promise<any> {
  const compartmentId = rootCompartmentId(cfg);
  if (DRY_RUN) {
    log(`[dry-run] GET internetGateways?vcnId=${vcnId}&displayName=${IGW_NAME} -- create if absent:`);
    log(`  POST /20160918/internetGateways { compartmentId, vcnId, displayName: "${IGW_NAME}", isEnabled: true }`);
    return { id: "<dry-run-igw-id>" };
  }
  const existing = await findByDisplayName(
    cfg,
    `/20160918/internetGateways?compartmentId=${compartmentId}&vcnId=${vcnId}`,
    IGW_NAME
  );
  if (existing) {
    log(`Internet gateway "${IGW_NAME}" already exists (${existing.id}), reusing.`);
    return existing;
  }
  log(`Creating internet gateway "${IGW_NAME}"...`);
  const created = await ociRequest(cfg, "POST", "/20160918/internetGateways", {
    compartmentId,
    vcnId,
    displayName: IGW_NAME,
    isEnabled: true,
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`POST /internetGateways -> ${created.status}: ${created.raw.slice(0, 500)}`);
  }
  const igw = created.json as any;
  return pollUntil(cfg, `/20160918/internetGateways/${igw.id}`, "AVAILABLE", "internet gateway");
}

async function ensureDefaultRouteToInternet(cfg: OCIConfig, routeTableId: string, igwId: string): Promise<void> {
  if (DRY_RUN) {
    log(`[dry-run] PUT /20160918/routeTables/${routeTableId} -- ensure 0.0.0.0/0 and ::/0 route to ${igwId}`);
    return;
  }
  const res = await ociRequest(cfg, "GET", `/20160918/routeTables/${routeTableId}`);
  if (res.status !== 200) throw new Error(`GET routeTable -> ${res.status}: ${res.raw.slice(0, 300)}`);
  const rt = res.json as any;
  const existingRules: any[] = rt.routeRules ?? [];
  const wantDestinations = [
    { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: igwId },
    { destination: "::/0", destinationType: "CIDR_BLOCK", networkEntityId: igwId },
  ];
  const merged = [...existingRules.filter((r) => r.destination !== "0.0.0.0/0" && r.destination !== "::/0"), ...wantDestinations];
  const already =
    existingRules.some((r) => r.destination === "0.0.0.0/0" && r.networkEntityId === igwId) &&
    existingRules.some((r) => r.destination === "::/0" && r.networkEntityId === igwId);
  if (already) {
    log("Default route table already routes 0.0.0.0/0 and ::/0 to the internet gateway.");
    return;
  }
  log("Updating default route table with 0.0.0.0/0 and ::/0 -> internet gateway...");
  const put = await ociRequest(cfg, "PUT", `/20160918/routeTables/${routeTableId}`, { routeRules: merged });
  if (put.status !== 200) throw new Error(`PUT routeTable -> ${put.status}: ${put.raw.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Step 3: Security list -- 22/tcp (SSH), 443/tcp (relay HTTPS), QUIC address-discovery/udp
// ---------------------------------------------------------------------------

function tcpRule(source: string, port: number, description: string) {
  return {
    protocol: "6",
    source,
    isStateless: false,
    tcpOptions: { destinationPortRange: { min: port, max: port } },
    description,
  };
}

function udpRule(source: string, port: number, description: string) {
  return {
    protocol: "17",
    source,
    isStateless: false,
    udpOptions: { destinationPortRange: { min: port, max: port } },
    description,
  };
}

async function ensureSecurityListRules(cfg: OCIConfig, securityListId: string): Promise<void> {
  const ingress = [
    tcpRule("0.0.0.0/0", 22, "SSH"),
    tcpRule("::/0", 22, "SSH (IPv6)"),
    tcpRule("0.0.0.0/0", 443, "iroh-relay HTTPS"),
    tcpRule("::/0", 443, "iroh-relay HTTPS (IPv6)"),
    // NOT 3478 (generic STUN) -- iroh-relay v1.0.2's own DEFAULT_RELAY_QUIC_PORT, verified by
    // reading the pinned tag's source (iroh-relay/src/defaults.rs). See the top-of-file comment.
    udpRule("0.0.0.0/0", QUIC_ADDR_DISCOVERY_PORT, "iroh-relay QUIC address discovery"),
    udpRule("::/0", QUIC_ADDR_DISCOVERY_PORT, "iroh-relay QUIC address discovery (IPv6)"),
    // Path-MTU discovery (task-6 review fix): this function PUTs the COMPLETE desired rule set,
    // which silently dropped Oracle's default-security-list ICMP rules -- without these, a
    // "fragmentation needed" / "packet too big" signal from a <1500-MTU path never reaches the
    // VM, and TCP/QUIC sessions black-hole with intermittent TLS/SSH stalls (PMTUD breakage).
    // ICMP type 3 code 4 (IPv4 "fragmentation needed and DF set") and ICMPv6 type 2 ("packet
    // too big" -- REQUIRED for IPv6, which has no in-network fragmentation at all).
    {
      protocol: "1", // ICMP
      source: "0.0.0.0/0",
      isStateless: false,
      icmpOptions: { type: 3, code: 4 },
      description: "ICMP path-MTU discovery (fragmentation needed)",
    },
    {
      protocol: "58", // ICMPv6
      source: "::/0",
      isStateless: false,
      icmpOptions: { type: 2 },
      description: "ICMPv6 path-MTU discovery (packet too big)",
    },
  ];
  const egress = [
    { protocol: "all", destination: "0.0.0.0/0", isStateless: false, description: "allow all egress (IPv4)" },
    { protocol: "all", destination: "::/0", isStateless: false, description: "allow all egress (IPv6)" },
  ];
  if (DRY_RUN) {
    log(`[dry-run] PUT /20160918/securityLists/${securityListId} -- ${ingress.length} ingress + ${egress.length} egress rules`);
    for (const r of ingress) log(`  ingress: ${r.description} (${r.source} -> proto ${r.protocol})`);
    return;
  }
  log("Applying security list rules (SSH, HTTPS, QUIC address discovery; dual-stack)...");
  const put = await ociRequest(cfg, "PUT", `/20160918/securityLists/${securityListId}`, {
    egressSecurityRules: egress,
    ingressSecurityRules: ingress,
  });
  if (put.status !== 200) throw new Error(`PUT securityList -> ${put.status}: ${put.raw.slice(0, 500)}`);
}

// ---------------------------------------------------------------------------
// Step 4: Public dual-stack subnet
// ---------------------------------------------------------------------------

function subnetIpv6CidrFromVcn(vcnIpv6CidrBlocks: string[]): string {
  const base = vcnIpv6CidrBlocks[0]; // e.g. "2603:c020:1234:5600::/56"
  if (!base) throw new Error("VCN has no ipv6CidrBlocks -- was isIpv6Enabled actually applied?");
  const [addr] = base.split("/");
  // A /56 has 8 free bits for subnetting into /64s; the first (and here, only) subnet reuses the
  // VCN's own base address with the prefix length narrowed to /64 -- valid since the low 8 bits
  // of the /56 base are already zero.
  return `${addr}/64`;
}

async function ensureSubnet(cfg: OCIConfig, vcn: any): Promise<any> {
  const compartmentId = rootCompartmentId(cfg);
  const ipv6CidrBlock = subnetIpv6CidrFromVcn(vcn.ipv6CidrBlocks ?? []);
  if (DRY_RUN) {
    log(`[dry-run] GET subnets?vcnId=${vcn.id}&displayName=${SUBNET_NAME} -- create if absent:`);
    log(`  POST /20160918/subnets { vcnId, displayName: "${SUBNET_NAME}", cidrBlock: "${SUBNET_CIDR}", ipv6CidrBlock: "${ipv6CidrBlock}", routeTableId: default, securityListIds: [default] }`);
    return { id: "<dry-run-subnet-id>" };
  }
  const existing = await findByDisplayName(cfg, `/20160918/subnets?compartmentId=${compartmentId}&vcnId=${vcn.id}`, SUBNET_NAME);
  if (existing) {
    log(`Subnet "${SUBNET_NAME}" already exists (${existing.id}), reusing.`);
    return existing;
  }
  log(`Creating public dual-stack subnet "${SUBNET_NAME}" (${SUBNET_CIDR} + ${ipv6CidrBlock})...`);
  const created = await ociRequest(cfg, "POST", "/20160918/subnets", {
    compartmentId,
    vcnId: vcn.id,
    displayName: SUBNET_NAME,
    cidrBlock: SUBNET_CIDR,
    ipv6CidrBlock,
    routeTableId: vcn.defaultRouteTableId,
    securityListIds: [vcn.defaultSecurityListId],
    prohibitPublicIpOnVnic: false,
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`POST /subnets -> ${created.status}: ${created.raw.slice(0, 500)}`);
  }
  const subnet = created.json as any;
  return pollUntil(cfg, `/20160918/subnets/${subnet.id}`, "AVAILABLE", "subnet");
}

// ---------------------------------------------------------------------------
// Step 5: Ubuntu 24.04 image lookup
// ---------------------------------------------------------------------------

async function findUbuntuImage(cfg: OCIConfig): Promise<{ id: string; displayName: string }> {
  const compartmentId = rootCompartmentId(cfg);
  const path =
    `/20160918/images?compartmentId=${compartmentId}` +
    `&operatingSystem=${encodeURIComponent("Canonical Ubuntu")}` +
    `&operatingSystemVersion=${encodeURIComponent("24.04")}` +
    `&shape=${encodeURIComponent(SHAPE)}` +
    `&sortBy=TIMECREATED&sortOrder=DESC&limit=10`;
  if (DRY_RUN) {
    log(`[dry-run] GET ${path}`);
    return { id: "<dry-run-image-id>", displayName: "Canonical-Ubuntu-24.04 (newest, dry-run)" };
  }
  const res = await ociRequest(cfg, "GET", path);
  if (res.status !== 200) throw new Error(`GET /images -> ${res.status}: ${res.raw.slice(0, 500)}`);
  const images = res.json as any[];
  // AMD (x86_64) build only -- E2.1.Micro is an AMD shape; the images list is
  // shape-filtered already, but Canonical publishes separate aarch64/x86_64 image lines under
  // the same OS/version, and the `shape` filter is the authoritative disambiguator here.
  const newest = images[0];
  if (!newest) throw new Error("no Canonical Ubuntu 24.04 image found compatible with " + SHAPE);
  return { id: newest.id, displayName: newest.displayName };
}

// ---------------------------------------------------------------------------
// Step 6: Availability domain
// ---------------------------------------------------------------------------

async function firstAvailabilityDomain(cfg: OCIConfig): Promise<string> {
  const compartmentId = rootCompartmentId(cfg);
  if (DRY_RUN) {
    log(`[dry-run] GET /20160918/availabilityDomains?compartmentId=${compartmentId}`);
    return "<dry-run-AD-1>";
  }
  const res = await ociRequest(cfg, "GET", `/20160918/availabilityDomains?compartmentId=${compartmentId}`);
  if (res.status !== 200) {
    throw new Error(
      `GET /availabilityDomains -> ${res.status}: ${res.raw.slice(0, 300)}\n` +
        `This endpoint 404ing (NotAuthorizedOrNotFound) while other IaaS endpoints (vcns/subnets/` +
        `images/instances) succeed is the known Oracle fresh-tenancy provisioning-lag signature ` +
        `(see task-6-report.md) -- re-run this script once it clears.`
    );
  }
  const ads = res.json as any[];
  if (!ads[0]?.name) throw new Error("tenancy has no availability domains?");
  return ads[0].name;
}

// ---------------------------------------------------------------------------
// Step 7: cloud-init render
// ---------------------------------------------------------------------------

function renderCloudInit(domain: string): string {
  const template = readFileSync(join(HERE, "cloud-init.yaml.tmpl"), "utf8");
  return template
    .replaceAll("{DOMAIN}", domain)
    .replaceAll("{IROH_RELAY_VERSION}", IROH_RELAY_VERSION)
    .replaceAll("{IROH_RELAY_SHA256}", IROH_RELAY_SHA256)
    .replaceAll("{QUIC_ADDR_DISCOVERY_PORT}", String(QUIC_ADDR_DISCOVERY_PORT));
}

// ---------------------------------------------------------------------------
// Step 8: instances
// ---------------------------------------------------------------------------

async function ensureInstance(
  cfg: OCIConfig,
  name: string,
  domain: string,
  availabilityDomain: string,
  imageId: string,
  subnetId: string,
  sshPublicKey: string
): Promise<any> {
  const compartmentId = rootCompartmentId(cfg);
  if (DRY_RUN) {
    log(`[dry-run] GET instances?displayName=${name} -- create if absent:`);
    log(`  POST /20160918/instances { availabilityDomain, shape: "${SHAPE}", displayName: "${name}", ` +
        `sourceDetails: { sourceType: "image", imageId }, createVnicDetails: { subnetId, assignPublicIp: true, assignIpv6Ip: true, hostnameLabel: "${name}" }, ` +
        `metadata: { ssh_authorized_keys, user_data: <base64 cloud-init for ${domain}> } }`);
    return { id: `<dry-run-${name}-id>` };
  }
  const existing = await findByDisplayName(cfg, `/20160918/instances?compartmentId=${compartmentId}`, name);
  if (existing) {
    log(`Instance "${name}" already exists (${existing.id}, ${existing.lifecycleState}), reusing.`);
    if (existing.lifecycleState !== "RUNNING") {
      return pollUntil(cfg, `/20160918/instances/${existing.id}`, "RUNNING", name);
    }
    return existing;
  }
  const userData = Buffer.from(renderCloudInit(domain), "utf8").toString("base64");
  log(`Launching instance "${name}" (${SHAPE}, Ubuntu 24.04, AD=${availabilityDomain})...`);
  const created = await ociRequest(cfg, "POST", "/20160918/instances", {
    availabilityDomain,
    compartmentId,
    shape: SHAPE,
    displayName: name,
    sourceDetails: { sourceType: "image", imageId },
    createVnicDetails: {
      subnetId,
      assignPublicIp: true,
      assignIpv6Ip: true,
      hostnameLabel: name,
    },
    metadata: {
      ssh_authorized_keys: sshPublicKey,
      user_data: userData,
    },
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`POST /instances (${name}) -> ${created.status}: ${created.raw.slice(0, 500)}`);
  }
  const instance = created.json as any;
  return pollUntil(cfg, `/20160918/instances/${instance.id}`, "RUNNING", name, 10 * 60_000);
}

async function fetchInstanceAddresses(cfg: OCIConfig, instanceId: string): Promise<{ ipv4: string; ipv6: string }> {
  const compartmentId = rootCompartmentId(cfg);
  const attachments = await ociRequest(cfg, "GET", `/20160918/vnicAttachments?compartmentId=${compartmentId}&instanceId=${instanceId}`);
  if (attachments.status !== 200) throw new Error(`GET vnicAttachments -> ${attachments.status}`);
  const list = attachments.json as any[];
  const primary = list.find((a) => a.lifecycleState === "ATTACHED") ?? list[0];
  if (!primary) throw new Error(`instance ${instanceId} has no VNIC attachment`);
  const vnic = await ociRequest(cfg, "GET", `/20160918/vnics/${primary.vnicId}`);
  if (vnic.status !== 200) throw new Error(`GET vnic -> ${vnic.status}`);
  const v = vnic.json as any;
  return { ipv4: v.publicIp ?? "", ipv6: v.ipv6Addresses?.[0] ?? "" };
}

// ---------------------------------------------------------------------------
// Step 9: Cloudflare DNS (A + AAAA, proxied: false)
// ---------------------------------------------------------------------------

function readCloudflareToken(): string {
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "com.norma.cf", "-a", "api-token", "-w"], {
      encoding: "utf8",
    }).trim();
    if (!raw) throw new Error("empty");
    return raw;
  } catch {
    throw new Error(
      'Cloudflare API token not found in Keychain (service "com.norma.cf", account "api-token"). ' +
        "The controller must add it: `security add-generic-password -s com.norma.cf -a api-token -w <token>` " +
        "(zone yanlinglabs.com, DNS edit permission) -- see README.md."
    );
  }
}

async function cfRequest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(`Cloudflare ${method} ${path} failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

async function upsertDNSRecord(token: string, zoneId: string, type: "A" | "AAAA", name: string, content: string): Promise<void> {
  const existing: any[] = await cfRequest(token, "GET", `/zones/${zoneId}/dns_records?type=${type}&name=${name}`);
  const body = { type, name, content, ttl: 300, proxied: false };
  if (existing.length > 0) {
    if (existing[0].content === content) {
      log(`Cloudflare ${type} ${name} already -> ${content}, skipping.`);
      return;
    }
    log(`Updating Cloudflare ${type} ${name} -> ${content}...`);
    await cfRequest(token, "PUT", `/zones/${zoneId}/dns_records/${existing[0].id}`, body);
  } else {
    log(`Creating Cloudflare ${type} ${name} -> ${content}...`);
    await cfRequest(token, "POST", `/zones/${zoneId}/dns_records`, body);
  }
}

async function ensureDNS(addrs: Record<string, { ipv4: string; ipv6: string }>): Promise<void> {
  if (DRY_RUN) {
    log("[dry-run] Cloudflare: upsert A/AAAA for " + RELAY_HOSTNAMES.map((h) => `${h}.${DOMAIN_BASE}`).join(", ") + " (proxied: false)");
    return;
  }
  const token = readCloudflareToken();
  const zones: any[] = await cfRequest(token, "GET", `/zones?name=${DOMAIN_BASE}`);
  const zone = zones[0];
  if (!zone) throw new Error(`Cloudflare zone "${DOMAIN_BASE}" not found (token scope?)`);
  for (const [i, hostname] of RELAY_HOSTNAMES.entries()) {
    const instanceName = INSTANCE_NAMES[i];
    const a = addrs[instanceName];
    const fqdn = `${hostname}.${DOMAIN_BASE}`;
    if (a.ipv4) await upsertDNSRecord(token, zone.id, "A", fqdn, a.ipv4);
    if (a.ipv6) await upsertDNSRecord(token, zone.id, "AAAA", fqdn, a.ipv6);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(DRY_RUN ? "=== provision.ts --dry-run (no network calls) ===" : "=== provision.ts (live) ===");

  const ssh = ensureSSHPublicKey();
  log(`SSH public key: ${ssh.path}${ssh.generated ? " (freshly generated)" : ""}`);

  const cfg = DRY_RUN
    ? ({ tenancy: "<tenancy>", user: "<user>", fingerprint: "<fp>", region: "eu-frankfurt-1", keyPem: "" } as OCIConfig)
    : loadOCIConfig();
  log(`OCI region: ${cfg.region}`);

  const vcn = await ensureVcn(cfg);
  const igw = await ensureInternetGateway(cfg, vcn.id);
  await ensureDefaultRouteToInternet(cfg, vcn.defaultRouteTableId, igw.id);
  await ensureSecurityListRules(cfg, vcn.defaultSecurityListId);
  const subnet = await ensureSubnet(cfg, vcn);
  const image = await findUbuntuImage(cfg);
  log(`Ubuntu image: ${image.displayName} (${image.id})`);
  const ad = await firstAvailabilityDomain(cfg);
  log(`Availability domain: ${ad}`);

  const addrs: Record<string, { ipv4: string; ipv6: string }> = {};
  for (const [i, name] of INSTANCE_NAMES.entries()) {
    const domain = `${RELAY_HOSTNAMES[i]}.${DOMAIN_BASE}`;
    const instance = await ensureInstance(cfg, name, domain, ad, image.id, subnet.id, ssh.publicKey);
    if (DRY_RUN) {
      addrs[name] = { ipv4: "<dry-run-ipv4>", ipv6: "<dry-run-ipv6>" };
      continue;
    }
    const a = await fetchInstanceAddresses(cfg, instance.id);
    addrs[name] = a;
    log(`  ${name}: ipv4=${a.ipv4} ipv6=${a.ipv6}`);
  }

  await ensureDNS(addrs);

  log("\n=== Summary ===");
  log(`VCN:            ${VCN_NAME} (${vcn.id})`);
  log(`Subnet:         ${SUBNET_NAME} (${subnet.id})`);
  for (const [i, name] of INSTANCE_NAMES.entries()) {
    const a = addrs[name];
    log(`${name.padEnd(16)} ${a.ipv4.padEnd(16)} ${a.ipv6}   https://${RELAY_HOSTNAMES[i]}.${DOMAIN_BASE}/`);
  }
  log(DRY_RUN ? "\n(dry run -- nothing was actually created)" : "\nDone.");
}

main().catch((err) => {
  console.error("provision.ts failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
