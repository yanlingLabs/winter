import { describe, expect, test } from "bun:test";
import { POLICY_ORDER } from "../src/tui/policy-order"; // the single shared source (app.tsx + main.ts both import it)
describe("CLI policy cycle (SP-policies)", () => {
  test("cycles all six in restrictiveness order", () => {
    expect(POLICY_ORDER).toEqual(["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"]);
  });
});
