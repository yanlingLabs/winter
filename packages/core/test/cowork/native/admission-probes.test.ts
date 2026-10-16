import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdmissionError, type AdmissionOwner, type AdmissionProbes, type HostIdentity, type ResourceObservation, type StopReceipt } from "../../../src/cowork/admission";
import {
  COORDINATION_DIR_ENV, COORDINATION_LEDGER_FILE, IOREG_ARGS, IOREG_PATH, PROC_BSDINFO_BYTES, coordinationLedgerPath, createCoworkAdmissionProbes, createProcessTable, createProductionHostAdapters,
  createSysctlReader, decodeSysctlString, parseIoPlatformUuid, parseProcBsdInfo, readBootId, readMachineId,
  type AdmissionProbeDeps, type HostCommandResult, type HostCommandRunner, type ProcessInspection, type ProcessTable, type SysctlLibrary, type SysctlReader,
} from "../../../src/cowork/native/admission-probes";
import { hostStorageFenceOptions } from "../../../src/runtime-sdk/host-storage-fence";
import { ledgerFixture } from "./pressure-ledger-fixture";

const MACHINE = "1878E96D-9994-5823-BE36-CA569B31B110", BOOT = "D517461A-E715-4E03-98A8-F21A88728F65", BOOT2 = "0AF2C6A4-3C3B-4D0F-A1B1-5C8B2F1A9E77", INSTALL = "installation-fixture";
const real = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const ioreg = (uuid: string, extra = "") => `+-o Root  <class IORegistryEntry, id 0x100000100, retain 28>\n  +-o J316sAP  <class IOPlatformExpertDevice, id 0x10000020d, registered, matched, active, busy 0 (1 ms), retain 35>\n    {\n      "IOPlatformSerialNumber" = "ABC123"\n      "IOPlatformUUID" = "${uuid}"\n${extra}      "manufacturer" = <"Apple Inc.">\n    }\n\n`;
const ok = (stdout: string): HostCommandResult => ({ status: 0, stdout });

// ---------------------------------------------------------------- machine identity
test("IOPlatformUUID: exactly one well-formed line is accepted, in either hex case, among surrounding output", () => {
  expect(parseIoPlatformUuid(ioreg(MACHINE))).toBe(MACHINE);
  expect(parseIoPlatformUuid(ioreg(MACHINE.toLowerCase()))).toBe(MACHINE.toLowerCase());
  expect(parseIoPlatformUuid(ioreg(MACHINE).replace(/\n/g, "\r\n"))).toBe(MACHINE);
});
test("IOPlatformUUID parse errors fail closed: none, two, malformed, nil, extra tokens, oversize", () => {
  const cases: Array<[string, string]> = [
    ["empty", ""], ["no key", '    "IOPlatformSerialNumber" = "ABC"\n'],
    ["two identical matches", ioreg(MACHINE, `      "IOPlatformUUID" = "${MACHINE}"\n`)],
    ["two different matches", ioreg(MACHINE, `      "IOPlatformUUID" = "${BOOT}"\n`)],
    ["the key quoted inside another value", ioreg(MACHINE, '      "other" = "IOPlatformUUID"\n')],
    ["not a UUID", ioreg("not-a-uuid")], ["too short", ioreg(MACHINE.slice(0, 35))], ["too long", ioreg(`${MACHINE}0`)],
    ["non-hex", ioreg(MACHINE.replace("1878", "ZZZZ"))], ["nil UUID", ioreg("00000000-0000-0000-0000-000000000000")],
    ["empty value", ioreg("")], ["whitespace inside the quotes", ioreg(` ${MACHINE}`)],
    ["trailing tokens after the value", ioreg(MACHINE).replace(`"${MACHINE}"`, `"${MACHINE}" extra`)],
    ["unquoted", ioreg(MACHINE).replace(`"${MACHINE}"`, MACHINE)],
    ["oversize output", `${ioreg(MACHINE)}${"x".repeat(256 * 1024)}`],
  ];
  for (const [name, text] of cases) expect({ name, parsed: parseIoPlatformUuid(text) }).toEqual({ name, parsed: null });
  expect(parseIoPlatformUuid(undefined as unknown as string)).toBeNull();
});
test("readMachineId runs only the fixed absolute ioreg query and fails closed on every runner failure", () => {
  const seen: Array<[string, readonly string[]]> = [];
  const run = (result: HostCommandResult | (() => HostCommandResult)): HostCommandRunner => (file, args) => { seen.push([file, args]); return typeof result === "function" ? result() : result; };
  expect(readMachineId(run(ok(ioreg(MACHINE))))).toBe(MACHINE);
  expect(seen).toEqual([["/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]]]);
  expect(IOREG_PATH).toBe("/usr/sbin/ioreg"); expect([...IOREG_ARGS]).toEqual(["-rd1", "-c", "IOPlatformExpertDevice"]); expect(Object.isFrozen(IOREG_ARGS)).toBe(true);
  for (const failure of [{ status: 1, stdout: ioreg(MACHINE) }, { status: null, stdout: ioreg(MACHINE) }, { status: 0, stdout: ioreg(MACHINE), timedOut: true }, { status: 0, stdout: "" }, () => { throw new Error("spawn"); }, () => undefined as unknown as HostCommandResult])
    expect(readMachineId(run(failure as HostCommandResult))).toBeNull();
});

// ---------------------------------------------------------------- sysctl
const stringBytes = (text: string, nul = true) => Uint8Array.from([...Buffer.from(text, "latin1"), ...(nul ? [0] : [])]);
test("a sysctl string needs exactly one trailing NUL and printable text", () => {
  expect(decodeSysctlString(stringBytes(BOOT))).toBe(BOOT);
  for (const bad of [null, new Uint8Array(), stringBytes("", true), stringBytes(BOOT, false), Uint8Array.from([0x41, 0, 0x42, 0]), Uint8Array.from([0x41, 0x01, 0]), Uint8Array.from([0xe9, 0])]) expect(decodeSysctlString(bad)).toBeNull();
});
test("the sysctl reader bounds the capacity, the width and the name, and swallows library failures", () => {
  const asked: Array<[string, number]> = [];
  let answer: Uint8Array | null = null;
  const library: SysctlLibrary = { query: (name, capacity) => { asked.push([name, capacity]); return answer; } };
  const reader = createSysctlReader(library);
  answer = stringBytes(BOOT); expect(reader.string("kern.bootsessionuuid")).toBe(BOOT); expect(asked.at(-1)).toEqual(["kern.bootsessionuuid", 128]);
  answer = Uint8Array.from([1, 0, 0, 0]); expect(reader.int32("hw.ncpu")).toBe(1); expect(asked.at(-1)).toEqual(["hw.ncpu", 4]);
  answer = Uint8Array.from([0xfe, 0xff, 0xff, 0xff]); expect(reader.int32("hw.ncpu")).toBe(-2);
  answer = Uint8Array.from([1, 0, 0]); expect(reader.int32("hw.ncpu")).toBeNull();            // short
  answer = Uint8Array.from([1, 0, 0, 0, 0]); expect(reader.int32("hw.ncpu")).toBeNull();       // longer than the capacity it asked for
  answer = Uint8Array.from([0, 0, 0, 0, 0, 0, 0x40, 0]); expect(reader.uint64("hw.memsize")).toBe(0x0040_0000_0000_0000n);
  answer = Uint8Array.from([1, 0, 0, 0]); expect(reader.uint64("hw.memsize")).toBeNull();     // wrong width
  answer = null; expect(reader.string("kern.bootsessionuuid")).toBeNull();
  const before = asked.length;
  for (const name of ["", "KERN.BOOT", "kern.boot;ls", "../x", "kern.boot\0x", "a".repeat(65)]) { answer = stringBytes("x"); expect(reader.string(name)).toBeNull(); }
  expect(asked.length).toBe(before); // a malformed name never reaches the library
  const throwing = createSysctlReader({ query: () => { throw new Error("boom"); } });
  expect(throwing.string("kern.bootsessionuuid")).toBeNull(); expect(throwing.int32("hw.ncpu")).toBeNull(); expect(throwing.uint64("hw.memsize")).toBeNull();
});
test("kern.bootsessionuuid must be a well-formed non-nil UUID", () => {
  const sysctl = (value: string | null | "throw"): SysctlReader => ({ string: () => { if (value === "throw") throw new Error("x"); return value; }, int32: () => null, uint64: () => null });
  expect(readBootId(sysctl(BOOT))).toBe(BOOT);
  for (const bad of [null, "throw", "", "boot-one", BOOT.slice(1), `${BOOT} `, "00000000-0000-0000-0000-000000000000"] as const) expect(readBootId(sysctl(bad))).toBeNull();
});

// ---------------------------------------------------------------- process identity
function bsdInfo(over: { pid?: number; status?: number; seconds?: bigint; micros?: bigint } = {}): Buffer {
  const b = Buffer.alloc(PROC_BSDINFO_BYTES);
  b.writeUInt32LE(over.status ?? 2, 4); b.writeUInt32LE(over.pid ?? 4242, 12);
  b.writeBigUInt64LE(over.seconds ?? 1792190531n, 120); b.writeBigUInt64LE(over.micros ?? 17254n, 128);
  return b;
}
test("proc_bsdinfo is read at its pinned offsets and every inconsistency is 'unknown'", () => {
  expect(PROC_BSDINFO_BYTES).toBe(136);
  expect(parseProcBsdInfo(bsdInfo(), 136, 4242)).toEqual({ kind: "present", startSeconds: 1792190531, startMicroseconds: 17254, zombie: false });
  expect(parseProcBsdInfo(bsdInfo({ status: 5 }), 136, 4242)).toMatchObject({ kind: "present", zombie: true });
  const unknown: ProcessInspection = { kind: "unknown" };
  expect(parseProcBsdInfo(bsdInfo(), 135, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo(), 137, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo(), 0, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo().subarray(0, 100), 136, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo({ pid: 4243 }), 136, 4242)).toEqual(unknown);                 // a record for another pid
  expect(parseProcBsdInfo(bsdInfo({ seconds: 0n }), 136, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo({ micros: 1_000_000n }), 136, 4242)).toEqual(unknown);
  expect(parseProcBsdInfo(bsdInfo({ seconds: BigInt(Number.MAX_SAFE_INTEGER) + 1n }), 136, 4242)).toEqual(unknown);
});
test("only ESRCH proves a process absent; every other failure is 'unknown'", () => {
  let result = { returned: 0, errno: 3 };
  const asked: number[] = [];
  const table = createProcessTable({ pidinfo: (pid, out) => { asked.push(pid); if (result.returned === 136) bsdInfo({ pid }).copy(out); return result; } });
  expect(table.inspect(4242)).toEqual({ kind: "absent" });
  for (const errno of [1, 0, 22, 13]) { result = { returned: 0, errno }; expect(table.inspect(4242)).toEqual({ kind: "unknown" }); }
  result = { returned: -1, errno: 3 }; expect(table.inspect(4242)).toEqual({ kind: "absent" });
  result = { returned: 64, errno: 0 }; expect(table.inspect(4242)).toEqual({ kind: "unknown" });
  result = { returned: 136, errno: 0 }; expect(table.inspect(4242)).toMatchObject({ kind: "present", startSeconds: 1792190531 });
  asked.length = 0;
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 31]) expect(table.inspect(pid)).toEqual({ kind: "unknown" });
  expect(asked).toEqual([]);
});

// ---------------------------------------------------------------- the probes over fakes
function world(overrides: Partial<{ boot: string | null; machineOutput: string; installation: string | null | "throw" }> = {}) {
  const state = { boot: overrides.boot === undefined ? BOOT : overrides.boot, machineOutput: overrides.machineOutput ?? ioreg(MACHINE), installation: overrides.installation === undefined ? INSTALL : overrides.installation, runs: 0, stopCalls: 0, relocationCalls: 0 };
  const processes = new Map<number, ProcessInspection>();
  const deps: AdmissionProbeDeps = {
    runCommand: () => { state.runs++; return ok(state.machineOutput); },
    sysctl: { string: name => name === "kern.bootsessionuuid" && state.boot !== null ? `${state.boot}` : null, int32: () => null, uint64: () => null },
    processes: { inspect: pid => processes.get(pid) ?? { kind: "absent" } } satisfies ProcessTable,
    installationId: () => { if (state.installation === "throw") throw new Error("x"); return state.installation; },
    homeIdentity: () => null,
    verifyStopReceipt: () => { state.stopCalls++; return false; },
  };
  return { state, processes, deps, probes: createCoworkAdmissionProbes(deps) };
}
test("construction requires every injected port; relocation is optional and, absent, denies", () => {
  const { deps } = world();
  for (const name of ["runCommand", "installationId", "homeIdentity", "verifyStopReceipt"] as const) expect(() => createCoworkAdmissionProbes({ ...deps, [name]: undefined } as unknown as AdmissionProbeDeps)).toThrow(TypeError);
  expect(() => createCoworkAdmissionProbes({ ...deps, sysctl: undefined } as unknown as AdmissionProbeDeps)).toThrow(TypeError);
  expect(() => createCoworkAdmissionProbes({ ...deps, processes: {} } as unknown as AdmissionProbeDeps)).toThrow(TypeError);
  expect(() => createCoworkAdmissionProbes({ ...deps, authorizeRelocation: "yes" } as unknown as AdmissionProbeDeps)).toThrow(TypeError);
  expect(() => createCoworkAdmissionProbes(undefined as never)).toThrow(TypeError);
  const authorization = { kind: "local-authorized-relocation", authorizationId: "a" } as const, anyHome = {} as never;
  expect(createCoworkAdmissionProbes(deps).authorizeRelocation(authorization, anyHome, anyHome)).toBe(false);
});
test("hostIdentity combines IOPlatformUUID, the injected installation id and the live boot session id", () => {
  const w = world();
  expect(w.probes.hostIdentity()).toEqual({ machineId: MACHINE, installationId: INSTALL, bootId: BOOT });
  w.state.boot = BOOT2; expect(w.probes.hostIdentity()!.bootId).toBe(BOOT2); // the boot id is read every time
  expect(w.state.runs).toBe(1);                                              // the machine id is cached after the first good answer
});
test("hostIdentity fails closed when any fact is missing or malformed, and retries a failed ioreg", () => {
  expect(world({ boot: null }).probes.hostIdentity()).toBeNull();
  expect(world({ boot: "boot-one" }).probes.hostIdentity()).toBeNull();
  expect(world({ installation: null }).probes.hostIdentity()).toBeNull();
  expect(world({ installation: "throw" }).probes.hostIdentity()).toBeNull();
  for (const bad of ["", "-lead", "has space", "x".repeat(201), "a/b"]) expect(world({ installation: bad }).probes.hostIdentity()).toBeNull();
  expect(world({ machineOutput: "" }).probes.hostIdentity()).toBeNull();
  const w = world({ machineOutput: "garbage" });
  expect(w.probes.hostIdentity()).toBeNull(); expect(w.probes.hostIdentity()).toBeNull(); expect(w.state.runs).toBe(2); // nothing cached from a failure
  w.state.machineOutput = ioreg(MACHINE); expect(w.probes.hostIdentity()).not.toBeNull();
});
test("processIdentity: start-time tokens, dead, unknown, zombie, and no consultation for an invalid pid", () => {
  const w = world();
  w.processes.set(10, { kind: "present", startSeconds: 1792190531, startMicroseconds: 42, zombie: false });
  w.processes.set(11, { kind: "present", startSeconds: 1792190531, startMicroseconds: 17254, zombie: false });
  w.processes.set(12, { kind: "unknown" });
  w.processes.set(13, { kind: "present", startSeconds: 1792190531, startMicroseconds: 1, zombie: true });
  expect(w.probes.processIdentity(10)).toEqual({ state: "alive", startToken: "1792190531.000042", bootId: BOOT });
  expect(w.probes.processIdentity(11)).toEqual({ state: "alive", startToken: "1792190531.017254", bootId: BOOT });
  expect(w.probes.processIdentity(99)).toEqual({ state: "dead" });                // absent: ESRCH
  expect(w.probes.processIdentity(12)).toEqual({ state: "unknown" });
  expect(w.probes.processIdentity(13)).toEqual({ state: "dead" });                // a zombie has terminated
  const token = (w.probes.processIdentity(10) as { startToken: string }).startToken;
  expect(token).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);                   // the ledger's id() shape
  let consulted = 0; const inspect = w.deps.processes.inspect; w.deps.processes.inspect = pid => { consulted++; return inspect(pid); };
  for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 31]) expect(w.probes.processIdentity(pid)).toBeNull();
  expect(consulted).toBe(0);
  w.state.boot = null; expect(w.probes.processIdentity(10)).toBeNull();          // no boot id, no observation
  w.state.boot = BOOT; w.deps.processes.inspect = () => { throw new Error("x"); }; expect(w.probes.processIdentity(10)).toBeNull();
});
test("a changed start time is a different process: a reused pid never reads as the same owner", () => {
  const w = world();
  w.processes.set(10, { kind: "present", startSeconds: 100, startMicroseconds: 5, zombie: false }); const first = w.probes.processIdentity(10);
  w.processes.set(10, { kind: "present", startSeconds: 100, startMicroseconds: 6, zombie: false }); const second = w.probes.processIdentity(10);
  expect(first).not.toEqual(second);
});
test("confirmsPreviousBootEnded needs a different, well-formed boot id AND a `current` that is exactly this live host", () => {
  const w = world(), live = w.probes.hostIdentity()!;
  w.state.boot = BOOT2; const current = w.probes.hostIdentity()!;
  expect(w.probes.confirmsPreviousBootEnded(BOOT, current)).toBe(true);
  // Same boot, in either hex case, is not a new boot.
  expect(w.probes.confirmsPreviousBootEnded(BOOT2, current)).toBe(false);
  expect(w.probes.confirmsPreviousBootEnded(BOOT2.toLowerCase(), current)).toBe(false);
  // A previous id that is not a UUID is never trusted to have "ended".
  for (const previous of ["boot-one", "", "00000000-0000-0000-0000-000000000000", `${BOOT} `]) expect(w.probes.confirmsPreviousBootEnded(previous, current)).toBe(false);
  // A forged `current`: another machine, another installation, or a boot id this host is not actually in.
  const forged = (patch: Partial<HostIdentity>) => w.probes.confirmsPreviousBootEnded(BOOT, { ...current, ...patch });
  expect(forged({ machineId: BOOT })).toBe(false);
  expect(forged({ installationId: "installation-other" })).toBe(false);
  expect(forged({ bootId: "11111111-2222-4333-8444-555555555555" })).toBe(false);
  expect(forged({ bootId: "boot-two" })).toBe(false);
  expect(w.probes.confirmsPreviousBootEnded(BOOT, undefined as never)).toBe(false);
  // The live host cannot be read: no proof.
  w.state.boot = null; expect(w.probes.confirmsPreviousBootEnded(BOOT, current)).toBe(false);
  w.state.boot = BOOT2; w.state.installation = null; expect(w.probes.confirmsPreviousBootEnded(BOOT, current)).toBe(false);
  expect(live.bootId).toBe(BOOT);
});
test("stop evidence is a port: only an exact `true` passes, a throw or anything else refuses, and nothing else calls it", () => {
  const w = world(), receipt = {} as StopReceipt, record = {} as never;
  expect(w.state.stopCalls).toBe(0);
  w.probes.hostIdentity(); w.probes.processIdentity(1); w.probes.confirmsPreviousBootEnded(BOOT, w.probes.hostIdentity()!);
  expect(w.state.stopCalls).toBe(0); // no observation in this file manufactures stop evidence
  for (const answer of [true]) expect(createCoworkAdmissionProbes({ ...w.deps, verifyStopReceipt: () => answer }).verifyStopReceipt(receipt, record)).toBe(true);
  for (const answer of [false, 1, "true", {}, undefined, null]) expect(createCoworkAdmissionProbes({ ...w.deps, verifyStopReceipt: () => answer as never }).verifyStopReceipt(receipt, record)).toBe(false);
  expect(createCoworkAdmissionProbes({ ...w.deps, verifyStopReceipt: () => { throw new Error("x"); } }).verifyStopReceipt(receipt, record)).toBe(false);
});
test("relocation and home identity are delegated; only an exact `true` authorizes and a throw is a refusal", () => {
  const w = world(), authorization = { kind: "local-authorized-relocation", authorizationId: "a" } as const, anyHome = {} as never;
  expect(createCoworkAdmissionProbes({ ...w.deps, authorizeRelocation: () => true }).authorizeRelocation(authorization, anyHome, anyHome)).toBe(true);
  for (const answer of [false, 1, "yes", undefined]) expect(createCoworkAdmissionProbes({ ...w.deps, authorizeRelocation: () => answer as never }).authorizeRelocation(authorization, anyHome, anyHome)).toBe(false);
  expect(createCoworkAdmissionProbes({ ...w.deps, authorizeRelocation: () => { throw new Error("x"); } }).authorizeRelocation(authorization, anyHome, anyHome)).toBe(false);
  const observation = { canonicalPath: "/h" } as never;
  expect(createCoworkAdmissionProbes({ ...w.deps, homeIdentity: () => observation }).homeIdentity("/h")).toBe(observation);
  expect(createCoworkAdmissionProbes({ ...w.deps, homeIdentity: () => { throw new Error("x"); } }).homeIdentity("/h")).toBeNull();
});

// ---------------------------------------------------------------- the Coordination ledger path
test("the ledger path is pure spelling: the default under the home directory, or an absolute override", () => {
  expect(COORDINATION_LEDGER_FILE).toBe("cowork-admission.sqlite"); expect(COORDINATION_DIR_ENV).toBe("WINTER_COWORK_COORDINATION_DIR");
  expect(coordinationLedgerPath({ env: {}, homeDirectory: "/Users/someone" })).toBe("/Users/someone/Library/Application Support/Winter/Coordination/cowork-admission.sqlite");
  expect(coordinationLedgerPath({ env: { [COORDINATION_DIR_ENV]: "/tmp/n2-coordination" }, homeDirectory: "/Users/someone" })).toBe("/tmp/n2-coordination/cowork-admission.sqlite");
});
test("a malformed path or override throws and never falls back to the real per-user path", () => {
  for (const override of ["", "relative/dir", "/tmp/dir/", "/tmp/../tmp/dir", "/tmp/a\0b", "/tmp/a\nb", `/${"x".repeat(4096)}`, "/"])
    expect(() => coordinationLedgerPath({ env: { [COORDINATION_DIR_ENV]: override }, homeDirectory: "/Users/someone" })).toThrow("coordination_path_invalid");
  for (const home of ["", "relative", "/Users/x/", "/a\0b", undefined as never]) expect(() => coordinationLedgerPath({ env: {}, homeDirectory: home })).toThrow("coordination_path_invalid");
  expect(() => coordinationLedgerPath(undefined as never)).toThrow("coordination_path_invalid");
});
test("the ledger path and the host-storage fence spell the Coordination directory identically, and spelling touches no filesystem", () => {
  const previous = process.env[COORDINATION_DIR_ENV];
  cleanups.push(() => { if (previous === undefined) delete process.env[COORDINATION_DIR_ENV]; else process.env[COORDINATION_DIR_ENV] = previous; });
  const fenceFor = () => join(hostStorageFenceOptions("/tmp/n2-home-for-fence-spelling").coordinationDir, COORDINATION_LEDGER_FILE);
  process.env[COORDINATION_DIR_ENV] = "/tmp/n2-pressure-override-that-does-not-exist";
  expect(coordinationLedgerPath({ env: process.env, homeDirectory: homedir() })).toBe(fenceFor());
  expect(existsSync("/tmp/n2-pressure-override-that-does-not-exist")).toBe(false);
  delete process.env[COORDINATION_DIR_ENV];
  expect(coordinationLedgerPath({ env: process.env, homeDirectory: homedir() })).toBe(fenceFor());
});

// ---------------------------------------------------------------- the real ledger over these probes
const observation = (now: number, over: Partial<ResourceObservation> = {}): ResourceObservation => ({ budget: { memoryBytes: 1 << 30, cpuUnits: 8, guestLimit: 4 }, pressure: "normal", admitNew: true, observedAt: now, validUntil: now + 100_000, ...over });
test("a live owner reserves; a dead or reused owner makes the record uncertain, never released; only a different live boot id releases", () => {
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  const w = world(); let now = 1_000_000;
  const home = f.makeHome("home-one", MACHINE, INSTALL), ledger = f.open({ ...w.probes, homeIdentity: f.homeIdentity }, () => observation(now), () => now);
  ledger.registerHome(home, home.canonicalPath);
  w.processes.set(4242, { kind: "present", startSeconds: 1792190531, startMicroseconds: 17254, zombie: false });
  const seen = w.probes.processIdentity(4242);
  if (seen?.state !== "alive") throw new Error("expected an alive fixture process");
  const owner: AdmissionOwner = { pid: 4242, startToken: seen.startToken, bootId: seen.bootId, instanceNonce: "nonce-one" };
  const record = ledger.reserve({ requestId: "request-one", homeId: home.homeId, owner, workspaceId: "workspace-one", incarnationId: "incarnation-one", leaseEpoch: 1, commitment: { memoryBytes: 1024, cpuUnits: 1 } });
  expect(record.state).toBe("reserved"); expect(record.owner).toEqual(owner);
  // The owner process vanishes: uncertain, and the disk-side release evidence (the port) was never produced.
  w.processes.delete(4242);
  expect(ledger.reconcile()[0]).toMatchObject({ state: "uncertain", uncertainReason: "owner-dead", releasedAt: null });
  const receipt = { confirmationId: "stop-one", admissionId: record.admissionId, homeId: record.homeId, workspaceId: record.workspaceId, incarnationId: record.incarnationId, leaseEpoch: 1, owner, confirmedAt: now };
  expect(() => ledger.release(record.admissionId, owner, receipt)).toThrow(AdmissionError); // verifyStopReceipt answered false
  expect(w.state.stopCalls).toBe(1);
  // The same pid with a different start time is a different process.
  w.processes.set(4242, { kind: "present", startSeconds: 1792190531, startMicroseconds: 99999, zombie: false });
  expect(ledger.reconcile()[0]).toMatchObject({ state: "uncertain", releasedAt: null });
  // A new boot session, seen live, is the only thing in these probes that releases a record.
  w.state.boot = BOOT2;
  const after = ledger.reconcile();
  expect(after).toEqual([]);
  expect(ledger.get(record.admissionId)).toMatchObject({ state: "released", releaseReason: "trusted-new-boot" });
});
test("an unreadable host fact surfaces as the ledger's probe_unavailable, never as an admission", () => {
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  const w = world({ machineOutput: "garbage" });
  let code = "";
  try { f.open({ ...w.probes, homeIdentity: f.homeIdentity }, () => observation(0), () => 0); } catch (error) { code = (error as AdmissionError).code; }
  expect(code).toBe("probe_unavailable");
});

// ---------------------------------------------------------------- the real host (read-only; shape, not values)
real("the real probes return well-formed host identity and process identity, and plug into the real ledger", async () => {
  const adapters = createProductionHostAdapters();
  const probes = createCoworkAdmissionProbes({ ...adapters, installationId: () => INSTALL, homeIdentity: () => null, verifyStopReceipt: () => false });
  const identity = probes.hostIdentity()!;
  expect(identity.machineId).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i); expect(identity.bootId).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i);
  expect(identity.machineId).not.toBe(identity.bootId); expect(identity.installationId).toBe(INSTALL);
  expect(probes.hostIdentity()).toEqual(identity); // stable between calls
  const sysctlTool = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]); expect(identity.bootId).toBe(sysctlTool.stdout.toString().trim());
  const self = probes.processIdentity(process.pid);
  expect(self).toMatchObject({ state: "alive", bootId: identity.bootId });
  const token = (self as { startToken: string }).startToken;
  expect(token).toMatch(/^\d{9,11}\.\d{6}$/); expect(probes.processIdentity(process.pid)).toEqual(self);
  const startedAt = Number(token.split(".")[0]), nowSeconds = Date.now() / 1000;
  expect(startedAt).toBeLessThanOrEqual(nowSeconds + 1); expect(startedAt).toBeGreaterThan(nowSeconds - process.uptime() - 30);
  expect(probes.processIdentity(0x7ffffffe)).toEqual({ state: "dead" });
  // A child process: alive with its own start token, then dead after it exits.
  const child = Bun.spawn(["/bin/sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const childSeen = probes.processIdentity(child.pid);
    expect(childSeen).toMatchObject({ state: "alive", bootId: identity.bootId }); expect((childSeen as { startToken: string }).startToken).not.toBe(token);
  } finally { child.kill(); await child.exited; }
  expect(probes.processIdentity(child.pid)).toEqual({ state: "dead" });
  // The real probes satisfy the real ledger's own validation (disposable temp path only).
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  const home = f.makeHome("home-real", identity.machineId, INSTALL), ledger = f.open({ ...probes, homeIdentity: f.homeIdentity }, () => observation(Date.now()), () => Date.now());
  ledger.registerHome(home, home.canonicalPath);
  const owner: AdmissionOwner = { pid: process.pid, startToken: token, bootId: identity.bootId, instanceNonce: "nonce-real" };
  expect(ledger.reserve({ requestId: "request-real", homeId: home.homeId, owner, workspaceId: "workspace-real", incarnationId: "incarnation-real", leaseEpoch: 1, commitment: { memoryBytes: 1024, cpuUnits: 1 } }).state).toBe("reserved");
});
real("the real sysctl adapter answers the facts the resource observer reads", () => {
  const sysctl = createProductionHostAdapters().sysctl;
  expect(sysctl.uint64("hw.memsize")! >= 1n << 30n).toBe(true);
  expect(sysctl.int32("hw.ncpu")!).toBeGreaterThanOrEqual(1);
  expect([1, 2, 4]).toContain(sysctl.int32("kern.memorystatus_vm_pressure_level"));
  expect(sysctl.string("kern.bootsessionuuid")).toMatch(/^[0-9A-F-]{36}$/i);
  expect(sysctl.string("kern.no_such_sysctl_name")).toBeNull(); expect(sysctl.int32("hw.memsize")).toBeNull(); // wrong width for an 8-byte value
});
