import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, OPENAI_API_KEY_SECRET, CODEX_SECRET_NAMES, writeCredentialMaterial } from "@yanlinglabs/winter-core";
import { runCredentialsRoute, runLogoutOpenAiRoute } from "../src/main";

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
    expect(set).toEqual({ ok: true, kind: "set", providerId: "deepseek" });
    expect(JSON.stringify(set)).not.toContain(SENTINEL);

    const list = await runCredentialsRoute(secrets, home, "list", undefined, never);
    if (!list.ok || list.kind !== "list") throw new Error("expected a list");
    expect(list.rows.find((r) => r.providerId === "deepseek")?.present).toBe(true);
    expect(JSON.stringify(list)).not.toContain(SENTINEL);

    expect(await runCredentialsRoute(secrets, home, "remove", "deepseek", never)).toEqual({ ok: true, kind: "remove", providerId: "deepseek", removed: true });
    expect(await runCredentialsRoute(secrets, home, "remove", "deepseek", never)).toEqual({ ok: true, kind: "remove", providerId: "deepseek", removed: false });
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
    expect(await runCredentialsRoute(secrets, home, "remove", "codex-oauth", never)).toMatchObject({ ok: true, removed: true });
    expect(await secrets.get("codex-oauth:default")).toBeNull();
    for (const name of Object.values(CODEX_SECRET_NAMES)) expect(await secrets.get(name)).toBeNull();
  });
});

describe("winter logout --openai (W19-11)", () => {
  test("clears BOTH the material record and the legacy raw record", async () => {
    await writeCredentialMaterial(secrets, "openai:default", { kind: "api-key", key: SENTINEL });
    await secrets.set(OPENAI_API_KEY_SECRET, `${SENTINEL}-legacy`);
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: true });
    expect(await secrets.get("openai:default")).toBeNull();
    expect(await secrets.get(OPENAI_API_KEY_SECRET)).toBeNull();
  });

  test("a legacy-only install still reports removed — the stale raw record is what was live there", async () => {
    await secrets.set(OPENAI_API_KEY_SECRET, `${SENTINEL}-legacy`);
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: true });
  });

  test("nothing stored -> removed:false, a successful no-op", async () => {
    expect(await runLogoutOpenAiRoute(secrets, OPENAI_API_KEY_SECRET)).toEqual({ ok: true, removed: false });
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
