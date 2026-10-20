import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  coworkNativeBootstrapOrder, CoworkNativeMuxSequence, CoworkNativeProtocolError, CoworkNativeRuntimeStreams, coworkNativeConversationsAreBound, coworkNativeGuestStopVerdict, coworkNativeHostStopWaitMs, coworkNativeLauncherKillMs, COWORK_LIBKRUN_OPTIONAL_SYMBOLS, COWORK_LIBKRUN_EXIT_REASONS, COWORK_LIBKRUN_FORBIDDEN_SYMBOLS, COWORK_NATIVE_WORKER_EXIT_CODES, COWORK_NATIVE_WORKER_FAULTS, COWORK_NATIVE_WORKER_LAYOUT, coworkNativeRuntimeImageDigest, COWORK_LIBKRUN_PRODUCTION_ABI, COWORK_LIBKRUN_PRODUCTION_STRUCTS, COWORK_LIBKRUN_RETIRED_FIXTURE_SYMBOLS,
  COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES, COWORK_NATIVE_BOOTSTRAP_FAULTS, COWORK_NATIVE_GUEST_FAULTS, COWORK_NATIVE_WORKER_STATES, COWORK_NATIVE_WORKER_STATUS, COWORK_NATIVE_LIMITS, COWORK_NATIVE_MUX_CLASSES, classAInvariantsHold, coworkNativeScopeDigest, parseCoworkNativeEnvelope, parseCoworkNativeLauncherLine,
  parseCoworkNativeMuxFrame, parseCoworkNativeStopReceipt, serializeCoworkNativeEnvelope, serializeCoworkNativeLauncherLine, serializeCoworkNativeMuxFrame, serializeCoworkNativeStopReceipt,
  COWORK_NATIVE_TEXT_VERSION, COWORK_NATIVE_BOOTSTRAP_VERSION, COWORK_NATIVE_CONTROL_VERSION, COWORK_NATIVE_REFUSAL_CODES, COWORK_NATIVE_ENVELOPE_KINDS, COWORK_NATIVE_RUNTIME_STREAMS, COWORK_NATIVE_SHARE_NOTICE_KINDS,
  COWORK_NATIVE_SHARE_MOUNTS, COWORK_NATIVE_FILE_CHANNEL_CAPABILITY, COWORK_NATIVE_WORKER_SHARES_FLAG, parseCoworkNativeWorkerArgv, serializeCoworkNativeWorkerArgv,
  type CoworkNativeEnvelope, type CoworkNativeLibkrunExitReason, type CoworkNativeLibkrunFlushCounters, type CoworkNativeFlushDevice, type CoworkNativeWorkerStatusState, type CoworkNativeLauncherDirection, type CoworkNativeMuxDirection, type CoworkNativeOrderlyReceipt, type CoworkNativeProtocolFailure,
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
test("only the volumes line (exactly two) and the shares line (one per record) may carry descriptors; a launcher line never carries any toward the daemon", () => {
  const volumes = lines.positive.find(entry => entry.name === "volumes-two-descriptors")!;
  for (const entry of lines.positive) {
    for (const rights of [0, 1, 2, 3]) {
      const wanted = entry.t === "volumes" ? 2 : entry.t === "shares" ? entry.rights : 0;
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
test("a runtime payload is a 4 byte stream prefix and then opaque bytes, up to exactly the transport frame; one byte more is oversize", () => {
  const limit = COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime, data = limit - COWORK_NATIVE_LIMITS.runtimePrefixBytes;
  const frame = serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "out", end: false, payload: new Uint8Array(data).fill(0x41) }, "up");
  expect(frame.length).toBe(16 + limit);
  expect(parseCoworkNativeMuxFrame(frame, "up")).toMatchObject({ class: "runtime", conversation: 0, stream: "out", end: false });
  expect(code(() => serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "out", end: false, payload: new Uint8Array(data + 1) }, "up"))).toBe("oversize");
});
test("the stream prefix is four fixed bytes in the payload: conversation, stream (1 IN, 2 OUT, 3 ERR), flags, reserved", () => {
  const wire = (conversation: number, stream: "in" | "out" | "err", end: boolean, direction: "up" | "down") => hex(serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation, stream, end, payload: new Uint8Array([0x41]) }, direction)).slice(32);
  expect(wire(0, "in", false, "down")).toBe("00010000" + "41");
  expect(wire(5, "out", true, "up")).toBe("05020100" + "41");
  expect(wire(15, "err", false, "up")).toBe("0f030000" + "41");
  expect(hex(serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 3, stream: "out", end: true, payload: new Uint8Array(0) }, "up")).slice(32)).toBe("03020100");
  // The header's own flags stay zero: nothing about the stream lives there.
  expect(hex(serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "in", end: false, payload: new Uint8Array([1]) }, "down")).slice(12, 16)).toBe("0000");
  for (const bad of [{ conversation: 16 }, { conversation: -1 }, { conversation: 1.5 }, { stream: "stdout" }, { end: 1 }, { payload: new Uint8Array(0) }]) {
    expect(code(() => serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "out", end: false, payload: new Uint8Array([1]), ...bad } as never, "up"))).toBe("bad_field");
  }
  expect(code(() => serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "in", end: false, payload: new Uint8Array([1]) }, "up"))).toBe("bad_direction");
  expect(code(() => serializeCoworkNativeMuxFrame({ class: "runtime", seq: 1, conversation: 0, stream: "err", end: false, payload: new Uint8Array([1]) }, "down"))).toBe("bad_direction");
});
test("the runtime stream tracker refuses a conversation outside the delivered set and anything after a stream's end", () => {
  const frame = (conversation: number, stream: "in" | "out" | "err", end = false) => ({ class: "runtime" as const, seq: 1, conversation, stream, end, payload: new Uint8Array([1]) });
  const streams = new CoworkNativeRuntimeStreams(1);
  streams.accept(frame(0, "out")); streams.accept(frame(0, "err")); streams.accept(frame(0, "out", true));
  expect(code(() => streams.accept(frame(0, "out")))).toBe("bad_field"); // data after the end
  expect(code(() => streams.accept(frame(0, "out", true)))).toBe("bad_field"); // a second end
  streams.accept(frame(0, "err")); // another stream of the same conversation is independent
  expect(code(() => streams.accept(frame(1, "out")))).toBe("bad_field"); // not in the delivered set (N2: one host-query conversation)
  expect(code(() => streams.accept({ class: "bootstrap", seq: 1, message: { t: "mounted", operationId: "x", nonce: "0f".repeat(16) } } as never))).toBe("bad_field");
  for (const count of [0, 2, 17, 1.5]) expect(code(() => new CoworkNativeRuntimeStreams(count))).toBe("bad_field");
});
test("the largest legal mux frame fits the largest legal carrier line", () => {
  const frame = { class: "runtime" as const, seq: 1, conversation: 0, stream: "in" as const, end: false, payload: new Uint8Array(COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime - COWORK_NATIVE_LIMITS.runtimePrefixBytes).fill(0xff) };
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
    muxPayloadBytes: { control: 4096, bootstrap: 262144, runtime: 1048576, provider: 0 }, receiptBytes: 8192, tokenChars: 63, vcpus: 2, minMemoryMiB: 768, maxMemoryMiB: 1024,
    drainBudgetMs: 30000, drainBudgetCeilingMs: 120000, volumeRights: 2,
    libkrunExitWatchdogMs: 20000, launcherKillMarginMs: 5000, hostStopMarginMs: 10000, conversationsBytes: 20480, conversationItems: 16, rootsPerConversation: 16, providerBytes: 4096, runtimePrefixBytes: 4, runtimeConversations: 16, runtimeInFlightBytes: 1048576,
    fileInFlightRequests: 4, fileRequestBytes: 16384, fileResponseBytes: 393216, shares: 12, folderShares: 9, shareTagChars: 32, shareRecordBytes: 308, endedGuestBoots: 4, runtimeTimeoutCeilingMs: 86400000 });
  expect({ ...COWORK_NATIVE_ENVELOPE_PAYLOAD_BYTES }).toEqual({ scope: 512, volumes: 104, drain: 28, status: 40, fault: 8, shares: 3704, share_revoke: 32, share_event: 40 });
  expect([COWORK_NATIVE_TEXT_VERSION, COWORK_NATIVE_BOOTSTRAP_VERSION, COWORK_NATIVE_CONTROL_VERSION]).toEqual([2, 2, 1]);
  // The runtime ceiling is the existing guest runtime transport frame, not a number invented here.
  const runtime = readFileSync(join(import.meta.dir, "..", "..", "..", "src", "cowork", "guest-runtime.ts"), "utf8");
  expect(runtime).toContain(`frameBytes: ${COWORK_NATIVE_LIMITS.muxPayloadBytes.runtime / 1024} * 1024`);
});
test("the production libkrun ABI replaces the fixture names and admits no new device", () => {
  const names = COWORK_LIBKRUN_PRODUCTION_ABI.map(symbol => symbol.name);
  expect(names).toEqual(["krun_cowork_enable_profile_v1", "krun_cowork_set_workspace_disks_v1", "krun_cowork_create_runtime_port_v1", "krun_cowork_validate_profile_v1", "krun_cowork_get_flush_counters_v1", "krun_cowork_set_exit_hook_v1", "krun_cowork_get_pin_counters_v1"]);
  expect(new Set(names).size).toBe(names.length);
  for (const symbol of COWORK_LIBKRUN_PRODUCTION_ABI) {
    expect(symbol.name).not.toMatch(/fixture/);
    expect(symbol.signature).toContain(`${symbol.name}(`);
    expect(symbol.signature).not.toMatch(/fixture/);
    // Per-context entry points take the context; the counter getters are process-global (the context leaves the library's table when the VM starts).
    expect(symbol.signature).toMatch(/get_(flush|pin)_counters_v1\(/.test(symbol.signature) ? /^int32_t krun_cowork_get_(flush|pin)_counters_v1\(struct krun_cowork_(flush|pin)_counters_v1 \*out\)$/ : /^int32_t krun_cowork_[a-z0-9_]+_v1\(uint32_t ctx_id/);
  }
  // The pin counters are optional diagnostics: nothing may depend on them, and nothing in a receipt or a verdict reads them.
  expect([...COWORK_LIBKRUN_OPTIONAL_SYMBOLS]).toEqual(["krun_cowork_get_pin_counters_v1"]);
  expect(readFileSync(join(import.meta.dir, "..", "..", "..", "src", "cowork", "native", "protocol.ts"), "utf8").match(/krun_cowork_get_pin_counters_v1/g)!.length).toBeGreaterThanOrEqual(2);
  expect(COWORK_LIBKRUN_PRODUCTION_ABI.filter(symbol => symbol.replaces !== null).map(symbol => symbol.replaces)).toEqual(["krun_enable_cowork_block_fixture_reclaim", "krun_set_cowork_workspace_disks", "krun_create_cowork_runtime_stream"]);
  expect(COWORK_LIBKRUN_PRODUCTION_STRUCTS.every(declaration => !/fixture/.test(declaration))).toBe(true);
  // The volume identity struct keeps its name (controller ruling); the other two are the new ones.
  expect(COWORK_LIBKRUN_PRODUCTION_STRUCTS.map(declaration => declaration.split(" {")[0])).toEqual(["struct krun_cowork_volume_identity", "struct krun_cowork_flush_device_v1", "struct krun_cowork_flush_counters_v1", "struct krun_cowork_pin_counters_v1",
    "#define KRUN_COWORK_EXIT_NONE 0, KRUN_COWORK_EXIT_OFF 1, KRUN_COWORK_EXIT_RESET 2, KRUN_COWORK_EXIT_VCPU_ERROR 3, KRUN_COWORK_EXIT_TERMINAL_FAULT 4", "typedef void (*krun_cowork_exit_hook_v1)(void *user_data, uint32_t reason)"]);
  // S4's header: zero is the UNKNOWN default, not a power-off; a hook that tests `reason != 0` instead of `reason == OFF` would treat every reason as orderly.
  expect({ ...COWORK_LIBKRUN_EXIT_REASONS }).toEqual({ none: 0, off: 1, reset: 2, "vcpu-error": 3, "terminal-fault": 4 });
  // Mux framing is ABOVE libkrun's byte port: no production symbol is named after a mux.
  expect(names.some(name => /mux/.test(name))).toBe(false);
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
  // Contract revision 3: every new bootstrap message, envelope kind, stream and fault is named in the prose too.
  for (const name of ["shares", "shares_mounted", "share_revoke", "share_event", "share_revoked", "share_notice", "file_in", "file_out", "FILE_IN", "FILE_OUT", "browseUid", "continuation", "endedGuestBoots", "continuations", "--shares-v1", "file-channel-v1", ...COWORK_NATIVE_BOOTSTRAP_FAULTS, ...COWORK_NATIVE_SHARE_NOTICE_KINDS])
    expect(`${name}:${doc.includes(name)}`).toBe(`${name}:true`);
  for (const cls of COWORK_NATIVE_MUX_CLASSES) expect(doc).toContain(cls);
});
test("the vector files are exactly the six the contract names, and nothing else lives beside them", () => {
  expect(readdirSync(vectorsDir).sort()).toEqual(["bootstrap-order.json", "envelopes.json", "guest-stop.json", "launcher-lines.json", "mux-frames.json", "runtime-flow.json", "runtime-image.json", "stop-receipts.json"]);
  for (const name of readdirSync(vectorsDir)) expect(basename(name).endsWith(".json")).toBe(true);
  expect(existsSync(join(vectorsDir, "launcher-lines.json"))).toBe(true);
});

// ---------------------------------------------------------------- the pins the controller made final for N2

test("the worker layout and exit codes are pinned (S3's WorkerCommon.h), and 77 belongs to libkrun", () => {
  expect({ ...COWORK_NATIVE_WORKER_LAYOUT }).toEqual({ l2Fd: 3, l3Fd: 4, argv: "[path]", guestDirectory: "cowork-guest", kernelFile: "kernel", initramfsFile: "initramfs.cpio" });
  expect({ ...COWORK_NATIVE_WORKER_EXIT_CODES }).toEqual({ ok: 0, usage: 2, sandbox: 70, bad_scope: 71, bad_volumes: 72, vm_failed: 73, mux_quarantine: 74, drain_timeout: 75, intake_timeout: 76, libkrun_reserved: 77, internal: 78, rights: 79 });
  const codes = Object.values(COWORK_NATIVE_WORKER_EXIT_CODES);
  expect(new Set(codes).size).toBe(codes.length);
  expect(Object.isFrozen(COWORK_NATIVE_WORKER_LAYOUT) && Object.isFrozen(COWORK_NATIVE_WORKER_EXIT_CODES)).toBe(true);
});
test("a second DRAIN has a named worker fault code, last in the list so no earlier code moves", () => {
  expect([...COWORK_NATIVE_WORKER_FAULTS]).toEqual(["bad_scope", "bad_volumes", "sandbox_failed", "vm_failed", "mux_violation", "truncated_rights", "internal", "second_drain"]);
});
test("runtimeImageDigest covers exactly the kernel and the initramfs, in that order, as raw digests", () => {
  const vectors = vector<{ positive: { name: string; kernelSha256: string; initramfsSha256: string; runtimeImageDigest: string }[] }>("runtime-image.json");
  expect(vectors.positive).toHaveLength(2);
  for (const entry of vectors.positive) expect(`${entry.name}:${coworkNativeRuntimeImageDigest(entry.kernelSha256, entry.initramfsSha256)}`).toBe(`${entry.name}:${entry.runtimeImageDigest}`);
  expect(vectors.positive[0]!.runtimeImageDigest).not.toBe(vectors.positive[1]!.runtimeImageDigest);
  for (const bad of [["", "a".repeat(64)], ["A".repeat(64), "a".repeat(64)], ["a".repeat(63), "a".repeat(64)]] as const) expect(code(() => coworkNativeRuntimeImageDigest(bad[0], bad[1]))).toBe("bad_field");
});
test("begin carries the home id (one source for it), right after the request id, and a scope below the 768 MiB floor is refused", () => {
  const begin = lines.positive.find(entry => entry.name === "begin")!, parsed = parseCoworkNativeLauncherLine(begin.line, "to-launcher") as { homeId: string; memoryMiB: number };
  expect(parsed.homeId).toMatch(/^home_/);
  expect(begin.line.startsWith(`{"v":2,"t":"begin","id":"req-0001","homeId":"${parsed.homeId}","workspaceId":`)).toBe(true);
  for (const memory of [767, 512, 256, 0]) expect(code(() => parseCoworkNativeLauncherLine(begin.line.replace('"memoryMiB":768', `"memoryMiB":${memory}`), "to-launcher"))).toBe("bad_field");
  for (const memory of [768, 1024]) expect(parseCoworkNativeLauncherLine(begin.line.replace('"memoryMiB":768', `"memoryMiB":${memory}`), "to-launcher").t).toBe("begin");
});
test("a byte order mark is never skipped: not on an L1 line, not in a mux payload", () => {
  expect(lines.negative.map(entry => entry.name)).toContain("bom-line");
  expect(mux.negative.map(entry => entry.name)).toEqual(expect.arrayContaining(["bom-mux", "bom-mux-bootstrap"]));
  const ping = lines.positive.find(entry => entry.name === "ping")!;
  expect(code(() => parseCoworkNativeLauncherLine(`\ufeff${ping.line}`, "to-launcher"))).toBe("malformed");
});

// ---------------------------------------------------------------- round 3: conversation set, runtime streams, guest faults, halting, timing

const conversationVector = (name: string) => bytes(mux.positive.find(entry => entry.name === name)!.hex);
test("the conversation set parses to its typed form, binds to the plan it follows, and refuses every other binding", () => {
  const frame = parseCoworkNativeMuxFrame(conversationVector("bootstrap-down-conversations-guided"), "down");
  if (frame.class !== "bootstrap" || frame.message.t !== "conversations") throw new Error("shape");
  const message = frame.message, authority = message.conversations[0]!.authority, bootId = (message.conversations[0]!.runtime!.provider.scope as { bootId: string }).bootId;
  const expected = { operationId: message.operationId, nonce: message.nonce, workspaceId: authority.workspaceId, incarnationId: authority.incarnationId, leaseEpoch: authority.leaseEpoch, guestBootId: bootId };
  expect(coworkNativeConversationsAreBound(message, expected)).toBe(true);
  for (const wrong of [{ operationId: "other" }, { nonce: "ee".repeat(16) }, { workspaceId: "other" }, { incarnationId: "other" }, { leaseEpoch: authority.leaseEpoch + 1 }, { guestBootId: "77777777-7777-4777-8777-777777777777" }])
    expect(`${Object.keys(wrong)[0]}:${coworkNativeConversationsAreBound(message, { ...expected, ...wrong })}`).toBe(`${Object.keys(wrong)[0]}:false`);
  // A tools-only set has no runtime, hence no provider scope to compare a boot id with.
  const toolsOnly = parseCoworkNativeMuxFrame(conversationVector("bootstrap-down-conversations-tools-only"), "down");
  if (toolsOnly.class !== "bootstrap" || toolsOnly.message.t !== "conversations") throw new Error("shape");
  expect(toolsOnly.message.profile).toBeNull();
  expect(toolsOnly.message.conversations.map(item => item.runtime)).toEqual([null, null]);
  expect(coworkNativeConversationsAreBound(toolsOnly.message, { ...expected, guestBootId: "77777777-7777-4777-8777-777777777777" })).toBe(true);
  expect(Object.isFrozen(message) && Object.isFrozen(message.conversations)).toBe(true);
});
test("the conversation message is bounded below the bootstrap class ceiling, and its text is printable ASCII", () => {
  expect(COWORK_NATIVE_LIMITS.conversationsBytes).toBeLessThan(COWORK_NATIVE_LIMITS.muxPayloadBytes.bootstrap);
  expect(COWORK_NATIVE_LIMITS.conversationsBytes).toBe(20_480); // the guest relay's payload cap as built
  for (const entry of mux.positive.filter(item => item.class === "bootstrap" || item.class === "control")) expect(Buffer.from(entry.hex, "hex").subarray(16).every(byte => byte >= 0x20 && byte <= 0x7e)).toBe(true);
  expect(mux.negative.map(entry => entry.name)).toEqual(expect.arrayContaining(["conversations-over-the-message-cap", "conversations-non-ascii-model", "conversations-provider-over-4k", "conversations-two-host-query-conversations"]));
});
test("every conversation negative is covered by a vector, and the set rules are each exercised", () => {
  const names = mux.negative.map(entry => entry.name).filter(name => name.startsWith("conversations-"));
  expect(names.length).toBeGreaterThanOrEqual(55);
  for (const rule of ["empty-list", "seventeen-items", "duplicate-logical-session", "duplicate-backend-session", "uid-reused-across-items", "gid-equals-a-runtime-uid", "root-dotdot", "root-views-nested", "host-query-sees-the-winter-tree", "host-query-plan-writable",
    "provider-credential-key", "provider-scope-other-session", "provider-model-differs", "boot-ids-differ-across-items", "guided-profile-without-binding", "tool-classes-unordered"])
    expect(names.some(name => name.includes(rule))).toBe(true);
});
test("the new bootstrap faults, the guest fault and the new worker states are appended, never renumbered", () => {
  expect([...COWORK_NATIVE_WORKER_STATUS]).toEqual(["sandboxed", "volumes_accepted", "vm_running", "guest_hello", "draining", "drain_acked", "guest_halted", "exiting", "halting", "guest_fault"]);
  expect([...COWORK_NATIVE_BOOTSTRAP_FAULTS]).toEqual(["bad_plan", "probe_failed", "format_failed", "replay_failed", "mount_failed", "internal", "bad_conversations", "supervisor_failed", "second_conversations",
    "share_inventory", "share_mount_failed", "resume_store_missing", "fresh_store_not_empty"]);
  expect([...COWORK_NATIVE_REFUSAL_CODES].at(-1)).toBe("shares_rejected");
  expect([...COWORK_NATIVE_ENVELOPE_KINDS]).toEqual(["scope", "volumes", "drain", "status", "fault", "shares", "share_revoke", "share_event"]);
  expect([...COWORK_NATIVE_RUNTIME_STREAMS]).toEqual(["in", "out", "err", "file_in", "file_out"]);
  expect([...COWORK_NATIVE_WORKER_STATES]).toEqual(["sandboxed", "volumes_accepted", "vm_running", "guest_hello", "draining", "drain_acked", "exited", "halting", "guest_fault"]);
  expect([...COWORK_NATIVE_GUEST_FAULTS]).toEqual(["unmount_failed", "supervisor_lost", "protocol_violation", "internal"]);
  for (const [name, state] of [["status-halting", 9], ["status-guest-fault", 10]] as const) expect(Buffer.from(envelopes.positive.find(entry => entry.name === name)!.hex, "hex").readUInt32LE(16)).toBe(state);
});
test("the control-up fault carries a closed code and the drain it belongs to, or null", () => {
  const inDrain = parseCoworkNativeMuxFrame(conversationVector("control-up-fault-during-drain"), "up"), outside = parseCoworkNativeMuxFrame(conversationVector("control-up-fault-outside-drain"), "up");
  expect(inDrain).toMatchObject({ class: "control", message: { t: "fault", code: "unmount_failed", stopNonce: "0f".repeat(16) } });
  expect(outside).toMatchObject({ class: "control", message: { t: "fault", code: "supervisor_lost", stopNonce: null } });
  expect(code(() => parseCoworkNativeMuxFrame(conversationVector("control-up-fault-during-drain"), "down"))).toBe("unknown_type"); // it only travels up
});

const GOOD_COUNTERS: CoworkNativeLibkrunFlushCounters = [{ requested: 3, completed: 3, finalSyncAttempted: 1, finalSyncCompleted: 1 }, { requested: 1, completed: 1, finalSyncAttempted: 1, finalSyncCompleted: 1 }];
interface StopVectors { exitReasons: Record<string, number>; cases: { name: string; states: CoworkNativeWorkerStatusState[]; exitReason: CoworkNativeLibkrunExitReason | null; counters: CoworkNativeLibkrunFlushCounters | null; verdict: ReturnType<typeof coworkNativeGuestStopVerdict> }[] }
const stops = vector<StopVectors>("guest-stop.json");
test("the guest stop verdict matches every vector, and only the full ordered sequence with reason off is orderly", () => {
  expect(stops.cases.length).toBeGreaterThanOrEqual(29);
  for (const entry of stops.cases) expect(`${entry.name}:${JSON.stringify(coworkNativeGuestStopVerdict({ states: entry.states, exitReason: entry.exitReason, counters: entry.counters }))}`).toBe(`${entry.name}:${JSON.stringify(entry.verdict)}`);
  expect(stops.cases.filter(entry => entry.verdict.guest === "orderly").map(entry => entry.name)).toEqual(["orderly"]);
  expect({ ...stops.exitReasons }).toEqual({ ...COWORK_LIBKRUN_EXIT_REASONS });
});
test("a power-off with no `halting` is uncertain whatever else the guest said, and never reaches a Class A", () => {
  const bare = stops.cases.find(entry => entry.name === "bare-power-off-without-halting")!;
  expect(bare.states).toContain("drain_acked");
  expect(bare.states).toContain("guest_halted");
  expect(bare.states).not.toContain("halting");
  expect(coworkNativeGuestStopVerdict({ states: bare.states, exitReason: "off", counters: GOOD_COUNTERS })).toEqual({ guest: "uncertain", reason: "guest-fault" });
  // The receipt form of the same rule: acked + powered off without `halting` parses and is not orderly evidence.
  expect(receipts.parsesButNotOrderly.map(entry => entry.name)).toEqual(expect.arrayContaining(["acked-and-powered-off-but-never-halting", "halting-and-powered-off-without-drain-ack"]));
});
test("a guest fault at any point, even before an otherwise perfect sequence, makes the stop uncertain", () => {
  const states = ["vm_running", "guest_hello", "draining", "drain_acked", "halting", "guest_halted", "exiting"] as CoworkNativeWorkerStatusState[];
  for (let at = 0; at <= states.length; at++) expect(coworkNativeGuestStopVerdict({ states: [...states.slice(0, at), "guest_fault", ...states.slice(at)], exitReason: "off", counters: GOOD_COUNTERS })).toEqual({ guest: "uncertain", reason: "guest-fault" });
  expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters: GOOD_COUNTERS })).toEqual({ guest: "orderly" });
});
test("the stop timeline is layered: the exit watchdog fires before the launcher kills, and the daemon waits longer than both", () => {
  const limits = COWORK_NATIVE_LIMITS;
  expect(limits.libkrunExitWatchdogMs).toBe(20_000); // S4's cowork_exit OBSERVER_BUDGET
  for (const budget of [0, 1_000, limits.drainBudgetMs, limits.drainBudgetCeilingMs]) {
    // The guest may spend all of `budget`; the VMM exit path then needs up to the watchdog; the launcher kills only after the watchdog has fired.
    expect(coworkNativeLauncherKillMs(budget)).toBeGreaterThan(budget + limits.libkrunExitWatchdogMs);
    expect(coworkNativeHostStopWaitMs(budget)).toBeGreaterThan(coworkNativeLauncherKillMs(budget));
  }
  expect(coworkNativeLauncherKillMs(30_000)).toBe(55_000);
  expect(coworkNativeLauncherKillMs(0)).toBe(25_000);
  expect(limits.drainBudgetMs).toBeGreaterThan(limits.libkrunExitWatchdogMs); // the default drain budget stays above S4's exit watchdog
  expect(coworkNativeHostStopWaitMs(30_000)).toBe(65_000);
});

test("a flush that was requested and never completed, a failed or missing final sync, or unread counters make the stop uncertain even with exit reason off", () => {
  const states = stops.cases.find(entry => entry.name === "orderly")!.states;
  const bad = (patch: Partial<CoworkNativeFlushDevice>): CoworkNativeLibkrunFlushCounters => [{ ...GOOD_COUNTERS[0], ...patch }, GOOD_COUNTERS[1]];
  for (const counters of [bad({ completed: 2 }), bad({ finalSyncCompleted: 0 }), bad({ finalSyncAttempted: 0, finalSyncCompleted: 0 }), null]) expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters })).toEqual({ guest: "uncertain", reason: "flush-uncertain" });
  expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters: bad({ finalSyncAttempted: 0 }) })).toEqual({ guest: "uncertain", reason: "flush-uncertain" });
  expect(coworkNativeGuestStopVerdict({ states: states.filter(state => state !== "guest_halted"), exitReason: "off", counters: GOOD_COUNTERS })).toEqual({ guest: "uncertain", reason: "flush-uncertain" });
  expect(stops.cases.filter(entry => entry.verdict.guest === "orderly").length).toBe(1);
});

test("a stop sequence must run vm_running, draining, drain_acked, halting, guest_halted in that order: every misordering is uncertain", () => {
  const names = ["draining-before-vm-running", "guest-halted-before-halting", "drain-acked-before-draining"];
  for (const name of names) {
    const entry = stops.cases.find(item => item.name === name)!;
    expect(entry.verdict.guest).toBe("uncertain");
    expect(coworkNativeGuestStopVerdict({ states: entry.states, exitReason: "off", counters: entry.counters })).toEqual(entry.verdict);
  }
  // Every permutation of the five states with the right set but a wrong order is refused; only the one true order is orderly.
  const five: CoworkNativeWorkerStatusState[] = ["vm_running", "draining", "drain_acked", "halting", "guest_halted"];
  const permutations = (items: CoworkNativeWorkerStatusState[]): CoworkNativeWorkerStatusState[][] => items.length < 2 ? [items] : items.flatMap((item, at) => permutations([...items.slice(0, at), ...items.slice(at + 1)]).map(rest => [item, ...rest]));
  for (const states of permutations(five)) expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters: GOOD_COUNTERS }).guest).toBe(states.join() === five.join() ? "orderly" : "uncertain");
});
test("a counter array that is not exactly two disks, or a completed count that differs from requested in either direction, is never orderly", () => {
  const states = stops.cases.find(entry => entry.name === "orderly")!.states;
  for (const counters of [[], [GOOD_COUNTERS[0]], [...GOOD_COUNTERS, GOOD_COUNTERS[0]]]) expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters: counters as never })).toEqual({ guest: "uncertain", reason: "flush-uncertain" });
  for (const completed of [2, 4]) expect(coworkNativeGuestStopVerdict({ states, exitReason: "off", counters: [{ ...GOOD_COUNTERS[0], completed }, GOOD_COUNTERS[1]] })).toEqual({ guest: "uncertain", reason: "flush-uncertain" });
});
test("the vectors carry one positive for every L2 status, every L2 fault, every bootstrap and guest fault and every L1 worker_state: a misnumbering anywhere fails a drift test", () => {
  const states = new Set<string>(), faults = new Set<string>();
  for (const entry of envelopes.positive) {
    const parsed = parseCoworkNativeEnvelope(bytes(entry.hex), entry.rights, entry.direction);
    if (parsed.kind === "status") states.add(parsed.state); else if (parsed.kind === "fault") faults.add(parsed.code);
    if (parsed.kind === "status") expect(Buffer.from(entry.hex, "hex").readUInt32LE(16)).toBe(COWORK_NATIVE_WORKER_STATUS.indexOf(parsed.state) + 1); // the numeric code on the wire
    if (parsed.kind === "fault") expect(Buffer.from(entry.hex, "hex").readUInt32LE(16)).toBe(COWORK_NATIVE_WORKER_FAULTS.indexOf(parsed.code) + 1);
  }
  expect([...states].sort()).toEqual([...COWORK_NATIVE_WORKER_STATUS].sort());
  expect([...faults].sort()).toEqual([...COWORK_NATIVE_WORKER_FAULTS].sort());
  expect(COWORK_NATIVE_WORKER_STATUS.length).toBe(10); expect(COWORK_NATIVE_WORKER_FAULTS.length).toBe(8);
  const bootstrap = new Set<string>(), control = new Set<string>();
  for (const entry of mux.positive) {
    const frame = parseCoworkNativeMuxFrame(Buffer.from(entry.hex, "hex"), entry.direction as never);
    if (frame.class === "bootstrap" && frame.message.t === "fault") bootstrap.add(frame.message.code);
    if (frame.class === "control" && frame.message.t === "fault") control.add(frame.message.code);
  }
  expect([...bootstrap].sort()).toEqual([...COWORK_NATIVE_BOOTSTRAP_FAULTS].sort());
  expect([...control].sort()).toEqual([...COWORK_NATIVE_GUEST_FAULTS].sort());
  const workerStates = new Set<string>();
  for (const entry of lines.positive) { const parsed = parseCoworkNativeLauncherLine(entry.line, entry.direction as never, entry.rights); if (parsed.t === "worker_state") workerStates.add(parsed.state); }
  expect([...workerStates].sort()).toEqual([...COWORK_NATIVE_WORKER_STATES].sort());
});
interface OrderVectors { cases: { name: string; events: { dir: "down" | "up"; t: string }[]; result: ReturnType<typeof coworkNativeBootstrapOrder> }[] }
const orders = vector<OrderVectors>("bootstrap-order.json");
test("bootstrap order: conversations only after mounted, a second set is second_conversations, runtime_ready only after a set (the stateless parser leaves 'once' to the two ends)", () => {
  for (const entry of orders.cases) expect(`${entry.name}:${JSON.stringify(coworkNativeBootstrapOrder(entry.events))}`).toBe(`${entry.name}:${JSON.stringify(entry.result)}`);
  const byName = (name: string) => orders.cases.find(entry => entry.name === name)!.result;
  expect(byName("full-sequence")).toEqual({ ok: true });
  expect(byName("conversations-before-mounted")).toMatchObject({ ok: false, reason: "out_of_order" });
  expect(byName("second-conversation-set")).toMatchObject({ ok: false, reason: "second_conversations" });
  expect(byName("runtime-ready-without-a-set")).toMatchObject({ ok: false, reason: "out_of_order" });
  expect(byName("duplicate-runtime-ready")).toMatchObject({ ok: false, reason: "duplicate_runtime_ready" });
  // The parser alone cannot see a second set: each copy is a valid frame.
  const set = Buffer.from(mux.positive.find(entry => entry.name === "bootstrap-down-conversations-guided")!.hex, "hex");
  expect(parseCoworkNativeMuxFrame(set, "down").class).toBe("bootstrap");
});

interface FlowVectors { limitBytes: number; cases: { name: string; steps: { stream: "in" | "out" | "err"; bytes: number; end?: boolean }[]; refusedAt: number | null }[] }
const flows = vector<FlowVectors>("runtime-flow.json");
test("runtime IN flow control: at most 1 MiB of IN bytes in flight with no OUT or ERR byte since; the guest's 4 MiB ring is never approached", () => {
  expect(flows.limitBytes).toBe(COWORK_NATIVE_LIMITS.runtimeInFlightBytes);
  expect(COWORK_NATIVE_LIMITS.runtimeInFlightBytes).toBeLessThan(4 * 1024 * 1024 / 2);
  for (const entry of flows.cases) {
    const streams = new CoworkNativeRuntimeStreams(1);
    let refusedAt: number | null = null;
    for (const [index, step] of entry.steps.entries()) {
      const failed = code(() => streams.accept({ class: "runtime", seq: index + 1, conversation: 0, stream: step.stream, end: step.end === true, payload: new Uint8Array(step.bytes) }));
      if (failed !== "accepted" && refusedAt === null) { expect(failed).toBe("oversize"); refusedAt = index; break; }
    }
    expect(`${entry.name}:${refusedAt}`).toBe(`${entry.name}:${entry.refusedAt}`);
  }
  expect(flows.cases.some(entry => entry.refusedAt !== null) && flows.cases.some(entry => entry.refusedAt === null)).toBe(true);
});
test("a conversation's uids and gid stay below nobody (65534) and 65535, and the shared gid is no member's uid", () => {
  const names = mux.negative.map(entry => entry.name);
  expect(names).toEqual(expect.arrayContaining(["conversations-uid-nobody-65534", "conversations-uid-65535", "conversations-gid-nobody", "conversations-gid-equals-a-tool-uid"]));
});

// ---------------------------------------------------------------- contract revision 3: shares, cold resume, the file channel
import { COWORK_GUEST_FILE_LIMITS } from "../../../src/cowork/guest-file-channel";
interface ArgvVectors { positive: { name: string; argv: string[] }[]; negative: { name: string; argv: string[] }[] }
interface FileFlowVectors { fileRequestBytes: number; fileResponseBytes: number; fileInFlightRequests: number; fileCases: { name: string; steps: { stream: "in" | "out" | "err" | "file_in" | "file_out"; bytes: number; newlines?: number }[]; refusedAt: number | null; error: string | null }[] }
const argvVectors = (vector<{ workerArgv: ArgvVectors }>("envelopes.json")).workerArgv;
const fileFlows = vector<FileFlowVectors>("runtime-flow.json");
test("the file channel's bounds are the channel's own literals, and FILE_IN has its own count", () => {
  expect<number>(COWORK_NATIVE_LIMITS.fileRequestBytes).toBe(COWORK_GUEST_FILE_LIMITS.requestFrameBytes);
  expect<number>(COWORK_NATIVE_LIMITS.fileResponseBytes).toBe(COWORK_GUEST_FILE_LIMITS.responseFrameBytes);
  expect([fileFlows.fileRequestBytes, fileFlows.fileResponseBytes, fileFlows.fileInFlightRequests]).toEqual([COWORK_NATIVE_LIMITS.fileRequestBytes, COWORK_NATIVE_LIMITS.fileResponseBytes, COWORK_NATIVE_LIMITS.fileInFlightRequests]);
  // The guest relay gives FILE_IN its own 256 KiB ring: four times the most the host may have outstanding, the same safety factor as the runtime ring.
  expect(4 * COWORK_NATIVE_LIMITS.fileInFlightRequests * COWORK_NATIVE_LIMITS.fileRequestBytes).toBe(256 * 1024);
  expect(COWORK_NATIVE_FILE_CHANNEL_CAPABILITY).toBe("file-channel-v1");
});
test("file channel flow: four outstanding requests, lines bounded, a response answers one, and neither file stream touches the runtime IN count", () => {
  for (const entry of fileFlows.fileCases) {
    const streams = new CoworkNativeRuntimeStreams(1);
    let refusedAt: number | null = null, error: string | null = null;
    for (const [index, step] of entry.steps.entries()) {
      const data = new Uint8Array(step.bytes).fill(0x61);
      for (let i = 0; i < (step.newlines ?? 0); i++) data[step.bytes - 1 - i] = 0x0a;
      const failed = code(() => streams.accept({ class: "runtime", seq: index + 1, conversation: 0, stream: step.stream, end: false, payload: data }));
      if (failed !== "accepted") { refusedAt = index; error = failed; break; }
    }
    expect(`${entry.name}:${refusedAt}:${error}`).toBe(`${entry.name}:${entry.refusedAt}:${entry.error}`);
  }
  expect(fileFlows.fileCases.length).toBeGreaterThanOrEqual(15);
});
test("a refused file frame changes nothing: the next legal frame is judged against the state before it", () => {
  const streams = new CoworkNativeRuntimeStreams(1), line = (n: number) => { const b = new Uint8Array(n).fill(0x61); b[n - 1] = 0x0a; return b; };
  const send = (stream: "file_in" | "file_out", payload: Uint8Array) => code(() => streams.accept({ class: "runtime", seq: 1, conversation: 0, stream, end: false, payload }));
  for (let i = 0; i < 3; i++) expect(send("file_in", line(10))).toBe("accepted");
  const two = new Uint8Array(20).fill(0x61); two[9] = 0x0a; two[19] = 0x0a;
  expect(send("file_in", two)).toBe("oversize"); // the fifth request is in the same frame: all of it is refused
  expect(streams.fileRequestBudget).toBe(1);
  expect(send("file_in", line(10))).toBe("accepted");
  expect(send("file_out", line(10))).toBe("accepted");
  expect(streams.fileRequestBudget).toBe(1);
});
test("the file streams travel only on conversation 0 and only their own way; stream 4 travelling up is a direction error", () => {
  const frame = (conversation: number, stream: number) => { const b = Buffer.alloc(16 + 6); b.write("WMX1", 0, "latin1"); b[4] = 1; b[5] = 2; b.writeUInt32LE(1, 8); b.writeUInt32LE(6, 12); b[16] = conversation; b[17] = stream; b[20] = 0x61; b[21] = 0x0a; return Uint8Array.from(b); };
  expect(code(() => parseCoworkNativeMuxFrame(frame(0, 4), "down"))).toBe("accepted");
  expect(code(() => parseCoworkNativeMuxFrame(frame(0, 5), "up"))).toBe("accepted");
  expect(code(() => parseCoworkNativeMuxFrame(frame(0, 4), "up"))).toBe("bad_direction");
  expect(code(() => parseCoworkNativeMuxFrame(frame(0, 5), "down"))).toBe("bad_direction");
  for (const conversation of [1, 15]) for (const [stream, dir] of [[4, "down"], [5, "up"]] as const) expect(code(() => parseCoworkNativeMuxFrame(frame(conversation, stream), dir))).toBe("bad_field");
  expect(code(() => parseCoworkNativeMuxFrame(frame(0, 6), "up"))).toBe("bad_field");
  expect(mux.negative.find(entry => entry.name === "runtime-stream-four")!.error).toBe("bad_direction");
});
test("bootstrap JSON is version 2 and control JSON stays version 1; a payload one revision behind or ahead is told `version`", () => {
  for (const entry of mux.positive.filter(item => item.class === "bootstrap")) expect(Buffer.from(entry.hex, "hex").subarray(16, 23).toString("latin1")).toBe('{"v":2,');
  for (const entry of mux.positive.filter(item => item.class === "control")) expect(Buffer.from(entry.hex, "hex").subarray(16, 23).toString("latin1")).toBe('{"v":1,');
  for (const name of ["bootstrap-version-one", "bootstrap-version-three"]) expect(mux.negative.find(entry => entry.name === name)!.error).toBe("version");
});
test("shares: the guest message and the L1 line follow one rule set (kinds, mounts, modes, tags), and every Winter share has its fixed mount", () => {
  const message = parseCoworkNativeMuxFrame(bytes(mux.positive.find(entry => entry.name === "bootstrap-down-shares")!.hex), "down");
  expect(message.class === "bootstrap" && message.message.t === "shares" && message.message.shares.map(share => share.kind)).toEqual(["folder", "folder", "guidance", "memory", "outputs"]);
  if (message.class === "bootstrap" && message.message.t === "shares") for (const share of message.message.shares) if (share.kind !== "folder") expect(share.guestPath).toBe(COWORK_NATIVE_SHARE_MOUNTS[share.kind]);
  const line = parseCoworkNativeLauncherLine(lines.positive.find(entry => entry.name === "shares-two-records")!.line, "to-launcher", 2);
  expect(line.t === "shares" && line.shares.map(share => [share.kind, share.mode])).toEqual([["folder", "rw"], ["guidance", "ro"]]);
  for (const rule of ["shares-nested-paths", "shares-equal-paths", "shares-same-identity", "shares-guidance-read-write", "shares-wrong-rights"]) expect(lines.negative.some(entry => entry.name === rule)).toBe(true);
  for (const rule of ["shares-thirteen", "shares-ten-folders", "shares-two-memory", "shares-guidance-writable", "shares-memory-read-only", "shares-folder-nested-mount", "shares-duplicate-tag"]) expect(mux.negative.some(entry => entry.name === rule)).toBe(true);
});
test("the SHARES envelope carries one descriptor per share, fixed 308 byte slots, and the ABI flag bits; share events number their notice kinds from 1", () => {
  const entry = envelopes.positive.find(item => item.name === "shares-two")!, parsed = parseCoworkNativeEnvelope(bytes(entry.hex), 2, "to-worker");
  expect(parsed.kind === "shares" && parsed.shares.map(share => [share.tag, share.readOnly, share.winterShare])).toEqual([["src-0", false, false], ["winter-guidance", true, true]]);
  expect(Buffer.from(entry.hex, "hex").readUInt32LE(16 + 8 + 48)).toBe(4); // folder rules
  expect(Buffer.from(entry.hex, "hex").readUInt32LE(16 + 8 + 308 + 48)).toBe(1 | 2); // read-only Winter share
  const notices = envelopes.positive.filter(item => item.kind === "share_event" && item.name.startsWith("share-event-notice-"));
  expect(notices.map(item => Buffer.from(item.hex, "hex").readUInt32LE(16 + 36))).toEqual(COWORK_NATIVE_SHARE_NOTICE_KINDS.map((_, index) => index + 1));
  for (const rights of [0, 1, 3]) expect(code(() => parseCoworkNativeEnvelope(bytes(entry.hex), rights, "to-worker"))).toBe("bad_rights");
});
test("worker argv: [path] without shares, otherwise the --shares-v1 form, strict and round-tripping", () => {
  expect(COWORK_NATIVE_WORKER_SHARES_FLAG).toBe("--shares-v1");
  for (const entry of argvVectors.positive) expect(serializeCoworkNativeWorkerArgv(parseCoworkNativeWorkerArgv(entry.argv))).toEqual(entry.argv);
  for (const entry of argvVectors.negative) expect(`${entry.name}:${code(() => parseCoworkNativeWorkerArgv(entry.argv))}`).not.toBe(`${entry.name}:accepted`);
  expect(argvVectors.negative.length).toBeGreaterThanOrEqual(15);
});
test("cold resume: continuation and ended boots ride in the runtime, a fresh store has no ended boot, the live boot is never ended, and runtime_ready says which ran", () => {
  const resume = parseCoworkNativeMuxFrame(bytes(mux.positive.find(entry => entry.name === "bootstrap-down-conversations-resume")!.hex), "down");
  expect(resume.class === "bootstrap" && resume.message.t === "conversations" && resume.message.conversations[0]!.runtime).toMatchObject({ continuation: "resume", endedGuestBoots: expect.any(Array) });
  const ready = parseCoworkNativeMuxFrame(bytes(mux.positive.find(entry => entry.name === "bootstrap-up-runtime-ready-resumed")!.hex), "up");
  expect(ready.class === "bootstrap" && ready.message.t === "runtime_ready" && ready.message.continuations).toEqual(["resume"]);
  for (const rule of ["conversations-fresh-with-ended-boots", "conversations-ended-boots-include-the-live-boot", "conversations-ended-boots-repeated", "conversations-ended-boots-five", "conversations-continuation-unknown", "conversations-timeout-over-a-day", "runtime-ready-continuations-longer-than-the-set", "runtime-ready-continuation-either"])
    expect(mux.negative.some(entry => entry.name === rule)).toBe(true);
  expect<number>(COWORK_NATIVE_LIMITS.runtimeTimeoutCeilingMs).toBe(24 * 60 * 60 * 1000);
});
test("the browse uid is one per workspace, distinct from every runtime uid, tool uid and group, inside the unix id range", () => {
  const set = parseCoworkNativeMuxFrame(bytes(mux.positive.find(entry => entry.name === "bootstrap-down-conversations-browse-uid")!.hex), "down");
  expect(set.class === "bootstrap" && set.message.t === "conversations" && set.message.browseUid).toBe(21000);
  for (const rule of ["browse-uid-equals-runtime-uid", "browse-uid-equals-tool-uid", "browse-uid-equals-gid", "browse-uid-nobody", "browse-uid-missing"]) expect(mux.negative.some(entry => entry.name === `conversations-${rule}`)).toBe(true);
});
test("bootstrap order with shares: shares only after mounted and before the set, the set only after shares_mounted", () => {
  const byName = (name: string) => orders.cases.find(entry => entry.name === name)!.result;
  expect(byName("full-sequence-with-shares")).toEqual({ ok: true });
  for (const name of ["conversations-before-shares-mounted", "shares-after-conversations", "shares-before-mounted", "shares-mounted-without-shares", "shares-twice"]) expect(byName(name)).toMatchObject({ ok: false, reason: "out_of_order" });
});
