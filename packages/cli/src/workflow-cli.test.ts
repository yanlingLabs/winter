import { expect, test } from "bun:test";
import { parseWorkflowArgs } from "./workflow-cli";

test("parses list/run/save/help", () => {
  expect(parseWorkflowArgs([])).toEqual({ action: "list" });
  expect(parseWorkflowArgs(["run", "triage", '{"files":["a"]}'])).toEqual({ action: "run", name: "triage", args: '{"files":["a"]}' });
  expect(parseWorkflowArgs(["save", "triage", "./t.js"])).toEqual({ action: "save", name: "triage", file: "./t.js" });
  expect(parseWorkflowArgs(["--help"])).toEqual({ action: "help" });
});

test("run/save without a trailing token omit the optional field", () => {
  expect(parseWorkflowArgs(["run", "triage"])).toEqual({ action: "run", name: "triage" });
  expect(parseWorkflowArgs(["save", "triage"])).toEqual({ action: "save", name: "triage" });
});

test("-h is an alias for --help; an unrecognized subcommand also falls back to help", () => {
  expect(parseWorkflowArgs(["-h"])).toEqual({ action: "help" });
  expect(parseWorkflowArgs(["bogus"])).toEqual({ action: "help" });
});
