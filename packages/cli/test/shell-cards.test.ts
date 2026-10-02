// The plain shell's cards, one at a time (`src/shell-cards.ts`): with several cards open in one session
// (agent SDK 0.0.40 -- concurrent subagents, two lanes), a typed answer must always go to the card whose
// prompt is on screen, and a question's read loop must never run beside another card's.
import { describe, expect, test } from "bun:test";
import { ShellCardQueue } from "../src/shell-cards";

function harness() {
  const out: string[] = [];
  const answers: Array<{ callId: string; approved: boolean }> = [];
  let suspended = 0;
  const cards = new ShellCardQueue({
    emit: (text) => out.push(text),
    respond: async (callId, approved) => { answers.push({ callId, approved }); },
    suspendKeys: () => { suspended++; },
    resumeKeys: () => { suspended--; },
  });
  return { cards, out, answers, suspended: () => suspended };
}

describe("ShellCardQueue", () => {
  test("only the card being answered shows its prompt; a 'y' answers THAT card, then the next prompt appears", async () => {
    const h = harness();
    h.cards.raiseApproval("a", "approve Computer? [y/N] ");
    h.cards.raiseApproval("b", "approve Bash? [y/N] ");
    expect(h.out).toEqual(["approve Computer? [y/N] "]); // b waits, unprinted
    expect(h.suspended()).toBe(1);
    expect(await h.cards.answerApproval("y\n")).toBe(true);
    expect(h.answers).toEqual([{ callId: "a", approved: true }]);
    expect(h.out.at(-1)).toBe("approve Bash? [y/N] ");
    expect(await h.cards.answerApproval("n\n")).toBe(true);
    expect(h.answers.at(-1)).toEqual({ callId: "b", approved: false });
    expect(h.cards.awaitingApproval).toBe(false);
    expect(h.suspended()).toBe(0); // the key listener got stdin back
    expect(await h.cards.answerApproval("y\n")).toBe(false); // nothing on screen: the line is not an answer
  });

  test("a card resolved elsewhere: a waiting one never prompts; the one on screen gives way to the next", async () => {
    const h = harness();
    h.cards.raiseApproval("a", "A? ");
    h.cards.raiseApproval("b", "B? ");
    h.cards.raiseApproval("c", "C? ");
    h.cards.resolved("b"); // waiting: dropped silently
    h.cards.resolved("a"); // on screen: gives way
    expect(h.out.some((t) => t.includes("answered elsewhere"))).toBe(true);
    expect(h.out.filter((t) => t.endsWith("? "))).toEqual(["A? ", "C? "]);
    await h.cards.answerApproval("y");
    expect(h.answers).toEqual([{ callId: "c", approved: true }]);
    expect(h.cards.held).toEqual([]);
  });

  test("a question's read loop starts only after the card before it is done -- never two stdin readers", async () => {
    const h = harness();
    const ran: string[] = [];
    let finishQ1!: () => void;
    h.cards.raiseInteractive("q1", async () => { ran.push("q1 start"); await new Promise<void>((r) => (finishQ1 = r)); ran.push("q1 end"); });
    h.cards.raiseApproval("a", "A? ");
    h.cards.raiseInteractive("q2", async () => { ran.push("q2 start"); });
    await Promise.resolve();
    expect(ran).toEqual(["q1 start"]);
    expect(h.out).toEqual([]); // A's prompt waits for q1
    expect(h.cards.awaitingApproval).toBe(false); // so a typed line is q1's, not an approval answer
    finishQ1();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(h.out).toEqual(["A? "]);
    await h.cards.answerApproval("y");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(ran).toEqual(["q1 start", "q1 end", "q2 start"]);
  });

  test("a card raised twice is held once; a failed answer is reported and the queue moves on", async () => {
    const errors: unknown[] = [];
    const out: string[] = [];
    const cards = new ShellCardQueue({
      emit: (t) => out.push(t),
      respond: async () => { throw new Error("daemon went away"); },
      suspendKeys: () => {},
      resumeKeys: () => {},
      onError: (e) => errors.push(e),
    });
    cards.raiseApproval("a", "A? ");
    cards.raiseApproval("a", "A? ");
    cards.raiseApproval("b", "B? ");
    expect(cards.held).toEqual(["a", "b"]);
    await cards.answerApproval("y");
    expect(errors).toHaveLength(1);
    expect(out.at(-1)).toBe("B? ");
  });
});
