import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionError, type AdmissionOwner, type AdmissionProbes, type HostIdentity, type ResourceObservation, type StopReceipt } from "../../../src/cowork/admission";
import {
  COORDINATION_DIR_ENV, COORDINATION_LEDGER_FILE, HOST_COMMAND_MAX_BUFFER_BYTES, HOST_COMMAND_TIMEOUT_MS, IOREG_ARGS, IOREG_PATH, PROC_BSDINFO_BYTES, coordinationLedgerPath, createCoworkAdmissionProbes, createHostCommandRunner, createProcessTable, createProductionHostAdapters, runHostCommand,
  createSysctlReader, decodeSysctlString, parseIoPlatformUuid, parseProcBsdInfo, readBootId, readMachineId,
  type AdmissionProbeDeps, type HostCommandResult, type HostCommandRunner, type ProcessInspection, type ProcessTable, type SysctlLibrary, type SysctlReader,
} from "../../../src/cowork/native/admission-probes";
import { hostStorageFenceOptions } from "../../../src/runtime-sdk/host-storage-fence";
import { ledgerFixture } from "./pressure-ledger-fixture";

// Every host value in this file is synthetic. Tests that read the real host assert SHAPE only, reduce every check to a boolean
// before it reaches expect(), and never store a host value anywhere.
const MACHINE = "00000000-0000-4000-8000-0000000000A1", BOOT = "00000000-0000-4000-8000-0000000000B1", BOOT2 = "00000000-0000-4000-8000-0000000000B2", FORGED = "00000000-0000-4000-8000-0000000000F1", INSTALL = "installation-fixture";
const real = process.platform === "darwin" && process.arch === "arm64" ? test : test.skip;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const ioreg = (uuid: string, extra = "") => `+-o Root  <class IORegistryEntry, id 0x100000100, retain 28>\n  +-o SyntheticModel  <class IOPlatformExpertDevice, id 0x10000020d, registered, matched, active, busy 0 (1 ms), retain 35>\n    {\n      "IOPlatformSerialNumber" = "SYNTHETIC0001"\n      "IOPlatformUUID" = "${uuid}"\n${extra}      "manufacturer" = <"Apple Inc.">\n    }\n\n`;
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
    ["non-hex", ioreg(MACHINE.replace("4000", "ZZZZ"))], ["nil UUID", ioreg("00000000-0000-0000-0000-000000000000")],
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

// ---------------------------------------------------------------- the command runner
// `hostIdentity()` runs inside the ledger's BEGIN IMMEDIATE, so a command that never returned would hold the coordination
// write lock: the runner must be bounded in time and output, and must not inherit the caller's stdin or environment.
const runnerTest = process.platform === "darwin" ? test : test.skip;
runnerTest("the host command runner is bounded: a hung child times out, runaway output is capped, the environment is empty and stdin is /dev/null", () => {
  expect(HOST_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(10_000); expect(HOST_COMMAND_MAX_BUFFER_BYTES).toBeLessThanOrEqual(1024 * 1024);
  expect(typeof runHostCommand).toBe("function");
  const started = Date.now(), hung = createHostCommandRunner({ timeoutMs: 150 })("/bin/sleep", ["30"]);
  expect(hung.status).toBeNull(); expect(hung.timedOut).toBe(true); expect(Date.now() - started).toBeLessThan(5000);
  // The cap is the configured one, not the platform default (1 MiB): 100 kB passes the default runner and not a 1 kB one,
  // and 300 kB, well under a platform default, is already over the production cap. Bounded producers only: an endless
  // one can make the platform's spawnSync throw instead of report, which the runner also treats as "no answer".
  const zeros = (bytes: number) => ["-c", String(bytes), "/dev/zero"];
  expect(createHostCommandRunner({ maxBufferBytes: 1024 })("/usr/bin/head", zeros(100_000)).status).toBeNull();
  expect(createHostCommandRunner()("/usr/bin/head", zeros(100_000))).toMatchObject({ status: 0, timedOut: false });
  expect(createHostCommandRunner()("/usr/bin/head", zeros(HOST_COMMAND_MAX_BUFFER_BYTES + 44_000)).status).toBeNull();
  expect(createHostCommandRunner()("/usr/bin/env", [])).toEqual({ status: 0, stdout: "", timedOut: false }); // nothing inherited
  expect(createHostCommandRunner()("/bin/sh", ["-c", "echo err 1>&2; echo out"])).toEqual({ status: 0, stdout: "out\n", timedOut: false }); // stderr is discarded
  expect(createHostCommandRunner()("/usr/bin/false", [])).toMatchObject({ status: 1, timedOut: false });
  expect(createHostCommandRunner()("/nonexistent/binary", [])).toMatchObject({ status: null, timedOut: false });
  expect(createHostCommandRunner()(undefined as unknown as string, [])).toEqual({ status: null, stdout: "", timedOut: false }); // a throw from the spawn is no answer
  // stdin is /dev/null (a character device), never the caller's pipe or terminal.
  const perl = 'print((-c STDIN ? "char" : -p STDIN ? "pipe" : -t STDIN ? "tty" : "other"), "\\n")';
  expect(createHostCommandRunner()("/usr/bin/perl", ["-e", perl])).toEqual({ status: 0, stdout: "char\n", timedOut: false });
});
runnerTest("a child that traps SIGTERM (and every other catchable signal) is killed at the timeout: the call returns promptly and no process is left running", () => {
  const root = mkdtempSync(join(tmpdir(), "winter-n2-runner-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = join(root, "pid");
  // The child ignores every catchable termination signal (only SIGKILL ends it) and spins, but gives up by itself after 8 s so a
  // broken runner can never leave a busy process behind.
  const script = 'echo $$ > "$1"; trap "" TERM INT HUP QUIT; end=$((SECONDS+8)); while [ $SECONDS -lt $end ]; do :; done';
  const started = Date.now(), result = createHostCommandRunner({ timeoutMs: 300 })("/bin/sh", ["-c", script, "sh", pidFile]);
  const elapsed = Date.now() - started;
  expect(result.status).toBeNull(); expect(result.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(3000);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});
runnerTest("a child that floods stderr neither blocks nor reaches the result", () => {
  // 1 MB on stderr is four times the output cap: were stderr piped it would exceed the cap and fail the call, and were it
  // merged it would appear in stdout.
  const result = createHostCommandRunner()("/bin/sh", ["-c", "/usr/bin/head -c 1000000 /dev/zero 1>&2; echo out"]);
  expect(result).toEqual({ status: 0, stdout: "out\n", timedOut: false });
});
test("the host command runner refuses nonsensical limits", () => {
  for (const bad of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: Number.NaN }, { maxBufferBytes: 0 }, { maxBufferBytes: 2.5 }]) expect(() => createHostCommandRunner(bad)).toThrow(RangeError);
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
  b.writeBigUInt64LE(over.seconds ?? 1700000000n, 120); b.writeBigUInt64LE(over.micros ?? 17254n, 128);
  return b;
}
test("proc_bsdinfo is read at its pinned offsets and every inconsistency is 'unknown'", () => {
  expect(PROC_BSDINFO_BYTES).toBe(136);
  expect(parseProcBsdInfo(bsdInfo(), 136, 4242)).toEqual({ kind: "present", startSeconds: 1700000000, startMicroseconds: 17254, zombie: false });
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
  result = { returned: 136, errno: 0 }; expect(table.inspect(4242)).toMatchObject({ kind: "present", startSeconds: 1700000000 });
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
  w.processes.set(10, { kind: "present", startSeconds: 1700000000, startMicroseconds: 42, zombie: false });
  w.processes.set(11, { kind: "present", startSeconds: 1700000000, startMicroseconds: 17254, zombie: false });
  w.processes.set(12, { kind: "unknown" });
  w.processes.set(13, { kind: "present", startSeconds: 1700000000, startMicroseconds: 1, zombie: true });
  expect(w.probes.processIdentity(10)).toEqual({ state: "alive", startToken: "1700000000.000042", bootId: BOOT });
  expect(w.probes.processIdentity(11)).toEqual({ state: "alive", startToken: "1700000000.017254", bootId: BOOT });
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
  expect(forged({ bootId: FORGED })).toBe(false);
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
  expect(coordinationLedgerPath({ env: {}, homeDirectory: "/fixture-home" })).toBe("/fixture-home/Library/Application Support/Winter/Coordination/cowork-admission.sqlite");
  expect(coordinationLedgerPath({ env: { [COORDINATION_DIR_ENV]: "/tmp/n2-coordination" }, homeDirectory: "/fixture-home" })).toBe("/tmp/n2-coordination/cowork-admission.sqlite");
});
test("a malformed path or override throws and never falls back to the real per-user path", () => {
  for (const override of ["", "relative/dir", "/tmp/dir/", "/tmp/../tmp/dir", "/tmp/a\0b", "/tmp/a\nb", `/${"x".repeat(4096)}`, "/"])
    expect(() => coordinationLedgerPath({ env: { [COORDINATION_DIR_ENV]: override }, homeDirectory: "/fixture-home" })).toThrow("coordination_path_invalid");
  for (const home of ["", "relative", "/fixture-home/", "/a\0b", undefined as never]) expect(() => coordinationLedgerPath({ env: {}, homeDirectory: home })).toThrow("coordination_path_invalid");
  expect(() => coordinationLedgerPath(undefined as never)).toThrow("coordination_path_invalid");
});
test("the ledger path and the host-storage fence spell the Coordination directory identically, and spelling touches no filesystem", () => {
  const previous = process.env[COORDINATION_DIR_ENV];
  cleanups.push(() => { if (previous === undefined) delete process.env[COORDINATION_DIR_ENV]; else process.env[COORDINATION_DIR_ENV] = previous; });
  const fenceFor = () => join(hostStorageFenceOptions("/tmp/n2-home-for-fence-spelling").coordinationDir, COORDINATION_LEDGER_FILE);
  process.env[COORDINATION_DIR_ENV] = "/tmp/n2-pressure-override-that-does-not-exist";
  // Booleans only: the default spelling contains the real home directory, which a failing assertion must not print.
  expect(coordinationLedgerPath({ env: process.env, homeDirectory: homedir() }) === fenceFor()).toBe(true);
  expect(existsSync("/tmp/n2-pressure-override-that-does-not-exist")).toBe(false);
  delete process.env[COORDINATION_DIR_ENV];
  expect(coordinationLedgerPath({ env: process.env, homeDirectory: homedir() }) === fenceFor()).toBe(true);
});

// ---------------------------------------------------------------- the real ledger over these probes
const observation = (now: number, over: Partial<ResourceObservation> = {}): ResourceObservation => ({ budget: { memoryBytes: 1 << 30, cpuUnits: 8, guestLimit: 4 }, pressure: "normal", admitNew: true, observedAt: now, validUntil: now + 100_000, ...over });
test("a live owner reserves; a dead or reused owner makes the record uncertain, never released; only a different live boot id releases", () => {
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  const w = world(); let now = 1_000_000;
  const home = f.makeHome("home-one", MACHINE, INSTALL), ledger = f.open({ ...w.probes, homeIdentity: f.homeIdentity }, () => observation(now), () => now);
  ledger.registerHome(home, home.canonicalPath);
  w.processes.set(4242, { kind: "present", startSeconds: 1700000000, startMicroseconds: 17254, zombie: false });
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
  w.processes.set(4242, { kind: "present", startSeconds: 1700000000, startMicroseconds: 99999, zombie: false });
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
// Rules for this section: a real host value (machine id, boot session id) is never compared with a literal, never passed to
// an assertion that could print it, never written to a file or a ledger and never logged. Every check reduces to a boolean
// first, so a failure can only ever print `false`.
const UUID_SHAPE = /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
const shaped = (value: unknown, shape: RegExp): boolean => typeof value === "string" && shape.test(value);
real("the real probes return well-formed host identity and process identity", async () => {
  const adapters = createProductionHostAdapters();
  const probes = createCoworkAdmissionProbes({ ...adapters, installationId: () => INSTALL, homeIdentity: () => null, verifyStopReceipt: () => false });
  const identity = probes.hostIdentity();
  expect(identity !== null).toBe(true);
  if (identity === null) return;
  expect(shaped(identity.machineId, UUID_SHAPE)).toBe(true);
  expect(shaped(identity.bootId, UUID_SHAPE)).toBe(true);
  expect(shaped(identity.machineId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/) && shaped(identity.bootId, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)).toBe(true); // the ledger's own id() shape
  expect(identity.machineId !== identity.bootId).toBe(true);
  expect(identity.installationId === INSTALL).toBe(true);
  expect(JSON.stringify(probes.hostIdentity()) === JSON.stringify(identity)).toBe(true); // stable between calls
  expect(identity.bootId === Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]).stdout.toString().trim()).toBe(true);
  const self = probes.processIdentity(process.pid);
  expect(self?.state === "alive" && self.bootId === identity.bootId && shaped(self.startToken, /^\d{9,11}\.\d{6}$/)).toBe(true);
  expect(JSON.stringify(probes.processIdentity(process.pid)) === JSON.stringify(self)).toBe(true);
  const token = self?.state === "alive" ? self.startToken : "";
  const startedAt = Number(token.split(".")[0]), nowSeconds = Date.now() / 1000;
  expect(startedAt <= nowSeconds + 1 && startedAt > nowSeconds - process.uptime() - 30).toBe(true);
  expect(probes.processIdentity(0x7ffffffe)?.state === "dead").toBe(true);
  // A child process: alive with its own start token, then dead after it exits.
  const child = Bun.spawn(["/bin/sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const childSeen = probes.processIdentity(child.pid);
    expect(childSeen?.state === "alive" && childSeen.bootId === identity.bootId && childSeen.startToken !== token).toBe(true);
  } finally { child.kill(); await child.exited; }
  expect(probes.processIdentity(child.pid)?.state === "dead").toBe(true);
});
real("the real process table satisfies the real ledger, with synthetic machine and boot ids substituted so no host value is stored", () => {
  const adapters = createProductionHostAdapters();
  const probes = createCoworkAdmissionProbes({ ...adapters, installationId: () => INSTALL, homeIdentity: () => null, verifyStopReceipt: () => false });
  const real_ = probes.processIdentity(process.pid);
  expect(real_?.state === "alive").toBe(true);
  const substituted: AdmissionProbes = {
    ...probes, hostIdentity: () => ({ machineId: MACHINE, installationId: INSTALL, bootId: BOOT }),
    processIdentity: pid => { const seen = probes.processIdentity(pid); return seen?.state === "alive" ? { ...seen, bootId: BOOT } : seen; },
  };
  const f = ledgerFixture(); cleanups.push(() => f.dispose());
  const home = f.makeHome("home-real", MACHINE, INSTALL), ledger = f.open({ ...substituted, homeIdentity: f.homeIdentity }, () => observation(Date.now()), () => Date.now());
  ledger.registerHome(home, home.canonicalPath);
  const seen = substituted.processIdentity(process.pid);
  if (seen?.state !== "alive") throw new Error("expected this process to be alive");
  const owner: AdmissionOwner = { pid: process.pid, startToken: seen.startToken, bootId: seen.bootId, instanceNonce: "nonce-real" };
  expect(ledger.reserve({ requestId: "request-real", homeId: home.homeId, owner, workspaceId: "workspace-real", incarnationId: "incarnation-real", leaseEpoch: 1, commitment: { memoryBytes: 1024, cpuUnits: 1 } }).state).toBe("reserved");
});
real("the real sysctl adapter answers the facts the resource observer reads", () => {
  const sysctl = createProductionHostAdapters().sysctl;
  expect(sysctl.uint64("hw.memsize")! >= 1n << 30n).toBe(true);
  expect(sysctl.int32("hw.ncpu")! >= 1).toBe(true);
  expect([1, 2, 4].includes(sysctl.int32("kern.memorystatus_vm_pressure_level")!)).toBe(true);
  expect(shaped(sysctl.string("kern.bootsessionuuid"), UUID_SHAPE)).toBe(true);
  expect(sysctl.string("kern.no_such_sysctl_name") === null).toBe(true); expect(sysctl.int32("hw.memsize") === null).toBe(true); // wrong width for an 8-byte value
});
