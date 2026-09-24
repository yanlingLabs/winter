/**
 * 2026-09-19: the endpoint half of the internal-jobs provider builder — the one production risk no
 * loopback test can see, because every loopback test overrides the base URL.
 *
 * The two factories this replaced passed NO base URL for codex-oauth and `""` for openai, so both used
 * the adapter's own generated default. `resolveEndpoint` prefers `connection.baseUrl` when one is set,
 * so forcing the catalog's value would have silently changed which URL every existing codex/openai
 * user's internal calls hit the day the catalog and the SDK constant diverged. `catalogApiEndpointFor`
 * therefore DEFERS for a single-provider adapter family, and these tests pin both halves of that: the
 * deferral itself, and the equality that makes it a no-op today.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { DEEPSEEK_BASE_URL, OPENAI_API_BASE_URL, OPENROUTER_BASE_URL } from "@yanlinglabs/winter-provider-runtime";
import { catalogApiEndpointFor, catalogApiEndpointRawFor, internalAdapterFor, internalDrivableAdapterIds, wireModelIdFor } from "../../src/providers/internal-adapters";
import { buildInternalProvider } from "../../src/providers/internal-provider";
import { FileSecretStore } from "../../src/auth/secret-store";
import { Settings, internalEligibleProviderIds } from "../../src/settings";

const secrets = (): FileSecretStore => new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-internal-adapters-")));
const settings = (extra: Record<string, unknown> = {}): Settings =>
  Settings.parse({ schemaVersion: 3, provider: { model: "codex-oauth/gpt-5.6-sol" }, ...extra });

/** Only `RuntimeBackedProvider` knows its own `ProviderContext`; this reads the connection back off it
 *  without exporting the class, which is what keeps every consumer depending on `Provider` alone. */
function connectionOf(p: unknown): { providerId: string; baseUrl?: string; local?: boolean } {
  return (p as { context?: { connection: { providerId: string; baseUrl?: string; local?: boolean } } }).context?.connection
    ?? (p as { inner?: { context: { connection: { providerId: string; baseUrl?: string; local?: boolean } } } }).inner!.context.connection;
}

describe("the single-provider deferral", () => {
  test("a family serving exactly one catalog provider defers to the adapter's own default", () => {
    // `winter.codex-oauth` and `winter.openai-responses` each serve exactly one provider.
    expect(catalogApiEndpointFor("codex-oauth")).toBeUndefined();
    expect(catalogApiEndpointFor("openai")).toBeUndefined();
    // …while the catalog does ship an endpoint for both — the deferral is deliberate, not a lookup miss.
    expect(catalogApiEndpointRawFor("codex-oauth")).toBeTruthy();
    expect(catalogApiEndpointRawFor("openai")).toBeTruthy();
  });

  test("a multi-provider family carries the catalog's endpoint (it has no vendor default)", () => {
    expect(catalogApiEndpointFor("deepseek")).toBe("https://api.deepseek.com");
    expect(catalogApiEndpointFor("openrouter")).toBe("https://openrouter.ai/api/v1");
  });

  // THE TRIPWIRE. Today the SDK constant and the catalog row agree byte-for-byte, which is the only
  // reason the deferral is invisible. If a catalog or SDK bump moves either one, this fails HERE rather
  // than redirecting a live user's internal calls silently.
  test("the SDK's own base-URL constants still equal the catalog rows they defer to", () => {
    expect(catalogApiEndpointRawFor("openai")).toBe(OPENAI_API_BASE_URL);
    expect(catalogApiEndpointRawFor("deepseek")).toBe(DEEPSEEK_BASE_URL);
    expect(catalogApiEndpointRawFor("openrouter")).toBe(OPENROUTER_BASE_URL);
    // `CODEX.backendUrl` is not exported; the catalog's row is asserted against the value measured out
    // of the pinned runtime's own bundle (`resolveEndpoint(ctx, options, CODEX.backendUrl)`).
    expect(catalogApiEndpointRawFor("codex-oauth")).toBe("https://chatgpt.com/backend-api/codex");
  });
});

describe("the connection profile buildInternalProvider assembles", () => {
  test("codex-oauth and openai: no baseUrl, no `local` — byte-identical to the retired factories", () => {
    for (const providerId of ["codex-oauth", "openai"]) {
      const built = buildInternalProvider({ providerId, secrets: secrets(), settings: settings() });
      expect("provider" in built).toBe(true);
      if (!("provider" in built)) continue;
      const conn = connectionOf(built.provider);
      expect(conn.providerId).toBe(providerId);
      expect(conn.baseUrl).toBeUndefined();
      expect(conn.local).toBeUndefined();
    }
  });

  test("a multi-provider row carries the catalog endpoint and is NOT declared local", () => {
    const built = buildInternalProvider({ providerId: "deepseek", secrets: secrets(), settings: settings() });
    if (!("provider" in built)) throw new Error("expected a provider");
    const conn = connectionOf(built.provider);
    expect(conn.baseUrl).toBe("https://api.deepseek.com");
    // `local` would disable the runtime's plain-http/private-address endpoint policy for ~94 providers.
    expect(conn.local).toBeUndefined();
  });

  test("a user's own providers.<id>.baseUrl wins AND is declared local (Winter's BYO-endpoint carve-out)", () => {
    const built = buildInternalProvider({
      providerId: "openai",
      secrets: secrets(),
      settings: settings({ providers: { openai: { baseUrl: "http://localhost:11434/v1" } } }),
    });
    if (!("provider" in built)) throw new Error("expected a provider");
    const conn = connectionOf(built.provider);
    expect(conn.baseUrl).toBe("http://localhost:11434/v1");
    expect(conn.local).toBe(true);
  });
});

describe("the drivable-family table", () => {
  test("every drivable adapter id is one the pinned catalog actually names", () => {
    const shipped = new Set(loadCatalog().providers.map((p) => p.adapterId));
    for (const id of internalDrivableAdapterIds()) expect(shipped.has(id)).toBe(true);
  });

  test("an undrivable family builds no adapter and refuses provider-unsupported", () => {
    expect(internalAdapterFor("bedrock")).toBeUndefined();
    const built = buildInternalProvider({ providerId: "bedrock", secrets: secrets(), settings: settings() });
    expect("refusal" in built).toBe(true);
    if ("refusal" in built) expect(built.refusal.code).toBe("provider-unsupported");
  });
});

describe("N-3: the wire model id", () => {
  // The whole reason `wireModelIdFor` is a one-hop lookup rather than "use the tag's bare half": that
  // equality is DATA, and the day a row breaks it the bare half would go on the wire as the model id.
  test("the pinned catalog holds `key === providerId + \"/\" + upstreamId` for every row", () => {
    const offenders = loadCatalog()
      .models.filter((m) => m.key !== `${m.providerId}/${m.upstreamId}`)
      .map((m) => `${m.key} (upstreamId ${m.upstreamId})`);
    expect(offenders).toEqual([]);
  });

  test("resolves through the provider-scoped descriptor, so a shared bare id cannot pick the wrong row", () => {
    // `deepseek-v4-flash` exists under several providers on the shared chat-completions adapter; the
    // scoped lookup is what keeps each one on its own row (see this module's header for the measurement).
    // R.1 (catalog refresh): DeepSeek's OWN row is now `deepseek-flash`, and the old id is its alias — so
    // the same bare id answers DeepSeek's renamed row under `deepseek`, and alibaba-cn's own row there.
    expect(wireModelIdFor("deepseek", "deepseek-v4-flash")).toBe("deepseek-flash");
    expect(wireModelIdFor("deepseek", "deepseek-flash")).toBe("deepseek-flash");
    expect(wireModelIdFor("alibaba-cn", "deepseek-v4-flash")).toBe("deepseek-v4-flash");
    // A tag whose bare half the provider does not serve falls through verbatim rather than inventing one.
    expect(wireModelIdFor("deepseek", "not-a-real-model")).toBe("not-a-real-model");
  });
});

describe("M-3: the row-level capability tripwire", () => {
  // Measured 2026-09-19: all 571 rows on the 94 eligible providers declare `chat` or `responses`, and
  // none is blocked — so `setModelRole`'s row check refuses nothing today. This asserts the measurement,
  // so the day the catalog adds an embeddings-only row to an otherwise-fine provider the tripwire's
  // existence is visible here rather than discovered by a background job failing every call.
  test("every row on an eligible provider is reachable by a single chat/responses turn", () => {
    const eligible = internalEligibleProviderIds();
    const rows = loadCatalog().models.filter((m) => eligible.has(m.providerId));
    expect(rows.length).toBeGreaterThan(400);
    const unreachable = rows
      .filter((m) => !m.endpoints.includes("chat") && !m.endpoints.includes("responses"))
      .map((m) => `${m.key} [${m.endpoints.join(",")}]`);
    expect(unreachable).toEqual([]);
    expect(rows.filter((m) => m.status === "blocked").map((m) => m.key)).toEqual([]);
  });

  test("every eligible row accepts text input — these jobs send nothing else", () => {
    const eligible = internalEligibleProviderIds();
    const noText = loadCatalog()
      .models.filter((m) => eligible.has(m.providerId) && !(m.inputModalities?.value ?? ["text"]).includes("text"))
      .map((m) => m.key);
    expect(noText).toEqual([]);
  });
});
