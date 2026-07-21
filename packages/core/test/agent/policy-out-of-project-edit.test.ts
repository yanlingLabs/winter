import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubClient } from "../../src/sessions/hub";
import type { ApprovalBroker } from "../../src/agent/approvals";
import { FakeProvider } from "../../src/agent/fake-provider";
import { PermissionRules } from "../../src/agent/permission-rules";
import { repoRootFor } from "../../src/agent/memory-dir";
import type { ProviderEvent } from "../../src/providers/types";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, writeTurn } from "./engine-reviewer.test";

// SP-policies Task 9: the OUT-OF-PROJECT edit card. An out-of-root write/edit under `ask` no longer
// rides the old plain approve/deny grant card whose approval added the dir to the session roots
// FOREVER (task-24's applyDirGrant). It now offers three options — [Allow once, Always allow edits
// in <dir> (= Edit(<dir>) scope project), Deny] — and its onApprove uses a ONE-SHOT roots override:
// the immediate write lands (the grant dir is mkdir'd first, since the write fence SKIPS a
// not-yet-existing root — see mkdirForOneShotGrant), but NOTHING is persisted to the session roots.
// "Always allow edits in <dir>" persists the Edit(<dir>) RULE (via ipc/server.ts's approval.respond
// handler, keyed by the chosen optionId) so FUTURE calls get <dir> in writableRoots; "Allow once"
// persists nothing, so a repeat out-of-project write cards again.
//
// Every test drives the REAL dispatch loop (setupEngine's harness — write/edit are REAL there,
// stubRegistry only stubs bash), per this feature area's established "drive the loop, don't
// unit-test internals" precedent (permission-gate-order.test.ts / approval-options.test.ts).

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

// One write turn with a caller-chosen callId, so two sequential turns in the same session never
// reuse an id (the imported writeTurn hardcodes "c1"). Same two-round shape: tool_call then
// end_turn.
function writeTurnId(path: string, content: string, callId: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId, name: "write", argsJson: JSON.stringify({ path, content }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

// A watcher that answers the FIRST approval_requested by a given optionId, mirroring ipc/server.ts's
// approval.respond handler EXACTLY: look the pending options up via `pendingMeta` (a non-consuming
// read), and if the chosen option carries a rule (and we're approving), persist it through the REAL
// PermissionRules.append BEFORE resolving — the same option-lookup-then-append-then-resolve ordering
// server.ts uses. broker.resolve itself takes no optionId (it only carries approved/by), so this is
// the ONLY place an optionId can drive rule persistence in the engine harness (the daemon's IPC
// layer isn't wired here). optionId "deny" (approved:false) persists nothing, exactly like the real
// handler's `p.approved`-gated append.
function optionResponder(
  broker: ApprovalBroker,
  permissionRules: PermissionRules,
  sessionId: string,
  projectRoot: string,
  optionId: string,
  approved = true,
): HubClient {
  return {
    clientName: "option-responder",
    deliver(e: any) {
      if (e.type === "approval_requested") {
        const meta = broker.pendingMeta(sessionId, e.callId);
        const option = meta?.options?.find((o) => o.id === optionId);
        if (option?.rule && approved) permissionRules.append(option.rule, option.scope ?? "project", projectRoot);
        broker.resolve(sessionId, e.callId, approved, "option-responder");
      }
      return true;
    },
  };
}

describe("out-of-project edit card (SP-policies Task 9)", () => {
  // (a) card SHAPE: three options; the middle one persists Edit(<grant.dir>) at project scope.
  test("under ask, an out-of-project edit offers [Allow once / Always allow edits in <dir> / Deny]; the rule option is Edit(<dir>) scope project", async () => {
    const cwd = tmp("norma-op-cwd-");
    const foo = tmp("norma-op-foo-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op-home-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider(writeTurn(join(foo, "x.txt"), "hi"));
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    // Deny immediately (fast + deterministic) — this test only inspects the card's options.
    hub.attach(optionResponder(broker, permissionRules, sessionId, repoRootFor(cwd), "deny", false), sessionId, 0);

    await engine.runTurn(sessionId);
    const card = store.read(sessionId).find((e: any) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();
    expect(card.summary).toContain("outside your project");
    expect(card.options).toEqual([
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: `Always allow edits in ${foo}`, rule: `Edit(${foo})`, scope: "project" },
      { id: "deny", label: "Deny" },
    ]);
  });

  // (b) Always allow edits: the write lands AND the Edit(<dir>) rule persists to the project rules
  // file — then a SECOND out-of-project write to the same dir rides that rule SILENTLY (no card).
  test("choosing allow_project: the write lands, Edit(<dir>) is persisted (project scope), and the NEXT write to that dir is silent", async () => {
    const cwd = tmp("norma-op2-cwd-");
    const foo = tmp("norma-op2-foo-");
    const projectRoot = repoRootFor(cwd);
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op2-home-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider([
      ...writeTurnId(join(foo, "x.txt"), "hi", "c1"), // turn 1: out-of-project → card → allow_project
      ...writeTurnId(join(foo, "y.txt"), "second", "c2"), // turn 2: same dir → rides the persisted rule, silent
    ]);
    const { engine, store, hub, broker, sessionId } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    hub.attach(optionResponder(broker, permissionRules, sessionId, projectRoot, "allow_project"), sessionId, 0);

    await engine.runTurn(sessionId); // turn 1
    expect(readFileSync(join(foo, "x.txt"), "utf8")).toBe("hi"); // the immediate write LANDED (one-shot roots)
    // The rule persisted to <projectRoot>/.norma/permissions.local.json, exactly as server.ts writes it:
    expect(permissionRules.rulesFor(projectRoot).project).toContain(`Edit(${foo})`);
    expect(existsSync(join(projectRoot, ".norma", "permissions.local.json"))).toBe(true);

    await engine.runTurn(sessionId); // turn 2
    const events = store.read(sessionId);
    // Exactly ONE card total — turn 2's write is now IN-ROOT (writableRoots folds in Edit(foo)), so
    // it is silenced by the in-project-silent flip, no card at all.
    expect(events.filter((e: any) => e.type === "approval_requested").length).toBe(1);
    expect(readFileSync(join(foo, "y.txt"), "utf8")).toBe("second");
  });

  // (c) Allow once: the write lands, but NOTHING is persisted — a repeat out-of-project write to the
  // SAME dir cards AGAIN (one-shot: no session grant, no rule).
  test("choosing allow_once: the write lands, NO rule is persisted, and a repeat write to the same dir cards again", async () => {
    const cwd = tmp("norma-op3-cwd-");
    const foo = tmp("norma-op3-foo-");
    const projectRoot = repoRootFor(cwd);
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op3-home-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider([
      ...writeTurnId(join(foo, "x.txt"), "one", "c1"), // turn 1: out-of-project → card → allow_once
      ...writeTurnId(join(foo, "y.txt"), "two", "c2"), // turn 2: same dir → cards AGAIN (one-shot)
    ]);
    const { engine, store, hub, broker, sessionId, dirs } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    hub.attach(optionResponder(broker, permissionRules, sessionId, projectRoot, "allow_once"), sessionId, 0);

    await engine.runTurn(sessionId); // turn 1
    expect(readFileSync(join(foo, "x.txt"), "utf8")).toBe("one"); // write LANDED via the one-shot roots
    expect(permissionRules.rulesFor(projectRoot).project).toEqual([]); // NO rule persisted
    expect(existsSync(join(projectRoot, ".norma", "permissions.local.json"))).toBe(false);
    // One-shot: the dir was NOT added to the session roots (no persistent grant, no directory_added).
    expect(dirs.has(sessionId, foo)).toBe(false);
    expect(store.read(sessionId).some((e: any) => e.type === "directory_added")).toBe(false);

    await engine.runTurn(sessionId); // turn 2
    const events = store.read(sessionId);
    expect(events.filter((e: any) => e.type === "approval_requested").length).toBe(2); // carded AGAIN — once is once
    expect(readFileSync(join(foo, "y.txt"), "utf8")).toBe("two"); // still landed (approved again)
  });

  // (d) accept-edits: an out-of-project edit is granted SILENTLY (no card) and the write lands — the
  // auto pre-grant now covers accept-edits too (applyDirGrant path: silent, directory_added for
  // observability, flows straight to executeCall — no auto-only reviewer fires under accept-edits).
  test("under accept-edits, an out-of-project edit is granted silently (no card) and the write lands", async () => {
    const cwd = tmp("norma-op4-cwd-");
    const foo = tmp("norma-op4-foo-");
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op4-home-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider(writeTurn(join(foo, "x.txt"), "silent"));
    const { engine, store, sessionId, dirs } = setupEngine(provider, { registry, policy: "accept-edits" as any, cwd, permissionRules });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e: any) => e.type === "approval_requested")).toBe(false); // silent — no card
    expect(readFileSync(join(foo, "x.txt"), "utf8")).toBe("silent"); // the write landed
    expect((events.find((e: any) => e.type === "tool_result") as any).isError).toBe(false);
    // accept-edits rides the SILENT pre-grant seam (applyDirGrant → directory_added for observability):
    expect(events.some((e: any) => e.type === "directory_added" && (e as any).path === foo)).toBe(true);
    expect(dirs.has(sessionId, foo)).toBe(true);
  });

  // The dir-creation decision, proven: grant.dir is fsWriteOutOfRootDir's canonicalized PARENT,
  // which does NOT exist for a write to a deep new subtree. The write fence (resolveWithinAny) SKIPS
  // a not-yet-existing root, so without onApprove's mkdir the target would fall outside every
  // surviving root and the write would fail its own containment. onApprove mkdir's grant.dir first
  // (one-shot — NO dirs.add, NO directory_added), which is exactly what lets the approved write land.
  test("allow_once to a NOT-YET-EXISTING nested dir: onApprove mkdir's the grant dir so the write lands (one-shot, no directory_added)", async () => {
    const cwd = tmp("norma-op5-cwd-");
    const foo = tmp("norma-op5-foo-");
    const grantDir = join(foo, "newsub", "deeper"); // nothing below foo exists yet
    const target = join(grantDir, "file.txt");
    const projectRoot = repoRootFor(cwd);
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op5-home-") });
    const { registry } = stubRegistry();
    const provider = new FakeProvider(writeTurn(target, "deep"));
    const { engine, store, hub, broker, sessionId, dirs } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    // The card's rule option names the deep (not-yet-existing) parent as grant.dir:
    hub.attach(optionResponder(broker, permissionRules, sessionId, projectRoot, "allow_once"), sessionId, 0);

    await engine.runTurn(sessionId);
    const card = store.read(sessionId).find((e: any) => e.type === "approval_requested") as any;
    expect(card.options.find((o: any) => o.id === "allow_project")).toMatchObject({ rule: `Edit(${grantDir})` });
    expect(readFileSync(target, "utf8")).toBe("deep"); // the write LANDED — proves the onApprove mkdir ran
    expect(existsSync(grantDir)).toBe(true);
    expect(dirs.has(sessionId, grantDir)).toBe(false); // one-shot: never added to session roots
    expect(store.read(sessionId).some((e: any) => e.type === "directory_added")).toBe(false);
  });

  // Denial rides the SAME requestApproval deniedByHuman path unchanged: no write, no rule, no grant.
  test("Deny: nothing is written, no rule persisted, no grant", async () => {
    const cwd = tmp("norma-op6-cwd-");
    const foo = tmp("norma-op6-foo-");
    const projectRoot = repoRootFor(cwd);
    const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome: tmp("norma-op6-home-") });
    const { registry } = stubRegistry();
    const target = join(foo, "x.txt");
    const provider = new FakeProvider(writeTurn(target, "nope"));
    const { engine, store, hub, broker, sessionId, dirs } = setupEngine(provider, { registry, policy: "ask", cwd, permissionRules });
    hub.attach(optionResponder(broker, permissionRules, sessionId, projectRoot, "deny", false), sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(existsSync(target)).toBe(false);
    expect(permissionRules.rulesFor(projectRoot).project).toEqual([]);
    expect(dirs.has(sessionId, foo)).toBe(false);
    expect((events.find((e: any) => e.type === "tool_result") as any).isError).toBe(true);
  });
});
