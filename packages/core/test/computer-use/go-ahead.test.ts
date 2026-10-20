// The user's GO-AHEAD for an app the agent was refused in because they were working there (`user_working`): their own
// message to the session, or — the review of 2026-10-20 — their answer to a question card of it. A card is answered
// through `ask_user.respond` (`QuestionBroker.respond`, `by` = the answering client), which the question bridge turns into
// `question_resolved` — no `user_message` — so the daemon's observer has to read that too. Traced end to end here: the
// PRODUCTION wiring (`createComputerUseRuntime`) over a fake helper, the real hub, the real question bridge and broker.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@yanlinglabs/winter-protocol";
import { ApprovalBroker } from "../../src/agent/approvals";
import { QuestionBroker } from "../../src/agent/questions";
import { goAheadFor, createComputerUseRuntime } from "../../src/computer-use/wiring";
import { askUserQuestionBridge } from "../../src/runtime-sdk/question-bridge";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";
import type { Settings } from "../../src/settings";
import { sandboxAvailable } from "../../src/workflows/sandbox";
import { FakeHelper, FakeHelperError } from "./fake-helper";

const macOnly = sandboxAvailable() ? test : test.skip;

const resolved = (o: { by: string; answers?: Record<string, string>; childSessionId?: string }): SessionEvent =>
  ({ type: "question_resolved", seq: 3, ts: 0, sessionId: "s1", threadId: "main", callId: "q1", answers: o.answers ?? { "Go ahead?": "Yes" }, by: o.by, ...(o.childSessionId === undefined ? {} : { childSessionId: o.childSessionId }) } as unknown as SessionEvent);

describe("goAheadFor: what counts as the user's go-ahead", () => {
  test("a human message, or a human's non-empty answer to a question card; never one unanswered or automated", () => {
    const msg = (clientName?: string): SessionEvent => ({ type: "user_message", seq: 1, ts: 0, sessionId: "s1", threadId: "main", text: "go", ...(clientName === undefined ? {} : { clientName }) } as unknown as SessionEvent);
    expect(goAheadFor(msg("winter-mac"))).toBe("s1");
    expect(goAheadFor(msg("messaging"))).toBeUndefined();
    expect(goAheadFor(resolved({ by: "winter-mac" }))).toBe("s1");
    expect(goAheadFor(resolved({ by: "phone" }))).toBe("s1");
    for (const by of ["timeout", "aborted", "superseded", "dispatch", "messaging", "routine", "workflow"]) expect(goAheadFor(resolved({ by }))).toBeUndefined();
    expect(goAheadFor(resolved({ by: "winter-mac", answers: {} }))).toBeUndefined();
    // A Dispatch child's question relayed to its coordinator: the child is the session lifted.
    expect(goAheadFor(resolved({ by: "winter-mac", childSessionId: "s_child" }))).toBe("s_child");
  });
});

function runtime() {
  const home = mkdtempSync(join(tmpdir(), "winter-go-ahead-"));
  const store = new SessionStore(home);
  const hub = new SessionHub(store);
  const fake = new FakeHelper();
  fake.helperVersion = "1.22.0";
  const settings = { computerUse: { apps: { "com.apple.Notes": { grant: "always" } } } } as unknown as Settings;
  const rt = createComputerUseRuntime({
    home, profile: "dev", settings: () => settings, settingsPath: join(home, "settings.json"), approvals: new ApprovalBroker(), hub, store,
    launchAllowed: true,
    inject: {
      transport: fake.transport, launcher: fake.launcher, verifier: fake.verifier, launchAllowed: true, browserInstalled: () => false,
      headless: { resolve: () => ({ missing: "no headless browser in this test" }) },
    },
  });
  // As `daemon.ts` does: every appended event reaches the runtime's observer.
  hub.addObserver((event) => rt.observe(event));
  const sessionId = store.createSession("t", { cwd: home, mode: "code", approvalPolicy: "bypass" });
  const done = (): void => { rt.stop(); store.close(); rmSync(home, { recursive: true, force: true }); };
  return { rt, fake, hub, sessionId, done };
}

const QUESTION = { questions: [{ question: "Go ahead in Notes?", header: "Notes", options: [{ label: "Go ahead" }, { label: "Wait" }], multiSelect: false }] };

describe("the go-ahead through a question card, end to end", () => {
  macOnly("refused (user_working) → AskUserQuestion → the user's answer through ask_user.respond → work.lift for that app", async () => {
    const w = runtime();
    try {
      w.fake.handlers["target.act"] = () => { throw new FakeHelperError("refused", "the user is working in Notes right now", { reason: "user_working" }); };
      const r = await w.rt.service.run({ sessionId: w.sessionId, vision: true, model: "anthropic/claude-opus-5-5" }, {
        code: "const notes = await apps.open('Notes', { emit: false })\ntry { await notes.click(14) } catch (e) { print(e.name) }",
      });
      expect(r.isError).toBe(false);
      const questions = new QuestionBroker();
      const ask = askUserQuestionBridge({ sessionId: w.sessionId, questions, emit: (e) => { w.hub.append(w.sessionId, e as never); } });
      // Unanswered (it times out): nothing lifts.
      const timedOut = askUserQuestionBridge({ sessionId: w.sessionId, questions, emit: (e) => { w.hub.append(w.sessionId, e as never); }, timeoutMs: 20 });
      await timedOut("q0", QUESTION, { signal: new AbortController().signal });
      await Bun.sleep(30);
      expect(w.fake.calls("work.lift")).toEqual([]);
      // Answered on the card (the Mac): `ask_user.respond` is exactly `QuestionBroker.respond` with the client's name.
      const pending = ask("q1", QUESTION, { signal: new AbortController().signal });
      await Bun.sleep(10);
      expect(questions.respond(w.sessionId, "q1", { "Go ahead in Notes?": "Go ahead" }, "winter-mac")).toEqual({ ok: true, alreadyResolved: false });
      await pending;
      await Bun.sleep(30);
      expect(w.fake.calls("work.lift")).toEqual([{ pids: [501], reason: "message" }]);
    } finally { w.done(); }
  }, 30_000);
});
