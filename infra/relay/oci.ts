#!/usr/bin/env bun
/**
 * OCI REST API client for `provision.ts` (SP2b Task 6): draft-cavage HTTP-signature signing
 * (the scheme OCI's IaaS API expects) + a thin `request()` wrapper. Reads credentials from the
 * login Keychain at runtime -- NEVER from disk, NEVER from an env var, and never printed.
 *
 * Signing scheme, verified against a real OCI endpoint (`/20160918/users/{userId}` GET returned
 * 200 during this task's own probing -- see task-6-report.md): RSA-SHA256 over a signing string
 * built from `date`, `(request-target)`, `host` (GET/DELETE -- no body), plus
 * `x-content-sha256`, `content-type`, `content-length` for bodied requests (POST/PUT), in that
 * exact header order. `Authorization: Signature version="1",keyId="tenancy/user/fingerprint",
 * algorithm="rsa-sha256",headers="...",signature="..."`. Mirrors the reference probe this task's
 * brief pointed at (`~/.claude/jobs/d68f4cae/tmp/oci-probe.ts`) almost verbatim for the
 * unbodied case, extended for bodied requests per OCI's own signing-in-detail docs.
 */
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";

const KEYCHAIN_SERVICE = "com.norma.infra";

/**
 * `security find-generic-password -w` HEX-ENCODES a stored value when it contains bytes the
 * Keychain considers "not a printable string" -- notably any value with embedded newlines, which
 * is exactly what a PEM-encoded private key is. Verified empirically during this task: reading
 * back `oci-key-pem` via `-w` returns a hex string, not the PEM text. Decode transparently: a
 * value that's ALL hex digits (even length) is almost certainly the hex-encoded form (a real
 * OCI config line/PEM is never coincidentally pure hex of even length across its whole content).
 */
function decodeKeychainValue(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex").toString("utf8");
  }
  return trimmed;
}

function keychainRead(account: string): string {
  const raw = execFileSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
    { encoding: "utf8" }
  );
  return decodeKeychainValue(raw);
}

export interface OCIConfig {
  tenancy: string;
  user: string;
  fingerprint: string;
  region: string;
  /** PEM-encoded RSA private key (API signing key). Never logged, never written to disk here. */
  keyPem: string;
}

/**
 * `oci-config`'s Keychain value is `key=value` lines (tenancy/user/fingerprint/region), same
 * shape the task brief's reference probe expects. Blank lines and `#`-comments are ignored so a
 * human editing the Keychain item by hand has some slack.
 */
function parseConfigLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

export function loadOCIConfig(): OCIConfig {
  const cfg = parseConfigLines(keychainRead("oci-config"));
  const keyPem = keychainRead("oci-key-pem");
  for (const field of ["tenancy", "user", "fingerprint", "region"]) {
    if (!cfg[field]) {
      throw new Error(
        `Keychain item "${KEYCHAIN_SERVICE}/oci-config" is missing required field "${field}" ` +
          `(expected \`key=value\` lines: tenancy, user, fingerprint, region)`
      );
    }
  }
  if (!keyPem.includes("PRIVATE KEY")) {
    throw new Error(
      `Keychain item "${KEYCHAIN_SERVICE}/oci-key-pem" does not look like a PEM private key ` +
        `after hex-decoding -- check it was stored correctly`
    );
  }
  return { tenancy: cfg.tenancy, user: cfg.user, fingerprint: cfg.fingerprint, region: cfg.region, keyPem };
}

/**
 * Builds the `Authorization` header (+ the bodied-request headers it covers) for one HTTP
 * request. Self-checking: immediately re-verifies the signature it just produced against the
 * public key derived from the SAME private key (mirrors `scripts/sign-relay-config.ts`'s own
 * "self-verify before anything is used" convention) -- catches a signing-string bug locally
 * instead of discovering it as an opaque 401 from OCI.
 */
export function signRequest(
  cfg: OCIConfig,
  method: string,
  url: URL,
  bodyText?: string
): Record<string, string> {
  const date = new Date().toUTCString();
  const host = url.host;
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const hasBody = bodyText !== undefined;

  const signedHeaderNames = hasBody
    ? ["date", "(request-target)", "host", "x-content-sha256", "content-type", "content-length"]
    : ["date", "(request-target)", "host"];

  const contentType = "application/json";
  const contentSha256 = hasBody ? createHash("sha256").update(bodyText!).digest("base64") : "";
  const contentLength = hasBody ? String(Buffer.byteLength(bodyText!)) : "";

  const values: Record<string, string> = {
    date,
    "(request-target)": requestTarget,
    host,
    "x-content-sha256": contentSha256,
    "content-type": contentType,
    "content-length": contentLength,
  };
  const signingString = signedHeaderNames.map((name) => `${name}: ${values[name]}`).join("\n");

  const signature = createSign("RSA-SHA256").update(signingString).sign(cfg.keyPem, "base64");

  // Self-verify: derive the public key from the same PEM and check the signature we just made
  // validates against the exact signing string -- a cheap local sanity check before spending a
  // network round trip against OCI.
  const publicKey = createPublicKey(cfg.keyPem);
  const ok = createVerify("RSA-SHA256").update(signingString).verify(publicKey, signature, "base64");
  if (!ok) {
    throw new Error("oci.ts: self-verify of the request signature failed -- refusing to send");
  }

  const keyId = `${cfg.tenancy}/${cfg.user}/${cfg.fingerprint}`;
  const authorization =
    `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",` +
    `headers="${signedHeaderNames.join(" ")}",signature="${signature}"`;

  const headers: Record<string, string> = { date, host, authorization };
  if (hasBody) {
    headers["x-content-sha256"] = contentSha256;
    headers["content-type"] = contentType;
    headers["content-length"] = contentLength;
  }
  return headers;
}

export interface OCIResponse<T = unknown> {
  status: number;
  json: T;
  raw: string;
}

/**
 * One signed OCI API call. `path` is the request-target (e.g. `/20160918/vcns?...`).
 * `body`, if present, is JSON-encoded and signed per `signRequest`'s bodied-request path.
 *
 * `service`: OCI splits its API across per-service hosts. Everything this toolkit touches lives
 * on `iaas.*` EXCEPT `ListAvailabilityDomains`, which is an Identity API operation served only
 * from `identity.*` — calling it on the iaas host returns a permanent 404 NotAuthorizedOrNotFound
 * (the bug behind provision.ts's long-misdiagnosed "fresh-tenancy provisioning lag" failure:
 * it was never lag, the request was simply aimed at the wrong host). The signer already covers
 * any host generically via the `host` header.
 */
export async function ociRequest<T = unknown>(
  cfg: OCIConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  service: "iaas" | "identity" = "iaas"
): Promise<OCIResponse<T>> {
  const url = new URL(`https://${service}.${cfg.region}.oraclecloud.com${path}`);
  const bodyText = body !== undefined ? JSON.stringify(body) : undefined;
  const headers = signRequest(cfg, method, url, bodyText);
  const res = await fetch(url, { method, headers, body: bodyText });
  const raw = await res.text();
  let json: T;
  try {
    json = raw ? (JSON.parse(raw) as T) : (null as T);
  } catch {
    json = raw as unknown as T;
  }
  return { status: res.status, json, raw };
}

/** `compartmentId` for every resource this toolkit creates: the tenancy's root compartment. */
export function rootCompartmentId(cfg: OCIConfig): string {
  return cfg.tenancy;
}
