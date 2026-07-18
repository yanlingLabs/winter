#!/usr/bin/env bun
/**
 * Signs a relay config with the Norma relay-config Ed25519 key (SP2b Task 2).
 *
 * Usage:
 *   bun run scripts/sign-relay-config.ts <config.json>   # normal mode
 *   bun run scripts/sign-relay-config.ts --generate      # create+store the signing key once
 *   bun run scripts/sign-relay-config.ts --test-vector   # sign a fixed config with a hardcoded
 *                                                         # test seed (0xD4 x 32) -- no Keychain
 *                                                         # touched; for cross-language test
 *                                                         # vectors only (see task-2-brief.md
 *                                                         # Step 10 / apple/NormaProtocol's
 *                                                         # RelayConfigTests.swift)
 *
 * The private key lives in the macOS login Keychain as a generic password (service
 * "com.norma.config-key", account "relay-config"), read/written via the `security` CLI --
 * never written to disk by this script. `--generate` creates it once (production key,
 * generated in a later task); every other invocation only reads it.
 *
 * Signs `"norma-relay-config/1"` (UTF-8) + the canonical-CBOR encoding of `{relays, version}` --
 * the exact same domain string and map shape `apple/NormaProtocol`'s `RelayConfigSigner` and
 * `QRPayload` use there, verified with `Curve25519.Signing`. This script re-implements the
 * canonical-CBOR *encoder* (not the decoder -- nothing here needs to parse CBOR) so it can run
 * standalone under Bun with no dependency on the Swift package.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const KEYCHAIN_SERVICE = "com.norma.config-key";
const KEYCHAIN_ACCOUNT = "relay-config";
const DOMAIN = Buffer.from("norma-relay-config/1", "utf8");

// RFC 8410's fixed prefix for wrapping a raw 32-byte Ed25519 seed as a PKCS8 DER private key --
// Node's `crypto` has no "from raw seed" constructor, only DER import/export.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ---------------------------------------------------------------------------
// Canonical CBOR (RFC 8949 core deterministic encoding) -- encode-only, and only the subset a
// `{relays: [string], version: number}` map needs: uint, text string, array, map. Mirrors
// `CanonicalCBOR.swift`'s `encode` exactly, including its map-key sort rule: bytewise
// lexicographic order of the ENCODED key bytes (header included, per RFC 8949 section 4.2.1) --
// which is length-first for text keys, since the header byte embeds the length.
// ---------------------------------------------------------------------------
type CBORValue =
  | { kind: "uint"; value: number }
  | { kind: "text"; value: string }
  | { kind: "array"; value: CBORValue[] }
  | { kind: "map"; value: [string, CBORValue][] };

function encodeHead(majorType: number, length: number): Buffer {
  const high = majorType << 5;
  if (length < 24) return Buffer.from([high | length]);
  if (length <= 0xff) return Buffer.from([high | 24, length]);
  if (length <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = high | 25;
    b.writeUInt16BE(length, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = high | 26;
  b.writeUInt32BE(length >>> 0, 1);
  return b;
}

function encodeCBOR(v: CBORValue): Buffer {
  switch (v.kind) {
    case "uint":
      return encodeHead(0, v.value);
    case "text": {
      const utf8 = Buffer.from(v.value, "utf8");
      return Buffer.concat([encodeHead(3, utf8.length), utf8]);
    }
    case "array":
      return Buffer.concat([encodeHead(4, v.value.length), ...v.value.map(encodeCBOR)]);
    case "map": {
      const keys = v.value.map(([k]) => k);
      if (new Set(keys).size !== keys.length) throw new Error("canonical CBOR: duplicate map key");
      const withEncodedKeys = v.value.map(([k, val]) => ({
        encodedKey: encodeCBOR({ kind: "text", value: k }),
        val,
      }));
      withEncodedKeys.sort((a, b) => Buffer.compare(a.encodedKey, b.encodedKey));
      const parts = withEncodedKeys.flatMap((e) => [e.encodedKey, encodeCBOR(e.val)]);
      return Buffer.concat([encodeHead(5, withEncodedKeys.length), ...parts]);
    }
  }
}

interface RelayConfig {
  version: number;
  relays: string[];
}

function canonicalRelayConfigMap(config: RelayConfig): CBORValue {
  return {
    kind: "map",
    value: [
      ["relays", { kind: "array", value: config.relays.map((r) => ({ kind: "text", value: r })) }],
      ["version", { kind: "uint", value: config.version }],
    ],
  };
}

function signingPayload(config: RelayConfig): Buffer {
  return Buffer.concat([DOMAIN, encodeCBOR(canonicalRelayConfigMap(config))]);
}

// ---------------------------------------------------------------------------
// Ed25519 key handling -- raw 32-byte seed in, PKCS8/SPKI DER to talk to node:crypto.
// ---------------------------------------------------------------------------

function privateKeyFromRawSeed(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function rawPublicKey(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function generateRawSeed(): Buffer {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  // The last 32 bytes of any Ed25519 PKCS8 DER are the raw seed -- the prefix above is
  // everything before it, regardless of how the key was produced.
  return pkcs8.subarray(pkcs8.length - 32);
}

function readSeedFromKeychain(): Buffer {
  const b64 = execFileSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
    { encoding: "utf8" }
  ).trim();
  return Buffer.from(b64, "base64");
}

function storeSeedInKeychain(seed: Buffer): void {
  execFileSync("security", [
    "add-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
    seed.toString("base64"),
    "-U", // update in place if it already exists, rather than erroring
  ]);
}

// ---------------------------------------------------------------------------
// Signing + mandatory self-verify before anything is written/printed.
// ---------------------------------------------------------------------------

interface SignedRelayConfigJSON {
  config: RelayConfig;
  sig: string; // base64
  publicKey: string; // base64
}

function signConfig(config: RelayConfig, seed: Buffer): SignedRelayConfigJSON {
  const privateKey = privateKeyFromRawSeed(seed);
  const publicKey = createPublicKey(privateKey);
  const payload = signingPayload(config);
  const sig = sign(null, payload, privateKey);

  if (!verify(null, payload, publicKey, sig)) {
    throw new Error("self-verify failed immediately after signing -- refusing to write output");
  }

  return {
    config,
    sig: sig.toString("base64"),
    publicKey: rawPublicKey(privateKey).toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// "test-relay-config-key" -- see task-2-brief.md Step 10 and
// apple/NormaProtocol/Tests/NormaProtocolTests/RelayConfigTests.swift. Not a secret: a
// clearly-named, hardcoded test fixture, never used to sign anything real.
const TEST_SEED = Buffer.alloc(32, 0xd4);

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--generate")) {
    const seed = generateRawSeed();
    storeSeedInKeychain(seed);
    const privateKey = privateKeyFromRawSeed(seed);
    console.log(`Generated relay-config signing key, stored in Keychain (${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}).`);
    console.log(`Public key (base64): ${rawPublicKey(privateKey).toString("base64")}`);
    return;
  }

  if (args.includes("--test-vector")) {
    const config: RelayConfig = { version: 1, relays: ["https://relay-1.yanlinglabs.com."] };
    const signed = signConfig(config, TEST_SEED);
    console.log(JSON.stringify(signed, null, 2));
    return;
  }

  const configPath = args[0];
  if (!configPath) {
    console.error("usage: bun run scripts/sign-relay-config.ts <config.json> | --generate | --test-vector");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    typeof raw.version !== "number" ||
    !Array.isArray(raw.relays) ||
    !raw.relays.every((r: unknown) => typeof r === "string")
  ) {
    console.error(`${configPath} must be {"version": number, "relays": string[]}`);
    process.exit(1);
  }
  const config: RelayConfig = { version: raw.version, relays: raw.relays };

  const seed = readSeedFromKeychain();
  const signed = signConfig(config, seed);

  const outPath = configPath.endsWith(".json")
    ? `${configPath.slice(0, -".json".length)}.signed.json`
    : `${configPath}.signed.json`;
  writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);

  console.log(`Wrote ${outPath}`);
  console.log(`Public key (base64): ${signed.publicKey}`);
}

main();
