import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { PermissionRules } from "../../src/agent/permission-rules";
import { repoRootFor } from "../../src/agent/memory-dir";
import { setupEngine } from "./engine-steer.test";
import { stubRegistry, bashTurn, writeTurn, stubReviewer } from "./engine-reviewer.test";

// SP-policies Task 12 — the exhaustive policy × tool × floor matrix (SECURITY PIN).
//
// This file adds NO production code. It CODIFIES the whole cross-product of {6 approval modes} ×
// {representative tool call} × {rule-state} that Tasks 1–11 already implement and shipped green, so
// a future edit can't silently open a hole in one cell without a test turning red. Every row drives
// the REAL dispatch loop (setupEngine — the same harness engine-reviewer.test.ts /
// permission-gate-order.test.ts / policy-*.test.ts all use), never a gate/helper in isolation.
//
// Each cell's outcome is one of:
//   ran          — the tool executed; no card, no denial (review state unspecified)
//   ran-silent   — executed with NO approval_requested AND NO tool_review (the strongest "clean run")
//   carded       — an approval_requested (human card) fired
//   denied       — an isError tool_result, no card, the tool did NOT run
//   reviewed-ran — a tool_review fired, no card, the tool ran (auto + a "safe" verdict)
//   reviewed-card— a tool_review fired AND a card fired (auto + a "non-safe" verdict escalates)
//
// TWO plan-mode cells were DRIVEN (not assumed) and pin what the code ACTUALLY does. (A) is a
// DELIBERATE, shipped divergence from a literal reading of the spec's matrix (not a defect); (B) is
// NOT a divergence — an earlier spec draft's matrix read "denied", but the spec was CORRECTED to say
// plan CARDS, so the code is confirmed correct per the (corrected) spec. Documented at each row:
//   (A) read-row / plan: a readonly bash `cat f` is DENIED under plan (not "ran"). `bash` is
//       MUTATING at the gate (gate.ts) and plan denies all mutating tools BEFORE the readOnlyBash
//       classifier is ever consulted (that classifier only runs inside the `decision === "ask"`
//       ruleAllowed block). The genuinely read-only `read` TOOL (READ_ONLY at the gate) DOES run in
//       every mode incl. plan — pinned separately — which is what the row's "reads are free" intent
//       is really about.
//   (B) web_fetch-row / plan: a dangerous-domain web_fetch with no rule CARDS under plan. CONFIRMED
//       CORRECT per the (corrected) spec — the earlier draft's matrix read "denied", but the spec was
//       corrected to say plan CARDS, matching the code (so this is NOT a divergence). gate.ts's
//       NETWORK class is unconditionally "allow" (web tools free for research even in plan); the
//       dangerous-domain floor is a CARD, not a deny, under every mode except dont-ask (deny) and
//       bypass (silent). This exactly matches the SHIPPED, already-green permission-gate-order.test.ts
//       scenario 10 ("under PLAN policy the dangerous-domain card STILL fires").

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

type Mode = "plan" | "dont-ask" | "ask" | "accept-edits" | "auto" | "bypass";

type Expect = "ran" | "ran-silent" | "carded" | "denied" | "reviewed-ran" | "reviewed-card";
type TR = { isError: boolean; output: string } | undefined;
type Obs = { carded: boolean; reviewed: boolean; ran: boolean; isError: boolean; output: string };
type Cell = { registry?: ToolRegistry; provider: FakeProvider; ran: (result: TR) => boolean };

// transfer.sh is on dangerous-domains.ts's SHIPPED list (anonymous one-shot upload host — exfil
// risk); its floor fires under every mode with no rule (permission-gate-order.test.ts scenario 10).
const DANGEROUS_URL = "https://transfer.sh/x";

/** A stub `read` turn (setupEngine registers the REAL read tool, so this just calls it). */
function readTurn(path: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "read", argsJson: JSON.stringify({ path }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** A stub `web_fetch` tool (NOT the network-backed one) — records the fetched URL, no live network.
 *  Mirrors policy-bypass-floors.test.ts's stubWebFetchRegistry: the dangerous-domain floor lives in
 *  the engine (webFetchGate, keyed on `call.name === "web_fetch"`), so a stub tool exercises it fine. */
function stubWebFetchRegistry(): { registry: ToolRegistry; calls: string[] } {
  const registry = new ToolRegistry();
  const calls: string[] = [];
  registry.register({
    name: "web_fetch",
    description: "stub web_fetch",
    args: z.object({ url: z.string() }),
    run({ url }) { calls.push(url); return `fetched: ${url}`; },
  });
  return { registry, calls };
}
function fetchTurn(url: string): ProviderEvent[][] {
  return [
    [{ type: "tool_call", callId: "c1", name: "web_fetch", argsJson: JSON.stringify({ url }) }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", delta: "ok" }, { type: "done", stopReason: "end_turn" }],
  ];
}

/** Drive ONE cell: build the tool call for `mode`, run the real turn, observe the outcome.
 *  An always-approve watcher answers any card (so a "carded" cell resolves instantly instead of
 *  waiting out the 500ms broker timeout, and an approved call proceeds to execution) — mirrors
 *  permission-gate-order.test.ts's `approver` idiom. */
async function driveCell(mode: Mode, opts: {
  build: (cwd: string) => Cell;
  rule?: string;
  reviewerVerdict?: "safe" | "unsafe";
  dangerousDomainsAdded?: string[];
}): Promise<Obs> {
  const cwd = tmp("norma-mx-cwd-");
  const normaHome = tmp("norma-mx-home-");
  const cell = opts.build(cwd);
  const permissionRules = new PermissionRules({
    globalAllow: () => (opts.rule ? [opts.rule] : []),
    normaHome,
  });
  const reviewerBundle = opts.reviewerVerdict ? stubReviewer(opts.reviewerVerdict) : undefined;
  const { engine, store, hub, broker, sessionId } = setupEngine(cell.provider, {
    registry: cell.registry,
    policy: mode as any,
    cwd,
    permissionRules,
    reviewer: reviewerBundle ? (reviewerBundle.reviewer as any) : undefined,
    dangerousDomainsAdded: opts.dangerousDomainsAdded,
  });
  hub.attach({
    clientName: "auto-approver",
    deliver(e: any) { if (e.type === "approval_requested") broker.resolve(sessionId, e.callId, true, "auto-approver"); return true; },
  }, sessionId, 0);
  await engine.runTurn(sessionId);
  const events = store.read(sessionId);
  const result = events.find((e) => e.type === "tool_result") as any as TR;
  return {
    carded: events.some((e) => e.type === "approval_requested"),
    reviewed: events.some((e) => e.type === "tool_review"),
    ran: cell.ran(result),
    isError: !!result?.isError,
    output: result?.output ?? "",
  };
}

/** Assert one cell against its expected outcome. The `mode`/`expected` are folded into the compared
 *  object so a failure diff pinpoints exactly WHICH cell drifted (e.g. `{ mode: "plan", ... }`). */
function assertCell(mode: Mode, expected: Expect, o: Obs): void {
  switch (expected) {
    case "ran":
      expect({ mode, expected, carded: o.carded, ran: o.ran, isError: o.isError })
        .toEqual({ mode, expected, carded: false, ran: true, isError: false });
      return;
    case "ran-silent":
      expect({ mode, expected, carded: o.carded, reviewed: o.reviewed, ran: o.ran, isError: o.isError })
        .toEqual({ mode, expected, carded: false, reviewed: false, ran: true, isError: false });
      return;
    case "carded":
      expect({ mode, expected, carded: o.carded }).toEqual({ mode, expected, carded: true });
      return;
    case "denied":
      expect({ mode, expected, carded: o.carded, ran: o.ran, isError: o.isError })
        .toEqual({ mode, expected, carded: false, ran: false, isError: true });
      return;
    case "reviewed-ran":
      expect({ mode, expected, reviewed: o.reviewed, carded: o.carded, ran: o.ran, isError: o.isError })
        .toEqual({ mode, expected, reviewed: true, carded: false, ran: true, isError: false });
      return;
    case "reviewed-card":
      expect({ mode, expected, reviewed: o.reviewed, carded: o.carded })
        .toEqual({ mode, expected, reviewed: true, carded: true });
      return;
  }
}

// Per-row expectation tables — one entry PER MODE, every cell explicit (a missed cell is a silent
// hole, so the coverage is visually auditable). `Row` pairs each mode with its pinned outcome.
type Row = readonly (readonly [Mode, Expect])[];

describe("SP-policies Task 12: policy × tool × floor matrix", () => {
  // ── READ ────────────────────────────────────────────────────────────────────────────────────
  test("read TOOL: runs in EVERY mode (reads are unrestricted, plan included)", async () => {
    const row: Row = [
      ["plan", "ran"], ["dont-ask", "ran"], ["ask", "ran"],
      ["accept-edits", "ran"], ["auto", "ran"], ["bypass", "ran"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        build: (cwd) => {
          const marker = "READ-MARKER-CONTENT";
          const path = join(cwd, "f.txt");
          writeFileSync(path, marker);
          return { provider: new FakeProvider(readTurn(path)), ran: (r) => !!r && !r.isError && r.output.includes(marker) };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  test("readonly bash `cat f`: runs in every mode EXCEPT plan — DENIED under plan (bash is command-agnostic MUTATING at the gate; the readOnlyBash classifier only runs on `ask`, never overriding plan's blanket deny)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "ran-silent"], ["ask", "ran-silent"],
      ["accept-edits", "ran-silent"], ["auto", "ran-silent"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        build: () => {
          const { registry, calls } = stubRegistry();
          return { registry, provider: new FakeProvider(bashTurn("cat f")), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── IN-PROJECT WRITE ──────────────────────────────────────────────────────────────────────────
  test("in-project write: denied (plan), silent (every other mode)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "ran-silent"], ["ask", "ran-silent"],
      ["accept-edits", "ran-silent"], ["auto", "ran-silent"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        build: (cwd) => {
          const target = join(cwd, "in.txt");
          return { provider: new FakeProvider(writeTurn(target, "hi")), ran: () => existsSync(target) };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── OUT-OF-PROJECT WRITE (no rule) ────────────────────────────────────────────────────────────
  // A "safe" reviewer is configured so the AUTO cell pins ran(reviewed): the dir grant is SILENT but
  // the write still rides the fs reviewer (an out-of-root target is "unusual" — engine-reviewer.
  // test.ts task-24 F1). The reviewer is auto-only, so it never bites the other five modes.
  test("out-of-project write (no rule): denied (plan/dont-ask), carded (ask), silent grant (accept-edits/bypass), reviewed (auto)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "denied"], ["ask", "carded"],
      ["accept-edits", "ran-silent"], ["auto", "reviewed-ran"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        reviewerVerdict: "safe",
        build: () => {
          const outside = tmp("norma-mx-out-");
          const target = join(outside, "x.txt");
          return { provider: new FakeProvider(writeTurn(target, "hi")), ran: () => existsSync(target) };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── BASH `git push` (no rule) ─────────────────────────────────────────────────────────────────
  test("bash `git push` (no rule): denied (plan/dont-ask), carded (ask/accept-edits), reviewed (auto), silent (bypass)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "denied"], ["ask", "carded"],
      ["accept-edits", "carded"], ["auto", "reviewed-ran"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        reviewerVerdict: "safe",
        build: () => {
          const { registry, calls } = stubRegistry();
          return { registry, provider: new FakeProvider(bashTurn("git push origin main")), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── BASH `git push` + Bash(git push:*) rule ───────────────────────────────────────────────────
  // The rule pre-clears the ASK-path card (ruleAllowed → decision "allow"), so ask/dont-ask/
  // accept-edits/bypass all run SILENTLY. Under auto the reviewer STILL gates (Task 8: reviewer is
  // auto-only, and a rule never removes it there). Under plan the rule is never even consulted.
  test("bash `git push` + Bash(git push:*) rule: denied (plan), runs silent (dont-ask/ask/accept-edits/bypass), reviewed (auto)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "ran-silent"], ["ask", "ran-silent"],
      ["accept-edits", "ran-silent"], ["auto", "reviewed-ran"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        rule: "Bash(git push:*)",
        reviewerVerdict: "safe",
        build: () => {
          const { registry, calls } = stubRegistry();
          return { registry, provider: new FakeProvider(bashTurn("git push origin main")), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── ESCAPE `docker` (dangerouslyDisableSandbox, no rule) ──────────────────────────────────────
  // A "safe" reviewer gates the AUTO cell (runs unattended). Under ask/accept-edits the reviewer
  // only ANNOTATES the human card (still carded). The auto+UNSAFE split is asserted separately.
  test("escape `docker` (no rule): denied (plan/dont-ask), carded (ask/accept-edits), reviewer-gated safe→ran (auto), silent (bypass)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "denied"], ["ask", "carded"],
      ["accept-edits", "carded"], ["auto", "reviewed-ran"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        reviewerVerdict: "safe",
        build: () => {
          const { registry, calls } = stubRegistry();
          return { registry, provider: new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true })), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
    // auto + UNSAFE verdict → the reviewer GATE escalates to the human card (reviewed AND carded):
    const unsafe = await driveCell("auto", {
      reviewerVerdict: "unsafe",
      build: () => {
        const { registry, calls } = stubRegistry();
        return { registry, provider: new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true })), ran: () => calls.length === 1 };
      },
    });
    assertCell("auto", "reviewed-card", unsafe);
  });

  // ── ESCAPE + BashUnsandboxed(docker:*) rule ───────────────────────────────────────────────────
  // An "unsafe" reviewer is configured on purpose: if it were EVER consulted it would escalate/deny,
  // so ran-silent (reviewed === false) in every non-plan mode proves the rule pre-clear skips the
  // escape branch AND its reviewer entirely (policy-escape.test.ts).
  test("escape + BashUnsandboxed(docker:*) rule: denied (plan), silent pre-clear in every other mode (reviewer NEVER consulted)", async () => {
    const row: Row = [
      ["plan", "denied"], ["dont-ask", "ran-silent"], ["ask", "ran-silent"],
      ["accept-edits", "ran-silent"], ["auto", "ran-silent"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        rule: "BashUnsandboxed(docker:*)",
        reviewerVerdict: "unsafe",
        build: () => {
          const { registry, calls } = stubRegistry();
          return { registry, provider: new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true })), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── WEB_FETCH dangerous domain (no rule) ──────────────────────────────────────────────────────
  // CONFIRMED CORRECT (plan cell): the code CARDS under plan, matching the (corrected) spec — an
  // earlier draft's table read "denied", but the spec was corrected to say plan CARDS. NETWORK is
  // unconditionally allowed under plan for research; the dangerous-domain floor is a card, not a
  // deny — matching shipped scenario 10. See the file header (B).
  test("web_fetch dangerous (no rule): plan CARDS (confirmed correct per corrected spec), denied (dont-ask), carded (ask/accept-edits/auto), silent (bypass)", async () => {
    const row: Row = [
      ["plan", "carded"], ["dont-ask", "denied"], ["ask", "carded"],
      ["accept-edits", "carded"], ["auto", "carded"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        dangerousDomainsAdded: [],
        build: () => {
          const { registry, calls } = stubWebFetchRegistry();
          return { registry, provider: new FakeProvider(fetchTurn(DANGEROUS_URL)), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });

  // ── WEB_FETCH dangerous domain + WebFetch(domain:transfer.sh) rule ────────────────────────────
  // The rule pre-clears the floor (webFetchGate → null) in EVERY mode; NETWORK is allowed under plan
  // too, so even the plan cell runs silently (the natural consequence of finding (B) once a standing
  // rule exists).
  test("web_fetch dangerous + WebFetch(domain:transfer.sh) rule: runs silently in EVERY mode (rule pre-clears the floor; plan permits NETWORK)", async () => {
    const row: Row = [
      ["plan", "ran-silent"], ["dont-ask", "ran-silent"], ["ask", "ran-silent"],
      ["accept-edits", "ran-silent"], ["auto", "ran-silent"], ["bypass", "ran-silent"],
    ];
    for (const [mode, expected] of row) {
      const obs = await driveCell(mode, {
        rule: "WebFetch(domain:transfer.sh)",
        dangerousDomainsAdded: [],
        build: () => {
          const { registry, calls } = stubWebFetchRegistry();
          return { registry, provider: new FakeProvider(fetchTurn(DANGEROUS_URL)), ran: () => calls.length === 1 };
        },
      });
      assertCell(mode, expected, obs);
    }
  });
});

// ── SECURITY INVARIANTS (from the spec) ─────────────────────────────────────────────────────────
describe("SP-policies Task 12: security invariants", () => {
  // Invariant 7: the AI reviewer NEVER mints a rule. Only a human answering a card's "always allow"
  // optionId (through the IPC layer's PermissionRules.append) ever mutates the store. A reviewer
  // passing a call "safe" under auto runs it — and writes nothing to either the project rules file
  // OR the global settings file. Both are snapshotted (raw bytes) before/after and asserted unchanged.
  describe("invariant 7: the reviewer never mints a rule", () => {
    async function assertNoRuleMinted(call: FakeProvider, calls: Array<unknown>, registry: ToolRegistry): Promise<void> {
      const cwd = tmp("norma-inv7-cwd-");
      const normaHome = tmp("norma-inv7-home-");
      const projectRulesFile = join(repoRootFor(cwd), ".norma", "permissions.local.json");
      const globalSettingsFile = join(normaHome, "settings.json");
      const snap = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
      const beforeProject = snap(projectRulesFile);
      const beforeGlobal = snap(globalSettingsFile);

      const permissionRules = new PermissionRules({ globalAllow: () => [], normaHome });
      const reviewer = stubReviewer("safe");
      const { engine, store, sessionId } = setupEngine(call, { registry, policy: "auto" as any, cwd, permissionRules, reviewer: reviewer.reviewer as any });
      await engine.runTurn(sessionId);
      const events = store.read(sessionId);

      // The reviewer gated the call (safe) and it ran unattended — no human card:
      expect(events.some((e) => e.type === "tool_review")).toBe(true);
      expect(events.some((e) => e.type === "approval_requested")).toBe(false);
      expect(calls.length).toBe(1);
      // ...and NOT ONE byte of rule state changed. Neither file was even created:
      expect(snap(projectRulesFile)).toBe(beforeProject);
      expect(snap(globalSettingsFile)).toBe(beforeGlobal);
      expect(existsSync(projectRulesFile)).toBe(false);
      expect(existsSync(globalSettingsFile)).toBe(false);
    }

    test("auto + a sandbox ESCAPE passed 'safe' runs unattended but mints no rule (project or global)", async () => {
      const { registry, calls } = stubRegistry();
      await assertNoRuleMinted(new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true })), calls, registry);
    });

    test("auto + an ordinary BASH call passed 'safe' likewise mints no rule", async () => {
      const { registry, calls } = stubRegistry();
      await assertNoRuleMinted(new FakeProvider(bashTurn("git push origin main")), calls, registry);
    });
  });

  // Invariant 8: a standing rule pre-clears its floor under dont-ask — WITH the rule the call runs
  // silently; WITHOUT it the identical call is denied. Proven for both floors that own a rule form:
  // BashUnsandboxed (the sandbox escape) and WebFetch(domain:) (the dangerous-domain fetch).
  describe("invariant 8: a rule pre-clears its floor under dont-ask", () => {
    test("BashUnsandboxed(docker:*): the escape runs SILENTLY under dont-ask WITH the rule; DENIED without it", async () => {
      const escapeCell = (): Cell => {
        const { registry, calls } = stubRegistry();
        return { registry, provider: new FakeProvider(bashTurn("docker ps", undefined, { dangerouslyDisableSandbox: true })), ran: () => calls.length === 1 };
      };
      assertCell("dont-ask", "ran-silent", await driveCell("dont-ask", { rule: "BashUnsandboxed(docker:*)", build: escapeCell }));
      assertCell("dont-ask", "denied", await driveCell("dont-ask", { build: escapeCell }));
    });

    test("WebFetch(domain:transfer.sh): the dangerous fetch runs SILENTLY under dont-ask WITH the rule; DENIED without it", async () => {
      const fetchCell = (): Cell => {
        const { registry, calls } = stubWebFetchRegistry();
        return { registry, provider: new FakeProvider(fetchTurn(DANGEROUS_URL)), ran: () => calls.length === 1 };
      };
      assertCell("dont-ask", "ran-silent", await driveCell("dont-ask", { rule: "WebFetch(domain:transfer.sh)", dangerousDomainsAdded: [], build: fetchCell }));
      assertCell("dont-ask", "denied", await driveCell("dont-ask", { dangerousDomainsAdded: [], build: fetchCell }));
    });
  });
});
