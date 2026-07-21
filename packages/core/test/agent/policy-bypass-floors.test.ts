import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { PermissionRules } from "../../src/agent/permission-rules";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn } from "./engine-reviewer.test";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// SP-policies Task 10: engine.ts's dispatch loop has two floors that must run SILENTLY under
// `bypass` (the escape branch and the dangerous-domain web_fetch branch, both guarded with
// `&& meta.approvalPolicy !== "bypass"` so they fall through to executeCall unseen) and one
// dangerous-domain floor that must DENY outright (no card) under `dont-ask`. These tests drive
// the REAL dispatch loop end to end (same idiom as permission-gate-order.test.ts's scenario 10/11
// and policy-dont-ask.test.ts), not the gate/webFetchGate helpers in isolation.

// A stub `web_fetch` tool (NOT the real network-backed one, registerWebTools) — mirrors
// permission-gate-order.test.ts's stubComputerRegistry idiom: records every invocation so a test
// can assert whether the fetch actually ran, with no live network involved. stubRegistry()
// (engine-reviewer.test.ts) only ever registers `bash`, so web_fetch needs its own small registry.
function stubWebFetchRegistry(): { registry: ToolRegistry; calls: string[] } {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register({
    name: "web_fetch",
    description: "stub web_fetch",
    args: z.object({ url: z.string() }),
    run({ url }) {
      calls.push(url);
      return `fetched: ${url}`;
    },
  });
  return { registry, calls };
}

// One round: model calls web_fetch(url) then stops with tool_calls; round 2 ends the turn.
function fetchTurn(url: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// transfer.sh is on dangerous-domains.ts's SHIPPED_DANGEROUS_DOMAINS list (anonymous one-shot
// file host — `curl --upload-file` exfil-by-upload, no auth) — a fetch to it always produces a
// non-null webFetchGate card under every OTHER policy (see permission-gate-order.test.ts
// scenario 10); no permissionRules WebFetch(domain:...) rule covers it in any test below, so the
// card would otherwise fire regardless of policy.
const DANGEROUS_URL = "https://transfer.sh/x";

describe("bypass + dangerous-domain floor (SP-policies Task 10)", () => {
  test("dangerous-domain fetch under BYPASS runs silently — no card, fetch actually ran", async () => {
    const cwd = tmp("norma-bp-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-bp-home-") });
    const { registry, calls } = stubWebFetchRegistry();
    const provider = new FakeProvider(fetchTurn(DANGEROUS_URL));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "bypass" as any, cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([DANGEROUS_URL]); // the fetch actually ran, unsupervised
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false);
  });

  test("dangerous-domain fetch under DONT-ASK is denied outright — no card, fetch never ran", async () => {
    const cwd = tmp("norma-bp2-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-bp2-home-") });
    const { registry, calls } = stubWebFetchRegistry();
    const provider = new FakeProvider(fetchTurn(DANGEROUS_URL));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "dont-ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls).toEqual([]); // never ran
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("dont-ask");
  });

  test("bash escape (dangerouslyDisableSandbox) under BYPASS runs silently — no card, bash stub ran", async () => {
    const cwd = tmp("norma-bp3-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-bp3-home-") });
    const { registry, calls } = stubRegistry();
    const provider = new FakeProvider(bashTurn("rm -rf x", undefined, { dangerouslyDisableSandbox: true }));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "bypass" as any, cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]?.dangerouslyDisableSandbox).toBe(true);
  });

  test("out-of-project write under BYPASS is silently pre-granted — no card, write lands", async () => {
    const cwd = tmp("norma-bp4-");
    const outside = tmp("norma-bp4-out-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-bp4-home-") });
    const { registry } = stubRegistry();
    const target = join(outside, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "bypass" as any, cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);

    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(false);
    expect(existsSync(target)).toBe(true); // the write actually landed
  });
});
