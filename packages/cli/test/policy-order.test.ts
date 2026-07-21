import { describe, expect, test } from "bun:test";
import { POLICY_ORDER } from "../src/tui/app"; // export it if not already
describe("CLI policy cycle (SP-policies)", () => {
  test("cycles all six in restrictiveness order", () => {
    expect(POLICY_ORDER).toEqual(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);
  });
});
