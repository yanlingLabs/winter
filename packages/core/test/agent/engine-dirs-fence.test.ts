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
import { memoryDirFor, assistantMemoryDirFor } from "../../src/agent/memory-dir";
import { registerWorktreeTools } from "../../src/agent/tools/worktree";
import { WorktreeManager } from "../../src/agent/worktree";
import { repo } from "./engine-worktree.test";

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

/** MIRRORS daemon.ts's real `sessionDirs` baseDirs closure (T5 shape, T6-extended): the session's
 *  own row supplies the user directories, and the Norma-owned folds the daemon adds — the MEMDIR
 *  (keyed off the PRIMARY, mkdir'd on read) and the session's OUTDIR — are appended after them.
 *  The `primary` precedence (`meta.cwd ?? dirs[0]?.path`) is the SAME one the engine uses.
 *
 *  working-directories T6: a workdir-less session (`!primary`) now ALSO gets a MEMDIR folded in —
 *  the shared `_assistant` bucket (`assistantMemDirOf`) rather than a project-keyed one, since
 *  there is no project to key off. OUTDIR-first there, the reverse of the with-dirs ordering below
 *  — mirrors daemon.ts's own real closure: T5 pinned `$OUTDIR` as `roots[0]` for a primary-less
 *  session BEFORE this fold existed, and that pin must survive the fold. */
function daemonLikeDirs(store: SessionStore, home: string, memDirOf: (cwd: string) => string, assistantMemDirOf: () => string): SessionDirectories {
  return new SessionDirectories((sid) => {
    const meta = store.meta(sid);
    const row = store.dirs(sid);
    const primary = meta.cwd ?? row[0]?.path ?? null;
    const roots: string[] = [];
    if (primary) roots.push(primary);
    for (const d of row) roots.push(d.path);
    if (!primary) {
      roots.push(ensureOutdir(home, sid));
      const memDir = assistantMemDirOf();
      mkdirSync(memDir, { recursive: true });
      roots.push(memDir);
      return roots;
    }
    const memDir = memDirOf(primary);
    mkdirSync(memDir, { recursive: true });
    roots.push(memDir);
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
  /** true → the LEGACY roots closure (`() => [cwd]`, the pre-T5 shape every older engine test
   *  harness uses): knows nothing about the `dirs` row. Proves the row-derivation is the ENGINE's
   *  own behavior rather than something daemon.ts's wiring supplies. */
  legacyRoots?: boolean;
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
  const bashCwds: string[] = [];
  registry.register({
    name: "bash",
    description: "stub bash",
    args: z.object({ command: z.string() }),
    run({ command }, ctx) { bashCalls.push(command); bashCwds.push(ctx.cwd); return `ran: ${command}`; },
  });
  const provider = new FakeProvider(script);
  const memDirOf = (c: string) => memoryDirFor(c, { normaHome: home });
  const assistantMemDirOf = () => assistantMemoryDirFor({ normaHome: home });
  const dirs = opts?.legacyRoots ? new SessionDirectories(() => [cwd]) : daemonLikeDirs(store, home, memDirOf, assistantMemDirOf);
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
    memDirOf,
    assistantMemDirOf,
    grantDeniedPrefixes: [home],
  });
  const sessionId = store.createSession("global", {
    ...(opts?.withCwd === false ? {} : { cwd }),
    approvalPolicy: opts?.policy ?? "auto",
  });
  const events: SessionEvent[] = [];
  hub.attach({ clientName: "test-observer", deliver: (e) => { events.push(e); return true; } }, sessionId, 0);
  const setDirsDeps: SetDirsDeps = { store, grantDenied: () => false };
  return { engine, store, hub, broker, sessionId, cwd, home, dirs, events, registry, bashCalls, bashCwds, setDirsDeps, memDirOf, assistantMemDirOf };
}

/** Establishes an UNLOCKED primary in the row. Pre-T6 this was load-bearing: a session created
 *  with a cwd had NO `dirs` column, so T1's lazy migration derived its primary as
 *  grandfathered-LOCKED, and the T2 setter (correctly) refused to `setPrimary` over a locked
 *  entry — this helper was the only way to get an unlocked fixture out of `store.createSession`.
 *  T6 made `createSession` itself write an unlocked primary directly, so every call below is now
 *  an idempotent no-op for a session created WITH a cwd (this file's `setup()` default) — kept
 *  rather than stripped out, both because it stays load-bearing for the `withCwd: false` +
 *  `setDirsRaw`-only shapes elsewhere in this file and because a no-op re-assertion of the exact
 *  state under test costs nothing and keeps every call site below self-explanatory without having
 *  to know T6 shipped. `setDirsRaw` is the low-level column write this exercises directly (T1/T2's
 *  own tests use it the same way); no production code outside `set-dirs.ts` calls it. */
function establishUnlockedPrimary(store: SessionStore, sessionId: string, path: string): void {
  store.setDirsRaw(sessionId, [{ path, locked: false }]);
}

/** F2b's harness: a real git repo + WorktreeManager, the daemon-shaped roots closure, and a
 *  reviewer that BLOCKS whatever it sees — so "silent" is proved by the write landing. A
 *  non-isolated worktree lives at `<repoRoot>/.norma/worktrees/<name>`, which is why the dot rule
 *  and the classification anchor collide there. */
function setupWorktree(script: ProviderEvent[][]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-wt-home-")));
  const cwd = repo();
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const registry = new ToolRegistry();
  registerWriteTools(registry);
  registerWorktreeTools(registry);
  const dirs = daemonLikeDirs(store, home, (c) => memoryDirFor(c, { normaHome: home }), () => assistantMemoryDirFor({ normaHome: home }));
  const provider = new FakeProvider(script);
  const skillsHome = mkdtempSync(join(tmpdir(), "norma-dirs-fence-wt-skills-"));
  const trust = new TrustStore(join(skillsHome, "trust.json"));
  const engine = new AgentEngine({
    store, hub, registry,
    broker: new ApprovalBroker(),
    gate: new PermissionGate(),
    provider: { provider, model: "gated-1" },
    dirs,
    approvalTimeoutMs: 300,
    assembler: new ContextAssembler({ normaHome: skillsHome, trust, skills: new SkillStore({ normaHome: skillsHome, trust }) }),
    compactor: new Compactor({ provider: { provider, model: "gated-1" }, store, hub }),
    reviewer: stubReviewer({ verdict: "unsafe", reason: "would have blocked if consulted" }),
    outDirOf: (sid) => ensureOutdir(home, sid),
    memDirOf: (c) => memoryDirFor(c, { normaHome: home }),
    grantDeniedPrefixes: [home],
    worktrees: new WorktreeManager({ baseRef: () => "head" }),
  });
  const sessionId = store.createSession("global", { cwd, approvalPolicy: "auto" });
  return { engine, store, hub, sessionId, cwd, home };
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

  test("the fence widens from the ROW even when the roots closure knows nothing about it — row-derivation is the ENGINE's behavior, not the daemon's wiring", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-legacy-")));
    const target = join(added, "note.txt");
    // `legacyRoots`: the pre-T5 closure shape, `() => [cwd]`. The added dir reaches the fence ONLY
    // through `writableRoots`'s union with `store.dirs`. Under `ask`, an out-of-root write would
    // raise a grant card (denied here) — so a landed write with NO card is the proof.
    const { engine, store, hub, broker, sessionId, setDirsDeps } = setup(writeTurn(target, "row-derived"), {
      policy: "ask", legacyRoots: true,
    });
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);
    hub.attach({
      clientName: "auto-denier",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, false, "auto-denier"); return true; },
    }, sessionId, 0);

    await engine.runTurn(sessionId);
    expect(store.read(sessionId).some((e) => e.type === "approval_requested")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("row-derived");
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

// ── the LIVE primary in the classification set (F2b) ───────────────────────────────────────────

describe("working-directories T5: a non-isolated worktree stint classifies against the LIVE primary", () => {
  test("a plain write inside an entered worktree is SILENT — the worktree (not the row's repo root) anchors the dot rule, so `.norma/worktrees/…` is not read as a dotted escape", async () => {
    const script: ProviderEvent[][] = [];
    const { engine, store, hub, sessionId, cwd } = setupWorktree(script);
    // The row must be WRITTEN for this to bite: a never-written row derives from the `cwd` column,
    // which `enter_worktree` moves, so it follows the stint by itself. A picker/RPC/adopt-written
    // row does NOT move — that is the case where the anchor and the live primary diverge.
    establishUnlockedPrimary(store, sessionId, cwd);
    script.push(
      [{ type: "tool_call", callId: "e1", name: "enter_worktree", argsJson: JSON.stringify({ name: "feat" }) }, { type: "done", stopReason: "tool_calls" }],
      // The write round is appended by the observer below, once the worktree dir exists.
    );
    let wtDir = "";
    hub.attach({
      clientName: "wt-observer",
      deliver(e) {
        if (e.type === "worktree_entered" && !wtDir) {
          wtDir = (e as any).path as string;
          script.push(
            [{ type: "tool_call", callId: "w1", name: "write", argsJson: JSON.stringify({ path: "scratch.txt", content: "in the worktree" }) }, { type: "done", stopReason: "tool_calls" }],
            [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
          );
        }
        return true;
      },
    }, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(wtDir).not.toBe("");
    expect(wtDir).toContain(join(".norma", "worktrees")); // the collision's actual shape
    expect(events.some((e) => e.type === "tool_review")).toBe(false); // silent, exactly as pre-branch
    expect(readFileSync(join(wtDir, "scratch.txt"), "utf8")).toBe("in the worktree");
  });
});

// ── the MEMDIR anchor (wd-m14) ─────────────────────────────────────────────────────────────────

describe("working-directories T5: the always-silent MEMDIR is the one the fence actually folds (wd-m14)", () => {
  // The DISCRIMINATING case, deliberately chosen: the anchor must be the session's primary read
  // FRESH, not the dispatch loop's per-call `cwd`. A workdir-less session that ADOPTS a directory
  // mid-turn is where those two visibly disagree — the loop's `cwd` stays the session tmp dir for
  // the rest of the turn, while the roots closure immediately starts folding
  // `memoryDirOf(adopted)`. (The other divergence the T4 re-review named — a worktree-isolated
  // child — is vacuous: `rootsOverride` excludes the memdir from that child's fence entirely, so
  // no memdir write of its can even reach this classification.)
  test("a workdir-less session that adopted a primary mid-turn writes into THAT primary's MEMDIR silently — the anchor is the fresh primary, not the turn's tmp-dir cwd", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-memanchor-")));
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, memDirOf } = setup(script, {
      withCwd: false, policy: "auto", // auto: the grant is silent AND the fs reviewer is live
      reviewer: { verdict: "unsafe", reason: "would have blocked if consulted" },
    });
    // c1 adopts `outside` as the primary (the silent auto pre-grant) and is itself reviewed — it
    // was out-of-root when it ran. c2 then writes a memory file into the MEMDIR that adoption just
    // folded into the fence; that one must be silent.
    script.push(
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: join(outside, "first.txt"), content: "adopted" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: join(memDirOf(outside), "notes.md"), content: "remembered" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    );

    await engine.runTurn(sessionId);
    const reviews = store.read(sessionId).filter((e) => e.type === "tool_review") as any[];
    expect(store.dirs(sessionId)).toEqual([{ path: outside, locked: true }]); // adoption happened
    // EXACTLY one review — c1's. A second one means the MEMDIR exemption named the wrong directory
    // (the turn's tmp-dir cwd instead of the freshly-adopted primary), which is wd-m14 itself.
    expect(reviews.length).toBe(1);
    expect(reviews[0].summary).toContain(join(outside, "first.txt"));
    expect(readFileSync(join(memDirOf(outside), "notes.md"), "utf8")).toBe("remembered");
  });
});

// ── the adoption matrix (fix round 1, controller ruling 2026-08-04) ────────────────────────────
//
// ADOPTION ⇔ ESTABLISHING A PRIMARY ON AN EMPTY SET, uniform across policies:
//   - workdir-less session (dirs = []): every door adopts — the silent auto/accept-edits/bypass
//     pre-grant AND the ask card — because the workdir-less arc REQUIRES exiting the mode, and the
//     granting write is the dir's first write, so it is born locked.
//   - with-dirs session: NO door adopts today. The silent pre-grant keeps its pre-branch shape (a
//     process-local grant; every write into it stays reviewable under auto — task-24 review F1),
//     and the ask card stays one-shot (SP-policies Task 9). Widening a session that already has
//     working directories must be a deliberate HUMAN act, which is the 4th-card-option follow-up.

describe("working-directories T5: the adoption matrix", () => {
  test("WITH-DIRS + auto: the silent pre-grant adopts NOTHING — the row is unchanged and EVERY write into the granted dir stays reviewable (task-24 review F1)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-withdirs-auto-")));
    const target1 = join(outside, "one.txt");
    const target2 = join(outside, "two.txt");
    const { engine, store, sessionId, cwd } = setup([
      [{ type: "tool_call", callId: "c1", name: "write", argsJson: JSON.stringify({ path: target1, content: "one" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "tool_call", callId: "c2", name: "write", argsJson: JSON.stringify({ path: target2, content: "two" }) }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }],
    ], { policy: "auto", reviewer: { verdict: "safe", reason: "fine" } });

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    // The grant still WORKS (both writes land, silently, no card) — it is just not durable state.
    expect(readFileSync(target1, "utf8")).toBe("one");
    expect(readFileSync(target2, "utf8")).toBe("two");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.filter((e) => e.type === "directory_added").length).toBe(1); // granted once, process-local
    // THE ruling: the row is untouched, so the user is never left with a widening no human
    // authorized (and, born-locked, could never have removed).
    expect(store.dirs(sessionId).map((d) => d.path)).toEqual([cwd]);
    // …and BOTH writes rode the fs reviewer — under auto it is the only out-of-root safety net
    // there is, and a silent grant must never be able to switch it off for the rest of the session.
    const reviews = events.filter((e) => e.type === "tool_review") as any[];
    expect(reviews.length).toBe(2);
    expect(reviews[0].summary).toContain(target1);
    expect(reviews[1].summary).toContain(target2);
  });

  test("WITH-DIRS + ask: an APPROVED grant card adopts nothing either — one-shot stays one-shot (SP-policies Task 9)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-withdirs-ask-")));
    const target = join(outside, "approved.txt");
    const { engine, store, hub, broker, sessionId, cwd } = setup(writeTurn(target, "approved"), { policy: "ask" });
    hub.attach({
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    }, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const card = events.find((e) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();
    expect(readFileSync(target, "utf8")).toBe("approved");   // the one-shot write lands
    expect(store.dirs(sessionId).map((d) => d.path)).toEqual([cwd]); // and adopts nothing
    expect(events.some((e) => e.type === "directory_added")).toBe(false);
    // …and the CARD SAID SO. The wording pin lives in the same test as the behavior pin on purpose:
    // an approval card that misdescribes what approving does is a defect even when the behavior is
    // right, and these two can only drift apart if someone edits them both.
    expect(card.summary).toContain("outside your project");            // still the grant seam's marker
    expect(card.summary).toContain("for this request");
    expect(card.summary).toContain("does not add a working directory");
    expect(card.summary).not.toMatch(/adds it as a working directory/i); // no adoption language
    expect(card.summary).not.toMatch(/permanent/i);
    expect(card.options?.[0]).toEqual({ id: "allow_once", label: "Allow once" });
  });

  test("WORKDIR-LESS + auto: the SILENT pre-grant DOES adopt — as the primary, born locked, exiting the mode (the empty-set rule)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-wdless-auto-")));
    const target = join(outside, "adopted.txt");
    const { engine, store, sessionId } = setup(writeTurn(target, "adopted"), { withCwd: false, policy: "auto" });
    expect(store.dirs(sessionId)).toEqual([]);

    await engine.runTurn(sessionId);
    expect(readFileSync(target, "utf8")).toBe("adopted");
    expect(store.dirs(sessionId)).toEqual([{ path: outside, locked: true }]);
    expect(store.read(sessionId).some((e) => e.type === "approval_requested")).toBe(false); // silent, per policy
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

// ── first-write locks (spec §1) ────────────────────────────────────────────────────────────────

describe("working-directories T5: first-write locks", () => {
  test("a write locks its CONTAINING directory only — the added dir locks, the primary stays unlocked", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-lock-added-")));
    const { engine, store, sessionId, cwd, setDirsDeps } = setup(writeTurn(join(added, "f.txt"), "x"), { policy: "auto" });
    establishUnlockedPrimary(store, sessionId, cwd);
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);

    await engine.runTurn(sessionId);
    expect(store.dirs(sessionId)).toEqual([
      { path: cwd, locked: false },   // never written in — untouched
      { path: added, locked: true },  // the write landed here
    ]);
  });

  test("a write in the PRIMARY locks the primary (and nothing else)", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-lock-primary-")));
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, cwd, setDirsDeps } = setup(script, { policy: "auto" });
    script.push(...writeTurn(join(cwd, "f.txt"), "x"));
    establishUnlockedPrimary(store, sessionId, cwd);
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);

    await engine.runTurn(sessionId);
    expect(store.dirs(sessionId)).toEqual([
      { path: cwd, locked: true },
      { path: added, locked: false },
    ]);
  });

  test("a write that FAILS INSIDE THE TOOL locks nothing — the lock records a fact, and a write that didn't land is not one", async () => {
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, cwd } = setup(script, { policy: "auto" });
    // In-root (no card, no grant) and it reaches the tool — which then fails: `edit` of a file
    // that doesn't exist. This is the call shape that actually exercises the `!result.isError`
    // gate; a DENIED call (the test below) never reaches executeCall at all.
    script.push([
      { type: "tool_call", callId: "c1", name: "edit", argsJson: JSON.stringify({ path: join(cwd, "missing.txt"), old_string: "a", new_string: "b" }) },
      { type: "done", stopReason: "tool_calls" },
    ], [{ type: "text_delta", delta: "done" }, { type: "done", stopReason: "end_turn" }]);
    establishUnlockedPrimary(store, sessionId, cwd);

    await engine.runTurn(sessionId);
    expect((store.read(sessionId).find((e) => e.type === "tool_result") as any).isError).toBe(true);
    expect(store.dirs(sessionId)).toEqual([{ path: cwd, locked: false }]);
  });

  test("a DENIED write locks nothing (it never reaches the tool at all)", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-lock-fail-")));
    const { engine, store, sessionId, cwd, setDirsDeps } = setup(
      // `plan` policy denies every mutating call — the tool_result is an error, nothing is written.
      writeTurn(join(outside, "f.txt"), "x"), { policy: "ask" },
    );
    establishUnlockedPrimary(store, sessionId, cwd);
    // No approver attached → the grant card times out → denial → the write never runs.
    await engine.runTurn(sessionId);
    expect((store.read(sessionId).find((e) => e.type === "tool_result") as any).isError).toBe(true);
    expect(store.dirs(sessionId)).toEqual([{ path: cwd, locked: false }]);
  });

  test("a successful bash run locks the PRIMARY only — an added dir stays unlocked after it", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-lock-bash-")));
    const { engine, store, sessionId, cwd, bashCalls, setDirsDeps } = setup(bashTurn("echo hi"), { policy: "auto" });
    establishUnlockedPrimary(store, sessionId, cwd);
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);

    await engine.runTurn(sessionId);
    expect(bashCalls).toEqual(["echo hi"]); // it really ran
    expect(store.dirs(sessionId)).toEqual([
      { path: cwd, locked: true },     // bash executes in the primary
      { path: added, locked: false },  // bash says nothing about the added dirs
    ]);
  });

  test("a read-only turn locks NOTHING — reading never locks (spec §1)", async () => {
    const added = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-lock-read-")));
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, cwd, setDirsDeps } = setup(script, { policy: "auto" });
    mkdirSync(join(cwd, "sub"), { recursive: true });
    Bun.write(join(cwd, "sub", "readme.txt"), "hello");
    script.push(...readTurn(join(cwd, "sub", "readme.txt")));
    establishUnlockedPrimary(store, sessionId, cwd);
    expect(setSessionDirs(setDirsDeps, sessionId, "add", added).ok).toBe(true);

    await engine.runTurn(sessionId);
    expect((store.read(sessionId).find((e) => e.type === "tool_result") as any).isError).toBe(false);
    expect(store.dirs(sessionId).every((d) => d.locked === false)).toBe(true);
  });
});

// ── workdir-less mode (spec §2) ────────────────────────────────────────────────────────────────

describe("working-directories T5: workdir-less sessions", () => {
  test("a dirs=[] session runs turns at all — and its shell starts in the session tmp dir (scratch by default)", async () => {
    const { engine, store, sessionId, bashCalls, bashCwds } = setup(bashTurn("echo hi"), { withCwd: false, policy: "auto" });
    expect(store.dirs(sessionId)).toEqual([]); // workdir-less

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "agent_error")).toBe(false); // no "session has no working directory"
    expect(bashCalls).toEqual(["echo hi"]);
    expect(bashCwds).toEqual([sessionTmpDir(sessionId)]);
    expect(store.dirs(sessionId)).toEqual([]); // bash in the tmp dir locks nothing — there is nothing to lock
  });

  test("a dirs=[] session writes into its $OUTDIR silently — no card, no review, no adoption (Norma-owned space is not a working directory)", async () => {
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, home } = setup(script, {
      withCwd: false, policy: "auto",
      reviewer: { verdict: "unsafe", reason: "would have blocked if consulted" },
    });
    const target = join(ensureOutdir(home, sessionId), "deliverable.txt");
    script.push(...writeTurn(target, "for the user"));

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "directory_added")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("for the user");
    expect(store.dirs(sessionId)).toEqual([]); // still workdir-less: the outdir is never a session dir
  });

  // working-directories T6 (spec §2: "MEMDIR for workdir-less sessions: the shared `_assistant`
  // bucket") — the SAME pin shape as the $OUTDIR test just above, for the OTHER Norma-owned space a
  // workdir-less session now has: writable, silent (no card, no review, no adoption), and never a
  // session dir of its own.
  test("a dirs=[] session writes into its shared _assistant MEMDIR silently — no card, no review, no adoption", async () => {
    const script: ProviderEvent[][] = [];
    const { engine, store, sessionId, assistantMemDirOf } = setup(script, {
      withCwd: false, policy: "auto",
      reviewer: { verdict: "unsafe", reason: "would have blocked if consulted" },
    });
    mkdirSync(assistantMemDirOf(), { recursive: true }); // realpath-consistent, mirroring ensureOutdir's own contract
    const target = join(assistantMemDirOf(), "notes.md");
    script.push(...writeTurn(target, "remembered"));

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    expect(events.some((e) => e.type === "tool_review")).toBe(false);
    expect(events.some((e) => e.type === "directory_added")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("remembered");
    expect(store.dirs(sessionId)).toEqual([]); // still workdir-less: the MEMDIR is never a session dir
  });

  test("the whole arc: a user-fs write CARDS, approving ADOPTS it as the primary (born locked), and the mode is exited — the next turn's relative paths resolve there", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "norma-dirs-fence-adopt-primary-")));
    const script: ProviderEvent[][] = [];
    const { engine, store, hub, broker, sessionId } = setup(script, { withCwd: false, policy: "ask" });
    script.push(...writeTurn(join(outside, "first.txt"), "adopted"));
    hub.attach({
      clientName: "auto-approver",
      deliver(e) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
    }, sessionId, 0);

    await engine.runTurn(sessionId);
    const events = store.read(sessionId);
    const card = events.find((e) => e.type === "approval_requested") as any;
    expect(card).toBeDefined();                          // ONE card, the same dirGrant card
    expect(card.summary).toContain(join(outside, "first.txt"));
    // The wording pin, beside the behavior it describes (see the with-dirs card's own pin for why):
    // this card DOES promise adoption, because this one really adopts.
    expect(card.summary).toMatch(/adds it as a working directory/i);
    expect(card.summary).toContain("permanent once written");
    expect(card.summary).not.toContain("outside your project"); // a workdir-less session has no project
    expect(card.options?.[0]).toEqual({ id: "allow_once", label: "Allow and add as working directory" });
    expect(readFileSync(join(outside, "first.txt"), "utf8")).toBe("adopted");
    // Adopted as the PRIMARY (the empty-set rule) and BORN LOCKED (the approved write is its first).
    expect(store.dirs(sessionId)).toEqual([{ path: outside, locked: true }]);

    // Mode exited: the NEXT turn runs in the adopted directory — a relative path lands there, with
    // no card of its own (it is now an ordinary in-primary write).
    script.push(...writeTurn("second.txt", "in the adopted primary"));
    await engine.runTurn(sessionId);
    expect(readFileSync(join(outside, "second.txt"), "utf8")).toBe("in the adopted primary");
    expect((store.read(sessionId).filter((e) => e.type === "approval_requested")).length).toBe(1); // still just the one
  });
});
