// The Winter island: the CLI's hello names its controlling terminal (`HelloParams.tty`), found by device number.
import { describe, expect, test } from "bun:test";
import { controllingTtyName, type TtyProbe } from "../src/tty-name";

function probe(o: { ttys: number[]; rdev?: number; dev: Record<string, number> }): TtyProbe {
  return {
    isatty: (fd) => o.ttys.includes(fd),
    rdevOf: () => o.rdev,
    rdevAt: (p) => o.dev[p],
    devNames: () => Object.keys(o.dev).map((p) => p.slice("/dev/".length)),
  };
}

describe("controllingTtyName", () => {
  test("a pseudo-terminal is named by its minor number", () => {
    const rdev = (16 << 24) | 4;
    expect(controllingTtyName(probe({ ttys: [0], rdev, dev: { "/dev/ttys004": rdev } }))).toBe("/dev/ttys004");
  });

  test("stdin piped, stdout a terminal: stdout's terminal", () => {
    const rdev = (16 << 24) | 12;
    expect(controllingTtyName(probe({ ttys: [1], rdev, dev: { "/dev/ttys012": rdev } }))).toBe("/dev/ttys012");
  });

  test("an unusual name is found by scanning /dev for the same device", () => {
    const rdev = (4 << 24) | 2;
    expect(controllingTtyName(probe({ ttys: [0], rdev, dev: { "/dev/ttys002": 99, "/dev/ttyp2": rdev } }))).toBe("/dev/ttyp2");
  });

  test("no terminal (a pipe, a launchd job, a test): none", () => {
    expect(controllingTtyName(probe({ ttys: [], dev: {} }))).toBeUndefined();
    expect(controllingTtyName(probe({ ttys: [0], rdev: 5, dev: { "/dev/ttys005": 6 } }))).toBeUndefined();
  });
});
