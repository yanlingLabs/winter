import { describe, expect, test } from "bun:test";
import { parseOutputStyleArgs } from "../src/output-style-cli";

describe("parseOutputStyleArgs", () => {
  test("no args → list action", () => {
    expect(parseOutputStyleArgs([])).toEqual({ action: "list" });
  });
  test("a name → set action", () => {
    expect(parseOutputStyleArgs(["proactive"])).toEqual({ action: "set", name: "proactive" });
  });
  test("--help → help action", () => {
    expect(parseOutputStyleArgs(["--help"])).toEqual({ action: "help" });
  });
});
