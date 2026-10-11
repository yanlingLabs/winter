import { test, expect } from "bun:test";
import { validateConfinement, memoryObservation } from "./evidence";

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
