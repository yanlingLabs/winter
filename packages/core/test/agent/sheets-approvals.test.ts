import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSheetsTool, type SheetsToolDeps } from "../../src/agent/tools/sheets";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";

/**
 * office-agent-tools T4 — approval parity, driven through the REAL dispatch loop, mirroring
 * `browser-approvals.test.ts`'s own posture: a fake `dispatch` (the panel command channel) recording
 * every call, a real engine turn, a real `ApprovalBroker`.
 *
 * **What this proves that `gate.test.ts`'s unit-level classification pin cannot**: `gate.ts`
 * (task 4's own reclassification, `sheets` -> MUTATING) proves `evaluate("sheets", "ask") === "ask"`
 * — a pure function's return value, not that the ENGINE actually cards a real `sheets` write call and
 * that a DENIAL actually stops the tool's own `run()` from ever dispatching a `panel_command`. That is
 * what "the same approval card write raises, and a denied approval means no file changed" (the task's
 * own dispatch) asks for, proven the same way `browser-approvals.test.ts` proves ITS class's parity:
 * end to end, through `setupEngine`, never a helper in isolation.
 *
 * Two rows: DENY (the dispatch list must stay empty — the strongest form of "no file changed" this
 * fake-transport harness can express, matching `sheets.ts`'s own test posture, spec §9) and APPROVE
 * (the SAME card must let the write through to the SAME dispatch mechanism `write`/`edit` ride).
 */

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** `path` is RELATIVE ("budget.xlsx") deliberately — `sheets.ts`'s own fence resolves a relative
 *  path against the session's primary working directory (`dirs[0]`), so this turn is in-fence for
 *  ANY `cwd` a test happens to mint, without needing to bake a specific tmpdir path into the
 *  provider script itself. */
function setTurn(): ProviderEvent[][] {
  return [
    [
      {
        type: "tool_call", callId: "c1", name: "sheets",
        argsJson: JSON.stringify({ verb: "set", path: "budget.xlsx", sheet: "Sheet1", range: "A1", values: [["x"]] }),
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function sheetsRegistry(cwd: string): { registry: ToolRegistry; dispatched: Array<{ action: string; args?: Record<string, unknown> }> } {
  const registry = new ToolRegistry();
  const dispatched: Array<{ action: string; args?: Record<string, unknown> }> = [];
  const deps: SheetsToolDeps = {
    dispatch(cmd) {
      dispatched.push({ action: cmd.action, args: cmd.args });
      return { commandId: "pcmd_1", settled: Promise.resolve({ kind: "result", ok: true, result: "wrote 1 cell" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
    dirsOf: () => [{ path: cwd, locked: true }],
  };
  registerSheetsTool(registry, deps);
  return { registry, dispatched };
}

describe("sheets approval parity (office-agent-tools T4)", () => {
  test("ask policy cards a write verb, and a DENIAL means the panel command is never dispatched", async () => {
    const cwd = tmp("norma-sheets-approve-deny-");
    const { registry, dispatched } = sheetsRegistry(cwd);
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
    // The strongest available "no file changed" proof at this layer: run() itself never reached
    // dispatch — no panel_command was ever built or sent toward the app/LOK at all.
    expect(dispatched).toEqual([]);

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(true);
  });

  test("ask policy cards a write verb, and APPROVAL lets it reach the SAME dispatch mechanism a read uses", async () => {
    const cwd = tmp("norma-sheets-approve-yes-");
    const { registry, dispatched } = sheetsRegistry(cwd);
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
      action: "office.sheets.set",
      args: { path: `${cwd}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["x"]] },
    }]);

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(false);
  });

  test("auto policy never cards — the SAME MUTATING lane write/schedule/etc already ride", async () => {
    const cwd = tmp("norma-sheets-auto-");
    const { registry, dispatched } = sheetsRegistry(cwd);
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
      action: "office.sheets.set",
      args: { path: `${cwd}/budget.xlsx`, sheet: "Sheet1", range: "A1", values: [["x"]] },
    }]);
  });

  test("plan policy denies outright — no card, no dispatch, matching gate.ts's own MUTATING/plan verdict", async () => {
    const cwd = tmp("norma-sheets-plan-");
    const { registry, dispatched } = sheetsRegistry(cwd);
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
