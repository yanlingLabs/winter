import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn } from "./engine-reviewer.test";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// NOTE on the write-turn success proxy: stubRegistry()'s `calls` array is closed over by its BASH
// stub only — a writeTurn drives the REAL write tool (setupEngine always layers it on), which never
// touches that array. So for a silent in-project write we prove it RAN via existsSync(target) (the
// same idiom policy-edit-dirs.test.ts uses) + a non-error tool_result, not via `calls.length`.

describe("dont-ask (SP-policies)", () => {
  test("a non-rule bash call is auto-DENIED, no card", async () => {
    const cwd = tmp("norma-da-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-da-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git push"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "dont-ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card
    expect(calls.length).toBe(0); // never ran
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("dont-ask");
  });

  test("a rule-allowed bash call still RUNS under dont-ask", async () => {
    const cwd = tmp("norma-da2-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Bash(git status:*)"], normaHome: tmp("norma-da2-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("git status"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "dont-ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    expect(calls.length).toBe(1);
  });

  test("an in-project edit is SILENT under dont-ask", async () => {
    const cwd = tmp("norma-da3-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-da3-home-") });
    const { registry } = stubRegistry();
    const target = join(cwd, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "dont-ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false); // ran, not denied
    expect(existsSync(target)).toBe(true); // the write actually landed
  });

  test("an out-of-project edit is DENIED (no grant card) under dont-ask", async () => {
    // The dont-ask flip does NOT guard `!dirGrant`, and the `decision === "deny"` branch is FIRST
    // in the dispatch chain — so an out-of-project write is converted to deny and short-circuits
    // BEFORE the `else if (dirGrant)` grant-card branch could offer to widen the roots. Proves the
    // branch-order contract in the brief: dont-ask never surfaces a grant card.
    const cwd = tmp("norma-da4-");
    const outside = tmp("norma-da4-out-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-da4-home-") });
    const { registry } = stubRegistry();
    const target = join(outside, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "dont-ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no grant card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("dont-ask");
    expect(existsSync(target)).toBe(false); // never written
  });
});

describe("in-project edits silent under ask (SP-policies)", () => {
  test("write inside cwd under ask → no card", async () => {
    const cwd = tmp("norma-ip-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-ip-home-") });
    const { registry } = stubRegistry();
    const target = join(cwd, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // no card
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false); // ran, not denied
    expect(existsSync(target)).toBe(true); // the write actually landed
  });
});
