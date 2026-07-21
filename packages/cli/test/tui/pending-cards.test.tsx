import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { PendingCards, capReviewerReason } from "../../src/tui/pending-cards";
import type { PendingCard } from "../../src/tui/state";
import { theme } from "../../src/tui/theme";

// Same caveat as composer.test.tsx: useInput wires its stdin listener inside a React effect,
// which runs on the next tick after render() returns — a short wait after render() and after
// each write keeps every assertion below deterministic.
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("PendingCards — approval", () => {
  const card: PendingCard = { kind: "approval", callId: "c1", toolName: "bash", summary: "rm -rf /tmp/x" };

  test("(a1) 'y\\r' -> onApprove(callId, true)", async () => {
    const calls: [string, boolean][] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={(id, yes) => calls.push([id, yes])} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    stdin.write("y");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["c1", true]]);
  });

  test("(a2) 'n\\r' -> onApprove(callId, false)", async () => {
    const calls: [string, boolean][] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={(id, yes) => calls.push([id, yes])} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["c1", false]]);
  });

  test("(a3) 'Y\\r' -> true (case-insensitive)", async () => {
    const calls: [string, boolean][] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={(id, yes) => calls.push([id, yes])} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    stdin.write("Y");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["c1", true]]);
  });

  test("(a4) 'yes\\r' -> false (only bare 'y' is true)", async () => {
    const calls: [string, boolean][] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={(id, yes) => calls.push([id, yes])} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    stdin.write("yes");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["c1", false]]);
  });

  test("(d1) frame renders the approval prompt + tool name + summary", async () => {
    const { lastFrame } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("approve bash?");
    expect(frame).toContain("rm -rf /tmp/x");
    expect(frame).toContain("[y/N]");
  });

  // Phase 5e T5: reviewer-rationale line above the action row.
  test("(d1a) no reviewerReason -> byte-identical to the plain single-line approval render (regression pin)", async () => {
    // The exact JSX ApprovalCard rendered before reviewerReason existed — a real (not remembered)
    // reference render, so this fails if the no-reviewerReason path ever grows a wrapping Box, an
    // extra line, or a color/spacing change, not just if the literal substrings disappear.
    const reference = (
      <Text color={theme.permission}>
        approve {card.toolName}? <Text dimColor>{card.summary}</Text> [y/N] {""}
      </Text>
    );
    const { lastFrame: refFrame } = render(reference);
    await wait();
    const { lastFrame } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    expect(lastFrame()).toBe(refFrame());
    expect(lastFrame()).not.toContain("⚠ reviewer");
  });

  test("(d1b) reviewerReason present -> distinct dim line rendered above the action row", async () => {
    const cardWithReason: PendingCard = {
      kind: "approval",
      callId: "c8",
      toolName: "bash",
      summary: "rm -rf /tmp/z",
      reviewerReason: "recursive delete outside the session cwd",
    };
    const { lastFrame } = render(<PendingCards pending={cardWithReason} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠ reviewer: recursive delete outside the session cwd");
    expect(frame.indexOf("⚠ reviewer:")).toBeLessThan(frame.indexOf("approve bash?"));
  });

  test("(d1c) a long reviewerReason is capped for layout", async () => {
    const longReason = "x".repeat(250);
    const cardWithReason: PendingCard = { kind: "approval", callId: "c9", toolName: "bash", summary: "rm -rf /tmp/y", reviewerReason: longReason };
    const { lastFrame } = render(<PendingCards pending={cardWithReason} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠ reviewer:");
    expect(frame).not.toContain(longReason); // full 250-char string never appears verbatim
    expect(frame).toContain("…"); // truncation marker present
  });

  test("(d1d) approve/deny keystrokes still work when reviewerReason is present", async () => {
    const calls: [string, boolean][] = [];
    const cardWithReason: PendingCard = {
      kind: "approval",
      callId: "c10",
      toolName: "bash",
      summary: "rm -rf /tmp/w",
      reviewerReason: "recursive delete outside the session cwd",
    };
    const { stdin } = render(<PendingCards pending={cardWithReason} onApprove={(id, yes) => calls.push([id, yes])} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    stdin.write("y");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["c10", true]]);
  });
});

// SP-approvals T7: the daemon's allow-rule `options` (events.ts's `ApprovalOption[]`) rendered as a
// numbered menu. Fixture mirrors engine.ts's real `approvalOptionsFor` bash shape (allow_once, the
// two rule-bearing allow_project/allow_global entries, deny) — labels are verbatim daemon strings.
describe("PendingCards — approval with options (SP-approvals T7)", () => {
  const bashOptions = [
    { id: "allow_once", label: "Allow once" },
    { id: "allow_project", label: 'Allow "Bash(git push:*)" in this project', rule: "Bash(git push:*)", scope: "project" as const },
    { id: "allow_global", label: 'Allow "Bash(git push:*)" everywhere', rule: "Bash(git push:*)", scope: "global" as const },
    { id: "deny", label: "Deny" },
  ];
  const card: PendingCard = { kind: "approval", callId: "o1", toolName: "bash", summary: "git push", options: bashOptions };

  test("(e1) '1\\r' -> onApprove(callId, true, 'allow_project') (first rule-bearing option)", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("1");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", true, "allow_project"]]);
  });

  test("(e2) '2\\r' -> onApprove(callId, true, 'allow_global') (second rule-bearing option)", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("2");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", true, "allow_global"]]);
  });

  test("(e3) 'y\\r' -> onApprove(callId, true, undefined) — no optionId", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("y");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", true, undefined]]);
  });

  test("(e4) bare Enter -> onApprove(callId, false, undefined) — fail-safe deny, same as the no-options card and out-of-range digits", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", false, undefined]]);
  });

  test("(e5) 'n\\r' -> onApprove(callId, false, undefined)", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("n");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", false, undefined]]);
  });

  test("(e6) an out-of-range digit ('3', only 2 rule-bearing options exist) -> denies rather than guessing", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("3");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", false, undefined]]);
  });

  test("(e9) a non-strict-digit numeric string ('1.0') denies rather than coercing through Number()", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={card} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("1.0");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o1", false, undefined]]);
  });

  test("(d4) frame renders the numbered menu with verbatim daemon labels, not the plain [y/N]", async () => {
    const { lastFrame } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("approve bash?");
    expect(frame).toContain("git push");
    expect(frame).toContain("[y] allow once");
    expect(frame).toContain('[1] Allow "Bash(git push:*)" in this project');
    expect(frame).toContain('[2] Allow "Bash(git push:*)" everywhere');
    expect(frame).toContain("[n] deny");
    expect(frame).not.toContain("[y/N]");
  });

  const editCard: PendingCard = {
    kind: "approval",
    callId: "o2",
    toolName: "edit",
    summary: "src/foo.ts",
    options: [
      { id: "allow_once", label: "Allow once" },
      { id: "allow_project", label: "Always allow edits in this project", rule: "Edit", scope: "project" as const },
      { id: "deny", label: "Deny" },
    ],
  };

  test("(d5) a single rule-bearing option (edit-shaped) numbers only [1]; no [2] line", async () => {
    const { lastFrame } = render(<PendingCards pending={editCard} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1] Always allow edits in this project");
    expect(frame).not.toContain("[2]");
  });

  test("(e8) edit-shaped card: '1\\r' -> onApprove(callId, true, 'allow_project')", async () => {
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin } = render(
      <PendingCards pending={editCard} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    stdin.write("1");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o2", true, "allow_project"]]);
  });

  test("(e7) reviewerReason + options can coexist: the reviewer line renders above the menu, keystrokes still work", async () => {
    const cardWithReason: PendingCard = { ...card, callId: "o3", reviewerReason: "escalated after a rule-allowed run" };
    const calls: [string, boolean, string | undefined][] = [];
    const { stdin, lastFrame } = render(
      <PendingCards pending={cardWithReason} onApprove={(id, yes, optionId) => calls.push([id, yes, optionId])} onAnswer={() => {}} onPlan={() => {}} />,
    );
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⚠ reviewer: escalated after a rule-allowed run");
    expect(frame.indexOf("⚠ reviewer:")).toBeLessThan(frame.indexOf("approve bash?"));
    stdin.write("1");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["o3", true, "allow_project"]]);
  });
});

// 5e whole-branch hardening: the newline/boundary cases the Swift twin (PendingCardsTests's four
// capReviewerReason tests) already pins — unit-level on the exported pure helper, because the
// exact 100/101 boundary can't be asserted through a rendered frame (Ink wraps at terminal width).
describe("capReviewerReason (pure helper — Swift-twin parity)", () => {
  test("short reason passes through unchanged", () => {
    expect(capReviewerReason("looks risky")).toBe("looks risky");
  });

  test("newlines (\\n and \\r\\n) are stripped to single spaces", () => {
    expect(capReviewerReason("line one\nline two\r\nline three")).toBe("line one line two line three");
  });

  test("exactly at the 100-char threshold -> unchanged, no ellipsis", () => {
    const exact = "x".repeat(100);
    expect(capReviewerReason(exact)).toBe(exact);
  });

  test("one past the threshold (101) -> capped at 100 + trailing ellipsis", () => {
    const over = "x".repeat(101);
    expect(capReviewerReason(over)).toBe("x".repeat(100) + "…");
  });
});

describe("PendingCards — plan", () => {
  const card: PendingCard = { kind: "plan", callId: "p1", plan: "Step 1: refactor foo\nStep 2: ship it" };

  test("(c1) '1\\r' -> onPlan(callId, {approved:true, autoAccept:false})", async () => {
    const calls: unknown[] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={(id, r) => calls.push([id, r])} />);
    await wait();
    stdin.write("1");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["p1", { approved: true, autoAccept: false }]]);
  });

  test("(c2) '2\\r' -> onPlan(callId, {approved:true, autoAccept:true})", async () => {
    const calls: unknown[] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={(id, r) => calls.push([id, r])} />);
    await wait();
    stdin.write("2");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["p1", { approved: true, autoAccept: true }]]);
  });

  test("(c3) '3 nope\\r' -> onPlan(callId, {approved:false, autoAccept:false, feedback:'nope'})", async () => {
    const calls: unknown[] = [];
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={(id, r) => calls.push([id, r])} />);
    await wait();
    stdin.write("3 nope");
    await wait();
    stdin.write("\r");
    await wait();
    expect(calls).toEqual([["p1", { approved: false, autoAccept: false, feedback: "nope" }]]);
  });

  test("(d2) frame renders Plan header, plan text, and the 3 menu lines + prompt", async () => {
    const { lastFrame } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Plan");
    expect(frame).toContain("Step 1: refactor foo");
    expect(frame).toContain("1) approve — I'll approve each edit");
    expect(frame).toContain("2) approve + auto-accept edits");
    expect(frame).toContain("3) reject (type: 3 <reason>)");
    // Ink's frame buffer trims trailing whitespace per line, so the prompt's trailing space
    // (present in the actual rendered <Text>) doesn't survive into lastFrame() — assert without it.
    expect(frame).toContain("choose (number or text):");
  });
});

describe("PendingCards — question (ask_user)", () => {
  const twoOptionQuestion = {
    header: "Approach",
    question: "Which approach?",
    options: [{ label: "Alpha" }, { label: "Beta" }],
    multiSelect: false,
  };

  test("(b1) single question, 2 options, '2\\r' then blank note -> onAnswer fires once with the picked label", async () => {
    const calls: [string, unknown][] = [];
    const card: PendingCard = { kind: "question", callId: "q1", questions: [twoOptionQuestion] };
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={(id, payload) => calls.push([id, payload])} onPlan={() => {}} />);
    await wait();
    stdin.write("2");
    await wait();
    stdin.write("\r"); // answer phase -> note phase
    await wait();
    expect(calls).toEqual([]); // not yet — still waiting on the note prompt
    stdin.write("\r"); // blank note -> skip, done (only question)
    await wait();
    expect(calls).toEqual([["q1", { answers: { "Which approach?": "Beta" } }]]);
    // notes key must be omitted entirely, not sent as {}
    const payload = calls[0]![1] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "notes")).toBe(false);
  });

  test("(b2) multiSelect, '1,2\\r' -> joined labels", async () => {
    const calls: unknown[] = [];
    const multiQuestion = {
      header: "Pick",
      question: "Which ones?",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      multiSelect: true,
    };
    const card: PendingCard = { kind: "question", callId: "q2", questions: [multiQuestion] };
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={(id, payload) => calls.push([id, payload])} onPlan={() => {}} />);
    await wait();
    stdin.write("1,2");
    await wait();
    stdin.write("\r");
    await wait();
    stdin.write("\r"); // blank note
    await wait();
    expect(calls).toEqual([["q2", { answers: { "Which ones?": "A, B" } }]]);
  });

  test("(b3) choosing 'Other' by its menu number re-prompts for free text, recorded verbatim", async () => {
    const calls: unknown[] = [];
    const card: PendingCard = { kind: "question", callId: "q3", questions: [twoOptionQuestion] };
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={(id, payload) => calls.push([id, payload])} onPlan={() => {}} />);
    await wait();
    stdin.write("3"); // options.length(2) + 1 = Other
    await wait();
    stdin.write("\r"); // answer phase detects isOtherChoice -> otherAnswer phase
    await wait();
    stdin.write("my custom answer");
    await wait();
    stdin.write("\r"); // otherAnswer phase -> note phase
    await wait();
    stdin.write("\r"); // blank note -> done
    await wait();
    expect(calls).toEqual([["q3", { answers: { "Which approach?": "my custom answer" } }]]);
  });

  test("(b4) a non-empty note lands in `notes`", async () => {
    const calls: unknown[] = [];
    const card: PendingCard = { kind: "question", callId: "q4", questions: [twoOptionQuestion] };
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={(id, payload) => calls.push([id, payload])} onPlan={() => {}} />);
    await wait();
    stdin.write("1");
    await wait();
    stdin.write("\r"); // answer phase -> note phase
    await wait();
    stdin.write("because reasons");
    await wait();
    stdin.write("\r"); // note phase -> done
    await wait();
    expect(calls).toEqual([["q4", { answers: { "Which approach?": "Alpha" }, notes: { "Which approach?": "because reasons" } }]]);
  });

  test("(b5) two questions -> onAnswer fires ONCE at the end with both answers", async () => {
    const calls: unknown[] = [];
    const q1 = { header: "Q1", question: "First?", options: [{ label: "One" }, { label: "Two" }], multiSelect: false };
    const q2 = { header: "Q2", question: "Second?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false };
    const card: PendingCard = { kind: "question", callId: "q5", questions: [q1, q2] };
    const { stdin } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={(id, payload) => calls.push([id, payload])} onPlan={() => {}} />);
    await wait();
    stdin.write("1"); // First -> "One"
    await wait();
    stdin.write("\r"); // answer -> note
    await wait();
    stdin.write("\r"); // blank note -> advance to Q2
    await wait();
    expect(calls).toEqual([]); // not done yet — second question still pending

    stdin.write("2"); // Second -> "Blue"
    await wait();
    stdin.write("\r"); // answer -> note
    await wait();
    stdin.write("\r"); // blank note -> done, both questions answered
    await wait();

    expect(calls).toEqual([["q5", { answers: { "First?": "One", "Second?": "Blue" } }]]);
  });

  test("(d3) frame renders header, question, numbered options, Other line, and the choose prompt", async () => {
    const card: PendingCard = { kind: "question", callId: "q6", questions: [twoOptionQuestion] };
    const { lastFrame } = render(<PendingCards pending={card} onApprove={() => {}} onAnswer={() => {}} onPlan={() => {}} />);
    await wait();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Approach");
    expect(frame).toContain("Which approach?");
    expect(frame).toContain("1) Alpha");
    expect(frame).toContain("2) Beta");
    expect(frame).toContain("3) Other (type your answer)");
    expect(frame).toContain("choose (number or text):"); // trailing space trimmed by Ink's frame buffer
  });
});
