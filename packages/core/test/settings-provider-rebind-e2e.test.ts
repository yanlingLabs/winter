// Daemon settings surface (2026-09-17 plan, item 2): the composed, "live daemon-shaped fixture"
// proof — a real settings.json on disk, a real `SettingsWatcher`, a real `makeApply`, and a real
// `RebindableProvider` (built the exact way `daemon.ts` builds `agentProvider`), wired together
// exactly like `daemon.ts` wires them, MINUS the rest of the daemon (no IPC server, no engine — the
// watcher's own injectable `watch` seam stands in for `fs.watch`, matching settings-watcher.test.ts's
// own precedent, so this test needs no real filesystem polling to be deterministic).
//
// What this proves that the two unit-level suites (test/providers/manager.test.ts,
// test/settings-apply.test.ts) do not on their own: that `daemon.ts`'s ACTUAL wiring — a settings
// FILE write triggering the watcher, which calls `makeApply`'s built `apply(prev, next)`, which
// calls `deps.refreshAgentProvider`, which is `RebindableProvider.refresh` bound to the SAME
// `secrets`/`settingsPath` `createRebindableProvider` was built with — really does swap the backend
// a consumer already holds a reference to, end to end, with no daemon restart.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/auth/secret-store";
import { createRebindableProvider, OPENAI_API_KEY_SECRET } from "../src/providers/manager";
import { makeApply } from "../src/settings-apply";
import { SettingsWatcher } from "../src/settings-watcher";
import { loadSettings, type Settings } from "../src/settings";

describe("settings.json → SettingsWatcher → makeApply → RebindableProvider.refresh (item 2, end to end)", () => {
  test("a provider.model write on disk swaps the backend a consumer already holds a reference to — no restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "winter-provider-rebind-e2e-"));
    const settingsPath = join(home, "settings.json");
    const bootSettings = { schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" } };
    writeFileSync(settingsPath, JSON.stringify(bootSettings, null, 2) + "\n");

    const store = new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-provider-rebind-secrets-")));
    await store.set(OPENAI_API_KEY_SECRET, "sk-test");

    const active = await createRebindableProvider(loadSettings(settingsPath), store, settingsPath);
    if (active === null) throw new Error("expected a real RebindableProvider (codex-oauth)");
    expect(active.provider.id).toBe("codex-oauth");

    // The consumer: holds a reference to `active.provider` (a `SwappableProvider`) captured BEFORE
    // any settings change — exactly what `SessionTitler`/`BashReviewer`/`Dreamer`/`SessionCleaner`
    // do via the `agentProvider` wrapper, and what the research runner does by unwrapping
    // `.provider` at construction. If this reference's own `.id` changes after the write below,
    // every one of those real consumers would see the swap too, with no code of their own re-run.
    const consumerCapturedProviderRef = active.provider;

    let fire = () => {};
    const apply = makeApply({
      setLiveSettings: () => {},
      registry: { unregister: () => {} } as any,
      buildComputerService: () => ({}) as any,
      registerComputer: () => {},
      teardownComputer: () => {},
      computerInFlight: () => false,
      buildLspManager: () => ({}) as any,
      registerLsp: () => {},
      teardownLsp: () => {},
      // THE wiring under test — the exact shape `daemon.ts` builds for `makeApply`'s
      // `refreshAgentProvider` dep.
      refreshAgentProvider: (next) => active.refresh(next, store, settingsPath),
    });
    const watcher = new SettingsWatcher({
      path: settingsPath,
      load: loadSettings,
      apply,
      debounceMs: 5,
      watch: (_p, cb) => {
        fire = cb;
        return { close() {} };
      },
    });
    watcher.start(loadSettings(settingsPath));

    // The write a Mac Settings pane's `settings.setModelRole("provider.model", "openai/gpt-5.2")`
    // (or an equivalent `provider.configure`) would ultimately produce on disk.
    const next: Settings = { schemaVersion: 3, provider: { model: "openai/gpt-5.2" as any }, providers: { openai: { baseUrl: "https://x" } } };
    writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");
    fire(); // the injected fs.watch seam — see settings-watcher.test.ts's own precedent

    // Debounced + async (refresh awaits `createProvider`, which for the openai branch awaits a
    // keychain read) — poll rather than a fixed sleep, bounded so a real regression fails fast.
    const deadline = Date.now() + 2000;
    while (consumerCapturedProviderRef.id !== "openai-compatible") {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the rebind — still "${consumerCapturedProviderRef.id}"`);
      await Bun.sleep(10);
    }

    expect(consumerCapturedProviderRef).toBe(active.provider); // identity never changed
    expect(consumerCapturedProviderRef.id).toBe("openai-compatible"); // but the backend it dispatches to did
    expect(active.model).toBe("gpt-5.2");

    watcher.stop();
  });
});
