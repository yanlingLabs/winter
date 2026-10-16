import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  CoworkNativeMuxSequence, CoworkNativeProtocolError, COWORK_LIBKRUN_FORBIDDEN_SYMBOLS, COWORK_LIBKRUN_PRODUCTION_ABI, COWORK_LIBKRUN_PRODUCTION_STRUCTS, COWORK_LIBKRUN_RETIRED_FIXTURE_SYMBOLS,
  COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES, COWORK_NATIVE_LIMITS, COWORK_NATIVE_MUX_CLASSES, classAInvariantsHold, coworkNativeScopeDigest, parseCoworkNativeEnvelope, parseCoworkNativeLauncherLine,
  parseCoworkNativeMuxFrame, parseCoworkNativeStopReceipt, serializeCoworkNativeEnvelope, serializeCoworkNativeLauncherLine, serializeCoworkNativeMuxFrame, serializeCoworkNativeStopReceipt,
  type CoworkNativeEnvelope, type CoworkNativeLauncherDirection, type CoworkNativeMuxDirection, type CoworkNativeOrderlyReceipt, type CoworkNativeProtocolFailure,
} from "../../../src/cowork/native/protocol";

// The vectors are the cross-language oracle. Everything below reads them from disk; nothing here re-derives an expected
// byte from the module under test (that would prove only that the module agrees with itself).
const vectorsDir = join(import.meta.dir, "vectors");
const vector = <T>(name: string): T => JSON.parse(readFileSync(join(vectorsDir, name), "utf8")) as T;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
/** The refusal code, or "accepted" when nothing was refused (so a failing vector names itself in the diff). */
function code(body: () => unknown): CoworkNativeProtocolFailure | "accepted" {
  try { body(); } catch (error) { expect(error).toBeInstanceOf(CoworkNativeProtocolError); return (error as CoworkNativeProtocolError).code; }
  return "accepted";
}

interface LineVectors { positive: { name: string; direction: CoworkNativeLauncherDirection; rights: number; line: string; t: string }[]; negative: { name: string; direction: CoworkNativeLauncherDirection; rights: number; line: string; error: string }[] }
interface MuxVectors { positive: { name: string; direction: CoworkNativeMuxDirection; hex: string; class: string; seq: number }[]; negative: { name: string; direction: CoworkNativeMuxDirection; hex: string; error: string }[] }
interface EnvelopeVectors { scopeDigest: { scope: Parameters<typeof coworkNativeScopeDigest>[0]; sha256: string }; positive: { name: string; direction: "to-worker" | "to-launcher"; rights: number; hex: string; kind: string; seq: number }[]; negative: { name: string; direction: "to-worker" | "to-launcher"; rights: number; hex: string; error: string }[] }
interface ReceiptVectors { positive: { name: string; text: string; class: "A" | "B"; invariantsHold?: boolean }[]; parsesButNotOrderly: { name: string; text: string }[]; negative: { name: string; text: string; error: string }[] }
const lines = vector<LineVectors>("launcher-lines.json"), mux = vector<MuxVectors>("mux-frames.json"), envelopes = vector<EnvelopeVectors>("envelopes.json"), receipts = vector<ReceiptVectors>("stop-receipts.json");

// ---------------------------------------------------------------- L1 launcher lines
test("every positive launcher line parses and re-serializes byte for byte", () => {
  for (const entry of lines.positive) {
    const parsed = parseCoworkNativeLauncherLine(entry.line, entry.direction, entry.rights);
    expect(String(parsed.t)).toBe(entry.t);
    expect(serializeCoworkNativeLauncherLine(parsed, entry.direction)).toBe(entry.line);
    expect(Object.isFrozen(parsed)).toBe(true);
  }
});
test("every negative launcher line is refused with its named code", () => {
  for (const entry of lines.negative) expect(`${entry.name}:${code(() => parseCoworkNativeLauncherLine(entry.line, entry.direction, entry.rights))}`).toBe(`${entry.name}:${entry.error}`);
});
test("a launcher line over its own ceiling is oversize, whatever its type", () => {
  const huge = `${"x".repeat(COWORK_NATIVE_LIMITS.muxLineBytes + 1)}\n`;
  expect(code(() => parseCoworkNativeLauncherLine(huge, "to-launcher"))).toBe("oversize");
  expect(code(() => parseCoworkNativeLauncherLine(42, "to-launcher"))).toBe("malformed");
  expect(code(() => parseCoworkNativeLauncherLine(null, "to-daemon"))).toBe("malformed");
});
test("only the volumes line may carry descriptors, and exactly two; a launcher line never carries any toward the daemon", () => {
  const volumes = lines.positive.find(entry => entry.name === "volumes-two-descriptors")!;
  for (const entry of lines.positive) {
    for (const rights of [0, 1, 2, 3]) {
      const wanted = entry.t === "volumes" ? 2 : 0;
      if (rights === wanted) continue;
      expect(`${entry.name}/${rights}:${code(() => parseCoworkNativeLauncherLine(entry.line, entry.direction, rights))}`).toBe(`${entry.name}/${rights}:bad_rights`);
    }
  }
  expect(volumes.rights).toBe(2);
  expect(lines.positive.filter(entry => entry.direction === "to-daemon").every(entry => entry.rights === 0)).toBe(true);
});
test("the stopped line holds only an orderly receipt and the uncertain line only an uncertain one", () => {
  const stopped = lines.positive.find(entry => entry.name === "stopped-orderly")!, uncertain = lines.positive.find(entry => entry.name === "uncertain")!;
  const a = receipts.positive.find(entry => entry.class === "A")!.text.trim(), b = receipts.positive.find(entry => entry.class === "B")!.text.trim();
  expect(code(() => parseCoworkNativeLauncherLine(stopped.line.replace(/"receipt":\{.*\}\}\n$/, `"receipt":${b}}\n`), "to-daemon"))).toBe("bad_field");
  expect(code(() => parseCoworkNativeLauncherLine(uncertain.line.replace(/"receipt":\{.*\}\}\n$/, `"receipt":${a}}\n`), "to-daemon"))).toBe("bad_field");
});

// ---------------------------------------------------------------- mux frames
test("every positive mux frame parses and re-serializes byte for byte", () => {
  for (const entry of mux.positive) {
    const frame = parseCoworkNativeMuxFrame(bytes(entry.hex), entry.direction);
    expect(String(frame.class)).toBe(entry.class);
    expect(frame.seq).toBe(entry.seq);
    expect(hex(serializeCoworkNativeMuxFrame(frame, entry.direction))).toBe(entry.hex);
  }
});
test("every negative mux frame is refused with its named code", () => {
  for (const entry of mux.negative) expect(`${entry.name}:${code(() => parseCoworkNativeMuxFrame(bytes(entry.hex), entry.direction))}`).toBe(`${entry.name}:${entry.error}`);
});
test("the provider class is reserved: it is refused at the header whatever follows, and it cannot be serialized", () => {
  expect(COWORK_NATIVE_MUX_CLASSES).toEqual(["control", "bootstrap", "runtime", "provider"]);
  expect(COWORK_NATIVE_LIMITS.muxPayloadBytes.provider).toBe(0);
  for (const direction of ["up", "down"] as const) expect(code(() => parseCoworkNativeMuxFrame(bytes("574d58310103000001000000" + "00000000"), direction))).toBe("reserved_class");
  expect(code(() => serializeCoworkNativeMuxFrame({ class: "provider", seq: 1, payload: new Uint8Array(0) } as never, "down"))).toBe("reserved_class");
});
test("mux sequence numbers are strictly +1 per class and direction, from 1", () => {
  const sequence = new CoworkNativeMuxSequence(), frame = (cls: "runtime" | "bootstrap", seq: number) => ({ class: cls, seq, payload: new Uint8Array(0) }) as never;
  sequence.accept(frame("runtime", 1), "up"); sequence.accept(frame("runtime", 2), "up");
  sequence.accept(frame("runtime", 1), "down"); // the other direction counts separately
  sequence.accept(frame("bootstrap", 1), "up"); // so does another class
  expect(code(() => sequence.accept(frame("runtime", 2), "up"))).toBe("bad_sequence"); // replay
  expect(code(() => sequence.accept(frame("runtime", 4), "up"))).toBe("bad_sequence"); // gap
  expect(code(() => new CoworkNativeMuxSequence().accept(frame("runtime", 2), "up"))).toBe("bad_sequence");
  sequence.accept(frame("runtime", 3), "up"); // a refused frame did not advance the counter
});
test("a runtime payload is opaque bytes up to exactly the transport frame; one byte more is oversize", () => {
  const limit = COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime;
  const frame = serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, payload: new Uint8Array(limit).fill(0x41) }, "up");
  expect(frame.length).toBe(16 + limit);
  expect(parseCoworkNativeMuxFrame(frame, "up").class).toBe("runtime");
  expect(code(() => serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, payload: new Uint8Array(limit + 1) }, "up"))).toBe("oversize");
});
test("the largest legal mux frame fits the largest legal carrier line", () => {
  const frame = { class: "runtime" as const, seq: 1, payload: new Uint8Array(COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime).fill(0xff) };
  const line = serializeCoworkNativeLauncherLine({ t: "mux_down", frame }, "to-launcher");
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(COWORK_NATIVE_LIMITS.muxLineBytes);
  expect(parseCoworkNativeLauncherLine(line, "to-launcher").t).toBe("mux_down");
});

// ---------------------------------------------------------------- L2 envelopes
test("every positive envelope parses and re-serializes byte for byte", () => {
  for (const entry of envelopes.positive) {
    const parsed = parseCoworkNativeEnvelope(bytes(entry.hex), entry.rights, entry.direction);
    expect(String(parsed.kind)).toBe(entry.kind);
    expect(hex(serializeCoworkNativeEnvelope(parsed))).toBe(entry.hex);
    expect(bytes(entry.hex).length).toBe(16 + COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES[parsed.kind]);
  }
});
test("every negative envelope is refused with its named code", () => {
  for (const entry of envelopes.negative) expect(`${entry.name}:${code(() => parseCoworkNativeEnvelope(bytes(entry.hex), entry.rights, entry.direction))}`).toBe(`${entry.name}:${entry.error}`);
});
test("the scope digest is the SHA-256 of the 512 byte scope payload, pinned independently", () => {
  expect(coworkNativeScopeDigest(envelopes.scopeDigest.scope)).toBe(envelopes.scopeDigest.sha256);
  const scope = envelopes.positive.find(entry => entry.name === "scope")!, volumes = parseCoworkNativeEnvelope(bytes(envelopes.positive.find(entry => entry.name === "volumes-two-descriptors")!.hex), 2, "to-worker");
  const payload = bytes(scope.hex).subarray(16);
  expect(payload.length).toBe(512);
  expect(new Bun.CryptoHasher("sha256").update(payload).digest("hex")).toBe(envelopes.scopeDigest.sha256);
  expect(volumes.kind === "volumes" && volumes.scopeDigest).toBe(envelopes.scopeDigest.sha256);
});
test("a u64 device or inode survives the binary and text forms without rounding", () => {
  const entry = envelopes.positive.find(item => item.name === "volumes-two-descriptors")!, parsed = parseCoworkNativeEnvelope(bytes(entry.hex), 2, "to-worker");
  if (parsed.kind !== "volumes") throw new Error("kind");
  expect(parsed.volumes.map(volume => volume.inode)).toEqual(["9007199254740993", "18446744073709551615"]);
  expect(parsed.volumes[1].inode).not.toBe(String(Number("18446744073709551615")));
});
test("serializers refuse what the parsers would refuse", () => {
  const scope = envelopes.scopeDigest.scope;
  for (const bad of [{ ...scope, vcpus: 4 }, { ...scope, memoryMiB: 4096 }, { ...scope, leaseEpoch: 0 }, { ...scope, workspaceId: "w".repeat(64) }, { ...scope, runtimeImageDigest: "AB".repeat(32) }, { ...scope, extra: 1 }])
    expect(code(() => serializeCoworkNativeEnvelope({ kind: "scope", seq: 1, scope: bad as never }))).toBe("bad_field");
  expect(code(() => serializeCoworkNativeEnvelope({ kind: "scope", seq: 0, scope }))).toBe("bad_sequence");
  expect(code(() => serializeCoworkNativeEnvelope({ kind: "teapot", seq: 1 } as unknown as CoworkNativeEnvelope))).toBe("unknown_type");
});

// ---------------------------------------------------------------- stop receipts
test("every positive stop receipt parses and re-serializes byte for byte", () => {
  for (const entry of receipts.positive) {
    const parsed = parseCoworkNativeStopReceipt(entry.text);
    expect(parsed.class).toBe(entry.class);
    expect(serializeCoworkNativeStopReceipt(parsed)).toBe(entry.text);
    if (parsed.class === "A") expect(classAInvariantsHold(parsed)).toBe(entry.invariantsHold ?? false);
  }
});
test("every negative stop receipt is refused with its named code", () => {
  for (const entry of receipts.negative) expect(`${entry.name}:${code(() => parseCoworkNativeStopReceipt(entry.text))}`).toBe(`${entry.name}:${entry.error}`);
});
test("a Class A receipt that contradicts itself parses but is not orderly evidence", () => {
  expect(receipts.parsesButNotOrderly.length).toBeGreaterThanOrEqual(5);
  for (const entry of receipts.parsesButNotOrderly) {
    const parsed = parseCoworkNativeStopReceipt(entry.text) as CoworkNativeOrderlyReceipt;
    expect(`${entry.name}:${parsed.class}:${classAInvariantsHold(parsed)}`).toBe(`${entry.name}:A:false`);
  }
});
test("Class B has no confirmation: its schema carries no key a release could be minted from", () => {
  const b = JSON.parse(receipts.positive.find(entry => entry.class === "B")!.text) as Record<string, unknown>;
  expect(Object.keys(b)).not.toContain("confirmationId");
  expect(Object.keys(b)).not.toContain("stopNonce");
  expect(Object.keys(b)).not.toContain("volumes");
});

// ---------------------------------------------------------------- limits, ABI, drift
test("drift guard: the pinned literals", () => {
  expect({ ...COWORK_NATIVE_LIMITS, depth: { ...COWORK_NATIVE_LIMITS.depth }, muxPayloadBytes: { ...COWORK_NATIVE_LIMITS.muxPayloadBytes } }).toEqual({
    controlLineBytes: 16384, muxLineBytes: 1572864, depth: { launcher: 4, receipt: 3, control: 1, bootstrap: 8 }, headerBytes: 16,
    muxPayloadBytes: { control: 4096, bootstrap: 262144, runtime: 1048576, provider: 0 }, receiptBytes: 8192, tokenChars: 63, vcpus: 2, minMemoryMiB: 256, maxMemoryMiB: 1024,
    drainBudgetMs: 30000, drainBudgetCeilingMs: 120000, volumeRights: 2 });
  expect({ ...COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES }).toEqual({ scope: 512, volumes: 104, drain: 28, status: 40, fault: 8 });
  // The runtime ceiling is the existing guest runtime transport frame, not a number invented here.
  const runtime = readFileSync(join(import.meta.dir, "..", "..", "..", "src", "cowork", "guest-runtime.ts"), "utf8");
  expect(runtime).toContain(`frameBytes: ${COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime / 1024} * 1024`);
});
test("the production libkrun ABI replaces the fixture names and admits no new device", () => {
  const names = COWORK_LIBKRUN_PRODUCTION_ABI.map(symbol => symbol.name);
  expect(names).toEqual(["krun_cowork_enable_profile_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_create_mux_stream_v1", "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1"]);
  expect(new Set(names).size).toBe(names.length);
  for (const symbol of COWORK_LIBKRUN_PRODUCTION_ABI) {
    expect(symbol.name).not.toMatch(/fixture/);
    expect(symbol.signature).toContain(`${symbol.name}(`);
    expect(symbol.signature).not.toMatch(/fixture/);
    expect(symbol.signature).toMatch(/^(int32_t) krun_cowork_[a-z0-9_]+\(uint32_t ctx_id/);
  }
  expect(COWORK_LIBKRUN_PRODUCTION_ABI.filter(symbol => symbol.replaces !== null).map(symbol => symbol.replaces)).toEqual(["krun_enable_cowork_block_fixture_reclaim", "krun_set_cowork_workspace_disks", "krun_create_cowork_runtime_stream"]);
  expect(COWORK_LIBKRUN_PRODUCTION_STRUCTS.every(declaration => !/fixture/.test(declaration))).toBe(true);
  // Retired and forbidden entry points: never re-exported under a production name.
  expect(COWORK_LIBKRUN_RETIRED_FIXTURE_SYMBOLS).toEqual(["krun_enable_cowork_runtime_port_fixture_trace", "krun_create_cowork_bootstrap_stream", "krun_set_cowork_bootstrap_stream"]);
  for (const forbidden of COWORK_LIBKRUN_FORBIDDEN_SYMBOLS) expect(names).not.toContain(forbidden);
  expect(COWORK_LIBKRUN_FORBIDDEN_SYMBOLS).toContain("krun_get_shutdown_eventfd");
  expect(COWORK_LIBKRUN_FORBIDDEN_SYMBOLS.filter(name => /vsock/.test(name)).length).toBeGreaterThanOrEqual(3);
});
test("the contract document names every production symbol, every message type and every mux class", () => {
  const doc = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "docs", "cowork-native-worker.md"), "utf8");
  for (const symbol of COWORK_LIBKRUN_PRODUCTION_ABI) expect(`${symbol.name}:${doc.includes(symbol.signature)}`).toBe(`${symbol.name}:true`);
  for (const type of new Set(lines.positive.map(entry => entry.t))) expect(`${type}:${doc.includes(`\`${type}\``)}`).toBe(`${type}:true`);
  for (const cls of COWORK_NATIVE_MUX_CLASSES) expect(doc).toContain(cls);
});
test("the vector files are exactly the four the contract names, and nothing else lives beside them", () => {
  expect(readdirSync(vectorsDir).sort()).toEqual(["envelopes.json", "launcher-lines.json", "mux-frames.json", "stop-receipts.json"]);
  for (const name of readdirSync(vectorsDir)) expect(basename(name).endsWith(".json")).toBe(true);
  expect(existsSync(join(vectorsDir, "launcher-lines.json"))).toBe(true);
});
