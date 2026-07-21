import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, stubReviewer } from "./engine-reviewer.test";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// SP-policies Task 8: drops the SP-approvals Task 3 "ask widening" — the bash reviewer branch used
// to fire whenever `meta.approvalPolicy === "auto" || ruleAllowed`, so a rule-allowed call rode the
// reviewer even under `ask`. A standing rule under `ask` is a HUMAN pre-authorization (the human
// already decided this call needs no gate at all); the reviewer's job is to stand in for a human
// gate that would otherwise fire, and under `ask` a rule-allowed call never reaches one. The
// reviewer is therefore auto-ONLY now. Both cases below use an "unsafe" stub verdict so a
// regression (the reviewer wrongly running, or wrongly not running) fails loudly either way.
describe("reviewer is auto-only (SP-policies Task 8)", () => {
  test("a rule-allowed bash under ASK runs with NO tool_review (reviewer not consulted)", async () => {
    const cwd = tmp("norma-rv-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(git push:*)"], normaHome: tmp("norma-rv-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "unsafe", reason: "WOULD_BLOCK_IF_CONSULTED" }); // would BLOCK if consulted
    const provider = new FakeProvider(bashTurn("git push origin main"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules, reviewer: reviewer as any });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(reviewer.seen.length).toBe(0); // reviewer NOT consulted under ask
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no escalation card either
    expect(calls.length).toBe(1); // ran (rule-allowed, no reviewer)
  });

  test("the same rule-allowed bash under AUTO IS reviewed", async () => {
    const cwd = tmp("norma-rv2-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(git push:*)"], normaHome: tmp("norma-rv2-home-") });
    const { registry, calls } = stubRegistry();
    const reviewer = stubReviewer({ verdict: "safe", reason: "OK" });
    const provider = new FakeProvider(bashTurn("git push origin main"));
    const { engine, sessionId } = setupEngine(provider, { registry, policy: "auto", cwd, permissionRules, reviewer: reviewer as any });

    await engine.runTurn(sessionId);

    expect(reviewer.seen.length).toBe(1); // reviewer consulted under auto
    expect(calls.length).toBe(1);
  });
});
