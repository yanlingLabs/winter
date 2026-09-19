import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, OPENAI_API_KEY_SECRET, CODEX_SECRET_NAMES, writeCredentialMaterial } from "@yanlinglabs/winter-core";
import { runCredentialsRoute, runLogoutOpenAiRoute, writeCredentialThroughDaemonOrLocally, notifyDaemonOfOutOfBandCredentialChange, credentialEffectNote, type CredentialRpcDoor } from "../src/main";
import { METHODS } from "@yanlinglabs/winter-protocol";

// WS-19 (W19-11, acceptance B-4) — `winter credentials` and `winter logout --openai`.
//
// Driven through the EXTRACTED route functions, the same convention `cli-verb-gates.test.ts`
// established for the eight session verbs: store + args in, a plain result out, nothing printed and
// nothing exited. That is what makes them testable at all here — the real `case` blocks construct a
// `KeychainSecretStore`, whose service resolves to the REAL `com.winter.core` (no home is passed, so
// the `WINTER_KEYCHAIN_SERVICE` test override is deliberately inert for it), and a test must never
// reach that. A `FileSecretStore` in a mkdtemp dir stands in.
//
// The masked prompt is injected rather than driven: `readSecret`'s raw-mode TTY read is the ONLY
// door the real command accepts a value through — never a flag, a pipe or an env var — and what is
// worth pinning here is that the route never ASKS for one until the verb and provider are valid.

const SENTINEL = "WS19-SENTINEL-cli-73b0d2";

let dir: string;
let home: string;
let secrets: FileSecretStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ws19-cli-"));
  home = join(dir, "home");
  secrets = new FileSecretStore(join(dir, "secrets"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never = async (): Promise<string> => { throw new Error("readKey must not be called"); };

describe("winter credentials", () => {
  test("a bare `credentials` lists, and every row carries the fields a client keys on", async () => {
    const r = await runCredentialsRoute(secrets, home, undefined, undefined, never);
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== "list") throw new Error("expected a list");
    expect(r.rows.length).toBeGreaterThan(100);
    for (const row of r.rows) {
      for (const field of ["providerId", "displayName", "group", "authKinds", "manageable", "present", "risk", "door"] as const) {
        expect(row[field]).toBeDefined();
      }
    }
  });

  test("set -> list -> remove round-trips on a temp store, and the value never appears in any result", async () => {
    const set = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => SENTINEL);
    expect(set).toEqual({ ok: true, kind: "set", providerId: "deepseek", via: "in-process" });
    expect(JSON.stringify(set)).not.toContain(SENTINEL);

    const list = await runCredentialsRoute(secrets, home, "list", undefined, never);
    if (!list.ok || list.kind !== "list") throw new Error("expected a list");
    expect(list.rows.find((r) => r.providerId === "deepseek")?.present).toBe(true);
    expect(JSON.stringify(list)).not.toContain(SENTINEL);

    expect(await runCredentialsRoute(secrets, home, "remove", "deepseek", never)).toEqual({ ok: true, kind: "remove", providerId: "deepseek", removed: true, via: "in-process" });
    expect(await runCredentialsRoute(secrets, home, "remove", "deepseek", never)).toEqual({ ok: true, kind: "remove", providerId: "deepseek", removed: false, via: "in-process" });
  });

  test("a store that answers NOTHING is a typed refusal, never \"none stored\" (review Minor 4)", async () => {
    const dead = {
      get: async (): Promise<string | null> => { throw Object.assign(new Error("keychain locked"), { code: "EKEYCHAINLOCKED" }); },
      set: async (): Promise<void> => { throw new Error("unused"); },
      delete: async (): Promise<boolean> => { throw new Error("unused"); },
    };
    const r = await runCredentialsRoute(dead, home, "list", undefined, never);
    expect(r).toMatchObject({ ok: false, code: "credential_store_unavailable" });
  });

  test("a 4097-character value is refused TYPED, and the message never says how long it was (review Minor 7)", async () => {
    const r = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => "a".repeat(4097));
    expect(r).toMatchObject({ ok: false, code: "credential_value_invalid" });
    if (r.ok) throw new Error("expected a refusal");
    expect(r.message).not.toMatch(/\d/);
    expect(await secrets.get("deepseek:default")).toBeNull();
  });

  test("the masked prompt is never reached for a malformed invocation — no staring at a prompt for a key that was going to be refused", async () => {
    // `never` throws if called; a missing provider id must be caught before it.
    expect(await runCredentialsRoute(secrets, home, "set", undefined, never)).toEqual({ ok: false, message: "usage: winter credentials set <providerId>" });
    expect(await runCredentialsRoute(secrets, home, "nonsense", undefined, never)).toMatchObject({ ok: false });
  });

  test("an unknown provider and an unsupported door both print the typed reason; the door names the way that DOES work", async () => {
    expect(await runCredentialsRoute(secrets, home, "set", "not-a-provider", async () => SENTINEL))
      .toMatchObject({ ok: false, code: "credential_provider_unknown" });
    expect(await runCredentialsRoute(secrets, home, "set", "codex-oauth", async () => SENTINEL))
      .toMatchObject({ ok: false, code: "credential_kind_unsupported", door: "cli-oauth" });
    expect(await runCredentialsRoute(secrets, home, "remove", "not-a-provider", never))
      .toMatchObject({ ok: false, code: "credential_provider_unknown" });
  });

  test("an unusable value is refused with the typed reason and the message never quotes it", async () => {
    const r = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => `${SENTINEL}​`);
    expect(r).toMatchObject({ ok: false, code: "credential_value_invalid" });
    if (r.ok) throw new Error("expected a refusal");
    expect(r.message).not.toContain(SENTINEL);
    // ...and nothing was stored.
    expect(await secrets.get("deepseek:default")).toBeNull();
  });

  test("the on-disk item is the JSON material record the spawned child parses — never a bare string", async () => {
    await runCredentialsRoute(secrets, home, "set", "zai", async () => SENTINEL);
    const raw = readFileSync(join(dir, "secrets", "zai:default"), "utf8");
    expect(JSON.parse(raw)).toEqual({ kind: "api-key", key: SENTINEL });
  });

  test("remove codex-oauth clears the material record AND the five legacy raw records", async () => {
    await writeCredentialMaterial(secrets, "codex-oauth:default", { kind: "oauth", accessToken: SENTINEL });
    for (const name of Object.values(CODEX_SECRET_NAMES)) await secrets.set(name, SENTINEL);
    expect(await runCredentialsRoute(secrets, home, "remove", "codex-oauth", never)).toMatchObject({ ok: true, removed: true, via: "in-process" });
    expect(await secrets.get("codex-oauth:default")).toBeNull();
    for (const name of Object.values(CODEX_SECRET_NAMES)) expect(await secrets.get(name)).toBeNull();
  });
});

describe("winter logout --openai (W19-11)", () => {
  test("clears BOTH the material record and the legacy raw record", async () => {
    await writeCredentialMaterial(secrets, "openai:default", { kind: "api-key", key: SENTINEL });
    await secrets.set(OPENAI_API_KEY_SECRET, `${SENTINEL}-legacy`);
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: true, via: "in-process" });
    expect(await secrets.get("openai:default")).toBeNull();
    expect(await secrets.get(OPENAI_API_KEY_SECRET)).toBeNull();
  });

  test("a legacy-only install still reports removed — the stale raw record is what was live there", async () => {
    await secrets.set(OPENAI_API_KEY_SECRET, `${SENTINEL}-legacy`);
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: true, via: "in-process" });
  });

  test("nothing stored -> removed:false, a successful no-op", async () => {
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: false, via: "in-process" });
  });
});

describe("the usage string lists every credential verb and flag (W19-11)", () => {
  test("credentials' three verbs, logout's three flags, and login's --anthropic-console are all named", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
    const usage = src.slice(src.indexOf("winter ${CORE_VERSION} — commands:"));
    const block = usage.slice(0, usage.indexOf("`);"));
    for (const fragment of [
      "credentials [list]",
      "credentials set <providerId>",
      "credentials remove <providerId>",
      "--anthropic-console",
      "--openai",
      "--anthropic-key",
    ]) {
      expect(block).toContain(fragment);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WS-19 fix round 4 — THE CLI's WRITE DOORS GO THROUGH THE DAEMON WHEN ONE IS LISTENING.
//
// Every credential verb here wrote the Keychain IN-PROCESS, so the daemon never learned of the
// change: a live child's `Options.provider.authRef` is fixed at spawn, and a key added from the
// terminal did not reach a session already running until the 900 s idle reap — the same journey the
// whole-branch review's MAJOR 1 caught on the RPC door, surviving on this one. Meanwhile the CLI
// printed "no daemon restart needed".
//
// The in-process path is still the fallback, and it is the RIGHT fallback (`winter login` has always
// worked with no daemon) — but the two outcomes are different promises and the copy now says which.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the daemon door (fix round 4)", () => {
  /** A scripted daemon: records the method and params it was asked for, answers like the real one. */
  function scriptedDaemon(answers: Record<string, unknown> = {}) {
    const calls: Array<{ method: string; params: any }> = [];
    let closed = 0;
    const door: CredentialRpcDoor = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params: params as any });
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        return answer ?? { ok: true };
      },
      close: () => { closed++; },
    };
    return { door, calls, closed: () => closed };
  }

  test("credentials set goes over the socket when a daemon is listening — and never writes the store itself", async () => {
    const { door, calls, closed } = scriptedDaemon();
    const r = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => SENTINEL, async () => door);
    expect(r).toEqual({ ok: true, kind: "set", providerId: "deepseek", via: "daemon" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe(METHODS.credentialSet);
    expect(calls[0]!.params.providerId).toBe("deepseek");
    // THE DAEMON STORED IT, not this process — that is the whole point: the daemon is the one that
    // can also replace the live children.
    expect(await secrets.get("deepseek:default")).toBeNull();
    expect(closed()).toBe(1);   // the connection is never leaked
  });

  test("credentials remove goes over the socket, and the daemon's `removed` is what is reported", async () => {
    const { door, calls } = scriptedDaemon({ [METHODS.credentialRemove]: { ok: true, removed: true } });
    const r = await runCredentialsRoute(secrets, home, "remove", "zai", never, async () => door);
    expect(r).toEqual({ ok: true, kind: "remove", providerId: "zai", removed: true, via: "daemon" });
    expect(calls[0]!.method).toBe(METHODS.credentialRemove);
    expect(calls[0]!.params).toEqual({ providerId: "zai" });
  });

  test("NO daemon -> the in-process fallback, and the copy says which promise the user got", async () => {
    const r = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => SENTINEL, async () => undefined);
    expect(r).toEqual({ ok: true, kind: "set", providerId: "deepseek", via: "in-process" });
    expect(JSON.parse((await secrets.get("deepseek:default"))!)).toEqual({ kind: "api-key", key: SENTINEL });
    expect(credentialEffectNote("in-process")).toContain("daemon isn't running");
    expect(credentialEffectNote("daemon")).toContain("in effect now");
  });

  test("the VALUE never appears in anything the door records but the one set frame — and never in a result", async () => {
    const { door, calls } = scriptedDaemon();
    const r = await runCredentialsRoute(secrets, home, "set", "deepseek", async () => SENTINEL, async () => door);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    // Exactly ONE frame carries it: `credential.set`'s own params, which is the wire this door
    // exists to use. Nothing else the CLI holds about this call does.
    const framesWithValue = calls.filter((c) => JSON.stringify(c.params).includes(SENTINEL));
    expect(framesWithValue).toHaveLength(1);
    expect(framesWithValue[0]!.method).toBe(METHODS.credentialSet);
  });

  test("a TYPED refusal from the daemon stands — it is never retried in-process", async () => {
    const refusal = Object.assign(new Error('codex-oauth signs in with ChatGPT rather than an API key (code -32602)'), {
      rpc: { message: "codex-oauth signs in with ChatGPT rather than an API key", code: -32602, data: { code: "credential_kind_unsupported", door: "cli-oauth" } },
    });
    const { door } = scriptedDaemon({ [METHODS.credentialSet]: refusal });
    const r = await runCredentialsRoute(secrets, home, "set", "codex-oauth", async () => SENTINEL, async () => door);
    expect(r).toMatchObject({ ok: false, code: "credential_kind_unsupported", door: "cli-oauth" });
    // Retrying a refused value locally would store what the daemon just rejected.
    expect(await secrets.get("codex-oauth:default")).toBeNull();
  });

  test("a TRANSPORT failure falls back in-process — a dropped socket must not lose the user's key", async () => {
    const { door } = scriptedDaemon({ [METHODS.credentialSet]: new Error("request timed out: credential.set") });
    const r = await writeCredentialThroughDaemonOrLocally({ kind: "set", providerId: "deepseek", apiKey: SENTINEL }, secrets, async () => door);
    expect(r).toEqual({ ok: true, via: "in-process" });
    expect(JSON.parse((await secrets.get("deepseek:default"))!)).toEqual({ kind: "api-key", key: SENTINEL });
  });

  test("logout --openai goes through the daemon too, and still clears the LEGACY raw record itself", async () => {
    await secrets.set(OPENAI_API_KEY_SECRET, `${SENTINEL}-legacy`);
    const { door, calls } = scriptedDaemon({ [METHODS.credentialRemove]: { ok: true, removed: true } });
    const r = await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET, async () => door);
    expect(r).toEqual({ ok: true, removed: true, via: "daemon" });
    expect(calls[0]!.params).toEqual({ providerId: "openai" });
    // The daemon's `credential.remove` knows only the material slot; a stale legacy record would
    // still be read by `readOpenAiApiKey`'s fallback, so this door clears it either way.
    expect(await secrets.get(OPENAI_API_KEY_SECRET)).toBeNull();
  });

  test("a TOOL row still falls back in-process with no daemon — `winter login --exa-key` must work when it is down", async () => {
    const r = await runCredentialsRoute(secrets, home, "set", "exa", async () => SENTINEL, async () => undefined);
    expect(r).toMatchObject({ ok: true, via: "in-process" });
    expect(await secrets.get("exa-api-key")).toBe(SENTINEL);
  });

  test("the RETIRED `web-search` row refuses a SET on both paths, and still removes on both", async () => {
    // 2026-09-18 (the web-tools ruling): nothing reads the Brave key any more, so `credential.set`
    // refuses it typed — and the refusal has to hold on the NO-DAEMON path too, which is the one that
    // could quietly bypass it if the fallback wrote the raw secret itself instead of going through
    // core's `setCredential`. It goes through core, and this pins that.
    const noDaemon = await runCredentialsRoute(secrets, home, "set", "web-search", async () => SENTINEL, async () => undefined);
    expect(noDaemon).toMatchObject({ ok: false });
    expect(String((noDaemon as { message: string }).message)).toContain("winter credentials remove web-search");
    expect(await secrets.get("web-search-api-key")).toBeNull();

    // …and the DAEMON's own refusal for the same row stands and is never retried in-process (the rule
    // this suite already pins for provider rows), so the store stays empty on that path too. The
    // daemon-side refusal itself is pinned in core's `credentials-rpc` suite; this door only has to
    // carry it.
    const refusal = Object.assign(new Error("Web search is no longer used by any Winter tool (code -32602)"), {
      rpc: { message: "Web search is no longer used by any Winter tool — its key cannot be set.", code: -32602, data: { code: "credential_kind_unsupported", door: "credential.set" } },
    });
    const { door } = scriptedDaemon({ [METHODS.credentialSet]: refusal });
    const viaDaemon = await runCredentialsRoute(secrets, home, "set", "web-search", async () => SENTINEL, async () => door);
    expect(viaDaemon).toMatchObject({ ok: false, code: "credential_kind_unsupported" });
    expect(await secrets.get("web-search-api-key")).toBeNull();

    // REMOVE is the door that must keep working: a key stored before the retirement is clearable.
    await secrets.set("web-search-api-key", SENTINEL);
    const removed = await runCredentialsRoute(secrets, home, "remove", "web-search", never, async () => undefined);
    expect(removed).toMatchObject({ ok: true, removed: true });
    expect(await secrets.get("web-search-api-key")).toBeNull();
  });

  test("with a daemon listening, the `exa` row goes THROUGH it (0.0.17: the key is baked into a spawn)", async () => {
    // It used to be written in-process by design — the daemon's own Search/ReadPage read it per call
    // and no child's `Options` named it. At agent SDK 0.0.17 a Winter child's
    // `Options.web.search.authRef` NAMES it, and whether it exists decides chat's and dispatch's tool
    // surface, both fixed at spawn. So the daemon has to hear about it: its `credential.set` evicts
    // every Winter-leg child resumably, which is what makes "no restart" true for this key too.
    const { door, calls } = scriptedDaemon({ [METHODS.credentialSet]: { ok: true } });
    const r = await runCredentialsRoute(secrets, home, "set", "exa", async () => SENTINEL, async () => door);
    expect(r).toMatchObject({ ok: true, via: "daemon" });
    expect(calls[0]!.params).toEqual({ providerId: "exa", apiKey: SENTINEL });
    // The value never touched this process's own store on that path — the daemon wrote it.
    expect(await secrets.get("exa-api-key")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// B-1 (2026-09-19 review): `winter login` (ChatGPT/Codex) and bare `winter logout` write
// `codex-oauth:default` IN-PROCESS and cannot go through `credential.set` (that door takes an API-KEY
// string; this material is an OAuth record). So a LIVE daemon has to be told, or its cached
// "which providers can Winter's own jobs run on" snapshot stays wrong until a restart.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("notifyDaemonOfOutOfBandCredentialChange", () => {
  /** The same shape the WS-19 block above uses, scoped here (that one is a nested helper). */
  function poked(answers: Record<string, unknown> = {}) {
    const calls: Array<{ method: string; params: unknown }> = [];
    const door: CredentialRpcDoor = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        return answer ?? { ok: true };
      },
      close: () => {},
    };
    return { door, calls };
  }

  test("pokes a live daemon through credential.list — the handler that reconciles its view", async () => {
    const { door, calls } = poked({ [METHODS.credentialList]: { providers: [] } });
    expect(await notifyDaemonOfOutOfBandCredentialChange(async () => door)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([METHODS.credentialList]);
    // An EXISTING method on purpose: a new one would engage the whole RPC checklist for a call whose
    // result nobody reads.
    expect(calls[0]!.params).toEqual({});
  });

  test("answers false with no daemon — `winter login` has always worked with the daemon down", async () => {
    expect(await notifyDaemonOfOutOfBandCredentialChange(async () => undefined)).toBe(false);
  });

  test("answers false on a refusal or a dropped socket, and never throws into the login flow", async () => {
    const { door } = poked({ [METHODS.credentialList]: new Error("request timed out") });
    expect(await notifyDaemonOfOutOfBandCredentialChange(async () => door)).toBe(false);
  });

  test("the printed note tells the truth either way", () => {
    expect(credentialEffectNote("daemon")).toContain("in effect now");
    expect(credentialEffectNote("in-process")).toContain("stored only");
  });
});
