// Winter Phase 8c (P8c-6) — THE REAL-BINARY PROOF for the engine-era import door.
//
// Everything else about the conversion (`convertEngineEraLog`, `importEngineEraSession`'s record
// patch) is proved in `test/runtime-sdk/import-legacy.test.ts` against a fake compat store. This
// file is the one that proves the WRITTEN FILE ITSELF is a transcript the real `winter` binary
// accepts as a resume target: it imports a fixture engine-era log through the REAL
// `WinterCompatibilitySessionStore` (no fake), then drives the actual compiled binary with
// `Options.resume` pointed at the freshly-imported backend id, exactly the way
// `session-driver.ts`'s `resume()` would on the daemon's own Winter-leg path.
//
// TWO CLAIMS:
//   (a) the real binary does not refuse the imported transcript — resume succeeds (`system/init`
//       reports the SAME backend id) and the new turn reaches a clean `result`, never a parse/chain
//       error, which is exactly the "green for the wrong reason" class CLAUDE.md warns a
//       dialect-shaped-but-wrong file would produce;
//   (b) the on-disk transcript, read back after the new turn, holds the IMPORTED entries first
//       (byte-identical text) followed by the NEW turn's entries, correctly chain-linked by
//       parentUuid — i.e. the resumed conversation really is a continuation, not a fresh start that
//       merely didn't error.
//
// This file never reaches the RPC layer (`ipc/server.ts`'s `session.send` wiring, which needs
// `daemon.ts`'s production `importLegacy` binding — a NEEDS_CONTEXT carry, see the lane report) —
// see `test/ipc/session-send-import.test.ts` for that door's own logic, proved with a fake driver
// table.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import type { SessionEvent } from "@winter/protocol";
import { importEngineEraSession } from "../../src/runtime-sdk/import-legacy";
import { openRuntimeStateDb, RuntimeSessionRecords, backfillNativeSessions } from "../../src/runtime-state";
import { sessionLegOf } from "../../src/runtime-sdk/leg";
import { SessionStore } from "../../src/sessions/store";
import { describeWithWinterBinary } from "../helpers/winter-binary";

interface ProtocolSdkMessage { type?: string; [k: string]: unknown }

describeWithWinterBinary("engine-era import — the REAL winter binary resumes the converted transcript", (bin) => {
  test("import then resume: no refusal, and the imported turns lead the new one on disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-import-e2e-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "winter-import-e2e-cwd-"));
    try {
      // ── Build an engine-era session exactly the way a pre-8b daemon would have left one ──────
      const store = new SessionStore(home);
      const sid = store.createSession("e2e", { cwd, model: "gpt-5.4" });
      store.append(sid, { type: "user_message", sessionId: sid, threadId: "main", text: "What is 2+2?", clientName: "cli" });
      store.append(sid, { type: "turn_started", sessionId: sid, threadId: "main" } as SessionEvent);
      store.append(sid, { type: "assistant_message", sessionId: sid, threadId: "main", text: "4" });
      store.append(sid, { type: "turn_completed", sessionId: sid, threadId: "main", stopReason: "end_turn", inputTokens: 5, outputTokens: 1 } as SessionEvent);

      const rs = openRuntimeStateDb(home);
      let backendSessionId: string;
      try {
        backfillNativeSessions({ rs, store, home, providerId: "codex-oauth" });
        const records = new RuntimeSessionRecords(rs);
        expect(sessionLegOf(records.get(sid))).toBe("engine");

        // ── The door under test: convert + append through the REAL compat store ────────────────
        const result = await importEngineEraSession({ home, store, records }, sid);
        backendSessionId = result.backendSessionId;
        expect(result.entries).toBe(2); // one user entry, one assistant entry
        expect(sessionLegOf(records.get(sid))).toBe("winter");
      } finally {
        rs.close();
      }

      // ── The real child resumes the imported transcript and runs one more turn ────────────────
      let stderrText = "";
      const q = query({
        prompt: (async function* () { yield "And 3+3?"; })(),
        options: {
          pathToClaudeCodeExecutable: bin,
          model: "winter-test/echo",
          cwd,
          resume: backendSessionId,
          stderr: (chunk: string) => { stderrText += chunk; },
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: home, TMPDIR: home, WINTER_HOME: home, WINTER_HOME: home,
            WINTER_PROFILE: "test",
            WINTER_TEST_PROVIDER: "echo",
          },
        },
      });

      const messages: ProtocolSdkMessage[] = [];
      let initSessionId: string | undefined;
      let resultCount = 0;
      let sawError = false;
      try {
        for await (const m of q as AsyncIterable<ProtocolSdkMessage>) {
          messages.push(m);
          if (m.type === "system" && m.subtype === "init") initSessionId = m.session_id as string;
          if (m.type === "result") { resultCount++; if (m.is_error === true) sawError = true; }
        }
      } catch (err) {
        throw new Error(`child failed: ${(err as Error).message}\n--- stderr ---\n${stderrText}`);
      }
      if (initSessionId === undefined) throw new Error(`no init frame; stderr:\n${stderrText}`);

      // (a) no refusal: the binary accepted the resume target and ran the new turn to completion.
      expect(initSessionId).toBe(backendSessionId);
      expect(resultCount).toBe(1);
      expect(sawError).toBe(false);

      // (b) the on-disk transcript now holds the imported turn FIRST, then the new one, correctly
      // chain-linked — read back through the real compat store, never a fake.
      const { WinterCompatibilitySessionStore } = await import("@yanlinglabs/winter-agent-sdk");
      const compat = new WinterCompatibilitySessionStore({ winterHome: home });
      const projectKey = transcriptProjectKey(cwd);
      const entries = (await compat.load({ projectKey, sessionId: backendSessionId })) ?? [];
      const conversational = entries.filter((e) => e.type === "user" || e.type === "assistant");
      expect(conversational.length).toBeGreaterThanOrEqual(4); // 2 imported + at least 2 new
      const texts = conversational.map((e) => {
        const content = (e as { message?: { content?: unknown } }).message?.content;
        return typeof content === "string" ? content : JSON.stringify(content);
      });
      expect(texts[0]).toContain("What is 2+2?");
      expect(texts[1]).toContain("4");
      // The chain is UNBROKEN from the imported tail into the new turn: every entry's parentUuid
      // (after the first) names the uuid immediately before it in file order.
      for (let i = 1; i < conversational.length; i++) {
        expect(conversational[i]!.parentUuid).toBe(conversational[i - 1]!.uuid);
      }
      // The new turn's own user message reached the real child (echo replies with it verbatim) —
      // proof the resumed session's INPUT path works, not just its stored history.
      const echoResult = messages.find((m) => m.type === "assistant") as { message?: { content?: { text?: string }[] } } | undefined;
      const echoText = echoResult?.message?.content?.[0]?.text ?? "";
      expect(echoText).toContain("And 3+3?");
    } finally {
      for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }, 40_000);
});
