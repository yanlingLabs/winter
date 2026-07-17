import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { FakeProvider } from "../../src/agent/fake-provider";
import { Dreamer, DREAM_MIN_SPACING_MS } from "../../src/agent/dreamer";
import { applyOps } from "../../src/agent/dream-ops";
import { assistantMemoryDirFor } from "../../src/agent/memory-dir";
import { ContextAssembler } from "../../src/agent/context";
import { TrustStore } from "../../src/agent/trust";
import { SkillStore } from "../../src/agent/skills";

/** Dreaming (Phase 7b) — end-to-end scenarios (Task 5, the final task). One continuous dispatch
 *  session lives through FOUR dream cycles, each a real `dreamer.tick()` against a real temp
 *  `SessionStore` and a scripted queue-of-responses `FakeProvider` (one script entry per cycle —
 *  `FakeProvider` plays them back in call order). The clock is marched forward past the 2h
 *  inter-cycle spacing gate between cycles (never a real sleep); each window is padded past
 *  DREAM_MIN_EVENTS with filler `user_message` events so the substantive-count gate is genuinely
 *  satisfied, not stubbed. This drives the real `tick()` — gates, window-filtering, prompt
 *  assembly, ops validation, atomic apply, and watermark advance — exactly as dreamer-gates.test.ts
 *  and dreamer-cycle.test.ts do per-cycle, but chained across cycles to prove the FULL story:
 *  teach -> forget -> tombstone survives a re-teach attempt -> temporal revision -> and that no
 *  cycle ever re-sees a prior cycle's transcript (watermark isolation). */

function fillSubstantive(store: SessionStore, sid: string, n: number, tag: string): void {
  for (let i = 0; i < n; i++) {
    store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: `${tag} filler ${i}`, clientName: "test" });
  }
}

/** The exact request `content` string the Dreamer sent on the Nth call — "the PROMPT" (brief's
 *  own term for Scenario C: the mechanism we own, independent of whether the scripted model
 *  obeys it). */
function requestContent(provider: FakeProvider, callIndex: number): string {
  const input = provider.requests[callIndex]!.input;
  expect(input).toHaveLength(1);
  return (input[0] as { content: string }).content;
}

describe("Dreaming end-to-end (Task 5): teach / forget / tombstone-survival / temporal-revision / watermark", () => {
  test("a single dispatch session dreamed across 4 cycles tells the whole story", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "norma-dreamer-e2e-")));
    const store = new SessionStore(home);
    const dispatchId = store.createSession("global", { mode: "dispatch", origin: "dispatch" });
    const dir = assistantMemoryDirFor({ normaHome: home });

    // Pre-existing memories the bucket already carries INTO cycle 1 — seeded via the real
    // `applyOps` (not a bare writeFileSync) so MEMORY.md's index bookkeeping is genuine, exactly
    // as if an earlier (untested) dream had already written them.
    applyOps(dir, [
      { op: "write", file: "home.md", content: "---\nrevised: 2026-07-01\n---\nThe user's home address is 123 Main St, Springfield." },
      { op: "write", file: "launch-week.md", content: "---\nrevised: 2026-07-14\n---\nNorma is launching this week (revised: 2026-07-14)." },
    ]);
    expect(existsSync(join(dir, "home.md"))).toBe(true);
    expect(existsSync(join(dir, "launch-week.md"))).toBe(true);

    let currentNow = Date.parse("2026-07-10T00:00:00Z");
    const provider = new FakeProvider([
      // Cycle 1 (A - TEACH): the model writes two new memory files.
      [
        { type: "text_delta", delta: JSON.stringify({ ops: [
          { op: "write", file: "alex.md", content: "---\nrevised: 2026-07-10\n---\nAlex is the user; he is building Norma, an agentic Mac assistant." },
          { op: "write", file: "norma-project.md", content: "---\nrevised: 2026-07-10\n---\nNorma is Alex's agentic assistant project, in active development." },
        ] }) },
        { type: "done", stopReason: "end_turn" },
      ],
      // Cycle 2 (B - FORGET): tombstone the address, delete its file.
      [
        { type: "text_delta", delta: JSON.stringify({ ops: [
          { op: "tombstone", text: "the user's home address" },
          { op: "delete", file: "home.md" },
        ] }) },
        { type: "done", stopReason: "end_turn" },
      ],
      // Cycle 3 (C - TOMBSTONE SURVIVAL): a faithful model sees the tombstone and refuses to re-learn it.
      [
        { type: "text_delta", delta: '{"ops":[]}' },
        { type: "done", stopReason: "end_turn" },
      ],
      // Cycle 4 (D - TEMPORAL REVISION): launch-week.md rewritten as past, with a newer revised date.
      [
        { type: "text_delta", delta: JSON.stringify({ ops: [
          { op: "write", file: "launch-week.md", content: "---\nrevised: 2026-08-01\n---\nNorma launched the week of 2026-07-14; now in normal iteration." },
        ] }) },
        { type: "done", stopReason: "end_turn" },
      ],
    ]);

    const dreamer = new Dreamer({
      provider: { provider, model: "ignored" },
      store,
      dir: () => dir,
      enabled: () => true,
      activeTurnCount: () => 0,
      now: () => currentNow,
    });

    // ---- Cycle 1 (A): TEACH ----
    fillSubstantive(store, dispatchId, 45, "cycle1");
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "CYCLE1_MARKER my name is Alex and I'm building Norma", clientName: "test" });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(1);
    expect(readFileSync(join(dir, "alex.md"), "utf8")).toContain("Alex is the user");
    expect(readFileSync(join(dir, "norma-project.md"), "utf8")).toContain("Norma is Alex's agentic assistant project");
    const memoryAfterA = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(memoryAfterA).toContain("alex.md");
    expect(memoryAfterA).toContain("norma-project.md");

    // Close the loop: what dreams write is what dispatch loads. Build a REAL ContextAssembler
    // over the SAME temp home, assistantDir pointing at this exact bucket, and confirm
    // assemble({memoryBucket:"assistant"}) surfaces both index lines (Task 1's assembler).
    const trust = new TrustStore(join(home, "trust.json"));
    const skills = new SkillStore({ normaHome: home, trust });
    const assembler = new ContextAssembler({
      normaHome: home, trust, skills,
      memory: { enabled: () => true, dirFor: () => join(home, "projects", "unused", "memory"), assistantDir: () => dir },
    });
    const assembled = assembler.assemble({ cwd: null, memoryBucket: "assistant" });
    expect(assembled).toContain("Assistant memory index");
    expect(assembled).toContain("alex.md");
    expect(assembled).toContain("Alex is the user");
    expect(assembled).toContain("norma-project.md");
    expect(assembled).toContain("Norma is Alex's agentic assistant project");

    // ---- Cycle 2 (B): FORGET ----
    currentNow += DREAM_MIN_SPACING_MS + 3_600_000; // > 2h spacing elapsed
    fillSubstantive(store, dispatchId, 45, "cycle2");
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "CYCLE2_MARKER forget where I live", clientName: "test" });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(2);
    expect(existsSync(join(dir, "home.md"))).toBe(false);
    const tombstonesAfterB = readFileSync(join(dir, "tombstones.md"), "utf8");
    expect(tombstonesAfterB).toContain("the user's home address");
    const memoryAfterB = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(memoryAfterB).not.toContain("home.md");
    expect(memoryAfterB).toContain("alex.md"); // untouched files survive the prune

    // ---- Cycle 3 (C): TOMBSTONE SURVIVAL ----
    currentNow += DREAM_MIN_SPACING_MS + 3_600_000;
    fillSubstantive(store, dispatchId, 45, "cycle3");
    store.append(dispatchId, { type: "user_message", sessionId: dispatchId, threadId: "main", text: "CYCLE3_MARKER I live at 123 Main St, Springfield", clientName: "test" });
    await dreamer.tick();

    expect(provider.requests).toHaveLength(3);
    const promptC = requestContent(provider, 2);
    expect(promptC).toContain("the user's home address"); // the mechanism we own: tombstone reached the prompt
    expect(existsSync(join(dir, "home.md"))).toBe(false); // ...and the scripted (faithful) model didn't re-write it

    // ---- Cycle 4 (D): TEMPORAL REVISION ----
    currentNow = Date.parse("2026-08-01T00:00:00Z");
    fillSubstantive(store, dispatchId, 45, "cycle4");
    await dreamer.tick();

    expect(provider.requests).toHaveLength(4);
    const promptD = requestContent(provider, 3);
    expect(promptD).toContain("Today's date: 2026-08-01");
    expect(promptD).toContain("revised: 2026-07-14"); // the stale file, as it existed BEFORE this cycle's revision
    const launchWeekAfterD = readFileSync(join(dir, "launch-week.md"), "utf8");
    expect(launchWeekAfterD).toContain("revised: 2026-08-01");
    expect(launchWeekAfterD).toContain("launched the week of");

    // ---- (E): WATERMARK ISOLATION across all 4 cycles ----
    // Cycle 2's request must never see cycle 1's transcript (and so on) — each window is
    // strictly bounded to events after the PRIOR cycle's watermark.
    const promptA = requestContent(provider, 0);
    const promptB = requestContent(provider, 1);
    expect(promptA).toContain("CYCLE1_MARKER");
    expect(promptB).not.toContain("CYCLE1_MARKER");
    expect(promptB).toContain("CYCLE2_MARKER");
    expect(promptC).not.toContain("CYCLE1_MARKER");
    expect(promptC).not.toContain("CYCLE2_MARKER");
    expect(promptC).toContain("CYCLE3_MARKER");
    expect(promptD).not.toContain("CYCLE1_MARKER");
    expect(promptD).not.toContain("CYCLE2_MARKER");
    expect(promptD).not.toContain("CYCLE3_MARKER");
  });
});
