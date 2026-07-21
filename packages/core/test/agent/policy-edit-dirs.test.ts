import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionRules } from "../../src/agent/permission-rules";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, writeTurn, bashTurn } from "./engine-reviewer.test";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// `setupEngine` always layers the REAL read/write tools on top of whatever registry a test
// passes (see engine-steer.test.ts's setup()) — so a write/edit call driven through it here hits
// the actual fs-write.ts fence (fsWriteOutOfRootDir/resolveWithinAny), not a stub. stubRegistry()
// only stubs "bash"; write/edit are always real in this harness.
function outsideCard(events: { type: string }[]): unknown {
  return events.find((e) => e.type === "approval_requested" && (e as { summary?: string }).summary?.includes("outside"));
}

describe("engine.writableRoots(): Edit(<path>) rules feed the write/edit fence + bash's roots (SP-policies Task 6)", () => {
  test("Edit(<foo>) rule: a write under foo is treated as IN-ROOT — no out-of-project grant card", async () => {
    const cwd = tmp("norma-ed-cwd-");
    const foo = tmp("norma-ed-foo-");
    const permissionRules = new PermissionRules({ globalAllow: () => [`Edit(${foo})`], normaHome: tmp("norma-ed-home-") });
    const { registry } = stubRegistry();
    const target = join(foo, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    // Task 7 (in-project-silent) is what makes an in-writable-set write fully cardless under
    // `ask`; at Task 6 the call may still hit the GENERIC ask card (approvalCardSummary's fallback
    // `${call.name} ${argsJson}` slice — never contains "outside"). The Task-6-local proof is that
    // the OUT-OF-PROJECT grant card specifically never appears — that card is the one whose
    // absence directly demonstrates fsWriteOutOfRootDir now sees `foo` as in-root.
    expect(outsideCard(events)).toBeUndefined();
  });

  test("without the rule, the same write DOES produce an out-of-project grant card", async () => {
    const cwd = tmp("norma-ed-cwd2-");
    const foo = tmp("norma-ed-foo2-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-ed-home2-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider(writeTurn(join(foo, "x.txt"), "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(outsideCard(events)).toBeDefined();
  });

  // --- REQUIRED SECURITY GUARD (Task 4 reviewer carry-forward) ---
  //
  // editPathRules() returns whatever a hand-authored (or approval-card "always allow"-persuaded)
  // `Edit(<path>)` rule declares, completely unvetted — writableRoots must filter that list before
  // unioning it into the session's writable set, or two dangerous things become possible:
  //  (1) `Edit(/)` (the bare filesystem root) would leak into bash's seatbelt roots and make
  //      EVERY path on disk bash-writable (sandbox.ts's buildSeatbeltProfile turns each root into a
  //      real `(subpath "<root>")` Seatbelt rule — `subpath "/"` matches literally everything).
  //  (2) an Edit dir at/under a grantDenied prefix (Norma's own `~/.norma`-class control-plane
  //      denylist) would silently become "in-root", which SKIPS every downstream control-plane
  //      check entirely (dirGrant would be null — the write looks ordinary — so dirGrantDenied's
  //      "can never be granted" hard-error is never even reached).

  test("GUARD: Edit(/) does not widen the write/edit fence — an unrelated outside write still cards as out-of-project", async () => {
    const cwd = tmp("norma-ed-cwd3-");
    const outside = tmp("norma-ed-outside-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit(/)"], normaHome: tmp("norma-ed-home3-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider(writeTurn(join(outside, "x.txt"), "hi"));
    const { engine, store, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    // NOTE (see task-6-report.md "concerns"): fs-write.ts's own resolveWithinAny/isWithin
    // containment check (`probe.startsWith(root + sep)`) already happens to treat a bare "/" root
    // as inert on its own — `"/" + sep` is `"//"`, which no real absolutized path ever starts with
    // — so this assertion would also hold even without writableRoots's own "/" filter. It is kept
    // as the task-specified end-to-end regression guard; the test below (bash's ctx.roots) is the
    // one that actually falsifies the filter, since sandbox.ts's real Seatbelt `subpath` primitive
    // has no equivalent quirk.
    expect(outsideCard(events)).toBeDefined();
  });

  test("GUARD (the real exposure): Edit(/) must never reach bash's ctx.roots — proves \"/\" is filtered before it could ever reach the seatbelt", async () => {
    const cwd = tmp("norma-ed-cwd4-");
    const permissionRules = new PermissionRules({ globalAllow: () => ["Edit(/)"], normaHome: tmp("norma-ed-home4-") });
    // A custom bash stub (not stubRegistry's) that records ctx.roots — the EXACT array
    // executeCall hands to registry.execute as ToolContext.roots, and the exact array
    // tools/bash.ts's real implementation realpaths and feeds into buildSeatbeltProfile's
    // writableRoots (sandbox.ts) to build the live `(subpath ...)` Seatbelt rules. Capturing it
    // here directly tests the vulnerable site, independent of any other tool's own fence quirks.
    const registry = new ToolRegistry();
    const seenRoots: string[][] = [];
    registry.register({
      name: "bash",
      description: "stub bash capturing ctx.roots",
      args: z.object({ command: z.string() }),
      run(_args, ctx) {
        seenRoots.push(ctx.roots);
        return "ok";
      },
    });
    const provider = new FakeProvider(bashTurn("true"));
    // `auto` + no reviewer configured: bash goes straight through the gate to executeCall with no
    // review/approval detour, so ctx.roots reflects writableRoots's return value directly.
    const { engine, sessionId } = setupEngine(provider, { registry, policy: "auto", cwd, permissionRules });

    await engine.runTurn(sessionId);
    expect(seenRoots.length).toBe(1);
    expect(seenRoots[0]).not.toContain("/");
  });

  test("GUARD: Edit(<dir under a grantDenied prefix>) is filtered — write stays hard-denied as the control plane, never silently in-root", async () => {
    const cwd = tmp("norma-ed-cwd5-");
    const deniedRoot = tmp("norma-ed-denied-");
    const editDir = join(deniedRoot, "sub");
    mkdirSync(editDir, { recursive: true });
    const permissionRules = new PermissionRules({ globalAllow: () => [`Edit(${editDir})`], normaHome: tmp("norma-ed-home5-") });
    const { registry } = stubRegistry();
    const target = join(editDir, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "hi"));
    const { engine, store, sessionId } = setupEngine(provider, {
      registry, policy: "ask", cwd, permissionRules,
      grantDeniedPrefixes: [deniedRoot],
    });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    // If the Edit dir were unioned in raw (unfiltered), fsWriteOutOfRootDir would see the target
    // as in-root, dirGrant would be null, and the control-plane check (dirGrantDenied, which only
    // ever runs when dirGrant is non-null) would NEVER fire — the write would sail through as an
    // ordinary in-root ask-card instead of being hard-denied. So: no card at all (the control-plane
    // branch is a straight isError, checked before any approval request), and the tool_result names
    // the control plane explicitly.
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const result = events.find((e) => e.type === "tool_result") as { isError: boolean; output: string } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("control plane");
    expect(existsSync(target)).toBe(false);
  });
});
