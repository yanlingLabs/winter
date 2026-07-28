import { describe, expect, test } from "bun:test";
import {
  checkCodeSession, filterCodeSessions, isCodeMode, nonCodeRefusalMessage, sessionModeMarker,
} from "../src/session-mode";

// Plan-immunity Task 2 (mode×surface matrix — ledger .superpowers/sdd/2026-07-28-plan-immunity/
// progress.md): the TUI/CLI's single source for "is this session's mode one the CLI is allowed to
// act on" (code = TUI + macOS app + iOS app; chat/cowork/dispatch are apps-only, dispatch also the
// orb) plus the two user-facing strings that predicate drives. Pure module, no socket/process —
// the actual command routes (main.ts's send/watch/resume/sessions cases) are thin glue over these,
// consistent with this package's existing convention (main.test.ts's own top comment) of unit
// testing the pure logic and exercising the wired socket/process paths by hand.

describe("isCodeMode", () => {
  test("undefined mode -> code (R-slice convention: absent = code)", () => {
    expect(isCodeMode(undefined)).toBe(true);
  });
  test("\"code\" explicit -> code", () => {
    expect(isCodeMode("code")).toBe(true);
  });
  test("chat/dispatch/cowork/anything-else -> not code", () => {
    expect(isCodeMode("chat")).toBe(false);
    expect(isCodeMode("dispatch")).toBe(false);
    expect(isCodeMode("cowork")).toBe(false);
    expect(isCodeMode("some-future-mode")).toBe(false);
  });
});

describe("filterCodeSessions", () => {
  test("keeps absent-mode and explicit \"code\" rows, drops everything else", () => {
    const rows = [
      { sessionId: "s1" },
      { sessionId: "s2", mode: "code" },
      { sessionId: "s3", mode: "chat" },
      { sessionId: "s4", mode: "dispatch" },
      { sessionId: "s5", mode: "cowork" },
    ];
    expect(filterCodeSessions(rows).map((r) => r.sessionId)).toEqual(["s1", "s2"]);
  });

  test("empty input -> empty output", () => {
    expect(filterCodeSessions([])).toEqual([]);
  });

  test("preserves extra fields on the surviving rows (generic passthrough)", () => {
    const rows: Array<{ sessionId: string; scope: string; lastSeq: number; mode?: string }> = [{ sessionId: "s1", scope: "global", lastSeq: 12 }];
    expect(filterCodeSessions(rows)).toEqual([{ sessionId: "s1", scope: "global", lastSeq: 12 }]);
  });
});

describe("sessionModeMarker — `norma sessions`' inventory tag (MARKS, never hides)", () => {
  test("code (absent or explicit) -> no marker", () => {
    expect(sessionModeMarker(undefined)).toBe("");
    expect(sessionModeMarker("code")).toBe("");
  });
  test("chat -> app-only marker", () => {
    expect(sessionModeMarker("chat")).toBe(" [chat — app only]");
  });
  test("dispatch -> orb/app marker (distinct wording — dispatch lives in both)", () => {
    expect(sessionModeMarker("dispatch")).toBe(" [dispatch — orb/app only]");
  });
  test("cowork / any future-or-unknown mode -> generic app-only marker, not hidden and not blank", () => {
    expect(sessionModeMarker("cowork")).toBe(" [cowork — app only]");
    expect(sessionModeMarker("some-future-mode")).toBe(" [some-future-mode — app only]");
  });
});

describe("nonCodeRefusalMessage — attach/send/watch/resume refusal wording", () => {
  test("chat -> points at the Norma app", () => {
    expect(nonCodeRefusalMessage("chat")).toBe("chat sessions live in the Norma app");
  });
  test("dispatch -> points at the orb and the app", () => {
    expect(nonCodeRefusalMessage("dispatch")).toBe("dispatch lives in the orb and the app");
  });
  test("cowork / any future-or-unknown mode -> generic apps-only message (future-proof, never blank)", () => {
    expect(nonCodeRefusalMessage("cowork")).toBe("cowork sessions are app-only");
    expect(nonCodeRefusalMessage("some-future-mode")).toBe("some-future-mode sessions are app-only");
  });
});

describe("checkCodeSession — shared attach/send/watch gate", () => {
  const rows = [
    { sessionId: "s-code", scope: "global", lastSeq: 3 },
    { sessionId: "s-code-explicit", scope: "global", lastSeq: 1, mode: "code" },
    { sessionId: "s-chat", scope: "global", lastSeq: 5, mode: "chat" },
    { sessionId: "s-dispatch", scope: "global", lastSeq: 9, mode: "dispatch" },
  ];

  test("unknown sessionId -> not-found message, byte-identical to the pre-existing wording", () => {
    const r = checkCodeSession(rows, "ghost");
    expect(r).toEqual({ ok: false, message: "no such session: ghost" });
  });

  test("code session (absent mode) -> ok, returns the row", () => {
    const r = checkCodeSession(rows, "s-code");
    expect(r).toEqual({ ok: true, row: rows[0]! });
  });

  test("code session (explicit mode:\"code\") -> ok", () => {
    const r = checkCodeSession(rows, "s-code-explicit");
    expect(r.ok).toBe(true);
  });

  test("chat session -> refused with the chat-specific message", () => {
    const r = checkCodeSession(rows, "s-chat");
    expect(r).toEqual({ ok: false, message: "chat sessions live in the Norma app" });
  });

  test("dispatch session -> refused with the dispatch-specific message", () => {
    const r = checkCodeSession(rows, "s-dispatch");
    expect(r).toEqual({ ok: false, message: "dispatch lives in the orb and the app" });
  });
});
