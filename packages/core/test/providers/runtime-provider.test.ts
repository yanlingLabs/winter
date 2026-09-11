import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFake, openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { createCodexOauthRuntimeProvider, createOpenAiCompatibleRuntimeProvider } from "../../src/providers/runtime-provider";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";

/** Mirrors `test/agent/titles.test.ts`'s own `setup`/`seedTurn` shape, over a REAL loopback fake
 *  instead of `FakeProvider` — proof that `RuntimeBackedProvider` (providers/runtime-provider.ts)
 *  actually speaks the wire the `@yanlinglabs/winter-provider-runtime` adapters expect, for both
 *  credential families lane 5 covers. */
function newStore(): SessionStore {
  return new SessionStore(mkdtempSync(join(tmpdir(), "norma-runtime-provider-home-")));
}

function seedTurn(store: SessionStore, sessionId: string): void {
  store.append(sessionId, { type: "user_message", sessionId, threadId: "main", text: "how do I fix the login flow?", clientName: "test" });
  store.append(sessionId, { type: "assistant_message", sessionId, threadId: "main", text: "I fixed it." });
}

describe("RuntimeBackedProvider over a loopback fake", () => {
  test("openai-compatible (api-key row): the titler produces a title", async () => {
    const model = "gpt-5.2";
    const fake = await openaiResponsesFake.startOpenAiResponsesFake({
      scenarios: { [model]: [openaiResponsesFake.responsesStream({ text: ["Fix Login Flow Bug"] })] },
    });
    try {
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-runtime-provider-secrets-")));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.openai, { kind: "api-key", key: "sk-test" });
      const provider = createOpenAiCompatibleRuntimeProvider(secrets, fake.url);

      const store = newStore();
      const hub = new SessionHub(store);
      const titler = new SessionTitler({ provider: { provider, model }, store, hub });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      seedTurn(store, sessionId);

      await titler.maybeTitle(sessionId);

      expect(store.getTitle(sessionId)).toBe("Fix Login Flow Bug");
      expect(fake.requests.length).toBeGreaterThan(0);
    } finally {
      await fake.close();
    }
  });

  test("codex-oauth (oauth row): the titler produces a title", async () => {
    const fake = await codexFake.startCodexFake({
      scenarios: { [DEFAULT_CODEX_MODEL]: [openaiResponsesFake.responsesStream({ text: ["Fix Login Flow Bug"] })] },
    });
    try {
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-runtime-provider-secrets-")));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, {
        kind: "oauth",
        accessToken: codexFake.FAKE_ACCESS_TOKEN,
      });
      const provider = createCodexOauthRuntimeProvider(secrets, fake.url);

      const store = newStore();
      const hub = new SessionHub(store);
      const titler = new SessionTitler({ provider: { provider, model: DEFAULT_CODEX_MODEL }, store, hub });
      const sessionId = store.createSession("global", { cwd: "/tmp" });
      seedTurn(store, sessionId);

      await titler.maybeTitle(sessionId);

      expect(store.getTitle(sessionId)).toBe("Fix Login Flow Bug");
      expect(fake.bearers).toEqual([codexFake.FAKE_ACCESS_TOKEN]);
    } finally {
      await fake.close();
    }
  });

  test("codex-oauth: a 401 refreshes and WRITES BACK to the same codex-oauth:default record", async () => {
    const fake = await codexFake.startCodexFake({
      scenarios: { [DEFAULT_CODEX_MODEL]: [openaiResponsesFake.responsesStream({ text: ["Fixed"] })] },
      requireRefreshFor: [DEFAULT_CODEX_MODEL],
    });
    try {
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-runtime-provider-secrets-")));
      await writeCredentialMaterial(secrets, CREDENTIAL_MATERIAL_NAMES.codexOauth, {
        kind: "oauth",
        accessToken: codexFake.FAKE_ACCESS_TOKEN,
        refreshToken: codexFake.FAKE_REFRESH_TOKEN,
      });
      const provider = createCodexOauthRuntimeProvider(secrets, fake.url);

      const events = [];
      for await (const ev of provider.streamTurn({ model: DEFAULT_CODEX_MODEL, instructions: "x", input: [{ type: "message", role: "user", content: "hi" }], tools: [] })) {
        events.push(ev);
      }

      // The fake's first request 401s (requireRefreshFor); the adapter refreshes and retries with
      // the NEW bearer — both bearers land in `fake.bearers`, in order.
      expect(fake.bearers).toEqual([codexFake.FAKE_ACCESS_TOKEN, codexFake.FAKE_REFRESHED_ACCESS_TOKEN]);
      expect(events.some((e) => e.type === "text_delta")).toBe(true);

      // The refreshed token was written back to the SAME material record the spawned Winter child
      // reads — one token set, one writer.
      const raw = await secrets.get(CREDENTIAL_MATERIAL_NAMES.codexOauth);
      expect(raw).toBeTruthy();
      const material = JSON.parse(raw!) as { kind: string; accessToken: string };
      expect(material.kind).toBe("oauth");
      expect(material.accessToken).toBe(codexFake.FAKE_REFRESHED_ACCESS_TOKEN);
    } finally {
      await fake.close();
    }
  });
});
