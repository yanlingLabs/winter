import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerSlidesTool, type SlidesToolDeps } from "../../src/agent/tools/slides";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";

/**
 * office-agent-tools T6 — approval parity, driven through the REAL dispatch loop, mirroring
 * `sheets-approvals.test.ts`'s own posture exactly. See that file's own header for the full
 * "what this proves that gate.test.ts's unit-level pin cannot" argument — not re-derived here.
 *
 * Two rows: DENY (the dispatch list must stay empty — the strongest form of "no file changed" this
 * fake-transport harness can express) and APPROVE (the SAME card must let the write through to the
 * SAME dispatch mechanism `sheets`/`write`/`edit` ride).
 */

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

/** `path` is RELATIVE ("deck.pptx") deliberately — `slides.ts`'s own fence resolves a relative path
 *  against the session's primary working directory (`dirs[0]`), matching `sheets-approvals.test.ts`'s
 *  own reasoning for the identical choice. */
function setTurn(): ProviderEvent[][] {
  return [
    [
      {
        type: "tool_call", callId: "c1", name: "slides",
        argsJson: JSON.stringify({ verb: "set_text", path: "deck.pptx", slide: 1, title: "Q3" }),
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function slidesRegistry(cwd: string): { registry: ToolRegistry; dispatched: Array<{ action: string; args?: Record<string, unknown> }> } {
  const registry = new ToolRegistry();
  const dispatched: Array<{ action: string; args?: Record<string, unknown> }> = [];
  const deps: SlidesToolDeps = {
    dispatch(cmd) {
      dispatched.push({ action: cmd.action, args: cmd.args });
      return { commandId: "pcmd_1", settled: Promise.resolve({ kind: "result", ok: true, result: "applied title to slide 1" }) };
    },
    harnesses: () => [{ clientName: "orb", role: "harness" }],
    dirsOf: () => [{ path: cwd, locked: true }],
  };
  registerSlidesTool(registry, deps);
  return { registry, dispatched };
}

describe("slides approval parity (office-agent-tools T6)", () => {
  test("ask policy cards a write verb, and a DENIAL means the panel command is never dispatched", async () => {
    const cwd = tmp("norma-slides-approve-deny-");
    const { registry, dispatched } = slidesRegistry(cwd);
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
    const cwd = tmp("norma-slides-approve-yes-");
    const { registry, dispatched } = slidesRegistry(cwd);
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
      action: "office.slides.set_text",
      args: { path: `${cwd}/deck.pptx`, slide: 1, title: "Q3" },
    }]);

    const events = store.read(sessionId);
    const result = events.find((e) => e.type === "tool_result") as unknown as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(false);
  });

  test("auto policy never cards — the SAME MUTATING lane sheets/write/schedule/etc already ride", async () => {
    const cwd = tmp("norma-slides-auto-");
    const { registry, dispatched } = slidesRegistry(cwd);
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
      action: "office.slides.set_text",
      args: { path: `${cwd}/deck.pptx`, slide: 1, title: "Q3" },
    }]);
  });

  test("plan policy denies outright — no card, no dispatch, matching gate.ts's own MUTATING/plan verdict", async () => {
    const cwd = tmp("norma-slides-plan-");
    const { registry, dispatched } = slidesRegistry(cwd);
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
