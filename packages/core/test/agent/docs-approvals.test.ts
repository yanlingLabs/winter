import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerDocsTool, type DocsToolDeps } from "../../src/agent/tools/docs";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";

/**
 * office-agent-tools T7 — approval parity for `docs`, driven through the REAL dispatch loop,
 * mirroring the two sibling suites exactly. See `sheets-approvals.test.ts`'s own header for the full
 * "what this proves that gate.test.ts's unit-level pin cannot" argument.
 *
 * The verb under test is `append`, deliberately: it is the one `docs` verb that is NOT safe to
 * re-send after a timeout, so it is the one whose approval card matters most.
 */

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** `path` is RELATIVE ("notes.odt") deliberately — `docs.ts`'s own fence resolves a relative path
 *  against the session's primary working directory (`dirs[0]`), matching the sibling suites' own
 *  reasoning for the identical choice. */
function setTurn(): ProviderEvent[][] {
  return [
    [
      {
        type: "tool_call", callId: "c1", name: "docs",
        argsJson: JSON.stringify({ verb: "append", path: "notes.odt", text: "a new paragraph" }),
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function docsRegistry(cwd: string): { registry: ToolRegistry; dispatched: Array<{ action: string; args?: Record<string, unknown> }> } {
  const registry = new ToolRegistry();
  const dispatched: Array<{ action: string; args?: Record<string, unknown> }> = [];
  const deps: DocsToolDeps = {
    dispatch(cmd) {
      dispatched.push({ action: cmd.action, args: cmd.args });
      return { commandId: "pcmd_1", settled: Promise.resolve({ kind: "result", ok: true, result: "appended as a new paragraph at the end of notes.odt" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
    dirsOf: () => [{ path: cwd, locked: true }],
  };
  registerDocsTool(registry, deps);
  return { registry, dispatched };
}

describe("docs approval parity (office-agent-tools T7)", () => {
  test("ask policy cards a write verb, and a DENIAL means the panel command is never dispatched", async () => {
    const cwd = tmp("norma-docs-approve-deny-");
    const { registry, dispatched } = docsRegistry(cwd);
    const provider = new FakeProvider(setTurn());
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd });

    let carded = false;
    hub.attach({
      clientName: "auto-denier",
      deliver(e: never) {
        const ev = e as unknown as { type: string; callId: string };
        if (ev.type === "approval_requested") {
          carded = true;
          broker.resolve(sessionId, ev.callId, false, "auto-denier");
        }
        return true;
      },
    } as never, sessionId, 0);

    await engine.runTurn(sessionId);

    expect(carded).toBe(true);
    expect(dispatched).toEqual([]);

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(true);
  });

  test("ask policy cards a write verb, and APPROVAL lets it reach the SAME dispatch mechanism a read uses", async () => {
    const cwd = tmp("norma-docs-approve-yes-");
    const { registry, dispatched } = docsRegistry(cwd);
    const provider = new FakeProvider(setTurn());
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd });

    let carded = false;
    hub.attach({
      clientName: "auto-approver",
      deliver(e: never) {
        const ev = e as unknown as { type: string; callId: string };
        if (ev.type === "approval_requested") {
          carded = true;
          broker.resolve(sessionId, ev.callId, true, "auto-approver");
        }
        return true;
      },
    } as never, sessionId, 0);

    await engine.runTurn(sessionId);

    expect(carded).toBe(true);
    expect(dispatched).toEqual([{
      action: "office.docs.append",
      args: { path: `${cwd}/notes.odt`, text: "a new paragraph" },
    }]);

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(false);
  });

  test("auto policy never cards — the SAME MUTATING lane sheets/slides/write/schedule already ride", async () => {
    const cwd = tmp("norma-docs-auto-");
    const { registry, dispatched } = docsRegistry(cwd);
    const provider = new FakeProvider(setTurn());
    const { engine, hub, sessionId } = setupEngine(provider, { registry, policy: "auto", cwd });

    let carded = false;
    hub.attach({
      clientName: "observer",
      deliver(e: never) {
        const ev = e as unknown as { type: string };
        if (ev.type === "approval_requested") carded = true;
        return true;
      },
    } as never, sessionId, 0);

    await engine.runTurn(sessionId);

    expect(carded).toBe(false);
    expect(dispatched).toEqual([{
      action: "office.docs.append",
      args: { path: `${cwd}/notes.odt`, text: "a new paragraph" },
    }]);
  });

  test("plan policy denies outright — no card, no dispatch, matching gate.ts's own MUTATING/plan verdict", async () => {
    const cwd = tmp("norma-docs-plan-");
    const { registry, dispatched } = docsRegistry(cwd);
    const provider = new FakeProvider(setTurn());
    const { engine, store, hub, sessionId } = setupEngine(provider, { registry, policy: "plan", cwd });

    let carded = false;
    hub.attach({
      clientName: "observer",
      deliver(e: never) {
        const ev = e as unknown as { type: string };
        if (ev.type === "approval_requested") carded = true;
        return true;
      },
    } as never, sessionId, 0);

    await engine.runTurn(sessionId);

    expect(carded).toBe(false);
    expect(dispatched).toEqual([]);
    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(true);
  });
});
