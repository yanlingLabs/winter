import { test, expect } from "bun:test";
import { validateConfinement, validateDirect, validateDenial, validateGuestWritableMount, memoryObservation } from "./evidence";

const rows = (await Bun.file(new URL("./testdata/confinement.ndjson", import.meta.url)).text()).trim().split("\n").map(line => JSON.parse(line));
const result = (records: unknown[]) => ({ exitCode: 0, stdout: records.map(row => JSON.stringify(row)).join("\n"), stderr: "", stdoutTruncated: false, stderrTruncated: false });
test("exit zero cannot certify empty or partial evidence", () => {
  expect(() => validateConfinement(result([]))).toThrow();
  expect(() => validateConfinement(result(rows.filter(row => !(row.kind === "summary" && row.policy === "auto" && row.uid === 10001))))).toThrow();
});
test("unsupported, failed, malformed or truncated evidence cannot pass", () => {
  expect(() => validateConfinement(result([...rows, { status: "unsupported" }]))).toThrow();
  expect(() => validateConfinement({ ...result(rows), stdoutTruncated: true })).toThrow();
  expect(() => validateConfinement({ ...result(rows), stdout: "not JSON" })).toThrow();
  expect(() => validateConfinement(result([...rows, rows.find(row => row.kind === "summary" && row.policy === "auto")]))).toThrow();
});
test("all required distinct views and terminal suite must succeed", () => {
  expect(validateConfinement(result(rows))).toHaveLength(rows.length);
});

test("optional measured Landlock absence is explicit, required unsupported still fails", () => {
  expect(validateConfinement(result([...rows, { kind: "observation", id: "landlock_abi", status: "unsupported", required: false }]))).toHaveLength(rows.length + 1);
  expect(() => validateConfinement(result([...rows, { kind: "check", id: "mount", status: "unsupported", required: false }]))).toThrow();
});

test("balloon target, RSS and another VM's footprint do not prove owned memory return", () => {
  expect(memoryObservation({ samples: [] }).backingFootprintDecreaseObserved).toBeNull();
  const sample = (label: string, own: number, other: number) => ({ label, footprint: [
    { pid: 10, summary: [`phys_footprint: ${own} MB`] }, { pid: 20, summary: [`phys_footprint: ${other} MB`] },
  ] });
  const report = { newBackingServiceCandidates: [{ pid: 10 }], samples: [sample("freed-without-balloon", 507, 900), sample("balloon-0", 507, 500), sample("balloon-1", 508, 300)] };
  expect(memoryObservation(report).backingFootprintDecreaseObserved).toBe(false);
  report.samples = [sample("freed-without-balloon", 507, 900), sample("balloon-0", 300, 900), sample("balloon-1", 300, 900)];
  expect(memoryObservation(report).backingFootprintDecreaseObserved).toBe(true);
  expect(memoryObservation(report).reclaimVerified).toBe(false);
});

test("dropping a required denial still fails even when summaries are adjusted", () => {
  const reduced = rows.filter(row => !(row.kind === "check" && row.id === "syscall_vsock" && row.policy === "auto" && row.uid === 10001)).map(row => row.kind === "summary" && row.policy === "auto" && row.uid === 10001 ? { ...row, checks: row.checks - 1 } : row);
  expect(() => validateConfinement(result(reduced))).toThrow();
});

test("denial evidence rejects command errors, wrong failure classes and failed positive controls", () => {
  const row = { id: "instructions_direct", denial: { exitCode: 1, failureClass: "EROFS", positiveControlPassed: true, positiveControlExitCode: 0 } };
  expect(() => validateDenial(row)).not.toThrow();
  for (const failureClass of ["ENOENT", "EXDEV", "EBUSY", "UNKNOWN", "syntax_error"])
    expect(() => validateDenial({ ...row, denial: { ...row.denial, failureClass, expectedFailureClasses: [failureClass] } })).toThrow();
  for (const exitCode of [0, 126, 127, 137]) expect(() => validateDenial({ ...row, denial: { ...row.denial, exitCode } })).toThrow();
  expect(() => validateDenial({ ...row, denial: { ...row.denial, positiveControlPassed: false } })).toThrow();
  expect(() => validateDenial({ ...row, denial: { ...row.denial, positiveControlExitCode: 1 } })).toThrow();
  expect(() => validateDenial({ id: row.id })).toThrow();
  expect(() => validateDenial({ id: "control_direct", denial: { ...row.denial, failureClass: "ENOENT" } })).not.toThrow();
});

test("positive prerequisites and trusted post-checks cannot be omitted", () => {
  for (const id of ["instruction_readable", "scratch_write", "instruction_symlink_setup", "trusted_integrity"])
    expect(() => validateConfinement(result(rows.filter(row => row.id !== id)))).toThrow();
});

test("direct summaries cannot replace per-check evidence", () => {
  const summaries = [
    { kind: "summary", id: "direct_strict_source", status: "pass", exitCode: 0 },
    ...[["auto", 10001], ["auto", 10002], ["plan", 10001]].map(([policy, uid]) => ({ kind: "summary", id: "direct_tool_view", policy, uid, status: "pass", failures: 0 })),
  ];
  expect(() => validateDirect(result(summaries))).toThrow();
});

test("direct suite distinguishes auto positive writes from plan denials", async () => {
  const directRows = (await Bun.file(new URL("./testdata/direct.ndjson", import.meta.url)).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(validateDirect(result(directRows))).toHaveLength(directRows.length);
  const missing = directRows.map(row => row.id === "plan_create" ? { ...row, denial: undefined } : row);
  expect(() => validateDirect(result(missing))).toThrow();
  const wrongReason = directRows.map(row => row.id === "plan_create" ? { ...row, denial: { ...row.denial, failureClass: "ENOENT" } } : row);
  expect(() => validateDirect(result(wrongReason))).toThrow();
});

test("host RO attribution requires raw mountinfo to show both guest layers writable", () => {
  const path = "/workspace/host-ro";
  const guestMount = { path, method: "remount_bind", remountExitCode: 0, filesystem: "virtiofs", guestWritableMountVerified: true, mountOptions: ["rw", "relatime"], superblockOptions: ["rw"], mountInfo: `12 3 0:9 /fixture ${path} rw,relatime - virtiofs virtiofs rw` };
  const row = { status: "pass", guestMount };
  expect(() => validateGuestWritableMount(row, path)).not.toThrow();
  for (const mountInfo of [
    `12 3 0:9 /fixture ${path} ro,relatime - virtiofs virtiofs rw`,
    `12 3 0:9 /fixture ${path} rw,relatime - virtiofs virtiofs ro`,
    `12 3 0:9 /fixture /another-source rw,relatime - virtiofs virtiofs rw`,
    `12 3 0:9 /fixture ${path} rw,relatime - ext4 /dev/vda rw`,
    "",
  ]) expect(() => validateGuestWritableMount({ ...row, guestMount: { ...guestMount, mountInfo } }, path)).toThrow();
  expect(() => validateGuestWritableMount({ ...row, guestMount: { ...guestMount, remountExitCode: 1 } }, path)).toThrow();
  expect(() => validateGuestWritableMount({ ...row, guestMount: { ...guestMount, mountOptions: ["ro"] } }, path)).toThrow();
});

test("confinement cannot attribute a host denial without both writable-view prerequisites", () => {
  for (const id of ["host_ro_supervisor_guest_rw_view", "host_rw_supervisor_guest_rw_view"]) {
    expect(() => validateConfinement(result(rows.filter(row => row.id !== id)))).toThrow();
    const guestReadOnly = rows.map(row => row.id !== id ? row : { ...row, guestMount: { ...row.guestMount, mountInfo: row.guestMount.mountInfo.replace(" rw,", " ro,") } });
    expect(() => validateConfinement(result(guestReadOnly))).toThrow();
  }
});
