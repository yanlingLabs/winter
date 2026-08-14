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
// The gateway enforces the SAME twenty-method `remote` allowlist twice, once per language: here
// in TS (`REMOTE_ALLOWED_METHODS`, ipc/server.ts) and once in Swift (`Gateway.remoteAllowedMethods`,
// GatewayGateTests' testG7). Neither test imports the other's list — each pins its own side to the
// literal twenty names, so editing ONE side without the other fails here (or in Swift) rather
// than silently letting the two allowlists diverge and admitting/denying a method inconsistently.
//
// SP3 T4b grew the list 9→10: `approval.list` (queryable pending-approval state) is remote-facing
// so a phone can query pending approvals it missed in the replay window.
// SP3.4 grew it 10→11: `session.create` (the phone's sidebar "+ New Code session" button).
// session-history grew it 11→12: `session.history` (the phone reads past events to render history
// without an unbounded attach replay).
// Chat Slice D task 1 grew it 12→13: `session.setModel` (the phone sets the model on a
// remote-driven code/dispatch/chat session).
// Chat Slice D task 2 grew it 13→16: `sync.heads`/`sync.pull`/`sync.push` (the phone replicates
// its own chat-session logs both ways — the phone is the only client these three exist for).
// Chat Slice D task 3 grew it 16→18: `sync.config`/`sync.memory` (the phone's OWN standalone-chat
// bootstrap config + its read-only `_assistant` memory-bucket replica — neither carries a
// sessionId, but both are phone-only surfaces exactly like the three sync verbs above).
// provider-correctness T4 grew it 18→19: `session.setEffort` (the phone sets the reasoning effort
// on a remote-driven session — the other half of its model picker, and its own method for the same
// reason the CLI keeps `norma model` and `norma model --effort` separate).
// session-activity-hygiene T3 grew it 19→20: `session.setActivity` (the phone backgrounds/archives
// a remote-driven code session — the write half of the `activity` state `session.list`, already on
// this list, has served since T2; a read-only phone could see the state but never move it).
// working-directories T3 grew it 20→21: `session.setDirs` (the phone mutates a remote-driven code
// session's working-directory set — the write half of the `dirs` field `session.list` now carries).

describe("remote allowlist parity (SP2a gate G7)", () => {
  // The canonical twenty-one (SP1 §6 + SP3 T4b approval.list + SP3.4 session.create +
  // session-history session.history + Chat Slice D session.setModel + Chat Slice D tasks 2/3's
  // five sync verbs + provider-correctness T4's session.setEffort + session-activity-hygiene T3's
  // session.setActivity + working-directories T3's session.setDirs) — the exact method STRINGS the
  // Swift Gateway mirrors.
  const TWENTY_ONE = [
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
    METHODS.sessionSetModel,
    METHODS.sessionSetEffort,
    METHODS.sessionSetActivity,
    METHODS.syncHeads,
    METHODS.syncPull,
    METHODS.syncPush,
    METHODS.syncConfig,
    METHODS.syncMemory,
    METHODS.sessionSetDirs,
  ];

  test("REMOTE_ALLOWED_METHODS is EXACTLY the twenty-one names", () => {
    expect(REMOTE_ALLOWED_METHODS.size).toBe(21);
    for (const m of TWENTY_ONE) {
      expect(REMOTE_ALLOWED_METHODS.has(m)).toBe(true);
    }
    expect([...REMOTE_ALLOWED_METHODS].sort()).toEqual([...TWENTY_ONE].sort());
  });

  test("the twenty-one string VALUES match the Swift Gateway.remoteAllowedMethods literals", () => {
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
        "session.setModel",
        "session.setEffort",
        "session.setActivity",
        "sync.heads",
        "sync.pull",
        "sync.push",
        "sync.config",
        "sync.memory",
        "session.setDirs",
      ].sort(),
    );
  });

  // diff-tabs Task 7: `panel.readDiff` (protocol Task 3) is harness/admin-only by construction —
  // panel state is Mac-only, same as every other `panel.*` method (none of the seven is on this
  // list; panel-methods.test.ts / panel-read-diff.test.ts pin the role-rejection behavior over the
  // real RPC). This assertion is TRUE both before and after Task 7's own implementation work — an
  // absent METHODS key is `undefined`, and `undefined` is not in the set either — so it is a PIN
  // against a future regression (someone later adding it here without updating the Swift mirror or
  // its own parity test), not a RED driver for this task's TDD cycle. The mirrored lists
  // themselves (TWENTY_ONE above, and its Swift twin) are DELIBERATELY untouched by this line.
  test("panel.readDiff (diff-tabs Task 7) is NOT in REMOTE_ALLOWED_METHODS", () => {
    expect(REMOTE_ALLOWED_METHODS.has(METHODS.panelReadDiff)).toBe(false);
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
