import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { createProvider, createRebindableProvider, internalModelFor, internalRoleEffortFor, OPENAI_API_KEY_SECRET, SwappableProvider } from "../../src/providers/manager";
import type { Settings } from "../../src/settings";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";
import type { ModelInfo, Provider, ProviderEvent, TurnRequest } from "../../src/providers/types";

function tmpSettingsFile(settings: Settings): string {
  const p = join(mkdtempSync(join(tmpdir(), "winter-manager-")), "settings.json");
  writeFileSync(p, JSON.stringify(settings));
  return p;
}

// WS-20 (review round 4): `createProvider` now answers `null` for a provider outside
// `INTERNAL_PROVIDER_IDS` (codex-oauth/openai) — every fixture below configures one of those two,
// so a `null` here would itself be the bug the test should catch, never a case to silently paper
// over with `!`.
async function createInternalProvider(
  ...args: Parameters<typeof createProvider>
): Promise<Exclude<Awaited<ReturnType<typeof createProvider>>, null>> {
  const p = await createProvider(...args);
  if (p === null) throw new Error("test fixture expected the internal Provider to build (codex-oauth/openai), got null");
  return p;
}

/** Deterministically bumps a file's mtime forward, so the liveModel resolver's mtime-cache key
 *  reliably changes even when two writes land in the same wall-clock millisecond (the same
 *  aliasing risk ipc/server.ts's livePlugins doc comment calls out for statSync's granularity). */
function bumpMtime(path: string, deltaMs: number): void {
  const now = new Date(Date.now() + deltaMs);
  utimesSync(path, now, now);
}

describe("createProvider", () => {
  test("codex-oauth settings (a codex-oauth/ tag) yield the codex provider (quota-wrapped)", async () => {
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.2-codex" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p.provider.id).toBe("codex-oauth");
    expect(p.model).toBe("gpt-5.2-codex"); // WS-20: the BARE modelId half, split from the tag
    expect(p.quota.state().kind).toBe("ok");
  });

  test("a non-codex-oauth tag (openai/) requires an api key in the secret store", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await expect(createProvider(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
    )).rejects.toThrow(/api key/i);
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
    );
    // WS-20: the internal Provider abstraction has no more "openai-compatible" id of its own —
    // every non-codex-oauth tag goes through the SAME openai-compatible adapter, still reported
    // under its own runtime id.
    expect(p.provider.id).toBe("openai-compatible");
  });

  // WS-20 (review round 4): a provider outside `INTERNAL_PROVIDER_IDS` (codex-oauth/openai) answers
  // `null` — never mis-built as an OpenAI-compatible client pointed at a provider it was never
  // meant to speak to, and never a throw (`settings.provider.model` itself is unconstrained now;
  // this is the ONE place the codex-oauth/openai constraint is actually enforced).
  test("a provider outside INTERNAL_PROVIDER_IDS (e.g. anthropic) answers null, never a mis-built client", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p).toBeNull();
  });

  test("a winter-test/* primary also answers null (a provider-less double, not an internal provider)", async () => {
    const p = await createProvider(
      { schemaVersion: 3, provider: { model: "winter-test/echo" } } as unknown as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
    );
    expect(p).toBeNull();
  });
});

describe("ActiveProvider.liveModel (no-restart model resolution)", () => {
  test("no settingsPath -> liveModel() just keeps returning the boot selection", async () => {
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra", reasoningEffort: "high" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      // settingsPath omitted
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high", providerId: "codex-oauth" });
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "high", providerId: "codex-oauth" }); // stable across calls
  });

  test("a settings.json edit is picked up on the NEXT liveModel() call — no re-construction", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" });

    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-luna", reasoningEffort: "max" } }));
    bumpMtime(settingsPath, 5_000);

    expect(p.liveModel()).toEqual({ model: "gpt-5.6-luna", reasoningEffort: "max", providerId: "codex-oauth" });
  });

  test("mtime-cached: an unchanged settingsPath does not re-parse (cache hit returns the same object)", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    const first = p.liveModel();
    const second = p.liveModel();
    expect(second).toBe(first); // same cached object reference — no fresh parse happened
  });

  // WS-20: the CODEX_MODELS deprecated-slug fallback (and its DEFAULT_CODEX_MODEL target) is
  // DELETED — `settings.provider.model` is read verbatim (bare modelId split from the tag), no
  // rewrite. A "deprecated" slug like gpt-5.4 now passes through exactly like any other.
  test("an unlisted codex-oauth slug passes through verbatim — no deprecated-slug rewrite any more", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.4" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.4", providerId: "codex-oauth" });
  });

  test("a non-codex-oauth tag's model passes the configured id through untouched (no allowlist)", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "openai/some-arbitrary-model" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "some-arbitrary-model", providerId: "openai" });
  });

  test("parse failure (corrupt JSON) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" });

    writeFileSync(settingsPath, "{ not valid json");
    bumpMtime(settingsPath, 5_000);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-sol", providerId: "codex-oauth" }); // last good, unchanged
  });

  test("parse failure (missing file) on re-read falls back to the LAST GOOD value, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "winter-manager-missing-"));
    const settingsPath = join(dir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } }));
    const p = await createInternalProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-terra" } } as Settings,
      new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))),
      settingsPath,
    );
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", providerId: "codex-oauth" });

    require("node:fs").rmSync(settingsPath);

    expect(() => p.liveModel()).not.toThrow();
    expect(p.liveModel()).toEqual({ model: "gpt-5.6-terra", providerId: "codex-oauth" }); // last good, unchanged
  });
});

describe("internalModelFor (WS-20 review round 1, GUARD)", () => {
  test("a pin naming the SAME provider as the daemon's internal Provider returns the bare modelId", () => {
    expect(internalModelFor("codex-oauth/gpt-5.6-terra" as ModelTag, { providerId: "codex-oauth" }, "pins.dream")).toBe("gpt-5.6-terra");
  });

  test("a pin naming a DIFFERENT provider returns undefined and logs one line naming the field, never the tag or a secret", () => {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const result = internalModelFor("openai/gpt-5.6-terra" as ModelTag, { providerId: "codex-oauth" }, "pins.dream");
      expect(result).toBeUndefined();
    } finally {
      console.error = realError;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pins.dream");
    expect(lines[0]).toContain("openai");
    expect(lines[0]).toContain("codex-oauth");
  });
});

// 2026-09-18: the effort for the two internal roles whose model FALLS BACK rather than skipping.
// What actually reaches the request is asserted in agent/titles.test.ts and agent/reviewer.test.ts,
// which wire this function exactly as daemon.ts does; this pins the row it maps against.
describe("internalRoleEffortFor (titles.model / reviewer.model)", () => {
  const settingsOf = (over: Record<string, unknown>): Settings =>
    ({ schemaVersion: 3, provider: { model: "openai/gpt-5.6-sol" }, ...over }) as Settings;
  const bound = { providerId: "openai", model: "gpt-5.6-sol" };

  test("nothing stored → undefined: these roles never sent an effort, and still do not", () => {
    expect(internalRoleEffortFor(settingsOf({}), "titles.model", undefined, bound)).toBeUndefined();
    expect(internalRoleEffortFor(null, "reviewer.model", undefined, bound)).toBeUndefined();
  });

  test("an unset pin runs on the bound model — the effort is mapped onto THAT row, recomposed as a tag", () => {
    const s = settingsOf({ roleEfforts: { "titles.model": "max" } });
    expect(internalRoleEffortFor(s, "titles.model", undefined, bound)).toBe("max");
    expect(internalRoleEffortFor(s, "titles.model", undefined, { providerId: "openai", model: "o4-mini" })).toBe("medium");
    expect(internalRoleEffortFor(s, "titles.model", undefined, { providerId: "openai", model: "gpt-5.4" })).toBeUndefined();
  });

  test("a pin on the bound provider is the row; a pin on ANOTHER provider is not (it was refused) — and no log line is written here", () => {
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      const s = settingsOf({ roleEfforts: { "reviewer.model": "xhigh" } });
      expect(internalRoleEffortFor(s, "reviewer.model", "openai/o4-mini" as ModelTag, bound)).toBe("medium");        // the pin's row
      expect(internalRoleEffortFor(s, "reviewer.model", "anthropic/claude-opus-5" as ModelTag, bound)).toBe("xhigh"); // the BOUND row (sol lists xhigh)
      expect(internalRoleEffortFor(s, "reviewer.model", "anthropic/claude-opus-5" as ModelTag, { providerId: "openai", model: "o4-mini" })).toBe("medium");
      // Per-role: the titler's effort is not the reviewer's.
      expect(internalRoleEffortFor(s, "titles.model", undefined, bound)).toBeUndefined();
    } finally { console.error = realError; }
    expect(lines).toEqual([]);
  });
});

// Daemon settings surface (2026-09-17 plan, item 2): a fake `Provider` whose `streamTurn` can be
// paused mid-generator and resumed on demand — the direct way to prove a rebind never tears an
// in-flight call, without needing a real network backend to hang.
class ControllableProvider implements Provider {
  readonly id: string;
  private release?: () => void;
  private readonly firstDelta: string;
  private readonly secondDelta: string;
  constructor(id: string, firstDelta: string, secondDelta: string) {
    this.id = id;
    this.firstDelta = firstDelta;
    this.secondDelta = secondDelta;
  }
  models(): ModelInfo[] { return []; }
  async *streamTurn(_req: TurnRequest): AsyncIterable<ProviderEvent> {
    yield { type: "text_delta", delta: this.firstDelta };
    await new Promise<void>((resolve) => { this.release = resolve; });
    yield { type: "text_delta", delta: this.secondDelta };
  }
  /** Lets a paused `streamTurn` call proceed past its first yield — the "still running" half of
   *  an in-flight call the test holds open across a `rebind()`. */
  unblock(): void {
    this.release?.();
  }
}

const noopReq: TurnRequest = { model: "x", input: [] };

describe("SwappableProvider (item 2 — a hot provider.model write must not tear an in-flight call)", () => {
  test("id/models delegate to whichever backend is current", () => {
    const a = new ControllableProvider("provider-a", "a1", "a2");
    const swappable = new SwappableProvider(a);
    expect(swappable.id).toBe("provider-a");
    const b = new ControllableProvider("provider-b", "b1", "b2");
    swappable.rebind(b);
    expect(swappable.id).toBe("provider-b");
  });

  test("an in-flight streamTurn call keeps running against the backend it started on, even after a rebind", async () => {
    const a = new ControllableProvider("provider-a", "a1", "a2");
    const b = new ControllableProvider("provider-b", "b1", "b2");
    const swappable = new SwappableProvider(a);

    const iter = swappable.streamTurn(noopReq)[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ type: "text_delta", delta: "a1" }); // in flight, paused mid-generator

    swappable.rebind(b); // the swap happens WHILE the call above is still suspended
    // `iter.next()` resumes A synchronously up to its next await point (where `release` is
    // captured) before this call's own promise settles — so `unblock()` must fire AFTER starting
    // the resumption, not before (calling it first would release a promise nothing awaits yet).
    const secondPromise = iter.next();
    a.unblock(); // let A's generator proceed past its await point

    const second = await secondPromise;
    expect(second.value).toEqual({ type: "text_delta", delta: "a2" }); // still A — never torn
    const third = await iter.next();
    expect(third.done).toBe(true);
  });

  test("a call started AFTER a rebind dispatches to the new backend", async () => {
    const a = new ControllableProvider("provider-a", "a1", "a2");
    const b = new ControllableProvider("provider-b", "b1", "b2");
    const swappable = new SwappableProvider(a);
    swappable.rebind(b);

    const events: ProviderEvent[] = [];
    const iter = swappable.streamTurn(noopReq)[Symbol.asyncIterator]();
    events.push((await iter.next()).value as ProviderEvent);
    const secondPromise = iter.next();
    b.unblock();
    events.push((await secondPromise).value as ProviderEvent);
    expect(events).toEqual([{ type: "text_delta", delta: "b1" }, { type: "text_delta", delta: "b2" }]);
  });
});

describe("createRebindableProvider / refresh (item 2 — the internal Provider follows provider.model with no restart)", () => {
  test("a provider.model write that crosses catalog providers rebinds .provider in place", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    expect(active.provider.id).toBe("codex-oauth");
    const providerRefBefore = active.provider; // same object identity must survive the rebind

    const next = { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings;
    // Production calls `refresh` only AFTER the settings-watcher has already loaded `next` FROM
    // `settingsPath` (settings-apply.ts's `apply(prev, next)` always agrees with the file it was
    // just re-read from) — write it here too, or `liveModel()`'s own live re-read (which prefers
    // disk over the boot-time argument from its very first call, by design — see
    // `buildLiveModelResolver`'s existing "picked up on the NEXT call" test) would report the
    // stale on-disk model under the NEW providerId.
    writeFileSync(settingsPath, JSON.stringify(next));
    bumpMtime(settingsPath, 5_000);
    const rebound = await active.refresh(next, store, settingsPath);
    expect(rebound).toBe(true);
    expect(active.provider).toBe(providerRefBefore); // IDENTITY unchanged — every existing holder still valid
    expect(active.provider.id).toBe("openai-compatible"); // but the BACKEND it dispatches to has changed
    expect(active.model).toBe("gpt-5.2");
  });

  test("a same-provider write (a different model, same provider) is a no-op — no rebuild attempted", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    const rebound = await active.refresh({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-luna" } } as Settings, store, settingsPath);
    expect(rebound).toBe(false); // same provider — refresh must not even attempt a rebuild
    expect(active.provider.id).toBe("codex-oauth");
  });

  test("moving OUTSIDE INTERNAL_PROVIDER_IDS leaves the old backend bound, logs one line for this one call, never torn down", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    const providerRefBefore = active.provider;

    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    let rebound: boolean;
    try {
      rebound = await active.refresh({ schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } } as Settings, store, settingsPath);
    } finally {
      console.error = realError;
    }
    expect(rebound).toBe(false);
    expect(active.provider).toBe(providerRefBefore);
    expect(active.provider.id).toBe("codex-oauth"); // the old backend keeps serving every caller
    expect(lines).toHaveLength(1);
  });

  test("NOT deduped: a settings write that leaves the provider STILL stuck logs AGAIN, every time — settings-apply.ts's applyAgentProviderDiff calls refresh unconditionally, and this function does not suppress a repeated failure", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");

    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const stuck = { schemaVersion: 3, provider: { model: "anthropic/claude-sonnet-5" } } as Settings;
    try {
      // Three calls with the IDENTICAL still-outside-INTERNAL_PROVIDER_IDS settings, modeling three
      // unrelated settings.json writes (an LSP toggle, a plugin enable, …) landing while stuck.
      await active.refresh(stuck, store, settingsPath);
      await active.refresh(stuck, store, settingsPath);
      await active.refresh(stuck, store, settingsPath);
    } finally {
      console.error = realError;
    }
    expect(lines).toHaveLength(3); // one line PER CALL, not deduped to one for the daemon's life
    expect(active.provider.id).toBe("codex-oauth"); // still never torn down
  });

  test("a failed rebuild (no stored credential for the new provider) leaves the old backend bound", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-"))); // no OPENAI_API_KEY_SECRET set
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    const providerRefBefore = active.provider;

    const realError = console.error;
    console.error = () => {};
    let rebound: boolean;
    try {
      rebound = await active.refresh(
        { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
        store,
        settingsPath,
      );
    } finally {
      console.error = realError;
    }
    expect(rebound).toBe(false);
    expect(active.provider).toBe(providerRefBefore);
    expect(active.provider.id).toBe("codex-oauth");
  });

  test("quota is the SAME instance across a rebind (per-daemon, not per-provider-instance)", async () => {
    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "s-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");
    const settingsPath = tmpSettingsFile({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings);
    const active = await createRebindableProvider(
      { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } } as Settings,
      store,
      settingsPath,
    );
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    const quotaBefore = active.quota;
    await active.refresh(
      { schemaVersion: 3, provider: { model: "openai/gpt-5.2" }, providers: { openai: { baseUrl: "https://x" } } } as unknown as Settings,
      store,
      settingsPath,
    );
    expect(active.quota).toBe(quotaBefore);
  });
});
