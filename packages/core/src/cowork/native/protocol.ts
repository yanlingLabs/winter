import { createHash } from "node:crypto";
import { validFilesystemPlan } from "../volume-filesystem";

/*
 * Wire contract of the production Mac Cowork VM worker (N2 slice S1). The prose is docs/cowork-native-worker.md; this
 * module is its executable twin: closed schemas, strict parsers that demand EXACT re-serialization, and the production
 * libkrun ABI names. The golden vectors under test/cowork/native/vectors/ are the cross-language oracle: the Swift
 * launcher (S2), the C worker (S3) and the guest (S5) copy this contract and carry a drift test against those vectors,
 * never the other way round.
 *
 * SOURCE ONLY. Nothing under src/ imports this module (an anti-wiring test pins it) and no port declared next to it has
 * an implementation in src/. There is no NIC and no vsock anywhere in this contract.
 *
 * Four links, one trust rule: a PARSE is never an AUTHENTICATION. The daemon knows who is on L1 because it created the
 * socketpair and spawned the launcher; no field in any frame below can say so on its own behalf.
 *
 *   L1  daemon <-> launcher   AF_UNIX SOCK_STREAM socketpair. NDJSON, one canonical JSON object per line.
 *                             SCM_RIGHTS rides on exactly one line type (`volumes`, exactly two descriptors).
 *   L2  launcher <-> worker   unnamed AF_UNIX SOCK_DGRAM socketpair. Fixed-layout little-endian ENVELOPES.
 *   L3  launcher <-> worker   unnamed AF_UNIX SOCK_STREAM socketpair. MUX FRAMES of the bootstrap and runtime classes.
 *   L4  worker <-> guest      the libkrun generic virtio-console port. MUX FRAMES of every class.
 *
 * Wire rules shared by every JSON text here: UTF-8, one line, the last byte is "\n", keys appear in EXACTLY the order of
 * the schema tables below, no whitespace, integers only, `null` only where a table says so. Parsing builds the typed
 * value and re-serializes it; the result must equal the input byte for byte. That refuses duplicate keys, reordered
 * keys, alternate escapes, alternate number spellings and trailing data in one comparison.
 */

export const COWORK_NATIVE_PROTOCOL_VERSION = 1;

/** Every refusal the parsers raise. `reserved_class` is the provider class; there is no implementation behind it. */
export const COWORK_NATIVE_PROTOCOL_FAILURES = Object.freeze(["malformed", "oversize", "version", "unknown_type", "bad_field", "bad_direction", "bad_rights", "reserved_class", "bad_sequence"] as const);
export type CoworkNativeProtocolFailure = typeof COWORK_NATIVE_PROTOCOL_FAILURES[number];
export class CoworkNativeProtocolError extends Error {
  constructor(readonly code: CoworkNativeProtocolFailure) { super(code); this.name = "CoworkNativeProtocolError"; }
}
const fail = (code: CoworkNativeProtocolFailure = "bad_field"): never => { throw new CoworkNativeProtocolError(code); };

export const COWORK_NATIVE_LIMITS = Object.freeze({
  /** Every L1 line except the two mux carriers. */
  controlLineBytes: 16 * 1024,
  /** A mux carrier: base64 of the largest frame (16 header bytes + 1 MiB) plus the envelope text. */
  muxLineBytes: 1_572_864,
  /** Brace/bracket nesting bound per text kind: an L1 line (frame, receipt, volumes array, volume record), a lone receipt,
   * a control payload (flat) and a bootstrap payload (message, plan or receipt, volumes array, target, identity). */
  depth: Object.freeze({ launcher: 4, receipt: 3, control: 1, bootstrap: 8 }),
  /** Both binary formats share the 16 byte header. */
  headerBytes: 16,
  /** Payload ceiling per mux class. The runtime ceiling is the existing guest runtime transport frame (guest-runtime.ts). */
  muxPayloadBytes: Object.freeze({ control: 4096, bootstrap: 262_144, runtime: 1_048_576, provider: 0 }),
  /** A stop receipt as a single text (the durable store keeps exactly this line). */
  receiptBytes: 8192,
  /** Identifier fields in the fixed-layout envelope are NUL padded to 64 bytes, so a token is at most 63 characters. */
  tokenChars: 63,
  /** Guest sizing, D8: 2 vCPU and at most 1024 MiB inside the reviewed device gate. */
  vcpus: 2, minMemoryMiB: 256, maxMemoryMiB: 1024,
  /** Documented graceful budget (execution contracts, "Daemon lifetime"); an explicit stop may ask for less, never more than the ceiling. */
  drainBudgetMs: 30_000, drainBudgetCeilingMs: 120_000,
  volumeRights: 2,
});

// ------------------------------------------------------------------------------------------------ shared validators

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const GUEST_BOOT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DECIMAL64 = /^(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = (1n << 64n) - 1n;
const DANGEROUS_KEYS = ["__proto__", "constructor", "prototype"];
export const COWORK_NATIVE_VOLUME_MODE = 0o600;
export const COWORK_NATIVE_DATA_SERIAL = "winter-data";
export const COWORK_NATIVE_ENVIRONMENT_SERIAL = "winter-environment";

type Validator<T = unknown> = (value: unknown) => T;
const token: Validator<string> = value => typeof value === "string" && TOKEN.test(value) ? value : fail();
const label: Validator<string> = value => typeof value === "string" && LABEL.test(value) ? value : fail();
const digest: Validator<string> = value => typeof value === "string" && DIGEST.test(value) ? value : fail();
const nonce: Validator<string> = value => typeof value === "string" && NONCE.test(value) ? value : fail();
const guestBoot: Validator<string> = value => typeof value === "string" && GUEST_BOOT.test(value) ? value : fail();
const uint = (min = 0, max = Number.MAX_SAFE_INTEGER): Validator<number> => value => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const decimal64: Validator<string> = value => typeof value === "string" && DECIMAL64.test(value) && BigInt(value) <= MAX_U64 ? value : fail();
const bool: Validator<boolean> = value => typeof value === "boolean" ? value : fail();
const literal = <T extends string | number | boolean>(expected: T): Validator<T> => value => value === expected ? expected : fail();
const nullable = <T>(inner: Validator<T>): Validator<T | null> => value => value === null ? null : inner(value);
const oneOf = <const T extends readonly string[]>(values: T): Validator<T[number]> => value => typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : fail();
const epochOf = uint(1, 0xffff_ffff);

function isPlain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
/** Exact key SET, own data properties only; the result lists the keys in SCHEMA order. Wire order is enforced by the
 * re-serialization compare every parser ends with, so a reordered text can never round-trip. */
type Spec = readonly (readonly [string, Validator])[];
function record(value: unknown, spec: Spec): Record<string, unknown> {
  if (!isPlain(value)) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== spec.length || spec.some(([key]) => !keys.includes(key))) return fail();
  const out: Record<string, unknown> = {};
  for (const [key, validate] of spec) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return fail();
    out[key] = validate(descriptor.value);
  }
  return out;
}
const recordOf = (spec: Spec): Validator<Record<string, unknown>> => value => record(value, spec);

/** Conservative brace/bracket nesting bound over the RAW text, string-aware, before any parser recurses. */
function nestsWithin(body: string, max: number): boolean {
  let depth = 0, inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (inString) { if (c === 0x5c) i++; else if (c === 0x22) inString = false; continue; }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) { if (++depth > max) return false; }
    else if (c === 0x7d || c === 0x5d) { if (--depth < 0) return false; }
  }
  return depth === 0 && !inString;
}
function cleanData(value: unknown): void {
  if (typeof value === "string") { if (!value.isWellFormed()) fail("malformed"); return; }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value) && (DANGEROUS_KEYS.some(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !key.isWellFormed()))) fail("malformed");
  for (const child of Object.values(value)) cleanData(child);
}
/** One bounded canonical line to its parsed plain object. The caller still owns key order and value validation. */
function strictLine(raw: unknown, maxBytes: number, depth: number): { body: string; parsed: Record<string, unknown> } {
  if (typeof raw !== "string") return fail("malformed");
  // UTF-16 length never exceeds the byte length, so check it first and never measure an arbitrarily long string.
  if (raw.length > maxBytes || Buffer.byteLength(raw, "utf8") > maxBytes) return fail("oversize");
  if (!raw.endsWith("\n") || !raw.isWellFormed()) return fail("malformed");
  const body = raw.slice(0, -1);
  if (!nestsWithin(body, depth)) return fail("malformed");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return fail("malformed"); }
  if (!isPlain(parsed) || JSON.stringify(parsed) !== body) return fail("malformed");
  cleanData(parsed);
  return { body, parsed };
}
/** Canonical spelling of a nested free-form object (a filesystem plan or receipt): keys sorted, recursively. */
export function sortedCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedCanonical((value as Record<string, unknown>)[key])]));
  return value;
}
/** Normalises to sorted keys; a text whose nested object was not already sorted fails the parser's re-serialization compare. */
const sortedObject: Validator<Record<string, unknown>> = value => isPlain(value) ? sortedCanonical(value) as Record<string, unknown> : fail();

// ------------------------------------------------------------------------------------------------ vocabularies

export const COWORK_NATIVE_REFUSAL_CODES = Object.freeze(["bad_request", "busy", "not_begun", "worker_spawn_failed", "code_identity_mismatch", "sandbox_failed", "volumes_rejected", "internal"] as const);
export const COWORK_NATIVE_CHANNEL_FAULTS = Object.freeze(["parent_unverified", "protocol_violation", "worker_channel_lost", "internal"] as const);
export const COWORK_NATIVE_WORKER_STATES = Object.freeze(["sandboxed", "volumes_accepted", "vm_running", "guest_hello", "draining", "drain_acked", "exited"] as const);
export const COWORK_NATIVE_STOP_REASONS = Object.freeze(["user", "shutdown", "restart", "update", "failed-start"] as const);
export const COWORK_NATIVE_BOOTSTRAP_FAULTS = Object.freeze(["bad_plan", "probe_failed", "format_failed", "replay_failed", "mount_failed", "internal"] as const);
/** Class B reasons. None of them can ever release anything. */
export const COWORK_NATIVE_UNCERTAIN_REASONS = Object.freeze(["daemon-lost", "drain-timeout", "worker-killed", "worker-crashed", "guest-fault", "flush-uncertain", "channel-eof", "launcher-fault"] as const);
export const COWORK_NATIVE_STOP_ORIGINS = Object.freeze(["host-stop", "owner-loss-drain"] as const);
export const COWORK_NATIVE_VOLUME_PURPOSES = Object.freeze(["data", "environment"] as const);
export type CoworkNativeVolumePurpose = typeof COWORK_NATIVE_VOLUME_PURPOSES[number];

// ------------------------------------------------------------------------------------------------ owner scope

/** What the daemon tells the launcher to start (`begin`), what the launcher gives the worker (envelope SCOPE) and what
 * every receipt echoes. The five owner fields are CoworkVolumeOwner verbatim. */
export interface CoworkNativeScope {
  readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number;
  readonly admissionId: string; readonly controllerInstanceId: string; readonly workerInstanceId: string;
  readonly runtimeImageDigest: string; readonly vcpus: number; readonly memoryMiB: number;
}
const SCOPE_SPEC: Spec = [["workspaceId", token], ["incarnationId", token], ["leaseEpoch", epochOf], ["admissionId", token], ["controllerInstanceId", token], ["workerInstanceId", token],
  ["runtimeImageDigest", digest], ["vcpus", literal(COWORK_NATIVE_LIMITS.vcpus)], ["memoryMiB", uint(COWORK_NATIVE_LIMITS.minMemoryMiB, COWORK_NATIVE_LIMITS.maxMemoryMiB)]];
export interface CoworkNativeVolumeIdentity {
  readonly purpose: CoworkNativeVolumePurpose; readonly device: string; readonly inode: string; readonly uid: number; readonly mode: number; readonly capacityBytes: number;
}
const capacity = uint(16 * 1024 ** 2, 256 * 1024 ** 3);
const volumeSpec = (purpose: CoworkNativeVolumePurpose): Spec => [["purpose", literal(purpose)], ["device", decimal64], ["inode", decimal64], ["uid", uint(0, 0xffff_ffff)], ["mode", literal(COWORK_NATIVE_VOLUME_MODE)],
  ["capacityBytes", value => { const n = capacity(value); return n % 4096 === 0 ? n : fail(); }]];
/** Exactly two volumes, data first, environment second. Position IS the purpose. */
const volumePair: Validator<readonly [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity]> = value => {
  if (!Array.isArray(value) || value.length !== 2) return fail();
  const pair = COWORK_NATIVE_VOLUME_PURPOSES.map((purpose, index) => record(value[index], volumeSpec(purpose)) as unknown as CoworkNativeVolumeIdentity) as [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity];
  return distinctFiles(pair);
};
/** The same-pair alias refusal of the fixture handoff: one file may never back both disks. */
function distinctFiles<T extends readonly [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity]>(pair: T): T {
  if (pair[0].device === pair[1].device && pair[0].inode === pair[1].inode) return fail();
  return Object.freeze(pair) as T;
}

// ------------------------------------------------------------------------------------------------ stop receipts

/** Class A: orderly. The ONLY receipt format that can ever become release evidence. The launcher fsyncs it to its durable
 * store BEFORE it sends it, and keeps it until the daemon sends `receipt_retire`. It states facts the launcher itself
 * observed (it is the sole reaper); it is valid only if every invariant in `classAInvariantsHold` holds. */
export interface CoworkNativeOrderlyReceipt {
  readonly v: 1; readonly class: "A"; readonly confirmationId: string; readonly stopNonce: string; readonly origin: typeof COWORK_NATIVE_STOP_ORIGINS[number];
  readonly launcherInstanceId: string; readonly admissionId: string; readonly homeId: string; readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number;
  readonly controllerInstanceId: string; readonly workerInstanceId: string; readonly runtimeImageDigest: string; readonly hostBootId: string;
  readonly guest: Readonly<{ drain: "acked" | "not-booted"; powerOff: "observed" | "not-booted" }>;
  readonly worker: Readonly<{ pid: number; startToken: string; exit: "code"; status: 0; reaped: true }>;
  readonly volumes: readonly [OrderlyVolume, OrderlyVolume];
  readonly issuedAtMs: number;
}
export interface OrderlyVolume {
  readonly purpose: CoworkNativeVolumePurpose; readonly device: string; readonly inode: string; readonly capacityBytes: number;
  readonly attached: boolean; readonly flushRequested: number; readonly flushCompleted: number; readonly finalFlush: "completed" | "not-attached";
}
/** A volume the worker never received cannot be named by the launcher, so an unattached entry carries zeros: device "0", inode "0",
 * capacityBytes 0 (`classAInvariantsHold` demands it). An attached entry carries the real identity, in the capacity range. */
const orderlyVolumeSpec = (purpose: CoworkNativeVolumePurpose): Spec => [["purpose", literal(purpose)], ["device", decimal64], ["inode", decimal64], ["capacityBytes", value => value === 0 ? 0 : capacity(value)], ["attached", bool],
  ["flushRequested", uint()], ["flushCompleted", uint()], ["finalFlush", oneOf(["completed", "not-attached"] as const)]];
const ORDERLY_SPEC: Spec = [["v", literal(1)], ["class", literal("A")], ["confirmationId", token], ["stopNonce", nonce], ["origin", oneOf(COWORK_NATIVE_STOP_ORIGINS)], ["launcherInstanceId", label],
  ["admissionId", token], ["homeId", token], ["workspaceId", token], ["incarnationId", token], ["leaseEpoch", epochOf], ["controllerInstanceId", token], ["workerInstanceId", token],
  ["runtimeImageDigest", digest], ["hostBootId", label],
  ["guest", recordOf([["drain", oneOf(["acked", "not-booted"] as const)], ["powerOff", oneOf(["observed", "not-booted"] as const)]])],
  ["worker", recordOf([["pid", uint(1, 0x7fff_ffff)], ["startToken", label], ["exit", literal("code")], ["status", literal(0)], ["reaped", literal(true)]])],
  ["volumes", value => {
    if (!Array.isArray(value) || value.length !== 2) return fail();
    return Object.freeze(COWORK_NATIVE_VOLUME_PURPOSES.map((purpose, index) => record(value[index], orderlyVolumeSpec(purpose))));
  }], ["issuedAtMs", uint()]];

/** Class B: uncertain. A crash, a daemon loss, a forced kill, a drain that ran out of budget, a closed channel. It
 * describes what the launcher saw and is exactly that: it has no key that could name a confirmation and the module
 * that mints release proofs (stop-proof.ts) has no code path that accepts one. */
export interface CoworkNativeUncertainReceipt {
  readonly v: 1; readonly class: "B"; readonly launcherInstanceId: string; readonly admissionId: string; readonly workspaceId: string; readonly incarnationId: string; readonly leaseEpoch: number;
  readonly workerInstanceId: string; readonly reason: typeof COWORK_NATIVE_UNCERTAIN_REASONS[number];
  readonly worker: Readonly<{ pid: number; startToken: string; exit: "code" | "signal" | "unknown"; status: number }>;
  readonly attachedVolumes: boolean; readonly issuedAtMs: number;
}
const UNCERTAIN_SPEC: Spec = [["v", literal(1)], ["class", literal("B")], ["launcherInstanceId", label], ["admissionId", token], ["workspaceId", token], ["incarnationId", token], ["leaseEpoch", epochOf],
  ["workerInstanceId", token], ["reason", oneOf(COWORK_NATIVE_UNCERTAIN_REASONS)],
  ["worker", recordOf([["pid", uint(1, 0x7fff_ffff)], ["startToken", label], ["exit", oneOf(["code", "signal", "unknown"] as const)], ["status", uint(0, 255)]])],
  ["attachedVolumes", bool], ["issuedAtMs", uint()]];

const orderly: Validator<CoworkNativeOrderlyReceipt> = value => record(value, ORDERLY_SPEC) as unknown as CoworkNativeOrderlyReceipt;
const uncertain: Validator<CoworkNativeUncertainReceipt> = value => record(value, UNCERTAIN_SPEC) as unknown as CoworkNativeUncertainReceipt;
export type CoworkNativeStopReceipt = CoworkNativeOrderlyReceipt | CoworkNativeUncertainReceipt;

/** The internal consistency a Class A receipt must have to mean what it says. A launcher that cannot state all of these
 * emits Class B instead. A receipt that parses but fails this is NOT orderly evidence: treat it as a protocol fault. */
export function classAInvariantsHold(receipt: CoworkNativeOrderlyReceipt): boolean {
  const booted = receipt.guest.drain === "acked";
  if (booted !== (receipt.guest.powerOff === "observed")) return false;
  const [data, environment] = receipt.volumes;
  if (data.attached !== environment.attached) return false;
  return receipt.volumes.every(v => v.attached
    // Held by the worker: every requested flush completed and a final flush followed. A guest that never booted wrote nothing, so its counters are zero.
    ? v.finalFlush === "completed" && v.flushRequested === v.flushCompleted && v.capacityBytes > 0 && (booted || v.flushRequested === 0)
    : v.finalFlush === "not-attached" && v.flushRequested === 0 && v.flushCompleted === 0 && v.device === "0" && v.inode === "0" && v.capacityBytes === 0);
}

/** Parse the text of ONE receipt (the durable store's file content, and the exact text embedded in `stopped`/`uncertain`). */
export function parseCoworkNativeStopReceipt(raw: unknown): CoworkNativeStopReceipt {
  const { parsed } = strictLine(raw, COWORK_NATIVE_LIMITS.receiptBytes, COWORK_NATIVE_LIMITS.depth.receipt);
  const typed = parsed.class === "A" ? orderly(parsed) : parsed.class === "B" ? uncertain(parsed) : fail("unknown_type");
  if (`${JSON.stringify(typed)}\n` !== raw) return fail("malformed");
  return Object.freeze(typed);
}
export function serializeCoworkNativeStopReceipt(receipt: CoworkNativeStopReceipt): string {
  const typed = receipt.class === "A" ? orderly(receipt) : uncertain(receipt);
  return `${JSON.stringify(typed)}\n`;
}

// ------------------------------------------------------------------------------------------------ mux frames (L3, L4)

/** 0 control, 1 bootstrap, 2 runtime, 3 provider (RESERVED: the header is recognised so it can be refused, nothing more). */
export const COWORK_NATIVE_MUX_CLASSES = Object.freeze(["control", "bootstrap", "runtime", "provider"] as const);
export type CoworkNativeMuxClass = typeof COWORK_NATIVE_MUX_CLASSES[number];
export const COWORK_NATIVE_MUX_MAGIC = "WMX1";
/** `up` = guest to host, `down` = host to guest. */
export type CoworkNativeMuxDirection = "up" | "down";

export type CoworkNativeControlMessage =
  | { readonly t: "drain"; readonly stopNonce: string; readonly budgetMs: number; readonly origin: "host-stop" | "owner-loss" }
  | { readonly t: "ping"; readonly n: number }
  | { readonly t: "drain_ack"; readonly stopNonce: string }
  | { readonly t: "halting"; readonly stopNonce: string }
  | { readonly t: "pong"; readonly n: number };
export type CoworkNativeBootstrapMessage =
  | { readonly t: "hello"; readonly guestBootId: string; readonly dataSerial: typeof COWORK_NATIVE_DATA_SERIAL; readonly environmentSerial: typeof COWORK_NATIVE_ENVIRONMENT_SERIAL }
  | { readonly t: "plan"; readonly operationId: string; readonly nonce: string; readonly plan: Record<string, unknown> }
  | { readonly t: "receipt"; readonly operationId: string; readonly nonce: string; readonly receipt: Record<string, unknown> }
  | { readonly t: "fault"; readonly operationId: string; readonly nonce: string; readonly code: typeof COWORK_NATIVE_BOOTSTRAP_FAULTS[number] }
  | { readonly t: "ready"; readonly operationId: string; readonly nonce: string }
  | { readonly t: "mounted"; readonly operationId: string; readonly nonce: string };
export type CoworkNativeMuxFrame =
  | { readonly class: "control"; readonly seq: number; readonly message: CoworkNativeControlMessage }
  | { readonly class: "bootstrap"; readonly seq: number; readonly message: CoworkNativeBootstrapMessage }
  | { readonly class: "runtime"; readonly seq: number; readonly payload: Uint8Array };

const MESSAGE_BASE: Spec = [["v", literal(1)]];
const operation: Spec = [["operationId", token], ["nonce", nonce]];
const planBody: Validator<Record<string, unknown>> = value => {
  const plan = sortedObject(value);
  return validFilesystemPlan(plan) && plan.protocolVersion === 3 ? plan : fail();
};
/** Control and bootstrap payload schemas, by direction then type. Runtime payloads are opaque bytes. */
const CONTROL_SPECS: Record<CoworkNativeMuxDirection, Record<string, Spec>> = {
  down: {
    drain: [["t", literal("drain")], ["stopNonce", nonce], ["budgetMs", uint(0, COWORK_NATIVE_LIMITS.drainBudgetCeilingMs)], ["origin", oneOf(["host-stop", "owner-loss"] as const)]],
    ping: [["t", literal("ping")], ["n", uint(0, 0xffff_ffff)]],
  },
  up: {
    drain_ack: [["t", literal("drain_ack")], ["stopNonce", nonce]],
    halting: [["t", literal("halting")], ["stopNonce", nonce]],
    pong: [["t", literal("pong")], ["n", uint(0, 0xffff_ffff)]],
  },
};
const BOOTSTRAP_SPECS: Record<CoworkNativeMuxDirection, Record<string, Spec>> = {
  down: {
    plan: [["t", literal("plan")], ...operation, ["plan", planBody]],
    ready: [["t", literal("ready")], ...operation],
  },
  up: {
    hello: [["t", literal("hello")], ["guestBootId", guestBoot], ["dataSerial", literal(COWORK_NATIVE_DATA_SERIAL)], ["environmentSerial", literal(COWORK_NATIVE_ENVIRONMENT_SERIAL)]],
    receipt: [["t", literal("receipt")], ...operation, ["receipt", sortedObject]],
    fault: [["t", literal("fault")], ...operation, ["code", oneOf(COWORK_NATIVE_BOOTSTRAP_FAULTS)]],
    mounted: [["t", literal("mounted")], ...operation],
  },
};
function jsonPayload(bytes: Uint8Array, specs: Record<string, Spec>, maxBytes: number, depth: number): Record<string, unknown> {
  if (bytes.length > maxBytes) return fail("oversize");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("malformed"); }
  const { parsed } = strictLine(`${text}\n`, maxBytes + 1, depth);
  const type = Object.hasOwn(parsed, "t") ? parsed.t : undefined;
  const spec = typeof type === "string" && Object.hasOwn(specs, type) ? specs[type]! : undefined;
  if (!spec) return fail("unknown_type");
  const typed = record(parsed, [...MESSAGE_BASE, ...spec]);
  if (JSON.stringify(typed) !== text) return fail("malformed");
  delete typed.v;
  return typed;
}
const writeAscii = (view: Uint8Array, offset: number, text: string, width: number) => { view.fill(0, offset, offset + width); view.set(Buffer.from(text, "ascii"), offset); };

/** A mux frame is a 16 byte little-endian header plus the payload.
 *   0  4  magic "WMX1"      4  1  version = 1      5  1  class       6  2  flags = 0
 *   8  4  seq               12 4  payload length
 * `seq` starts at 1 and rises by exactly 1 per (class, direction). The provider class is refused at the header. */
export function parseCoworkNativeMuxFrame(bytes: Uint8Array, direction: CoworkNativeMuxDirection): CoworkNativeMuxFrame {
  if (!(bytes instanceof Uint8Array) || bytes.length < COWORK_NATIVE_LIMITS.headerBytes) return fail("malformed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== COWORK_NATIVE_MUX_MAGIC) return fail("malformed");
  if (view.getUint8(4) !== COWORK_NATIVE_PROTOCOL_VERSION) return fail("version");
  const cls = COWORK_NATIVE_MUX_CLASSES[view.getUint8(5)];
  if (cls === undefined || view.getUint16(6, true) !== 0) return fail("malformed");
  if (cls === "provider") return fail("reserved_class");
  const seq = view.getUint32(8, true), length = view.getUint32(12, true);
  if (seq < 1) return fail("bad_sequence");
  if (length > COWORK_NATIVE_LIMITS.muxPayloadBytes[cls]) return fail("oversize");
  if (bytes.length !== COWORK_NATIVE_LIMITS.headerBytes + length) return fail("malformed");
  const payload = bytes.slice(COWORK_NATIVE_LIMITS.headerBytes);
  if (cls === "runtime") return Object.freeze({ class: "runtime", seq, payload });
  const specs = cls === "control" ? CONTROL_SPECS[direction] : BOOTSTRAP_SPECS[direction], max = COWORK_NATIVE_LIMITS.muxPayloadBytes[cls];
  const message = Object.freeze(jsonPayload(payload, specs, max, cls === "control" ? COWORK_NATIVE_LIMITS.depth.control : COWORK_NATIVE_LIMITS.depth.bootstrap)) as unknown;
  return Object.freeze(cls === "control" ? { class: "control", seq, message: message as CoworkNativeControlMessage } : { class: "bootstrap", seq, message: message as CoworkNativeBootstrapMessage });
}
export function serializeCoworkNativeMuxFrame(frame: CoworkNativeMuxFrame, direction: CoworkNativeMuxDirection): Uint8Array {
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1 || frame.seq > 0xffff_ffff) return fail("bad_sequence");
  const cls = frame.class;
  if ((cls as string) === "provider" || !COWORK_NATIVE_MUX_CLASSES.includes(cls)) return fail("reserved_class");
  let payload: Uint8Array;
  if (frame.class === "runtime") payload = frame.payload;
  else {
    const specs = frame.class === "control" ? CONTROL_SPECS[direction] : BOOTSTRAP_SPECS[direction], type = (frame.message as { t: string }).t;
    const spec = Object.hasOwn(specs, type) ? specs[type]! : undefined;
    if (!spec) return fail("unknown_type");
    const typed = record({ v: 1, ...frame.message }, [...MESSAGE_BASE, ...spec]);
    payload = Buffer.from(JSON.stringify(typed), "utf8");
  }
  if (payload.length > COWORK_NATIVE_LIMITS.muxPayloadBytes[cls]) return fail("oversize");
  const out = new Uint8Array(COWORK_NATIVE_LIMITS.headerBytes + payload.length), view = new DataView(out.buffer);
  out.set(Buffer.from(COWORK_NATIVE_MUX_MAGIC, "latin1"), 0);
  view.setUint8(4, COWORK_NATIVE_PROTOCOL_VERSION); view.setUint8(5, COWORK_NATIVE_MUX_CLASSES.indexOf(cls)); view.setUint16(6, 0, true);
  view.setUint32(8, frame.seq, true); view.setUint32(12, payload.length, true);
  out.set(payload, COWORK_NATIVE_LIMITS.headerBytes);
  return out;
}
/** Per (class, direction) sequence check, one instance per link end. A gap, a repeat or a rewind is `bad_sequence`. */
export class CoworkNativeMuxSequence {
  private readonly next = new Map<string, number>();
  accept(frame: CoworkNativeMuxFrame, direction: CoworkNativeMuxDirection): void {
    const key = `${frame.class}:${direction}`, expected = this.next.get(key) ?? 1;
    if (frame.seq !== expected) fail("bad_sequence");
    this.next.set(key, expected + 1);
  }
}

// ------------------------------------------------------------------------------------------------ launcher envelopes (L2)

/** Fixed-layout, little-endian, one datagram each. Header (16): "WEV1", u8 version = 1, u8 kind, u16 flags = 0, u32 seq, u32 payload length.
 *   kind 1 SCOPE   to worker   512 bytes   no descriptors
 *   kind 2 VOLUMES to worker   104 bytes   EXACTLY two descriptors (data, environment)
 *   kind 3 DRAIN   to worker    28 bytes   no descriptors
 *   kind 4 STATUS  to launcher  40 bytes   no descriptors
 *   kind 5 FAULT   to launcher   8 bytes   no descriptors
 * Every reserved byte is zero; a datagram with any other length, magic, version, flag, rights count or non-zero reserved byte is refused. */
export const COWORK_NATIVE_ENVELOPE_MAGIC = "WEV1";
export const COWORK_NATIVE_ENVELOPE_KINDS = Object.freeze(["scope", "volumes", "drain", "status", "fault"] as const);
export const COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES = Object.freeze({ scope: 512, volumes: 104, drain: 28, status: 40, fault: 8 });
export const COWORK_NATIVE_WORKER_STATUS = Object.freeze(["sandboxed", "volumes_accepted", "vm_running", "guest_hello", "draining", "drain_acked", "guest_halted", "exiting"] as const);
export const COWORK_NATIVE_WORKER_FAULTS = Object.freeze(["bad_scope", "bad_volumes", "sandbox_failed", "vm_failed", "mux_violation", "truncated_rights", "internal"] as const);
export interface CoworkNativeFlushCounters { readonly requested: number; readonly completed: number }
export type CoworkNativeEnvelope =
  | { readonly kind: "scope"; readonly seq: number; readonly scope: CoworkNativeScope }
  | { readonly kind: "volumes"; readonly seq: number; readonly scopeDigest: string; readonly volumes: readonly [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity] }
  | { readonly kind: "drain"; readonly seq: number; readonly stopNonce: string; readonly budgetMs: number; readonly origin: "host-stop" | "owner-loss" }
  | { readonly kind: "status"; readonly seq: number; readonly state: typeof COWORK_NATIVE_WORKER_STATUS[number]; readonly flush: readonly [CoworkNativeFlushCounters, CoworkNativeFlushCounters] }
  | { readonly kind: "fault"; readonly seq: number; readonly code: typeof COWORK_NATIVE_WORKER_FAULTS[number] };
/** Which way each kind travels on L2. */
export const COWORK_NATIVE_ENVELOPE_DIRECTION = Object.freeze({ scope: "to-worker", volumes: "to-worker", drain: "to-worker", status: "to-launcher", fault: "to-launcher" } as const);
const SCOPE_TEXT_FIELDS = ["workspaceId", "incarnationId", "controllerInstanceId", "workerInstanceId", "admissionId"] as const;
const hexBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "hex"));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function readText(view: Uint8Array, offset: number): string {
  const field = view.subarray(offset, offset + 64), end = field.indexOf(0);
  if (end < 1 || field.subarray(end).some(byte => byte !== 0)) return fail();
  const text = Buffer.from(field.subarray(0, end)).toString("latin1");
  return TOKEN.test(text) ? text : fail();
}
function readVolume(view: DataView, offset: number, purpose: CoworkNativeVolumePurpose): CoworkNativeVolumeIdentity {
  const value = { purpose, device: view.getBigUint64(offset, true).toString(), inode: view.getBigUint64(offset + 8, true).toString(), uid: view.getUint32(offset + 24, true), mode: view.getUint32(offset + 28, true), capacityBytes: Number(view.getBigUint64(offset + 16, true)) };
  if (view.getBigUint64(offset + 16, true) > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return record(value, volumeSpec(purpose)) as unknown as CoworkNativeVolumeIdentity;
}
function writeVolume(view: DataView, offset: number, volume: CoworkNativeVolumeIdentity, purpose: CoworkNativeVolumePurpose): void {
  const checked = record({ ...volume }, volumeSpec(purpose)) as unknown as CoworkNativeVolumeIdentity;
  view.setBigUint64(offset, BigInt(checked.device), true); view.setBigUint64(offset + 8, BigInt(checked.inode), true);
  view.setBigUint64(offset + 16, BigInt(checked.capacityBytes), true); view.setUint32(offset + 24, checked.uid, true); view.setUint32(offset + 28, checked.mode, true);
}
const flushOf = (view: DataView, offset: number): CoworkNativeFlushCounters => {
  const requested = view.getBigUint64(offset, true), completed = view.getBigUint64(offset + 8, true);
  if (requested > BigInt(Number.MAX_SAFE_INTEGER) || completed > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return { requested: Number(requested), completed: Number(completed) };
};
const allZero = (bytes: Uint8Array): boolean => bytes.every(byte => byte === 0);

/** SHA-256 of the 512 byte SCOPE payload: how a `volumes` line and a VOLUMES envelope name the scope they belong to. */
export function coworkNativeScopeDigest(scope: CoworkNativeScope): string {
  return createHash("sha256").update(encodeScopePayload(scope)).digest("hex");
}
function encodeScopePayload(scope: CoworkNativeScope): Uint8Array {
  const typed = record({ ...scope }, SCOPE_SPEC) as unknown as CoworkNativeScope, out = new Uint8Array(COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES.scope), view = new DataView(out.buffer);
  SCOPE_TEXT_FIELDS.forEach((field, index) => writeAscii(out, index * 64, typed[field], 64));
  out.set(hexBytes(typed.runtimeImageDigest), 320); view.setBigUint64(352, BigInt(typed.leaseEpoch), true);
  view.setUint32(360, typed.vcpus, true); view.setUint32(364, typed.memoryMiB, true);
  return out;
}
function decodeScopePayload(payload: Uint8Array): CoworkNativeScope {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (!allZero(payload.subarray(368)) || view.getBigUint64(352, true) > 0xffff_ffffn) return fail();
  const fields = Object.fromEntries(SCOPE_TEXT_FIELDS.map((field, index) => [field, readText(payload, index * 64)])) as Record<typeof SCOPE_TEXT_FIELDS[number], string>;
  return record({ workspaceId: fields.workspaceId, incarnationId: fields.incarnationId, leaseEpoch: Number(view.getBigUint64(352, true)), admissionId: fields.admissionId, controllerInstanceId: fields.controllerInstanceId,
    workerInstanceId: fields.workerInstanceId, runtimeImageDigest: hexOf(payload.subarray(320, 352)), vcpus: view.getUint32(360, true), memoryMiB: view.getUint32(364, true) }, SCOPE_SPEC) as unknown as CoworkNativeScope;
}

export function serializeCoworkNativeEnvelope(envelope: CoworkNativeEnvelope): Uint8Array {
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1 || envelope.seq > 0xffff_ffff) return fail("bad_sequence");
  const kindIndex = COWORK_NATIVE_ENVELOPE_KINDS.indexOf(envelope.kind);
  if (kindIndex < 0) return fail("unknown_type");
  const length = COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES[envelope.kind], out = new Uint8Array(COWORK_NATIVE_LIMITS.headerBytes + length), view = new DataView(out.buffer), body = out.subarray(COWORK_NATIVE_LIMITS.headerBytes);
  out.set(Buffer.from(COWORK_NATIVE_ENVELOPE_MAGIC, "latin1"), 0); view.setUint8(4, COWORK_NATIVE_PROTOCOL_VERSION); view.setUint8(5, kindIndex + 1); view.setUint16(6, 0, true);
  view.setUint32(8, envelope.seq, true); view.setUint32(12, length, true);
  const b = new DataView(out.buffer, COWORK_NATIVE_LIMITS.headerBytes);
  if (envelope.kind === "scope") body.set(encodeScopePayload(envelope.scope));
  else if (envelope.kind === "volumes") {
    b.setUint32(0, 1, true); body.set(hexBytes(digest(envelope.scopeDigest) as string), 8);
    if (!Array.isArray(envelope.volumes) || envelope.volumes.length !== 2) return fail();
    distinctFiles(envelope.volumes);
    COWORK_NATIVE_VOLUME_PURPOSES.forEach((purpose, index) => writeVolume(b, 40 + index * 32, envelope.volumes[index]!, purpose));
  } else if (envelope.kind === "drain") {
    body.set(hexBytes(nonce(envelope.stopNonce) as string), 0); b.setUint32(16, uint(0, COWORK_NATIVE_LIMITS.drainBudgetCeilingMs)(envelope.budgetMs) as number, true);
    b.setUint32(20, oneOf(["host-stop", "owner-loss"] as const)(envelope.origin) === "host-stop" ? 1 : 2, true);
  } else if (envelope.kind === "status") {
    b.setUint32(0, COWORK_NATIVE_WORKER_STATUS.indexOf(oneOf(COWORK_NATIVE_WORKER_STATUS)(envelope.state) as never) + 1, true);
    envelope.flush.forEach((counter, index) => { b.setBigUint64(8 + index * 16, BigInt(uint()(counter.requested) as number), true); b.setBigUint64(16 + index * 16, BigInt(uint()(counter.completed) as number), true); });
  } else b.setUint32(0, COWORK_NATIVE_WORKER_FAULTS.indexOf(oneOf(COWORK_NATIVE_WORKER_FAULTS)(envelope.code) as never) + 1, true);
  return out;
}
/** `rights` is how many descriptors arrived WITH the datagram. VOLUMES needs exactly 2; everything else exactly 0; the
 * caller must close any it was handed when this throws. A truncated control buffer is a worker-level `_exit`, not a parse. */
export function parseCoworkNativeEnvelope(bytes: Uint8Array, rights: number, direction: "to-worker" | "to-launcher"): CoworkNativeEnvelope {
  if (!(bytes instanceof Uint8Array) || bytes.length < COWORK_NATIVE_LIMITS.headerBytes) return fail("malformed");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Buffer.from(bytes.subarray(0, 4)).toString("latin1") !== COWORK_NATIVE_ENVELOPE_MAGIC) return fail("malformed");
  if (header.getUint8(4) !== COWORK_NATIVE_PROTOCOL_VERSION) return fail("version");
  const kind = COWORK_NATIVE_ENVELOPE_KINDS[header.getUint8(5) - 1];
  if (kind === undefined || header.getUint16(6, true) !== 0) return fail("unknown_type");
  if (COWORK_NATIVE_ENVELOPE_DIRECTION[kind] !== direction) return fail("bad_direction");
  const seq = header.getUint32(8, true), length = header.getUint32(12, true), wantedRights = kind === "volumes" ? COWORK_NATIVE_LIMITS.volumeRights : 0;
  if (seq < 1) return fail("bad_sequence");
  if (length !== COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES[kind] || bytes.length !== COWORK_NATIVE_LIMITS.headerBytes + length) return fail("malformed");
  if (rights !== wantedRights) return fail("bad_rights");
  const payload = bytes.subarray(COWORK_NATIVE_LIMITS.headerBytes), view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const parsed = ((): CoworkNativeEnvelope => {
    if (kind === "scope") return { kind, seq, scope: decodeScopePayload(payload) };
    if (kind === "volumes") {
      if (view.getUint32(0, true) !== 1 || view.getUint32(4, true) !== 0) return fail();
      return { kind, seq, scopeDigest: hexOf(payload.subarray(8, 40)), volumes: distinctFiles([readVolume(view, 40, "data"), readVolume(view, 72, "environment")] as const) };
    }
    if (kind === "drain") {
      const origin = view.getUint32(20, true);
      if (!allZero(payload.subarray(24)) || (origin !== 1 && origin !== 2) || view.getUint32(16, true) > COWORK_NATIVE_LIMITS.drainBudgetCeilingMs) return fail();
      return { kind, seq, stopNonce: hexOf(payload.subarray(0, 16)), budgetMs: view.getUint32(16, true), origin: origin === 1 ? "host-stop" : "owner-loss" };
    }
    if (kind === "status") {
      const state = COWORK_NATIVE_WORKER_STATUS[view.getUint32(0, true) - 1];
      if (state === undefined || view.getUint32(4, true) !== 0) return fail();
      return { kind, seq, state, flush: Object.freeze([flushOf(view, 8), flushOf(view, 24)]) as unknown as readonly [CoworkNativeFlushCounters, CoworkNativeFlushCounters] };
    }
    const code = COWORK_NATIVE_WORKER_FAULTS[view.getUint32(0, true) - 1];
    if (code === undefined || view.getUint32(4, true) !== 0) return fail();
    return { kind, seq, code };
  })();
  // Exact re-serialization, as for every other format here.
  if (hexOf(serializeCoworkNativeEnvelope(parsed)) !== hexOf(bytes)) return fail("malformed");
  return Object.freeze(parsed);
}

// ------------------------------------------------------------------------------------------------ launcher lines (L1)

export type CoworkNativeLauncherDirection = "to-daemon" | "to-launcher";
export type CoworkNativeToDaemon =
  | { readonly t: "hello"; readonly launcherInstanceId: string; readonly hostBootId: string; readonly parentVerified: true }
  | { readonly t: "begun"; readonly id: string; readonly workerInstanceId: string; readonly workerPid: number; readonly workerStartToken: string }
  | { readonly t: "volumes_accepted"; readonly id: string }
  | { readonly t: "refused"; readonly id: string; readonly code: typeof COWORK_NATIVE_REFUSAL_CODES[number] }
  | { readonly t: "worker_state"; readonly state: typeof COWORK_NATIVE_WORKER_STATES[number] }
  | { readonly t: "mux_up"; readonly frame: CoworkNativeMuxFrame }
  | { readonly t: "stopped"; readonly id: string | null; readonly receipt: CoworkNativeOrderlyReceipt }
  | { readonly t: "uncertain"; readonly receipt: CoworkNativeUncertainReceipt }
  | { readonly t: "pong"; readonly id: string }
  | { readonly t: "fault"; readonly code: typeof COWORK_NATIVE_CHANNEL_FAULTS[number] };
export type CoworkNativeToLauncher =
  | ({ readonly t: "begin"; readonly id: string } & CoworkNativeScope)
  | { readonly t: "volumes"; readonly id: string; readonly scopeDigest: string; readonly volumes: readonly [CoworkNativeVolumeIdentity, CoworkNativeVolumeIdentity] }
  | { readonly t: "mux_down"; readonly frame: CoworkNativeMuxFrame }
  | { readonly t: "stop"; readonly id: string; readonly stopNonce: string; readonly reason: typeof COWORK_NATIVE_STOP_REASONS[number]; readonly budgetMs: number }
  | { readonly t: "receipt_retire"; readonly confirmationId: string }
  | { readonly t: "ping"; readonly id: string };
export type CoworkNativeLauncherMessage = CoworkNativeToDaemon | CoworkNativeToLauncher;

/** A mux carrier decodes and re-serializes its frame, so the base64 must be canonical and the frame itself exact. The
 * launcher relays blind: it needs the header (magic, class, lengths) and nothing inside the payload. */
const muxField = (direction: CoworkNativeMuxDirection): Validator<CoworkNativeMuxFrame> => value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return fail();
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) return fail();
  const frame = parseCoworkNativeMuxFrame(bytes, direction);
  // Control frames terminate at the worker and never cross L1 or L3; a carrier holds bootstrap or runtime frames only.
  if (frame.class === "control" || Buffer.from(serializeCoworkNativeMuxFrame(frame, direction)).toString("base64") !== value) return fail();
  return frame;
};
const LINE_BASE: Spec = [["v", literal(1)]];
const LAUNCHER_SPECS: Record<CoworkNativeLauncherDirection, Record<string, Spec>> = {
  "to-daemon": {
    hello: [["t", literal("hello")], ["launcherInstanceId", label], ["hostBootId", label], ["parentVerified", literal(true)]],
    begun: [["t", literal("begun")], ["id", token], ["workerInstanceId", token], ["workerPid", uint(1, 0x7fff_ffff)], ["workerStartToken", label]],
    volumes_accepted: [["t", literal("volumes_accepted")], ["id", token]],
    refused: [["t", literal("refused")], ["id", token], ["code", oneOf(COWORK_NATIVE_REFUSAL_CODES)]],
    worker_state: [["t", literal("worker_state")], ["state", oneOf(COWORK_NATIVE_WORKER_STATES)]],
    mux_up: [["t", literal("mux_up")], ["frame", muxField("up")]],
    stopped: [["t", literal("stopped")], ["id", nullable(token)], ["receipt", orderly]],
    uncertain: [["t", literal("uncertain")], ["receipt", uncertain]],
    pong: [["t", literal("pong")], ["id", token]],
    fault: [["t", literal("fault")], ["code", oneOf(COWORK_NATIVE_CHANNEL_FAULTS)]],
  },
  "to-launcher": {
    begin: [["t", literal("begin")], ["id", token], ...SCOPE_SPEC],
    volumes: [["t", literal("volumes")], ["id", token], ["scopeDigest", digest], ["volumes", volumePair]],
    mux_down: [["t", literal("mux_down")], ["frame", muxField("down")]],
    stop: [["t", literal("stop")], ["id", token], ["stopNonce", nonce], ["reason", oneOf(COWORK_NATIVE_STOP_REASONS)], ["budgetMs", uint(0, COWORK_NATIVE_LIMITS.drainBudgetCeilingMs)]],
    receipt_retire: [["t", literal("receipt_retire")], ["confirmationId", token]],
    ping: [["t", literal("ping")], ["id", token]],
  },
};
/** Message types that may only travel on L1 as a mux carrier. */
const MUX_CARRIERS = new Set(["mux_up", "mux_down"]);

/** Strict parse of ONE L1 line. `rights` is the number of descriptors that arrived with the line: `volumes` needs exactly
 * two, nothing else may carry any. A launcher may NEVER send descriptors to the daemon (`to-daemon` lines need 0). */
export function parseCoworkNativeLauncherLine(raw: unknown, direction: CoworkNativeLauncherDirection, rights = 0): CoworkNativeLauncherMessage {
  const specs = LAUNCHER_SPECS[direction];
  if (specs === undefined) return fail("bad_direction");
  // The size ceiling depends on the type, so parse under the generous one and then hold the line to its own.
  const { parsed } = strictLine(raw, COWORK_NATIVE_LIMITS.muxLineBytes, COWORK_NATIVE_LIMITS.depth.launcher), type = Object.hasOwn(parsed, "t") ? parsed.t : undefined;
  if (typeof type !== "string") return fail("malformed");
  const spec = Object.hasOwn(specs, type) ? specs[type]! : undefined;
  if (!spec) return Object.hasOwn(LAUNCHER_SPECS[direction === "to-daemon" ? "to-launcher" : "to-daemon"], type) ? fail("bad_direction") : fail("unknown_type");
  if (Buffer.byteLength(raw as string, "utf8") > (MUX_CARRIERS.has(type) ? COWORK_NATIVE_LIMITS.muxLineBytes : COWORK_NATIVE_LIMITS.controlLineBytes)) return fail("oversize");
  if (rights !== (type === "volumes" ? COWORK_NATIVE_LIMITS.volumeRights : 0)) return fail("bad_rights");
  if (parsed.v !== COWORK_NATIVE_PROTOCOL_VERSION) return fail("version");
  const typed = record(parsed, [...LINE_BASE, ...spec]);
  delete typed.v;
  // A mux carrier decodes into a frame object, so the compare goes through the serializer, which re-encodes the frame.
  const message = typed as unknown as CoworkNativeLauncherMessage;
  if (serializeCoworkNativeLauncherLine(message, direction) !== raw) return fail("malformed");
  return Object.freeze(message);
}
export function serializeCoworkNativeLauncherLine(message: CoworkNativeLauncherMessage, direction: CoworkNativeLauncherDirection): string {
  const specs = LAUNCHER_SPECS[direction], type = (message as { t: string }).t, spec = specs !== undefined && Object.hasOwn(specs, type) ? specs[type]! : undefined;
  if (!spec) return fail("unknown_type");
  const wire: Record<string, unknown> = { v: 1, ...message }, carrier = MUX_CARRIERS.has(type);
  // The typed object carries a frame; the wire carries its canonical base64, which muxField re-verifies while validating.
  if (carrier) wire.frame = Buffer.from(serializeCoworkNativeMuxFrame((message as { frame: CoworkNativeMuxFrame }).frame, type === "mux_up" ? "up" : "down")).toString("base64");
  const typed = record(wire, [...LINE_BASE, ...spec]);
  if (carrier) typed.frame = wire.frame;
  return `${JSON.stringify(typed)}\n`;
}

// ------------------------------------------------------------------------------------------------ libkrun production ABI

/**
 * Names and signatures ONLY. These replace the `*_fixture_*` entry points of the pinned fixture library (two-disk fixture
 * commit 9a588735) and are what S3 (the C worker) links and S4 (the libkrun patch queue) must export. They declare a
 * contract; nothing here calls, loads or links libkrun. The fixture names stay behind a cfg in S4 as a regression oracle
 * and are never reachable from the production worker.
 *
 * Inventory rule: the device set does not change. Two virtio-blk disks (serial `winter-data`, `winter-environment`), one
 * generic virtio-console port for the mux, the PL011 serial output. NO NIC, NO vsock, NO virtiofs, NO GPU, NO input
 * device and NO shutdown GPIO (`krun_get_shutdown_eventfd` is not admitted): stop is a `drain` control frame and then a
 * guest power-off, observed as the process exit of the worker.
 */
export interface CoworkLibkrunProductionSymbol { readonly name: string; readonly signature: string; readonly replaces: string | null }
export const COWORK_LIBKRUN_PRODUCTION_STRUCTS = Object.freeze([
  "struct krun_cowork_volume_identity_v1 { uint64_t device; uint64_t inode; uint64_t capacity_bytes; uint32_t uid; uint32_t mode; }",
  "struct krun_cowork_flush_counters_v1 { uint64_t data_requested; uint64_t data_completed; uint64_t environment_requested; uint64_t environment_completed; }",
] as const);
export const COWORK_LIBKRUN_PRODUCTION_ABI: readonly CoworkLibkrunProductionSymbol[] = Object.freeze([
  Object.freeze({ name: "krun_cowork_enable_profile_v1", replaces: "krun_enable_cowork_block_fixture_reclaim",
    signature: "int32_t krun_cowork_enable_profile_v1(uint32_t ctx_id)" }),
  Object.freeze({ name: "krun_cowork_set_workspace_disks_v1", replaces: "krun_set_cowork_workspace_disks",
    signature: "int32_t krun_cowork_set_workspace_disks_v1(uint32_t ctx_id, int32_t data_fd, const struct krun_cowork_volume_identity_v1 *data, int32_t environment_fd, const struct krun_cowork_volume_identity_v1 *environment)" }),
  Object.freeze({ name: "krun_cowork_create_mux_stream_v1", replaces: "krun_create_cowork_runtime_stream",
    signature: "int32_t krun_cowork_create_mux_stream_v1(uint32_t ctx_id)" }),
  Object.freeze({ name: "krun_cowork_get_flush_counters_v1", replaces: null,
    signature: "int32_t krun_cowork_get_flush_counters_v1(uint32_t ctx_id, struct krun_cowork_flush_counters_v1 *out)" }),
  Object.freeze({ name: "krun_cowork_set_exit_hook_v1", replaces: null,
    signature: "int32_t krun_cowork_set_exit_hook_v1(uint32_t ctx_id, void (*hook)(void *user, int32_t guest_halted), void *user)" }),
]);
/** Fixture entry points that get NO production equivalent. The single mux stream replaces the separate bootstrap and runtime ports; the control ACK trace is a fixture measurement. */
export const COWORK_LIBKRUN_RETIRED_FIXTURE_SYMBOLS = Object.freeze(["krun_enable_cowork_runtime_port_fixture_trace", "krun_create_cowork_bootstrap_stream", "krun_set_cowork_bootstrap_stream"] as const);
/** Never admitted into the production device inventory. */
export const COWORK_LIBKRUN_FORBIDDEN_SYMBOLS = Object.freeze(["krun_get_shutdown_eventfd", "krun_add_vsock", "krun_add_vsock_port", "krun_add_vsock_port2", "krun_add_virtiofs", "krun_add_virtiofs2", "krun_add_virtiofs3", "krun_add_virtiofs4", "krun_set_port_map", "krun_set_gpu_options", "krun_set_gpu_options2", "krun_add_display", "krun_add_input_device", "krun_add_input_device_fd"] as const);
