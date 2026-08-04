import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { SessionEvent } from "@norma/protocol";
import type { HubClient } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerReadTools } from "../../src/agent/tools/fs-read";
import { registerWriteTools } from "../../src/agent/tools/fs-write";
import { PermissionGate } from "../../src/agent/gate";
import { ApprovalBroker } from "../../src/agent/approvals";
import { AgentEngine } from "../../src/agent/engine";
import { SessionDirectories } from "../../src/agent/dirs";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";
import { Compactor } from "../../src/agent/compactor";
import type { BashReviewer, ReviewInput } from "../../src/agent/reviewer";
import { sessionTmpDir } from "../../src/agent/session-tmp";
import { ensureOutdir } from "../../src/sessions/outdir";
import { setSessionDirs, lockDir, type SetDirsDeps } from "../../src/sessions/set-dirs";

/**
 * working-directories T5 — the generalized write fence, driven through REAL engine turns.
 *
 * Every test here runs `engine.runTurn()` against a FakeProvider script: the classification,
 * grant, adopt and lock behaviors all live in the dispatch loop / executeCall, and the
 * direct-registry shortcut (calling a tool's `run()` with hand-built roots) is BANNED for this
 * task — it is exactly the blindness class that shipped two bugs on this project already.
 */

// ── harness ────────────────────────────────────────────────────────────────────────────────────

/** working-directories T4 re-review (wd-m13): an UNWANTED safety review escalates to an approval
 *  card whose wait is `NORMA_REVIEW_APPROVAL_TIMEOUT_MS ?? 60_000` — NOT the engine's own
 *  `approvalTimeoutMs`. Left at the default, every "this must be SILENT" test here would fail by
 *  riding bun's 5s per-test timeout (an opaque framework failure) instead of by its own assertion.
 *  Pinned tiny for this file so a regression fails CLEANLY: the review resolves (denied) in
 *  milliseconds, the write doesn't land, and the readFileSync/tool_review assertions are what
 *  report the break. */
const REVIEW_TIMEOUT_ENV = "NORMA_REVIEW_APPROVAL_TIMEOUT_MS";
let prevReviewTimeout: string | undefined;
beforeAll(() => { prevReviewTimeout = process.env[REVIEW_TIMEOUT_ENV]; process.env[REVIEW_TIMEOUT_ENV] = "20"; });
afterAll(() => {
  if (prevReviewTimeout === undefined) delete process.env[REVIEW_TIMEOUT_ENV];
  else process.env[REVIEW_TIMEOUT_ENV] = prevReviewTimeout;
});

/** MIRRORS daemon.ts's real `sessionDirs` baseDirs closure (T5 shape): the session's own row
 *  supplies the user directories, and the two Norma-owned folds the daemon adds — the MEMDIR (not
 *  wired here: no memory dir in this harness) and the session's OUTDIR — are appended after them.
 *  The `primary` precedence (`meta.cwd ?? dirs[0]?.path`) is the SAME one the engine uses. */
function daemonLikeDirs(store: SessionStore, home: string): SessionDirectories {
  return new SessionDirectories((sid) => {
    const meta = store.meta(sid);
    const row = store.dirs(sid);
    const primary = meta.cwd ?? row[0]?.path ?? null;
    const roots: string[] = [];
    if (primary) roots.push(primary);
    for (const d of row) roots.push(d.path);
    roots.push(ensureOutdir(home, sid));
    return roots;
  });
}

function stubReviewer(v: { verdict: "safe" | "unsafe"; reason: string }): BashReviewer {
  return { review: async (_input: ReviewInput) => ({ verdict: v.verdict, reason: v.reason }) } as unknown as BashReviewer;
}

/** One round: the model calls `write(path, content)`, then a round that ends the turn. */
function writeTurn(path: string, content: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path, content }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** Same shape for the stub bash tool below. */
function bashTurn(command: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "bash", argsJson: JSON.stringify({ command }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** One round: the model calls `read(path)`, then a round that ends the turn. */
function readTurn(path: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "read", argsJson: JSON.stringify({ path }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
  ];
}

function setup(script: ProviderEvent[][], opts?: {
  policy?: "ask" | "auto";
  reviewer?: { verdict: "safe" | "unsafe"; reason: string };
  /** false → the session is created with NO cwd (workdir-less). */
  withCwd?: boolean;
}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-home-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-cwd-")));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  // A stub bash (NOT the real sandboxed one) — the lock hook under test lives in executeCall and
  // fires on the tool NAME, so a stub proves it without shelling out to sandbox-exec.
  const bashCalls: string[] = [];
  registry.register({
    name: "bash",
    description: "stub bash",
    args: z.object({ command: z.string() }),
    run({ command }) { bashCalls.push(command); return `ran: ${command}`; },
  });
  const provider = new FakeProvider(script);
  const dirs = daemonLikeDirs(store, home);
  const broker = new ApprovalBroker();
  const skillsHome = mkdtempSync(join(tmpdir(), "norma-dirs-fence-skills-"));
  const skills = new SkillStore({ normaHome: skillsHome, trust: new TrustStore(join(skillsHome, "trust.json")) });
  const assembler = new ContextAssembler({ normaHome: skillsHome, trust: new TrustStore(join(skillsHome, "trust.json")), skills });
  const engine = new AgentEngine({
    store, hub, registry, broker,
    gate: new PermissionGate(),
    provider: { provider, model: "gated-1" },
    dirs,
    approvalTimeoutMs: 300,
    assembler,
    compactor: new Compactor({ provider: { provider, model: "gated-1" }, store, hub }),
    reviewer: opts?.reviewer ? stubReviewer(opts.reviewer) : undefined,
    // The daemon's own wiring: the outputs dir is a blessed Norma-owned space, and `home` (this
    // harness's NORMA_HOME) is the grant denylist exactly as daemon.ts passes `[normaHome]`.
    outDirOf: (sid) => ensureOutdir(home, sid),
    grantDeniedPrefixes: [home],
  });
  const sessionId = store.createSession("global", {
    ...(opts?.withCwd === false ? {} : { cwd }),
    approvalPolicy: opts?.policy ?? "auto",
  });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  const setDirsDeps: SetDirsDeps = { store, grantDenied: () => false };
  return { engine, store, hub, broker, sessionId, cwd, home, dirs, events, registry, bashCalls, setDirsDeps };
}

/** Establishes an UNLOCKED primary in the row (the T2 setter, the one writer). Sessions created
 *  today still derive their primary from the `cwd` column, which the T1 migration grandfathers as
 *  LOCKED — T6 makes create write the column unlocked. Tests that care about lock TRANSITIONS
 *  must therefore write the column first, through the setter. */
function establishUnlockedPrimary(deps: SetDirsDeps, sessionId: string, path: string): void {
  const res = setSessionDirs(deps, sessionId, "setPrimary", path);
  if (!res.ok) throw new Error(`test setup failed: ${res.error}`);
}

// ── the fence table (spec §2) ──────────────────────────────────────────────────────────────────

describe("working-directories T5: the generalized write fence", () => {
  test("a write inside an ADDED (row) directory is silent-plain — no grant card, no safety review, the write lands", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-added-")));
    const target = join(added, "note.txt");
    // The reviewer would BLOCK if it were ever consulted — so a landed write proves silence.
    const { engine, store, sessionId, setDirsDeps } = setup(writeTurn(target, "added-dir content"), {
      policy: "auto",
      reviewer: { verdict: "unsafe", reason: "would have blocked if consulted" },
    });
    const res = setSessionDirs(setDirsDeps, sessionId, "add", added);
    expect(res.ok).toBe(true);
    lockDir(setDirsDeps, sessionId, added); // the dirGrant-adopted shape: born locked

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);       // never reviewed
    expect(events.some((e) => e.type === "approval_requested")).toBe(false); // never carded
    expect(events.some((e) => e.type === "directory_added")).toBe(false);    // never granted (already a session dir)
    expect(readFileSync(target, "utf8")).toBe("added-dir content");
  });

  test("an UNLOCKED added directory is silent too — lock state is UX permanence, not a fence input (spec §2: 'inside ANY session directory: silent')", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-added-unlocked-")));
    const target = join(added, "note.txt");
    const { engine, store, sessionId, setDirsDeps } = setup(writeTurn(target, "unlocked-added"), {
      policy: "auto",
      reviewer: { verdict: "unsafe", reason: "would have blocked if consulted" },
    });
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true); // added, NOT locked
    expect(store.dirs(sessionId).find((d) => d.path === added)?.locked).toBe(false);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("unlocked-added");
  });

  test("a DOTTED path inside an added directory still gets the safety review — the dot rule is anchored per-dir, not only at the primary", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-added-dotted-")));
    const target = join(added, ".ssh", "config");
    const { engine, store, sessionId, setDirsDeps } = setup(writeTurn(target, "Host evil"), {
      policy: "auto",
      reviewer: { verdict: "safe", reason: "dotted, but fine" },
    });
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);
    lockDir(setDirsDeps, sessionId, added);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const review = events.find((e) => e.type === "tool_review") as any;
    expect(review).toMatchObject({ toolName: "write", verdict: "safe" });
    expect(review.summary).toContain(target);
    expect(readFileSync(target, "utf8")).toBe("Host evil"); // safe verdict → still executes
  });

  test("a write OUTSIDE every session directory still raises the dirGrant card under ask", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-outside-")));
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-added-other-")));
    const target = join(outside, "nope.txt");
    const { engine, store, hub, broker, sessionId, setDirsDeps } = setup(writeTurn(target, "x"), { policy: "ask" });
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true); // a DIFFERENT added dir

    hub.attach({
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    }, sessionId, 0);
    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const card = events.find((e) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();
    expect(card.summary).toContain(outside);
    expect(existsSync(target)).toBe(false); // denied → nothing written
  });
});

// ── adopt-on-grant (spec §1: "a dirGrant-adopted directory is born locked") ─────────────────────

describe("working-directories T5: the dirGrant approval adopts into the row", () => {
  test("auto-policy grant lands the directory in the ROW, born LOCKED — and a second write there is then silent-plain", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-adopt-")));
    const target1 = join(outside, "one.txt");
    const target2 = join(outside, "two.txt");
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target1, content: "one" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: target2, content: "two" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ], { policy: "auto" });

    await engine.runTurn(sessionId);

    // THE assertion this task exists for: the grant is durable state on the session row, not an
    // in-memory SessionDirectories entry that dies with the daemon.
    const row = store.dirs(sessionId);
    expect(row.map((d) => d.path)).toEqual([cwd, outside]);
    expect(row[1]).toMatchObject({ path: outside, locked: true }); // BORN locked — the approved write is its first write
    expect(readFileSync(target1, "utf8")).toBe("one");
    expect(readFileSync(target2, "utf8")).toBe("two");
    // The dir joined the set once; the second write rode it as an ordinary session dir.
    const events = store.read(sessionId);
    expect(events.filter((e) => e.type === "directory_added").length).toBe(1);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  test("the GRANTING write still rides the fs reviewer (task-24 F1 invariant); only the NEXT write into the now-adopted dir is silent", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-grantfirst-")));
    const { engine, store, sessionId } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: join(outside, "one.txt"), content: "one" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: join(outside, "two.txt"), content: "two" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ], { policy: "auto", reviewer: { verdict: "safe", reason: "fine" } });

    await engine.runTurn(sessionId);
    const reviews = store.read(sessionId).filter((e) => e.type === "tool_review") as any[];
    // EXACTLY one: c1 (out-of-root at the moment it ran — a dir adopted BY a call must not
    // retroactively make that same call ordinary, or `auto`'s only out-of-root safety net is gone);
    // c2 rode the row and was silent.
    expect(reviews.length).toBe(1);
    expect(reviews[0].summary).toContain(join(outside, "one.txt"));
    expect(readFileSync(join(outside, "two.txt"), "utf8")).toBe("two");
  });

  test("a grant-denied directory is never adopted — hard error, nothing in the row (the denylist is one predicate for both doors)", async () => {
    // The script is the SAME array FakeProvider holds (by reference), so the target — which needs
    // `home`, minted inside setup() — can be filled in after construction, before runTurn reads it.
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, home, cwd } = setup(script, { policy: "auto" });
    script.push(...writeTurn(join(home, "sessions", "evil.txt"), "x")); // inside NORMA_HOME = grantDeniedPrefixes
    await engine.runTurn(sessionId);
    const result = store.read(sessionId).find((e) => e.type === "tool_result") as any;
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/never be granted/);
    expect(store.dirs(sessionId).map((d) => d.path)).toEqual([cwd]); // untouched
  });
});
