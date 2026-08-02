import { describe, expect, test } from "bun:test";
import { formatQuestionHeadlineLine, formatResumeHint, invisibleKeyCharWarning, routeCliInvocation, type CliRoute } from "../src/main";
import { agentResumeCommand } from "../src/agents-cli";

// Pure arg-routing table test (final-review Findings 3+4). `routeCliInvocation` is the ONLY piece
// of the bare/--auto/--plan/-p/resume dispatch that's cheaply unit-testable without a real
// terminal/socket — everything downstream (actually entering chat, seeding policy via
// process.argv, resuming a session over the wire) is integration behavior exercised by hand /
// documented in the fix report, not here. `argv` throughout is the USER-supplied args
// (process.argv.slice(2)), matching what main.ts passes.

describe("routeCliInvocation — bare / policy-flag entry (Findings 3 & 4)", () => {
  test("bare `norma` on a TTY → chat, no existing session", () => {
    expect(routeCliInvocation([], true)).toEqual<CliRoute>({ kind: "chat" });
  });

  test("bare `norma --auto` / `--plan` on a TTY → chat (Finding 3 — previously fell through to help)", () => {
    expect(routeCliInvocation(["--auto"], true)).toEqual<CliRoute>({ kind: "chat" });
    expect(routeCliInvocation(["--plan"], true)).toEqual<CliRoute>({ kind: "chat" });
  });

  test("non-TTY bare `norma` → fallthrough, NOT chat (Finding 4 — keeps the usage/help output on scripted stdin)", () => {
    expect(routeCliInvocation([], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("non-TTY `norma --auto` / `--plan` → fallthrough too (chat requires a TTY regardless of which flag asked for it)", () => {
    expect(routeCliInvocation(["--auto"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["--plan"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });
});

describe("routeCliInvocation — `-p` and other subcommands are untouched", () => {
  test("`-p \"<prompt>\"` → fallthrough (handled by its own dedicated top-level check, not this table)", () => {
    expect(routeCliInvocation(["-p", "do the thing"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["-p", "do the thing"], false)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("ordinary subcommands (ping, daemon run, …) → fallthrough, unaffected by this routing", () => {
    expect(routeCliInvocation(["ping"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["daemon", "run"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
    expect(routeCliInvocation(["sessions"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
  });
});

describe("routeCliInvocation — resume (Finding 3)", () => {
  test("`resume` with no id → fallthrough (the existing picker handles it)", () => {
    expect(routeCliInvocation(["resume"], true)).toEqual<CliRoute>({ kind: "fallthrough" });
  });

  test("`resume <id>` with no message → chat on that session", () => {
    expect(routeCliInvocation(["resume", "sess1"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });

  test("`resume <id> --auto` / `--plan` (exactly the flag, nothing else) → chat, NOT a literal prompt", () => {
    expect(routeCliInvocation(["resume", "sess1", "--auto"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
    expect(routeCliInvocation(["resume", "sess1", "--plan"], true)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });

  test("`resume <id> <text…>` → resumeOneShot, carrying the joined text (existing behavior, unchanged)", () => {
    expect(routeCliInvocation(["resume", "sess1", "hello", "world"], true)).toEqual<CliRoute>({
      kind: "resumeOneShot",
      sessionId: "sess1",
      text: "hello world",
    });
  });

  test("a flag FOLLOWED BY more text is real prompt text, not the chat-seed case ('anything else unchanged')", () => {
    expect(routeCliInvocation(["resume", "sess1", "--auto", "and then some"], true)).toEqual<CliRoute>({
      kind: "resumeOneShot",
      sessionId: "sess1",
      text: "--auto and then some",
    });
  });

  test("resume chat-entry is NOT gated on isTTY (pre-existing, unflagged behavior — documented, not changed here)", () => {
    expect(routeCliInvocation(["resume", "sess1"], false)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
    expect(routeCliInvocation(["resume", "sess1", "--auto"], false)).toEqual<CliRoute>({
      kind: "chat",
      existingSessionId: "sess1",
    });
  });
});

describe("formatResumeHint (Phase 3c Task 5 — the dim post-exit resume hint)", () => {
  test("exact text (dim-wrapped), including the session id", () => {
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    expect(formatResumeHint("s_abc123")).toBe(`${DIM}\nResume this session with:\n  norma resume s_abc123\n${RESET}`);
  });

  test("no trailing newline is added beyond the one already in the spec string (process.stdout.write, not console.log)", () => {
    const hint = formatResumeHint("x");
    expect(hint.endsWith("\n\x1b[0m")).toBe(true); // ends with the required "\n" then the RESET code — no EXTRA "\n"
  });

  // session-activity-hygiene T9: `norma agents`' "open" verb prints a resume invocation for the
  // selected session. Two surfaces now tell a user how to get back into a session, and a roster that
  // printed a command the CLI does not accept would be worse than printing nothing — so the strings
  // are bound together here rather than each being asserted against a literal in its own file.
  // `norma resume <id>` is a SUBCOMMAND (main.ts's `case "resume"`), NOT a `--resume` flag.
  test("agentResumeCommand is exactly the invocation formatResumeHint already advertises", () => {
    expect(formatResumeHint("s_abc123")).toContain(agentResumeCommand("s_abc123"));
    expect(agentResumeCommand("s_abc123")).toBe("norma resume s_abc123");
  });
});

// Chat mode Slice B1 Task 4: the question_asked TTY handler's one-line headline. Extracted as a
// pure/exported helper (same "no readline/TTY round-trip" convention as formatResumeHint above) so
// the header-less (Slice B1 simplified card) fix is unit-testable — this line otherwise lives
// inside an async IIFE nested in the event-handling loop, with no other test seam.
describe("formatQuestionHeadlineLine (Slice B1 Task 4 — CLI one-line question headline)", () => {
  const AQUA = "\x1b[38;2;53;214;232m";
  const RESET = "\x1b[0m";

  test("header present -> byte-identical to the pre-Slice-B1 template literal (regression pin)", () => {
    expect(formatQuestionHeadlineLine("Tier", "Which tier?")).toBe(`${AQUA}Tier${RESET} — Which tier?`);
  });

  test("header absent (Slice B1 simplified card) -> just the colored question, no 'undefined' literal", () => {
    const line = formatQuestionHeadlineLine(undefined, "Which tier should I compare against?");
    expect(line).not.toContain("undefined");
    expect(line).toBe(`${AQUA}Which tier should I compare against?${RESET}`);
  });

  test("header absent -> no stray '— ' prefix left over from the header segment", () => {
    const line = formatQuestionHeadlineLine(undefined, "A?");
    expect(line).not.toContain("—");
  });
});

// Branch review (chat-mode Slice B1, FIX 1 — defense in depth): `norma login --exa-key` /
// `--web-search-key` must reject a key carrying a non-printable or non-ASCII character BEFORE it
// ever reaches a fetch header, since Bun's real fetch embeds an invalid header's VALUE verbatim in
// its own error text (confirmed live against both Exa's and Brave's auth headers — see
// search.test.ts/web.test.ts's own FIX-1 tests). `.trim()` does NOT strip U+200B (Cf category, not
// whitespace) — the most common copy-paste artifact. Every "bad" char below is spelled with an
// explicit \u escape (not a literal invisible character) so the test source stays legible.
describe("invisibleKeyCharWarning (branch review FIX 1 — `norma login --exa-key`/`--web-search-key`)", () => {
  test("a clean printable-ASCII key -> null (no warning)", () => {
    expect(invisibleKeyCharWarning("sk-exa-abc123XYZ_-")).toBeNull();
  });

  test("trailing U+200B (zero-width space) -> warns", () => {
    expect(invisibleKeyCharWarning("SUPER_SECRET_EXA_KEY​")).not.toBeNull();
  });

  test("en dash, emoji, newline, carriage return, NUL -> all warn (the review's full repro list)", () => {
    const bads = ["a\u2013b", "a\u{1F642}b", "a\nb", "a\rb", "a\u0000b"];
    for (const bad of bads) {
      expect(invisibleKeyCharWarning(bad)).not.toBeNull();
    }
  });

  test("the warning explains WHAT happened rather than just 'invalid'", () => {
    const msg = invisibleKeyCharWarning("bad​key");
    expect(msg).toContain("invisible character");
    expect(msg).toContain("copying from a web page");
  });
});
