import { describe, expect, test } from "bun:test";
import { PermissionGate, type SessionApprovalPolicy } from "../../src/agent/gate";

const g = new PermissionGate();
const MODES: SessionApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];

describe("PermissionGate.evaluate — 6-mode table", () => {
  test("reads are always allow", () => {
    for (const m of MODES) expect(g.evaluate("read", m)).toBe("allow");
  });
  test("web is always allow (floor lives in engine)", () => {
    for (const m of MODES) expect(g.evaluate("web_fetch", m)).toBe("allow");
  });
  test("write/edit: plan=deny, dont-ask/ask=ask, accept-edits/auto/bypass=allow", () => {
    expect(g.evaluate("edit", "plan")).toBe("deny");
    expect(g.evaluate("edit", "dont-ask")).toBe("ask");
    expect(g.evaluate("edit", "ask")).toBe("ask");
    expect(g.evaluate("edit", "accept-edits")).toBe("allow");
    expect(g.evaluate("edit", "auto")).toBe("allow");
    expect(g.evaluate("edit", "bypass")).toBe("allow");
  });
  test("bash: accept-edits still ASKS (edits free, rest carded)", () => {
    expect(g.evaluate("bash", "accept-edits")).toBe("ask");
    expect(g.evaluate("bash", "auto")).toBe("allow");
    expect(g.evaluate("bash", "bypass")).toBe("allow");
    expect(g.evaluate("bash", "plan")).toBe("deny");
  });
  test("skill_write: deny in plan, allow in bypass, ask everywhere else (incl auto)", () => {
    expect(g.evaluate("skill_write", "plan")).toBe("deny");
    expect(g.evaluate("skill_write", "auto")).toBe("ask");
    expect(g.evaluate("skill_write", "bypass")).toBe("allow");
    expect(g.evaluate("skill_write", "dont-ask")).toBe("ask");
  });
  test("external (mcp__) tracks bash", () => {
    expect(g.evaluate("mcp__x__y", "accept-edits")).toBe("ask");
    expect(g.evaluate("mcp__x__y", "auto")).toBe("allow");
    expect(g.evaluate("mcp__x__y", "bypass")).toBe("allow");
    expect(g.evaluate("mcp__x__y", "plan")).toBe("deny");
  });
});
