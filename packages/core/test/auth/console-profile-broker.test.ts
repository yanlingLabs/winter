// Winter Phase 10a (O4) — REVISED per the "providers system lives on the agent SDKs" ruling: this
// module is a thin host adapter, so its tests exercise WIRING against a FAKE `AnthropicConsoleSdk`
// — never a stub binary, never a real spawn. Lane S's own SDK repo tests the actual spawn/redaction/
// timer behaviour; nothing here duplicates that.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { anthropicConfigDirFor, ANTHROPIC_PROFILE_NAME, officialConfigDirFor } from "../../src/runtime-sdk/official-options";
import {
  CONSOLE_BROKER_UNAVAILABLE_REASON,
  createConsoleProfileBroker,
  UNAVAILABLE_SDK,
  type AnthropicConsoleSdk,
  type AnthropicLoginHandle,
  type AnthropicLoginOptions,
} from "../../src/auth/console-profile-broker";

const roots: string[] = [];
function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), "winter-console-broker-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fake `AnthropicConsoleSdk` that records every call it receives, so tests assert on the
 *  options/args this door built without any real process ever spawning. */
function fakeSdk(overrides: Partial<AnthropicConsoleSdk> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const record = (fn: string, args: unknown[]) => calls.push({ fn, args });
  const sdk: AnthropicConsoleSdk = {
    startProviderLogin: async (provider, store, options) => {
      record("startProviderLogin", [provider, store, options]);
      return { submitCode: async () => {}, done: Promise.resolve({ ok: true, profile: ANTHROPIC_PROFILE_NAME }) };
    },
    refreshAnthropicBearer: async (store, options) => {
      record("refreshAnthropicBearer", [store, options]);
      return { ok: true, expiresAt: 123 };
    },
    anthropicConsoleProfileExists: (dir, profile) => {
      record("anthropicConsoleProfileExists", [dir, profile]);
      return true;
    },
    logoutAnthropicConsole: async (store, options) => {
      record("logoutAnthropicConsole", [store, options]);
    },
    createAnthropicBearerRefresher: (store, options, clock) => {
      record("createAnthropicBearerRefresher", [store, options, clock]);
      return { start: () => record("refresher.start", []), stop: () => record("refresher.stop", []) };
    },
    ...overrides,
  };
  return { sdk, calls };
}

describe("createConsoleProfileBroker — login", () => {
  test("refuses claude_executable_unavailable WITHOUT ever calling the sdk", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => undefined, secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await expect(broker.login(() => {})).rejects.toThrow("claude_executable_unavailable");
    expect(calls).toEqual([]);
  });

  test("calls sdk.startProviderLogin(\"anthropic\", store, options) with the right paths, profile, and onLine forwarded", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const lines: string[] = [];
    const onLine = (l: string) => lines.push(l);
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", antExecutable: () => "/bin/ant",
      secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    const handle = await broker.login(onLine);
    expect(calls.length).toBe(1);
    expect(calls[0]!.fn).toBe("startProviderLogin");
    const [provider, , options] = calls[0]!.args as [string, unknown, AnthropicLoginOptions];
    expect(provider).toBe("anthropic");
    expect(options.claudeExecutable).toBe("/bin/claude");
    expect(options.antExecutable).toBe("/bin/ant");
    expect(options.anthropicConfigDir).toBe(anthropicConfigDirFor(home));
    expect(options.claudeConfigDir).toBe(officialConfigDirFor(home));
    expect(options.profile).toBe(ANTHROPIC_PROFILE_NAME);
    expect(options.onLine).toBe(onLine);
    // The handle the fake sdk returned is threaded straight back to the caller.
    expect(await handle.done).toEqual({ ok: true, profile: ANTHROPIC_PROFILE_NAME });
  });

  test("antExecutable is OMITTED from options (not even undefined) when the resolver isn't supplied", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    await broker.login(() => {});
    const options = calls[0]!.args[2] as AnthropicLoginOptions;
    expect("antExecutable" in options).toBe(false);
  });

  test("submitCode on the returned handle is the sdk's own — this door does not intercept it", async () => {
    const home = freshHome();
    const submitted: string[] = [];
    const { sdk } = fakeSdk({
      startProviderLogin: async (): Promise<AnthropicLoginHandle> => ({
        submitCode: async (code) => { submitted.push(code); },
        done: Promise.resolve({ ok: true, profile: ANTHROPIC_PROFILE_NAME }),
      }),
    });
    const broker = createConsoleProfileBroker({
      home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk,
    });
    const handle = await broker.login(() => {});
    await handle.submitCode("123456");
    expect(submitted).toEqual(["123456"]);
  });
});

describe("createConsoleProfileBroker — profileExists / refreshBearer / logout", () => {
  test("profileExists() forwards to sdk.anthropicConsoleProfileExists(anthropicConfigDir, profile) synchronously", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => undefined, secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(broker.profileExists()).toBe(true);
    expect(calls).toEqual([{ fn: "anthropicConsoleProfileExists", args: [anthropicConfigDirFor(home), ANTHROPIC_PROFILE_NAME] }]);
  });

  test("refreshBearer() forwards to sdk.refreshAnthropicBearer(store, options) and returns its result verbatim", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    const result = await broker.refreshBearer();
    expect(result).toEqual({ ok: true, expiresAt: 123 });
    expect(calls[0]!.fn).toBe("refreshAnthropicBearer");
  });

  test("logout() forwards to sdk.logoutAnthropicConsole(store, options) and awaits it", async () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    await broker.logout();
    expect(calls[0]!.fn).toBe("logoutAnthropicConsole");
  });
});

describe("createConsoleProfileBroker — startRefresher / stopRefresher", () => {
  test("startRefresher() builds ONE refresher via sdk.createAnthropicBearerRefresher and calls .start()", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    broker.startRefresher();
    expect(calls.map((c) => c.fn)).toEqual(["createAnthropicBearerRefresher", "refresher.start"]);
  });

  test("a second startRefresher() before stopRefresher() is a no-op — never a second refresher instance", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    broker.startRefresher();
    broker.startRefresher();
    expect(calls.filter((c) => c.fn === "createAnthropicBearerRefresher").length).toBe(1);
  });

  test("stopRefresher() calls .stop() on the current refresher and allows a fresh one to start again", () => {
    const home = freshHome();
    const { sdk, calls } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    broker.startRefresher();
    broker.stopRefresher();
    broker.startRefresher();
    expect(calls.map((c) => c.fn)).toEqual([
      "createAnthropicBearerRefresher", "refresher.start",
      "refresher.stop",
      "createAnthropicBearerRefresher", "refresher.start",
    ]);
  });

  test("stopRefresher() with no refresher running is a harmless no-op", () => {
    const home = freshHome();
    const { sdk } = fakeSdk();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")), sdk });
    expect(() => broker.stopRefresher()).not.toThrow();
  });
});

describe("UNAVAILABLE_SDK — the default before the real package publishes (controller wires it after v0.0.6)", () => {
  test("the async calls reject with CONSOLE_BROKER_UNAVAILABLE_REASON, never a raw/unnamed error", async () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")) });
    await expect(broker.refreshBearer()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
    await expect(broker.logout()).rejects.toThrow(CONSOLE_BROKER_UNAVAILABLE_REASON);
  });

  test("the sync calls answer a SAFE inert default rather than throwing — profileExists() must never crash daemon boot", () => {
    const home = freshHome();
    const broker = createConsoleProfileBroker({ home, claudeExecutable: () => "/bin/claude", secrets: new FileSecretStore(join(home, "secrets")) });
    expect(broker.profileExists()).toBe(false);
    expect(() => broker.startRefresher()).not.toThrow();
    expect(() => broker.stopRefresher()).not.toThrow();
  });

  test("UNAVAILABLE_SDK is exported directly, so a caller can identify the not-yet-wired state without constructing a broker", () => {
    expect(UNAVAILABLE_SDK.anthropicConsoleProfileExists("x", "winter")).toBe(false);
  });
});
