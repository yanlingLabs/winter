import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashLooksSafe, BashReviewer, REVIEW_INSTRUCTION, FS_REVIEW_INSTRUCTION, EXTERNAL_REVIEW_INSTRUCTION } from "../../src/agent/reviewer";
import { FakeProvider } from "../../src/agent/fake-provider";
import type { ProviderEvent } from "../../src/providers/types";
import { internalRoleEffortFor } from "../../src/providers/manager";
import { RoleHealthRegistry } from "../../src/providers/role-health";
import { Settings } from "../../src/settings";

describe("bashLooksSafe", () => {
  test("read-only argv0, no metachars → bypass", () => {
    for (const c of ["ls -la", "pwd", "grep foo .", "cat README.md", "echo hi"]) expect(bashLooksSafe(c)).toBe(true);
  });
  test("git is NOT in the default safe set", () => {
    expect(bashLooksSafe("git status")).toBe(false);
  });
  test("any metachar forces review (no chaining bypass)", () => {
    for (const c of ["ls; rm -rf /", "cat x | sh", "echo $(whoami)", "echo `id`", "echo hi > f", "ls\nrm -rf ~", "a && b"])
      expect(bashLooksSafe(c)).toBe(false);
  });
  test("non-safe argv0 → review", () => {
    expect(bashLooksSafe("rm -rf x")).toBe(false);
    expect(bashLooksSafe("curl http://x")).toBe(false);
  });
  test("user allow list adds a command", () => {
    expect(bashLooksSafe("git status", ["git status"])).toBe(true);
    expect(bashLooksSafe("mytool", ["mytool"])).toBe(true);
  });
  test("command-runner / destructive argv0 are NOT bypassed (must be reviewed)", () => {
    expect(bashLooksSafe("env rm -rf .")).toBe(false);   // env defeats the allowlist
    expect(bashLooksSafe("env FOO=1 ls")).toBe(false);
    expect(bashLooksSafe("find . -delete")).toBe(false);
    expect(bashLooksSafe("find . -name x")).toBe(false);
  });
});

describe("BashReviewer", () => {
  // BashReviewer's ctor takes { provider: <the provider handle {provider, model}>, model?, timeoutMs? } —
  // same nested-handle convention as Compactor's deps.provider and EngineConfig.provider.
  const handle = (script: any) => ({ provider: { provider: new FakeProvider(script), model: "fake" } });
  const verdict = (v: string, reason: string): ProviderEvent[][] => [
    [{ type: "text_delta", delta: JSON.stringify({ verdict: v, reason }) }, { type: "done", stopReason: "end_turn" }],
  ];

  test("parses safe/unsafe verdicts", async () => {
    expect(await new BashReviewer(handle(verdict("safe", "benign")) as any).review({ command: "ls" })).toEqual({
      verdict: "safe",
      reason: "benign",
    });
    expect(
      await new BashReviewer(handle(verdict("unsafe", "recursive delete")) as any).review({ command: "rm -rf /" }),
    ).toEqual({ verdict: "unsafe", reason: "recursive delete" });
  });

  // Daemon settings surface (2026-09-17 plan, item 4a): `model` is now a LIVE getter, re-invoked on
  // every `review()` call — proves the daemon.ts boot-snapshot bug is actually fixed, not just that
  // the constructor accepts a function. Same instance, two calls, the getter's return value
  // mutated in between — exactly what a `reviewer.model` write hitting a running daemon needs.
  test("model is read LIVE — a getter mutated between calls changes the NEXT call, no restart", async () => {
    const p = new FakeProvider([...verdict("safe", "first"), ...verdict("safe", "second")]);
    let liveModel = "openai/gpt-5.4";
    const reviewer = new BashReviewer({ provider: { provider: p, model: "fake" }, model: () => liveModel } as any);
    await reviewer.review({ command: "ls" });
    expect(p.requests[0]?.model).toBe("openai/gpt-5.4");

    liveModel = "anthropic/claude-opus-5";
    await reviewer.review({ command: "pwd" });
    expect(p.requests[1]?.model).toBe("anthropic/claude-opus-5");
  });

  // The getter returning `undefined` (daemon.ts's own shape when `internalModelFor` refuses a
  // mismatched provider) falls back to `deps.provider.model` — identical to no override at all.
  test("a getter returning undefined falls back to the provider's own model", async () => {
    const p = new FakeProvider(verdict("safe", "ok"));
    const reviewer = new BashReviewer({ provider: { provider: p, model: "fake" }, model: () => undefined } as any);
    await reviewer.review({ command: "ls" });
    expect(p.requests[0]?.model).toBe("fake");
  });

  // Minor 5c (fix wave, pre-merge review): same fix as SessionTitler's (titles.ts) — the fallback
  // (no `reviewer.model` override) now consults `deps.provider.live` (RebindableProvider.live)
  // FIRST, which moves on a SAME-provider model change too, unlike the static `deps.provider.model`
  // snapshot that only ever moves on a rebind crossing catalog providers.
  test("no override -> falls back to the LIVE bound model (deps.provider.live), not the static snapshot", async () => {
    const p = new FakeProvider([...verdict("safe", "first"), ...verdict("safe", "second")]);
    let bound = "codex-oauth/gpt-5.6-sol";
    const reviewer = new BashReviewer({ provider: { provider: p, model: "fake", live: () => ({ model: bound }) } } as any);
    await reviewer.review({ command: "ls" });
    expect(p.requests[0]?.model).toBe("codex-oauth/gpt-5.6-sol"); // NOT "fake", the static snapshot

    bound = "codex-oauth/gpt-5.6-luna";
    await reviewer.review({ command: "pwd" });
    expect(p.requests[1]?.model).toBe("codex-oauth/gpt-5.6-luna");
  });

  test("tools:[] and the justification reaches the provider input", async () => {
    const p = new FakeProvider(verdict("safe", "ok"));
    await new BashReviewer({ provider: { provider: p, model: "fake" } } as any).review({
      command: "rm x",
      justification: "cleaning a temp file JUSTIF_SENTINEL",
    });
    expect(p.requests[0]!.tools).toEqual([]);
    expect(JSON.stringify(p.requests[0]!.input)).toContain("JUSTIF_SENTINEL");
  });

  test("unparseable/empty output → throws", async () => {
    await expect(
      new BashReviewer(
        handle([[{ type: "text_delta", delta: "not json at all" }, { type: "done", stopReason: "end_turn" }]]) as any,
      ).review({ command: "ls" }),
    ).rejects.toThrow();
  });

  test("aborted → throws", async () => {
    const { AbortAwaitProvider } = await import("../../src/agent/test-providers");
    const ac = new AbortController();
    const p = new BashReviewer({ provider: { provider: new AbortAwaitProvider(), model: "fake" } } as any).review(
      { command: "ls" },
      ac.signal,
    );
    ac.abort();
    await expect(p).rejects.toThrow();
  });

  // phase 5e T3: ONE review() entry point serves bash/fs/external — `class` selects the
  // per-class prompt clause + content shape. Omitting `class` (every pre-T3 call site/test above)
  // still means "bash" — verified here rather than assumed, since that's the whole back-compat claim.
  test("class omitted defaults to bash: same instructions as an explicit class:\"bash\"", async () => {
    const p = new FakeProvider(verdict("safe", "ok"));
    await new BashReviewer({ provider: { provider: p, model: "fake" } } as any).review({ command: "ls" });
    expect(p.requests[0]!.instructions).toBe(REVIEW_INSTRUCTION);

    const p2 = new FakeProvider(verdict("safe", "ok"));
    await new BashReviewer({ provider: { provider: p2, model: "fake" } } as any).review({ class: "bash", command: "ls" } as any);
    expect(p2.requests[0]!.instructions).toBe(REVIEW_INSTRUCTION);
  });

  test("class:\"fs\" sends FS_REVIEW_INSTRUCTION + the précis only — no COMMAND/JUSTIFICATION framing", async () => {
    const p = new FakeProvider(verdict("safe", "ok"));
    await new BashReviewer({ provider: { provider: p, model: "fake" } } as any).review({
      class: "fs",
      precis: "write /tmp/x/.ssh/config (42 chars)",
    } as any);
    expect(p.requests[0]!.instructions).toBe(FS_REVIEW_INSTRUCTION);
    expect(p.requests[0]!.instructions).not.toBe(REVIEW_INSTRUCTION);
    const content = JSON.stringify(p.requests[0]!.input);
    expect(content).toContain("write /tmp/x/.ssh/config (42 chars)");
    expect(content).not.toContain("JUSTIFICATION");
  });

  test("class:\"external\" sends EXTERNAL_REVIEW_INSTRUCTION + the précis only", async () => {
    const p = new FakeProvider(verdict("unsafe", "risky"));
    const v = await new BashReviewer({ provider: { provider: p, model: "fake" } } as any).review({
      class: "external",
      precis: 'mcp__fs__delete {"path":"/etc/passwd"}',
    } as any);
    expect(v).toEqual({ verdict: "unsafe", reason: "risky" });
    expect(p.requests[0]!.instructions).toBe(EXTERNAL_REVIEW_INSTRUCTION);
    expect(p.requests[0]!.instructions).not.toBe(REVIEW_INSTRUCTION);
    expect(p.requests[0]!.instructions).not.toBe(FS_REVIEW_INSTRUCTION);
    const content = (p.requests[0]!.input[0] as any).content as string;
    expect(content).toContain('mcp__fs__delete {"path":"/etc/passwd"}');
    expect(content).not.toContain("COMMAND:");
  });
});

// 2026-09-18: `settings.roleEfforts["reviewer.model"]` — wired EXACTLY as daemon.ts wires it
// (`internalRoleEffortFor` over a live settings holder and the bound selection), asserted on the
// OUTGOING `TurnRequest`. See titles.test.ts's twin block for the fall-through-to-bound-model case.
describe("BashReviewer: the reviewer.model role effort", () => {
  const settingsOf = (over: Record<string, unknown>): Settings =>
    Settings.parse({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over });
  const BOUND = { providerId: "openai", model: "gpt-5.6-sol" };
  const safe: ProviderEvent[] = [{ type: "text_delta", delta: '{"verdict":"safe","reason":"ok"}' }, { type: "done", stopReason: "end_turn" }];

  function liveReviewer(initial: Settings) {
    const p = new FakeProvider([safe]);
    const holder = { settings: initial };
    const reviewer = new BashReviewer({
      provider: { provider: p, model: BOUND.model, live: () => BOUND },
      effort: () => internalRoleEffortFor(holder.settings, "reviewer.model", holder.settings.reviewer?.model, BOUND),
    });
    return { p, holder, reviewer };
  }

  test("absent → the request carries NO reasoningEffort key at all, exactly as before", async () => {
    const { p, reviewer } = liveReviewer(settingsOf({}));
    await reviewer.review({ command: "ls" });
    expect("reasoningEffort" in p.requests[0]!).toBe(false);
    const bare = new FakeProvider([safe]);
    await new BashReviewer({ provider: { provider: bare, model: "fake" } }).review({ command: "ls" });
    expect("reasoningEffort" in bare.requests[0]!).toBe(false);
  });

  test("a stored effort the model offers reaches the request", async () => {
    const { p, reviewer } = liveReviewer(settingsOf({ roleEfforts: { "reviewer.model": "high" } }));
    await reviewer.review({ command: "ls" });
    expect(p.requests[0]!.reasoningEffort).toBe("high");
  });

  test("a stored effort the model does NOT offer is mapped or omitted — a verdict still comes back, never a throw", async () => {
    const mapped = liveReviewer(settingsOf({ reviewer: { model: "openai/o4-mini" }, roleEfforts: { "reviewer.model": "xhigh" } }));
    expect(await mapped.reviewer.review({ command: "ls" })).toEqual({ verdict: "safe", reason: "ok" });
    expect(mapped.p.requests[0]!.reasoningEffort).toBe("medium");
    const omitted = liveReviewer(settingsOf({ reviewer: { model: "openai/gpt-5.4" }, roleEfforts: { "reviewer.model": "high" } }));
    expect(await omitted.reviewer.review({ command: "ls" })).toEqual({ verdict: "safe", reason: "ok" });
    expect("reasoningEffort" in omitted.p.requests[0]!).toBe(false);
  });

  test("a settings change lands on the NEXT review from the SAME reviewer — no restart", async () => {
    const { p, holder, reviewer } = liveReviewer(settingsOf({}));
    await reviewer.review({ command: "ls" });
    holder.settings = settingsOf({ roleEfforts: { "reviewer.model": "low" } });
    await reviewer.review({ command: "pwd" });
    expect(p.requests.map((r) => r.reasoningEffort)).toEqual([undefined, "low"]);
  });
});

describe("BashReviewer role-health wiring (2026-09-18) — observation only", () => {
  const handle = (script: any) => ({ provider: { provider: new FakeProvider(script), model: "fake" } });

  test("a provider error records reviewer.model under the tag that ran, and STILL throws the same 'reviewer returned no JSON verdict' as before", async () => {
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-reviewer-rh-")));
    const failing: any = { ...handle([[{ type: "error", code: "network", message: "ECONNRESET" }]]), boundProviderId: () => "openai", roleHealth };
    const reviewer = new BashReviewer(failing);
    // Unchanged: no text ever arrives, so review() still throws its pre-existing "no JSON verdict" error.
    await expect(reviewer.review({ command: "ls" })).rejects.toThrow(/no JSON verdict/);
    const problem = roleHealth.problemFor("reviewer.model", "openai/fake");
    expect(problem).not.toBeNull();
    expect(problem?.reason).toBe("provider-unavailable");
  });

  test("a successful review clears a previously recorded note", async () => {
    const roleHealth = new RoleHealthRegistry(mkdtempSync(join(tmpdir(), "winter-reviewer-rh2-")));
    roleHealth.recordFailure("reviewer.model", "openai/fake", { reason: "other", detail: "stale" });
    const verdict: ProviderEvent[][] = [[{ type: "text_delta", delta: JSON.stringify({ verdict: "safe", reason: "ok" }) }, { type: "done", stopReason: "end_turn" }]];
    const ok: any = { ...handle(verdict), boundProviderId: () => "openai", roleHealth };
    const reviewer = new BashReviewer(ok);
    expect(await reviewer.review({ command: "ls" })).toEqual({ verdict: "safe", reason: "ok" });
    expect(roleHealth.problemFor("reviewer.model", "openai/fake")).toBeNull();
  });

  test("no boundProviderId/roleHealth wired (every pre-existing construction) -> unchanged", async () => {
    const reviewer = new BashReviewer(handle([[{ type: "error", code: "network", message: "x" }]]) as any);
    await expect(reviewer.review({ command: "ls" })).rejects.toThrow(/no JSON verdict/);
  });
});
