import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store";
import { effortRefusalFor } from "../../src/settings";

// Field report 2026-09-19: pick an effort on a reasoning model, switch the session to
// `deepseek-anthropic/deepseek-reasoner` (a catalog row with an EMPTY effort vocabulary), and the next
// turn was refused by the child: "declares no effort vocabulary, so no effort level can be verified".
// R.1: the refreshed catalog removed that row; `zai/glm-5` is a live row with the same EMPTY vocabulary.
const NO_VOCABULARY = "zai/glm-5";
const WITH_LEVELS = "codex-oauth/gpt-5.6-terra";

const stale = (effort: string, model: string, mode: string | undefined) => effortRefusalFor(effort, model, mode) !== undefined;
const fresh = () => new SessionStore(mkdtempSync(join(tmpdir(), "winter-stale-effort-")), { effortStaleFor: stale });

describe("effortRefusalFor — the one selection rule", () => {
  test("a catalog row with no vocabulary takes no wire level at all, 'none' included", () => {
    for (const level of ["none", "low", "high", "max"]) expect(effortRefusalFor(level, NO_VOCABULARY, "code")).toContain("declares no reasoning-effort vocabulary");
  });
  test("a row with levels takes what it lists plus 'none', and refuses the rest by name", () => {
    expect(effortRefusalFor("high", WITH_LEVELS, "code")).toBeUndefined();
    expect(effortRefusalFor("none", WITH_LEVELS, "code")).toBeUndefined();
    expect(effortRefusalFor("galactic", WITH_LEVELS, "code")).toContain("supported:");
  });
  test("a tag the catalog does not know is unconstrained; a tier is judged by mode, never by the row", () => {
    expect(effortRefusalFor("high", "my-endpoint/whatever", "code")).toBeUndefined();
    expect(effortRefusalFor("ultra", NO_VOCABULARY, "code")).toBeUndefined();
    expect(effortRefusalFor("ultra", WITH_LEVELS, "chat")).toContain("code sessions only");
  });
});

describe("SessionStore.setModel clears an effort the destination model cannot take", () => {
  test("the reported case: 'high' does not survive a switch onto a row with no vocabulary", () => {
    const store = fresh();
    const sid = store.createSession("global", { cwd: "/tmp/p", approvalPolicy: "ask" });
    store.setModel(sid, WITH_LEVELS);
    store.setEffort(sid, "high");
    store.setModel(sid, NO_VOCABULARY);
    expect(store.meta(sid).model).toBe(NO_VOCABULARY);
    expect(store.meta(sid).effort).toBeUndefined();
    store.close();
  });
  test("a level the destination lists survives; one it does not list is cleared", () => {
    const store = fresh();
    const sid = store.createSession("global", { cwd: "/tmp/p", approvalPolicy: "ask" });
    store.setModel(sid, WITH_LEVELS);
    store.setEffort(sid, "high");
    store.setModel(sid, "anthropic/claude-opus-5");
    expect(store.meta(sid).effort).toBe("high");
    (store as unknown as { db: { run(sql: string, args: unknown[]): void } }).db.run("UPDATE sessions SET effort = ? WHERE session_id = ?", ["galactic", sid]);
    store.setModel(sid, WITH_LEVELS);
    expect(store.meta(sid).effort).toBeUndefined();
    store.close();
  });
  test("clearing the model (back to the live default) and a store built without the rule both leave the effort alone", () => {
    const store = fresh();
    const sid = store.createSession("global", { cwd: "/tmp/p", approvalPolicy: "ask" });
    store.setModel(sid, WITH_LEVELS);
    store.setEffort(sid, "high");
    store.setModel(sid, null);
    expect(store.meta(sid).effort).toBe("high");
    store.close();
    const plain = new SessionStore(mkdtempSync(join(tmpdir(), "winter-stale-effort-")));
    const sid2 = plain.createSession("global", { cwd: "/tmp/p", approvalPolicy: "ask" });
    plain.setEffort(sid2, "high");
    plain.setModel(sid2, NO_VOCABULARY);
    expect(plain.meta(sid2).effort).toBe("high");
    plain.close();
  });
  test("a throwing rule clears nothing and never fails the model write", () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-stale-effort-")), { effortStaleFor: () => { throw new Error("boom"); } });
    const sid = store.createSession("global", { cwd: "/tmp/p", approvalPolicy: "ask" });
    store.setEffort(sid, "high");
    store.setModel(sid, NO_VOCABULARY);
    expect(store.meta(sid).model).toBe(NO_VOCABULARY);
    expect(store.meta(sid).effort).toBe("high");
    store.close();
  });
});
