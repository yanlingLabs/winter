// Cowork (session door): the consumers that read a STORED `mode` string (not a typed runnable mode) and used
// to answer a mode they did not know the way they answered Code or by policy. Each now treats a stored
// `cowork` row as the most restrictive thing it can say — computer-use policy facts: refused; a peripheral
// lease: denied whatever the row's approval policy — and each keeps its answer for every runnable mode.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../../src/agent/approvals";
import { computerPolicyModeOf } from "../../src/computer-use/wiring";
import { isAutomationFailure } from "../../src/computer-use/errors";
import { buildLeasePolicy } from "../../src/daemon";
import { SessionHub } from "../../src/sessions/hub";
import { SessionStore } from "../../src/sessions/store";

describe("computer-use policy facts never read a stored cowork row as Code", () => {
  test("runnable and absent modes map as before", () => {
    expect(computerPolicyModeOf(undefined)).toBe("code");
    expect(computerPolicyModeOf("code")).toBe("code");
    expect(computerPolicyModeOf("chat")).toBe("chat");
    expect(computerPolicyModeOf("dispatch")).toBe("dispatch");
  });

  test("cowork — and any string that is not a runnable mode — is refused NotAllowed: no policy facts for a session nothing can run", () => {
    for (const stored of ["cowork", "something-new", ""]) {
      let thrown: unknown;
      try { computerPolicyModeOf(stored); } catch (err) { thrown = err; }
      expect(isAutomationFailure(thrown)).toBe(true);
      expect(thrown).toMatchObject({ kind: "NotAllowed" });
    }
  });
});

describe("a peripheral lease is denied to a stored cowork row, whatever its approval policy says", () => {
  function setup() {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-cowork-lease-")));
    const policy = buildLeasePolicy({ store, approvals: new ApprovalBroker(), hub: new SessionHub(store), timeoutMs: 50 });
    return { store, policy, close: () => store.close() };
  }
  const asCowork = (store: SessionStore, id: string): string => {
    (store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["cowork", id]);
    return id;
  };

  test("cowork + auto → denied (auto is 'granted' for Code); code + auto → granted; chat → denied; unknown session → denied", async () => {
    const t = setup();
    try {
      const odd = t.store.createSession("global", { approvalPolicy: "auto" });
      (t.store as any).db.run("UPDATE sessions SET mode = ? WHERE session_id = ?", ["something-new", odd]); // a newer daemon's / hand-edited mode
      expect(await t.policy(odd, "keyboard" as never)).toBe("denied");
      const cowork = asCowork(t.store, t.store.createSession("global", { approvalPolicy: "auto" }));
      const code = t.store.createSession("global", { approvalPolicy: "auto", mode: "code" });
      const chat = t.store.createSession("global", { approvalPolicy: "auto", mode: "chat" });
      expect(t.store.meta(cowork).approvalPolicy).toBe("auto"); // sanity: the policy alone WOULD grant
      expect(await t.policy(cowork, "keyboard" as never)).toBe("denied");
      expect(await t.policy(code, "keyboard" as never)).toBe("granted");
      expect(await t.policy(chat, "keyboard" as never)).toBe("denied");
      expect(await t.policy("s_unknown", "keyboard" as never)).toBe("denied");
    } finally { t.close(); }
  });
});
