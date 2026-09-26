/**
 * 2026-09-19: the internal-jobs router — Winter's own background calls (titles, the bash reviewer, the
 * dreamer, the session cleaner) no longer depend on `settings.provider.model`'s provider being one of
 * codex-oauth/openai.
 *
 * Every credential here goes through a throwaway `FileSecretStore` and every wire call through a
 * loopback conformance fake — never the real Keychain and never the network.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFake, openaiChatFake, openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial, clearCredentialMaterial } from "../../src/auth/credential-material";
import { createInternalProviderView, staticInternalProviderView, REFRESH_SOON_MIN_MS } from "../../src/providers/internal-view";
import { createInternalRouter, staticInternalRouter, isInternalRefusal, type InternalRouter } from "../../src/providers/internal-router";
import { internalWireEffortFor } from "../../src/providers/internal-provider";
import type { Provider } from "../../src/providers/types";
import { internalEligibleProviderIds, CLAUDE_FIRST_PARTY_PROVIDER_IDS, Settings, setModelRole } from "../../src/settings";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";
import { BashReviewer, ReviewerNoRunnableModel } from "../../src/agent/reviewer";
import { internalRoleProblemsFor } from "../../src/providers/internal-role-problems";
import { catalogRoleProblemsFor } from "../../src/providers/catalog-role-problems";
import { withProblemsForRoles } from "../../src/providers/role-health";
import { effortToSpendForRole, modelRolesFor } from "../../src/settings";

function secretsStore(): FileSecretStore {
  return new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-internal-router-secrets-")));
}

function settingsWith(model: string, extra: Record<string, unknown> = {}): Settings {
  return Settings.parse({ schemaVersion: 3, provider: { model }, ...extra });
}

async function routerFor(
  secrets: FileSecretStore,
  opts: { testBackendUrl?: (id: string) => string | undefined; log?: (m: string) => void } = {},
): Promise<InternalRouter> {
  const view = createInternalProviderView({ secrets, ...(opts.log ? { log: opts.log } : { log: () => {} }) });
  await view.refresh();
  return createInternalRouter({ view, secrets, ...(opts.testBackendUrl ? { testBackendUrl: opts.testBackendUrl } : {}) });
}

describe("the eligible set", () => {
  // WS-23: `anthropic` rejoined the eligible set (every model runs on the Winter SDK now), and
  // `console` with the live-gate fix; only the reserved `cc` row stays out.
  test("excludes the reserved first-party Claude row and includes anthropic, console plus ordinary token-priced ones", () => {
    const eligible = internalEligibleProviderIds();
    expect([...CLAUDE_FIRST_PARTY_PROVIDER_IDS]).toEqual(["cc"]);
    for (const id of CLAUDE_FIRST_PARTY_PROVIDER_IDS) expect(eligible.has(id)).toBe(false);
    expect(eligible.has("anthropic")).toBe(true);
    expect(eligible.has("console")).toBe(true);
    expect(eligible.has("codex-oauth")).toBe(true);
    expect(eligible.has("openai")).toBe(true);
    expect(eligible.has("deepseek")).toBe(true);
  });

  test("excludes the adapter families the daemon cannot drive", () => {
    const eligible = internalEligibleProviderIds();
    // Their credential material is `aws`/`gcp-*`, which `credential-store.ts` refuses typed.
    expect(eligible.has("bedrock")).toBe(false);
    expect(eligible.has("vertex")).toBe(false);
    // No Winter login door and no inventory slot.
    expect(eligible.has("xai-oauth")).toBe(false);
  });
});

describe("a DeepSeek default with only a DeepSeek key", () => {
  test("the titler really calls the DeepSeek adapter on the user's own default model", async () => {
    const fake = await openaiChatFake.startOpenAiChatFake({
      scenarios: { "deepseek-flash": () => openaiChatFake.chatStream({ text: ["Fix Login Flow"], finishReason: "stop", usage: { prompt: 9, completion: 3 } }) },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "deepseek" ? fake.url : undefined) });
      const settings = settingsWith("deepseek/deepseek-flash");

      const call = router.resolve("titles.model", settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) return;
      expect(call.providerId).toBe("deepseek");
      expect(String(call.tag)).toBe("deepseek/deepseek-flash");
      expect(call.model).toBe("deepseek-flash");

      const home = mkdtempSync(join(tmpdir(), "winter-internal-router-home-"));
      const store = new SessionStore(home);
      const hub = new SessionHub(store);
      const titler = new SessionTitler({
        provider: { provider: call.provider, model: call.model },
        store, hub,
      });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how do I fix the login flow?", clientName: "test" });
      store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "I fixed it." });

      await titler.maybeTitle(sessionId);

      expect(store.getTitle(sessionId)).toBe("Fix Login Flow");
      expect(fake.requests.length).toBe(1);
      expect(openaiChatFake.chatModelOf(fake.requests[0]!)).toBe("deepseek-flash");
    } finally {
      await fake.close();
    }
  });

  test("every internal role resolves, and the dreamer's `medium` default is dropped rather than refused or escalated", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-flash");
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const) {
      const call = router.resolve(role, settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) continue;
      expect(call.providerId).toBe("deepseek");
    }
    // The deepseek row's vocabulary is [none, low, high, max]: `medium` (the dreamer's constant) is not in
    // it. Sending it verbatim is what the pinned runtime refuses `capability` for. The refreshed row DECLARES
    // a default, `high` — HEAVIER than what the dreamer asked for — and an internal job never escalates
    // (R.1 controller ruling, `internalEffortNoEscalationFor`): the request carries NO effort.
    const dream = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(dream)).toBe(false);
    if (!isInternalRefusal(dream)) expect(dream.effort).toBeUndefined();
    // `low` IS in that vocabulary, so the cleaner's constant survives.
    const cleaner = router.resolve("pins.cleaner", settings);
    if (!isInternalRefusal(cleaner)) expect(cleaner.effort).toBe("low");
  });
});

describe("a DeepSeek default with a Codex OAuth login", () => {
  test("the jobs fall back to codex-oauth on its own terra row", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at", refreshToken: "rt" });
    const router = await routerFor(secrets);
    const call = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash"));
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(call.providerId).toBe("codex-oauth");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
  });
});

describe("a Claude default", () => {
  // WS-23: `anthropic` is an ordinary eligible provider now, so rung 1 (the session default's own
  // provider, eligible AND credentialed) lands on the user's own Claude model — never a fallback.
  test("with an Anthropic key: runs on the user's own Claude model, not on a fallback", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    // An anthropic key is stored too — it is now the session default's own provider, so it wins.
    await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    const router = await routerFor(secrets);
    const claudeDefault = settingsWith("anthropic/claude-sonnet-5");
    for (const role of ["titles.model", "pins.dream"] as const) {
      const call = router.resolve(role, claudeDefault);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) continue;
      expect(call.providerId).toBe("anthropic");
      expect(String(call.tag)).toBe("anthropic/claude-sonnet-5");
    }
  });

  test("without one: falls back to the credentialed internal provider, never to an uncredentialed Claude row", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const claudeDefault = settingsWith("anthropic/claude-sonnet-5");
    for (const role of ["titles.model", "pins.dream"] as const) {
      const call = router.resolve(role, claudeDefault);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) continue;
      expect(call.providerId).toBe("codex-oauth");
    }
  });

  test("EXPLICIT anthropic and console pins RUN; an explicit pin on an undrivable provider refuses provider-unsupported, naming it", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    await writeCredentialMaterial(secrets, "anthropic:console", { kind: "bearer", token: "console-bearer-test" });
    const router = await routerFor(secrets);
    const pinned = settingsWith("codex-oauth/gpt-5.6-sol", { titles: { model: "anthropic/claude-sonnet-5" } });
    const live = router.resolve("titles.model", pinned);
    expect(isInternalRefusal(live)).toBe(false);
    if (!isInternalRefusal(live)) expect(live.providerId).toBe("anthropic");
    // WS-23 live-gate fix: the Console's bearer slot is an ordinary inventory row the Anthropic adapter
    // is driven over (see the Console-only home below for the wire), so a console pin runs too.
    const consolePinned = settingsWith("codex-oauth/gpt-5.6-sol", { titles: { model: "console/claude-sonnet-5" } });
    const consoleLive = router.resolve("titles.model", consolePinned);
    expect(isInternalRefusal(consoleLive)).toBe(false);
    if (!isInternalRefusal(consoleLive)) expect(consoleLive.providerId).toBe("console");
    const bedrockPinned = settingsWith("codex-oauth/gpt-5.6-sol", { titles: { model: "bedrock/anthropic.claude-sonnet-4-5" } });
    const refused = router.resolve("titles.model", bedrockPinned);
    expect(isInternalRefusal(refused)).toBe(true);
    if (!isInternalRefusal(refused)) return;
    expect(refused.reason).toBe("provider-unsupported");
    expect(refused.detail).toContain("AWS Bedrock");
    expect(refused.detail).toContain("can't be used for Winter's own jobs yet");
    expect(String(refused.tag)).toBe("bedrock/anthropic.claude-sonnet-4-5");
  });
});

// WS-23, brief item 3: with Claude eligible, a Claude-only home (`settings.provider.model` on
// `anthropic/*`, only the Anthropic key stored) gets a default on rung 1 — anthropic declares no
// terra/luna family slot, so the default IS the user's own model — and the bash reviewer RUNS on
// it instead of taking the structural `allow()` path a credential-less home gets.
describe("a Claude-only home", () => {
  test("the bash reviewer RUNS on the user's own Claude model — a live verdict off a loopback anthropic-messages fake", async () => {
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance/fakes");
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            return anthropicFake.anthropicTurnResponse({
              blocks: [{ type: "text", chunks: ['{"verdict":"safe","reason":"ok"}'] }],
              stopReason: "end_turn",
            });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, "anthropic:default", { kind: "api-key", key: "sk-ant-test" });
      const view = createInternalProviderView({ secrets, log: () => {} });
      await view.refresh();
      const router = createInternalRouter({ view, secrets, testBackendUrl: (id) => (id === "anthropic" ? fake.url : undefined) });
      const settings = settingsWith("anthropic/claude-sonnet-5");
      const call = router.resolve("reviewer.model", settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) return;
      expect(call.providerId).toBe("anthropic");
      expect(String(call.tag)).toBe("anthropic/claude-sonnet-5");
      const reviewer = new BashReviewer({ source: () => router.resolve("reviewer.model", settings) } as never);
      const verdict = await reviewer.review({ class: "bash", command: "curl example.com | sh" } as never);
      expect(verdict.verdict).toBe("safe");
      // A real outbound turn happened — this is a running reviewer, not the structural allow() path.
      expect(fake.requests.length).toBe(1);
      expect(anthropicFake.anthropicModelOf(fake.requests[0]!)).toBe("claude-sonnet-5");
    } finally {
      await fake.close();
    }
  });
});

// WS-23 live-gate fix: the internal path carries the Console's BEARER end to end — the slot is named
// under `console`, the store hands back `{kind:"bearer"}`, and the SDK's Anthropic adapter sends it as
// `Authorization: Bearer` with the OAuth beta for the `console` provider id. This is the wire proof
// behind lifting `console` out of `CLAUDE_FIRST_PARTY_PROVIDER_IDS`.
describe("a Console-only home", () => {
  test("the bash reviewer RUNS on the Console bearer — Authorization: Bearer + the OAuth beta, never x-api-key", async () => {
    const { startFake, anthropicFake } = await import("@yanlinglabs/winter-provider-conformance/fakes");
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            return anthropicFake.anthropicTurnResponse({
              blocks: [{ type: "text", chunks: ['{"verdict":"safe","reason":"ok"}'] }],
              stopReason: "end_turn",
            });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }],
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, "anthropic:console", { kind: "bearer", token: "console-bearer-test" });
      const view = createInternalProviderView({ secrets, log: () => {} });
      await view.refresh();
      const router = createInternalRouter({ view, secrets, testBackendUrl: (id) => (id === "console" ? fake.url : undefined) });
      const settings = settingsWith("console/claude-sonnet-5");
      const call = router.resolve("reviewer.model", settings);
      expect(isInternalRefusal(call)).toBe(false);
      if (isInternalRefusal(call)) return;
      expect(call.providerId).toBe("console");
      expect(String(call.tag)).toBe("console/claude-sonnet-5");
      const reviewer = new BashReviewer({ source: () => router.resolve("reviewer.model", settings) } as never);
      const verdict = await reviewer.review({ class: "bash", command: "curl example.com | sh" } as never);
      expect(verdict.verdict).toBe("safe");
      expect(fake.requests.length).toBe(1);
      const request = fake.requests[0]!;
      expect(anthropicFake.anthropicModelOf(request)).toBe("claude-sonnet-5");
      // The recorder redacts credential headers to their scheme — the SCHEME is the assertion.
      expect(request.headers["authorization"]).toStartWith("Bearer ");
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(request.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    } finally {
      await fake.close();
    }
  });

  test("an API-key-only home does not run on console, and a Console-only home does not run on anthropic", async () => {
    const keyOnly = secretsStore();
    await writeCredentialMaterial(keyOnly, "anthropic:default", { kind: "api-key", key: "sk-ant" });
    const keyRouter = await routerFor(keyOnly);
    const consoleCall = keyRouter.resolve("titles.model", settingsWith("anthropic/claude-sonnet-5", { titles: { model: "console/claude-sonnet-5" } }));
    expect(isInternalRefusal(consoleCall) && consoleCall.reason).toBe("no-credential");

    const consoleOnly = secretsStore();
    await writeCredentialMaterial(consoleOnly, "anthropic:console", { kind: "bearer", token: "console-bearer-test" });
    const consoleRouter = await routerFor(consoleOnly);
    const keyCall = consoleRouter.resolve("titles.model", settingsWith("console/claude-sonnet-5", { titles: { model: "anthropic/claude-sonnet-5" } }));
    expect(isInternalRefusal(keyCall) && keyCall.reason).toBe("no-credential");
  });
});

describe("roles split across two credentialed providers", () => {
  test("titles on one, the dreamer on the other, each on its own backend", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      titles: { model: "openai/gpt-5.6-luna" },
      pins: { dream: "codex-oauth/gpt-5.6-terra" },
    });
    const titles = router.resolve("titles.model", settings);
    const dream = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(titles) || isInternalRefusal(dream)).toBe(false);
    if (isInternalRefusal(titles) || isInternalRefusal(dream)) return;
    expect(titles.providerId).toBe("openai");
    expect(dream.providerId).toBe("codex-oauth");
    expect(titles.provider).not.toBe(dream.provider);
  });
});

describe("no internal credential at all", () => {
  test("every internal role reports no-internal-credential and nothing throws", async () => {
    const secrets = secretsStore();
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-flash");
    for (const role of ["titles.model", "reviewer.model", "pins.dream", "pins.cleaner"] as const) {
      const call = router.resolve(role, settings);
      expect(isInternalRefusal(call)).toBe(true);
      if (!isInternalRefusal(call)) continue;
      expect(call.reason).toBe("no-internal-credential");
      expect(call.detail).toContain("ChatGPT");
      expect(call.tag).toBeNull();
    }
    expect(router.effectiveTag("titles.model", settings)).toBeNull();
  });

  test("an explicit pin on an eligible provider with no key reports no-credential", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-flash" } });
    const call = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(call)).toBe(true);
    if (!isInternalRefusal(call)) return;
    expect(call.reason).toBe("no-credential");
    expect(String(call.tag)).toBe("deepseek/deepseek-flash");
  });
});

describe("hot transitions", () => {
  test("storing a credential makes the jobs runnable on the next call, with no restart", async () => {
    const secrets = secretsStore();
    const lines: string[] = [];
    const view = createInternalProviderView({ secrets, log: (m) => lines.push(m) });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-flash");

    expect(isInternalRefusal(router.resolve("titles.model", settings))).toBe(true);
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await view.refresh();
    const after = router.resolve("titles.model", settings);
    expect(isInternalRefusal(after)).toBe(false);
    if (!isInternalRefusal(after)) expect(after.providerId).toBe("deepseek");
    // One line for the change, never one per call.
    expect(lines.filter((l) => l.includes("DeepSeek") || l.includes("deepseek")).length).toBe(1);
  });

  test("removing the last credential makes them inert again cleanly, one line per change", async () => {
    const secrets = secretsStore();
    const lines: string[] = [];
    const view = createInternalProviderView({ secrets, log: (m) => lines.push(m) });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-flash");
    expect(isInternalRefusal(router.resolve("pins.dream", settings))).toBe(false);

    await clearCredentialMaterial(secrets, "deepseek:default");
    await view.refresh();
    for (let i = 0; i < 3; i += 1) {
      const call = router.resolve("pins.dream", settings);
      expect(isInternalRefusal(call)).toBe(true);
      if (isInternalRefusal(call)) expect(call.reason).toBe("no-internal-credential");
    }
    // Two state changes total: absent -> present, present -> absent. Never one per `resolve`.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("are inert until one is stored");
    // A refresh that changes nothing says nothing.
    await view.refresh();
    expect(lines.length).toBe(2);
  });

  test("changing provider.model moves a defaulted role on the next call", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const first = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash"));
    const second = router.resolve("titles.model", settingsWith("openai/gpt-5.6-luna"));
    if (!isInternalRefusal(first)) expect(first.providerId).toBe("deepseek");
    if (!isInternalRefusal(second)) expect(second.providerId).toBe("openai");
    // `openai`'s terra row, not the user's luna default: the family slot wins when the provider has one.
    if (!isInternalRefusal(second)) expect(String(second.tag)).toBe("openai/gpt-5.6-terra");
  });

  test("changing a role pin moves that role alone on the next call", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const base = settingsWith("deepseek/deepseek-flash");
    const pinned = setModelRole(base, "pins.dream", "openai/gpt-5.6-terra");
    const dream = router.resolve("pins.dream", pinned);
    const titles = router.resolve("titles.model", pinned);
    if (!isInternalRefusal(dream)) expect(dream.providerId).toBe("openai");
    if (!isInternalRefusal(titles)) expect(titles.providerId).toBe("deepseek");
  });

  test("a providers.<id>.baseUrl change rebuilds that provider's instance", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const a = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash"));
    const b = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash"));
    const c = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash", { providers: { deepseek: { baseUrl: "https://proxy.example/v1" } } }));
    if (isInternalRefusal(a) || isInternalRefusal(b) || isInternalRefusal(c)) throw new Error("expected three live calls");
    expect(a.provider).toBe(b.provider); // cached across identical reads
    expect(c.provider).not.toBe(a.provider); // rebuilt on the override
  });

  test("a credential write bumps the generation, so a cached instance is never reused across it", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-1" });
    const view = createInternalProviderView({ secrets, log: () => {} });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-flash");
    const before = router.resolve("titles.model", settings);
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-2" });
    await view.refresh();
    const after = router.resolve("titles.model", settings);
    if (isInternalRefusal(before) || isInternalRefusal(after)) throw new Error("expected two live calls");
    expect(view.generation()).toBe(2);
    expect(after.provider).not.toBe(before.provider);
  });
});

describe("codex-oauth and openai still work over their own loopback fakes", () => {
  test("codex-oauth", async () => {
    const fake = await codexFake.startCodexFake({
      scenarios: { "gpt-5.6-terra": [openaiResponsesFake.responsesStream({ text: ["Codex Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "codex-oauth" ? fake.url : undefined) });
      const call = router.resolve("titles.model", settingsWith("codex-oauth/gpt-5.6-terra"));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [], ...(call.effort ? { reasoningEffort: call.effort } : {}) })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("Codex Title");
    } finally {
      await fake.close();
    }
  });

  test("openai", async () => {
    const model = "gpt-5.6-terra";
    const fake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: { [model]: [openaiResponsesFake.responsesStream({ text: ["OpenAI Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
      const router = await routerFor(secrets, { testBackendUrl: (id) => (id === "openai" ? fake.url : undefined) });
      const call = router.resolve("titles.model", settingsWith(`openai/${model}`));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [], ...(call.effort ? { reasoningEffort: call.effort } : {}) })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("OpenAI Title");
    } finally {
      await fake.close();
    }
  });
});

describe("a user-entered providers.<id>.baseUrl", () => {
  test("keeps Winter's historically unrestricted BYO-endpoint behaviour — a loopback override streams", async () => {
    const model = "gpt-5.6-terra";
    const fake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: { [model]: [openaiResponsesFake.responsesStream({ text: ["Local Title"] })] },
    });
    try {
      const secrets = secretsStore();
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
      // NO `testBackendUrl`: the loopback url arrives the way a real user's does, through settings.
      const router = await routerFor(secrets);
      const call = router.resolve("titles.model", settingsWith(`openai/${model}`, { providers: { openai: { baseUrl: fake.url } } }));
      if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason} ${call.detail}`);
      const out: string[] = [];
      for await (const ev of call.provider.streamTurn({ model: call.model, instructions: "t", input: [{ type: "message", role: "user", content: "hi" }], tools: [] })) {
        if (ev.type === "text_delta") out.push(ev.delta);
        if (ev.type === "error") throw new Error(`provider error: ${ev.message}`);
      }
      expect(out.join("")).toBe("Local Title");
      expect(fake.requests.length).toBe(1);
    } finally {
      await fake.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-19 review fixes: B-1 (self-heal), M-1 (effort "none"), M-2 (per-provider quota),
// M-3 (no-default-model).
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("B-1: the snapshot self-heals from an out-of-band credential write", () => {
  test("`winter login`'s in-process codex write is picked up without a restart", async () => {
    const secrets = secretsStore();
    let clock = 1_000_000;
    const view = createInternalProviderView({ secrets, log: () => {}, now: () => clock });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("deepseek/deepseek-flash");

    // Inert, and the refusal asked for a background probe.
    expect(isInternalRefusal(router.resolve("titles.model", settings))).toBe(true);
    await Bun.sleep(30); // let that first probe settle — `refreshSoon` coalesces while one is in flight
    // …the CLI writes the material itself, exactly as `winter login` does.
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    clock += REFRESH_SOON_MIN_MS + 1; // past the self-heal floor
    router.resolve("titles.model", settings); // fires the probe
    await Bun.sleep(30);
    const healed = router.resolve("titles.model", settings);
    expect(isInternalRefusal(healed)).toBe(false);
    if (!isInternalRefusal(healed)) expect(healed.providerId).toBe("codex-oauth");
  });

  test("`winter logout`'s in-process clear is picked up too — the jobs go inert, not credential-rejected", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const view = createInternalProviderView({ secrets, log: () => {} });
    await view.refresh();
    const router = createInternalRouter({ view, secrets });
    const settings = settingsWith("codex-oauth/gpt-5.6-sol");
    expect(isInternalRefusal(router.resolve("pins.dream", settings))).toBe(false);

    await clearCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth);
    // STATED HONESTLY: the router cannot self-heal from THIS direction on its own. A stale-but-present
    // snapshot makes `resolve()` SUCCEED, so no refusal fires and nothing asks for a probe — the call
    // then fails at the provider as an `auth` error. That is exactly why the logout direction has two
    // other carriers, and both are exercised: the CLI pokes `credential.list` after its in-process clear
    // (`test/ipc/credentials-rpc.test.ts`), and the dreamer asks for a re-probe once per tick AND on any
    // `auth`-classified failure (`test/agent/dreamer-cycle.test.ts`). Either one lands here:
    await view.refresh();
    const after = router.resolve("pins.dream", settings);
    expect(isInternalRefusal(after)).toBe(true);
    if (isInternalRefusal(after)) expect(after.reason).toBe("no-internal-credential");
  });

  test("the self-heal is rate-limited — a hot loop of refusals is not a Keychain probe per call", async () => {
    const secrets = secretsStore();
    let clock = 1_000_000;
    // Counted at the STORE, which is what a probe actually costs — `refreshSoon` closes over the
    // view's own `refresh`, so wrapping the view object could not observe it.
    let reads = 0;
    const counting = { get: (n: string) => { reads += 1; return secrets.get(n); }, set: (n: string, v: string) => secrets.set(n, v), delete: (n: string) => secrets.delete(n) };
    const view = createInternalProviderView({ secrets: counting, log: () => {}, now: () => clock });
    await view.refresh();
    const perProbe = reads;
    expect(perProbe).toBeGreaterThan(0);
    const router = createInternalRouter({ view, secrets: counting });
    const settings = settingsWith("deepseek/deepseek-flash");
    for (let i = 0; i < 50; i += 1) router.resolve("titles.model", settings);
    await Bun.sleep(40);
    // ONE probe for 50 refused calls, not 50.
    expect(reads).toBe(perProbe * 2);
    // …and a second window admits exactly one more.
    clock += REFRESH_SOON_MIN_MS + 1;
    for (let i = 0; i < 50; i += 1) router.resolve("titles.model", settings);
    await Bun.sleep(40);
    expect(reads).toBe(perProbe * 3);
  });

  test("an EXPLICIT pin on an uncredentialed provider does NOT probe (nothing else writes that slot)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    let reads = 0;
    const counting = { get: (n: string) => { reads += 1; return secrets.get(n); }, set: (n: string, v: string) => secrets.set(n, v), delete: (n: string) => secrets.delete(n) };
    const view = createInternalProviderView({ secrets: counting, log: () => {} });
    await view.refresh();
    const afterSeed = reads;
    const router = createInternalRouter({ view, secrets: counting });
    const pinned = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-flash" } });
    const call = router.resolve("pins.dream", pinned);
    await Bun.sleep(40);
    expect(isInternalRefusal(call)).toBe(true);
    if (isInternalRefusal(call)) expect(call.reason).toBe("no-credential");
    expect(reads).toBe(afterSeed); // no probe at all
  });
});

describe("M-1 / D2 follow-up (2026-09-22): an explicit effort of `none`", () => {
  test("is never turned into the row's defaultEffort — it maps to the row's OWN LOWEST declared tier instead", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    // `codex-oauth/gpt-5.6-terra`'s vocabulary is [low, medium, high, xhigh, max] — no `"none"`, so
    // `implicitEffortFor` would MISS and fall through to the row's defaultEffort, `"medium"` — an
    // ESCALATION past what a role asking for `"none"` (for speed) wanted. The rule sends the row's
    // lowest declared tier ("low") instead: less reasoning than the escalation, never more, and never
    // a tier this row does not itself declare.
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "none" } });
    const call = router.resolve("pins.dream", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBe("low");
    expect(call.effort).not.toBe("medium");
  });

  test("a row whose vocabulary LISTS \"none\" is sent \"none\"; one that does not gets its lowest tier (SDK 0.0.24)", async () => {
    // SDK 0.0.23/0.0.24 settled the SDK CARRY: the catalog lists a literal "none" only where the vendor
    // documents one for the adapter's dialect, so a listed "none" is sent rather than dropped to the
    // provider's own (higher) default. DeepSeek's chat dialect documents low/high/max only (the audit
    // dropped its undocumented "none"), so a role asking for "none" there gets its lowest tier, "low".
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-flash", { roleEfforts: { "pins.dream": "none" } });
    const call = router.resolve("pins.dream", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBe("low");
    expect(internalWireEffortFor("openai/gpt-5.6-luna", "none")).toBe("none");
  });

  test("the dist case, verbatim: codex-oauth/gpt-5.6-luna with role effort \"none\" sends its lowest declared effort", () => {
    // Direct unit coverage of `internalWireEffortFor` itself, against the REAL pinned catalog row the
    // dist log's cleaner timeout ran on (`[cleaner] judgment failed ... judgment timed out`,
    // `pins.cleaner` pinned to `codex-oauth/gpt-5.6-luna`, `roleEfforts: {"pins.cleaner": "none"}`).
    expect(internalWireEffortFor("codex-oauth/gpt-5.6-luna", "none")).toBe("low");
    // SDK 0.0.23: a row that LISTS "none" (OpenAI's metered GPT-5.6 rows document it) is sent "none",
    // never dropped to the provider's own (higher) default.
    expect(internalWireEffortFor("openai/gpt-5.6-luna", "none")).toBe("none");
  });

  test("the dist case through the router: pins.cleaner on gpt-5.6-luna with effort \"none\" resolves to \"low\", never \"medium\"", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      pins: { cleaner: "codex-oauth/gpt-5.6-luna" },
      roleEfforts: { "pins.cleaner": "none" },
    });
    const call = router.resolve("pins.cleaner", settings);
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.tag).toBe("codex-oauth/gpt-5.6-luna" as never);
    expect(call.effort).toBe("low");
    expect(call.effort).not.toBe("medium");
  });

  test("a row with NO declared vocabulary at all still sends nothing", () => {
    const view = staticInternalProviderView(["codex-oauth"]);
    const fake: Provider = { id: "fake", models: () => [], streamTurn: () => (async function* () {})() };
    // `openai/gpt-4o` carries no `reasoning` block at all — nothing to pick a "lowest" tier from.
    const router = staticInternalRouter({ view, provider: fake, model: "gpt-4o", tag: "openai/gpt-4o" as never });
    const call = router.resolve("pins.dream", settingsWith("openai/gpt-4o", { roleEfforts: { "pins.dream": "none" } }));
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBeUndefined();
  });

  test("a stored tier the row DOES list still survives", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    const call = router.resolve("pins.dream", settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "high" } }));
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(call.effort).toBe("high");
  });

  test("the static test double runs the SAME effort rule production does", () => {
    const view = staticInternalProviderView(["codex-oauth"]);
    const fake: Provider = { id: "fake", models: () => [], streamTurn: () => (async function* () {})() };
    const router = staticInternalRouter({ view, provider: fake, model: "gpt-5.6-terra", tag: "codex-oauth/gpt-5.6-terra" as never });
    const none = router.resolve("pins.dream", settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dream": "none" } }));
    if (isInternalRefusal(none)) throw new Error("expected a live call");
    expect(none.effort).toBe("low"); // gpt-5.6-terra's own lowest declared tier, not the provider's "medium" default
    // …and the dreamer's own unmappable constant ("medium", not in this row's vocabulary at all) is still
    // dropped on a deepseek row here — never escalated onto its heavier `high` default (R.1 controller
    // ruling) — unaffected by the `"none"` rule above, since "medium" is never `"none"`.
    const ds = staticInternalRouter({ view, provider: fake, model: "deepseek-flash", tag: "deepseek/deepseek-flash" as never });
    const dream = ds.resolve("pins.dream", settingsWith("deepseek/deepseek-flash"));
    if (isInternalRefusal(dream)) throw new Error("expected a live call");
    expect(dream.effort).toBeUndefined();
  });
});

describe("M-2: one quota ledger per provider", () => {
  test("a Codex usage-limit 429 cannot stall a healthy DeepSeek role", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", {
      titles: { model: "codex-oauth/gpt-5.6-terra" },
      pins: { dream: "deepseek/deepseek-flash" },
    });
    const codex = router.resolve("titles.model", settings);
    const deepseek = router.resolve("pins.dream", settings);
    if (isInternalRefusal(codex) || isInternalRefusal(deepseek)) throw new Error("expected two live calls");
    expect(codex.quota).not.toBe(deepseek.quota);
    const codexLedger = router.quotaFor("codex-oauth");
    const deepseekLedger = router.quotaFor("deepseek");
    expect(codexLedger).toBeDefined();
    expect(deepseekLedger).toBeDefined();
    // An hour-scale rate limit on the codex ledger leaves the deepseek one untouched. Before the split
    // this single `limitedUntil` stalled BOTH roles for the full hour.
    codexLedger!.noteRateLimit(3_600_000);
    expect(codexLedger!.state().kind).toBe("limited");
    expect(deepseekLedger!.state().kind).toBe("ok");
  });

  test("daemon.status still reads the codex-oauth ledger for a codex user", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("codex-oauth/gpt-5.6-sol", { pins: { dream: "deepseek/deepseek-flash" } });
    router.resolve("pins.dream", settings);   // deepseek's ledger exists FIRST
    router.resolve("titles.model", settings); // then codex's
    const codexLedger = router.quotaFor("codex-oauth");
    expect(codexLedger).toBeDefined();
    expect(router.quota).toBe(codexLedger!);
  });
});

describe("M-3: Winter never guesses a model on a provider the user did not choose", () => {
  test("a credentialed provider with no family slot and no session-default claim reports no-default-model", async () => {
    const secrets = secretsStore();
    // `groq` is eligible and credentialed, declares no terra slot, and is NOT provider.model's provider.
    await writeCredentialMaterial(secrets, "groq:default", { kind: "api-key", key: "sk-groq" });
    const router = await routerFor(secrets);
    // A Claude default with no Anthropic key: rung 1 fails (eligible but uncredentialed), rung 2
    // fails (no codex/openai key), rung 3 names Groq so the refusal can point at it — but never
    // invents a model on it.
    const call = router.resolve("titles.model", settingsWith("anthropic/claude-fable-1"));
    expect(isInternalRefusal(call)).toBe(true);
    if (!isInternalRefusal(call)) return;
    expect(call.reason).toBe("no-default-model");
    expect(call.detail).toBe("pick a model for this job in Settings › Roles — Winter won't choose one on Groq for you");
    expect(call.tag).toBeNull();
  });

  test("a credentialed OWN provider with no slot still uses the user's own model (the DeepSeek case)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const call = router.resolve("titles.model", settingsWith("deepseek/deepseek-flash"));
    if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason}`);
    expect(String(call.tag)).toBe("deepseek/deepseek-flash");
  });

  test("the fallback only ever considers codex-oauth/openai — never an alphabetical third party", async () => {
    const secrets = secretsStore();
    // `agentrouter` sorts before `codex-oauth` in inventory order and was what the retired rung picked.
    await writeCredentialMaterial(secrets, "agentrouter:default", { kind: "api-key", key: "sk-ar" });
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-openai" });
    const router = await routerFor(secrets);
    const call = router.resolve("pins.cleaner", settingsWith("anthropic/claude-fable-1"));
    if (isInternalRefusal(call)) throw new Error(`refused: ${call.reason}`);
    expect(call.providerId).toBe("openai");
    expect(String(call.tag)).toBe("openai/gpt-5.6-terra");
  });

  test("no-default-model when a third-party key is the ONLY one and it IS the session default's sibling", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "groq:default", { kind: "api-key", key: "sk-groq" });
    const router = await routerFor(secrets);
    // groq IS provider.model's provider here, so rung 2 of the DEFAULT rule applies: the user's own tag.
    const own = router.resolve("titles.model", settingsWith("groq/llama-3.3-70b-versatile"));
    if (isInternalRefusal(own)) throw new Error(`refused: ${own.reason}`);
    expect(String(own.tag)).toBe("groq/llama-3.3-70b-versatile");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// USER RULING 2026-09-19: `reviewer.model` is a SAFETY gate, so an unrunnable EXPLICIT pin must not
// switch it off — it runs on the answer an unpinned reviewer would get. The other three internal
// roles keep "a refused pin is inert with a note": spending a credential on a provider the user did
// not choose for titles/dreams/cleanup is worse than not running it.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("the reviewer's pin fallback", () => {
  async function codexHome(pin: string) {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    const router = await routerFor(secrets);
    return { router, settings: settingsWith("codex-oauth/gpt-5.6-sol", { reviewer: { model: pin } }) };
  }

  test("pinned to an UNCREDENTIALED provider: reviews on the codex default, carrying the pin's own issue", async () => {
    const { router, settings } = await codexHome("deepseek/deepseek-flash");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(call.providerId).toBe("codex-oauth");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
    // The pin's issue rides along so the wire can still report it.
    expect(call.pinRefusal?.reason).toBe("no-credential");
    expect(call.pinRefusal?.detail).toBe("no credential is stored for DeepSeek");
    expect(String(call.pinRefusal?.tag)).toBe("deepseek/deepseek-flash");
  });

  // WS-23: `anthropic` and `console` pins are runnable now, so the fallback's provider-unsupported
  // case is a provider whose adapter family the daemon cannot drive — Bedrock.
  test("pinned to bedrock/*: reviews on the default, pin reported as provider-unsupported", async () => {
    const { router, settings } = await codexHome("bedrock/anthropic.claude-sonnet-4-5");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(false);
    if (isInternalRefusal(call)) return;
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
    expect(call.pinRefusal?.reason).toBe("provider-unsupported");
    expect(call.pinRefusal?.detail).toBe("AWS Bedrock can't be used for Winter's own jobs yet");
  });

  test("a RUNNABLE pin is untouched — no fallback, no pinRefusal", async () => {
    const { router, settings } = await codexHome("codex-oauth/gpt-5.6-luna");
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    if (isInternalRefusal(call)) throw new Error("expected a live call");
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-luna");
    expect(call.pinRefusal).toBeUndefined();
  });

  test("no fallback available: the structural refusal stands (this is the hook's allow() path)", async () => {
    const secrets = secretsStore();
    const router = await routerFor(secrets); // nothing credentialed at all
    const settings = settingsWith("deepseek/deepseek-flash", { reviewer: { model: "anthropic/claude-opus-5" } });
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(true);
    if (isInternalRefusal(call)) expect(call.reason).toBe("no-internal-credential");
  });

  test("THE ASYMMETRY: titles/dreamer/cleaner never fall back, even when asked the same way", async () => {
    const { router, settings } = await codexHome("deepseek/deepseek-flash");
    const pinnedEverywhere = { ...settings, titles: { model: "deepseek/deepseek-flash" as never }, pins: { dream: "deepseek/deepseek-flash" as never, cleaner: "deepseek/deepseek-flash" as never } };
    for (const role of ["titles.model", "pins.dream", "pins.cleaner"] as const) {
      // Even WITH the option set — nothing passes it for these roles, and it would change nothing if it did,
      // because the option is only consulted for a refusal and these stay refused by design.
      const call = router.resolve(role, pinnedEverywhere, { fallbackToDefault: true });
      expect(isInternalRefusal(call)).toBe(true);
      if (isInternalRefusal(call)) expect(call.reason).toBe("no-credential");
    }
  });
});

// R.1 ruling 1 (WS-21): a tag the catalog has no row for — a row a refresh RETIRED with no rename, stored
// before the upgrade — is an unrunnable pin like any other: titles/the dreamer/the cleaner report
// `model-not-in-catalog` and skip; the reviewer falls back to the default rule's answer and keeps running,
// its problem saying what it reviews on meanwhile; with no default answer either, the refusal stands (the
// hook's `allow()` path for an ordinary sandboxed call).
describe("R.1 ruling 1: a tag with no catalog row is an unrunnable pin", () => {
  const RETIRED = "deepseek/deepseek-reasoner";
  async function codexAndDeepseekHome() {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, { kind: "oauth", accessToken: "at" });
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    return { secrets, router: await routerFor(secrets) };
  }
  const pinnedEverywhere = (base: Settings): Settings =>
    ({ ...base, titles: { model: RETIRED as never }, reviewer: { ...(base.reviewer ?? {}), model: RETIRED as never }, pins: { dream: RETIRED as never, cleaner: RETIRED as never } }) as Settings;

  test("titles, the dreamer and the cleaner: refused model-not-in-catalog (before the key), never a fallback", async () => {
    const { router } = await codexAndDeepseekHome();
    const settings = pinnedEverywhere(settingsWith("codex-oauth/gpt-5.6-sol"));
    for (const role of ["titles.model", "pins.dream", "pins.cleaner"] as const) {
      const call = router.resolve(role, settings, { fallbackToDefault: true }); // inert for these roles by design
      expect(isInternalRefusal(call)).toBe(true);
      if (!isInternalRefusal(call)) continue;
      expect(call.reason).toBe("model-not-in-catalog");
      expect(String(call.tag)).toBe(RETIRED);
      expect(call.detail).toContain("not in this build's model catalog");
    }
  });

  test("the titler SKIPS its run on it — no provider call, no title", async () => {
    const { router } = await codexAndDeepseekHome();
    const settings = pinnedEverywhere(settingsWith("codex-oauth/gpt-5.6-sol"));
    const store = new SessionStore(mkdtempSync(join(tmpdir(), "winter-r1-titles-")));
    const hub = new SessionHub(store);
    const titler = new SessionTitler({ source: () => router.resolve("titles.model", settings), store, hub } as never);
    const sessionId = store.createSession("global", { cwd: "/tmp" });
    store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "hello", clientName: "test" });
    store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "hi" });
    await titler.maybeTitle(sessionId);
    expect(store.getTitle(sessionId) ?? null).toBeNull();
    store.close();
  });

  test("the reviewer: falls back to the default rule's answer and RUNS, carrying the pin's own issue", async () => {
    const { router } = await codexAndDeepseekHome();
    const settings = pinnedEverywhere(settingsWith("codex-oauth/gpt-5.6-sol"));
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    if (isInternalRefusal(call)) throw new Error(`expected a live call, got ${call.reason}`);
    expect(String(call.tag)).toBe("codex-oauth/gpt-5.6-terra");
    expect(call.pinRefusal?.reason).toBe("model-not-in-catalog");
    expect(String(call.pinRefusal?.tag)).toBe(RETIRED);
  });

  test("the reviewer with NO default answer either: the refusal stands — the reviewer throws ReviewerNoRunnableModel (the hook's allow() path)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    // Unpinned, and the default rule's answer IS the retired tag (the user's own provider.model).
    const settings = settingsWith(RETIRED);
    const call = router.resolve("reviewer.model", settings, { fallbackToDefault: true });
    expect(isInternalRefusal(call)).toBe(true);
    if (isInternalRefusal(call)) expect(call.reason).toBe("model-not-in-catalog");
    const reviewer = new BashReviewer({ source: () => router.resolve("reviewer.model", settings, { fallbackToDefault: true }) } as never);
    let thrown: unknown;
    try { await reviewer.review({ class: "bash", command: "curl example.com | sh" } as never); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ReviewerNoRunnableModel);
    expect((thrown as ReviewerNoRunnableModel).reason).toBe("model-not-in-catalog");
  });

  test("the four roles' problems: model-not-in-catalog on each, the reviewer's with its meanwhile clause", async () => {
    const { router } = await codexAndDeepseekHome();
    const settings = pinnedEverywhere(settingsWith("codex-oauth/gpt-5.6-sol"));
    const roles = internalRoleProblemsFor(withProblemsForRoles(modelRolesFor(settings, undefined, router.view.snapshot()), undefined), settings, router);
    for (const role of ["titles.model", "pins.dream", "pins.cleaner", "reviewer.model"] as const) {
      expect(roles[role].problem?.reason).toBe("model-not-in-catalog");
      expect(roles[role].problem?.model).toBe(RETIRED);
    }
    expect(roles["reviewer.model"].problem?.detail).toContain("— reviewing on codex-oauth/gpt-5.6-terra meanwhile");
    // …and the session-facing overlay leaves that detail alone rather than replacing it.
    expect(catalogRoleProblemsFor(roles)["reviewer.model"].problem?.detail).toContain("meanwhile");
  });
});

// R.1 (controller ruling): an internal job's effort is mapped onto its row but NEVER UP. A level the row
// does not list falls back to the row's default only when that default is no heavier; otherwise nothing
// is sent. Session turns (dispatch, a session's own default effort) keep the ordinary mapping.
describe("R.1: internal jobs never escalate an effort onto a heavier row default", () => {
  test("the wire rule: a heavier default is dropped, a lighter one still taken, a listed level kept", () => {
    expect(internalWireEffortFor("deepseek/deepseek-flash", "medium")).toBeUndefined(); // default `high` is heavier
    expect(internalWireEffortFor("deepseek/deepseek-flash", "xhigh")).toBe("high");     // default `high` is lighter
    expect(internalWireEffortFor("deepseek/deepseek-flash", "low")).toBe("low");        // listed
    expect(internalWireEffortFor("openai/o4-mini", "max")).toBe("medium");              // unchanged: a lighter default
  });

  test("a STORED role effort takes the same rule through the router (pins.dream `medium` on DeepSeek sends nothing)", async () => {
    const secrets = secretsStore();
    await writeCredentialMaterial(secrets, "deepseek:default", { kind: "api-key", key: "sk-deepseek" });
    const router = await routerFor(secrets);
    const settings = settingsWith("deepseek/deepseek-flash", { roleEfforts: { "pins.dream": "medium", "pins.cleaner": "max" } });
    const dream = router.resolve("pins.dream", settings);
    if (isInternalRefusal(dream)) throw new Error("expected a live call");
    expect(dream.effort).toBeUndefined();
    const cleaner = router.resolve("pins.cleaner", settings);
    if (isInternalRefusal(cleaner)) throw new Error("expected a live call");
    expect(cleaner.effort).toBe("max"); // listed: sent as stored
  });

  test("the session-turn rule is untouched: effortToSpendForRole without the flag still maps onto the row's default", () => {
    const s = settingsWith("codex-oauth/gpt-5.6-sol", { roleEfforts: { "pins.dispatch": "medium" } });
    expect(effortToSpendForRole(s, "pins.dispatch", "deepseek/deepseek-flash", undefined)).toBe("high");
    expect(effortToSpendForRole(s, "pins.dispatch", "deepseek/deepseek-flash", undefined, { neverEscalate: true })).toBeUndefined();
  });
});
