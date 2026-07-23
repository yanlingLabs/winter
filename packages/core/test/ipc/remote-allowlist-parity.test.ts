import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METHODS } from "@norma/protocol";
import { REMOTE_ALLOWED_METHODS } from "../../src/ipc/server";
import { startDaemon } from "../../src/daemon";
import { FileSecretStore } from "../../src/auth/secret-store";

// SP2a Task 2 — the cross-language drift tripwire (gate G7) + the remote token type (gate G8).
//
// The gateway enforces the SAME twelve-method `remote` allowlist twice, once per language: here in
// TS (`REMOTE_ALLOWED_METHODS`, ipc/server.ts) and once in Swift (`Gateway.remoteAllowedMethods`,
// GatewayGateTests' testG7). Neither test imports the other's list — each pins its own side to the
// literal twelve names, so editing ONE side without the other fails here (or in Swift) rather than
// silently letting the two allowlists diverge and admitting/denying a method inconsistently.
//
// SP3 T4b grew the list 9→10: `approval.list` (queryable pending-approval state) is remote-facing
// so a phone can query pending approvals it missed in the replay window.
// SP3.4 grew it 10→11: `session.create` (the phone's sidebar "+ New Code session" button).
// session-history grew it 11→12: `session.history` (the phone reads past events to render history
// without an unbounded attach replay).

describe("remote allowlist parity (SP2a gate G7)", () => {
  // The canonical twelve (SP1 §6 + SP3 T4b approval.list + SP3.4 session.create + session-history
  // session.history) — the exact method STRINGS the Swift Gateway mirrors.
  const TWELVE = [
    METHODS.hello,
    METHODS.sessionList,
    METHODS.sessionAttach,
    METHODS.sessionSend,
    METHODS.sessionDispatch,
    METHODS.approvalRespond,
    METHODS.askUserRespond,
    METHODS.sessionInterrupt,
    METHODS.engineActivity,
    METHODS.approvalList,
    METHODS.sessionCreate,
    METHODS.sessionHistory,
  ];

  test("REMOTE_ALLOWED_METHODS is EXACTLY the twelve names", () => {
    expect(REMOTE_ALLOWED_METHODS.size).toBe(12);
    for (const m of TWELVE) {
      expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(true);
    }
    expect([...REMOTE_ALLOWED_METHODS].sort()).toEqual([...TWELVE].sort());
  });

  test("the twelve string VALUES match the Swift Gateway.remoteAllowedMethods literals", () => {
    expect([...REMOTE_ALLOWED_METHODS].sort()).toEqual(
      [
        "protocol.hello",
        "session.list",
        "session.attach",
        "session.send",
        "session.dispatch",
        "approval.respond",
        "ask_user.respond",
        "session.interrupt",
        "engine.activity",
        "approval.list",
        "session.create",
        "session.history",
      ].sort(),
    );
  });
});

describe("RunningDaemon.tokens.remote (SP2a gate G8)", () => {
  let home: string | undefined;
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  test("startDaemon exposes a non-empty remote token distinct from harness/admin", async () => {
    home = mkdtempSync(join(tmpdir(), "norma-remote-token-"));
    const d = await startDaemon({
      home,
      secrets: new FileSecretStore(join(home, "secrets")),
      agentProvider: null,
    });
    stop = d.stop;

    expect(typeof d.tokens.remote).toBe("string");
    expect(d.tokens.remote.length).toBeGreaterThan(0);
    // Least-privileged principal — must be its OWN secret, never a reused harness/admin token.
    expect(d.tokens.remote).not.toBe(d.tokens.harness);
    expect(d.tokens.remote).not.toBe(d.tokens.admin);
  });
});
