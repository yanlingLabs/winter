import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexFake, openaiResponsesFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CREDENTIAL_MATERIAL_NAMES, writeCredentialMaterial } from "../../src/auth/credential-material";
import { DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { createCodexOauthRuntimeProvider, createOpenAiCompatibleRuntimeProvider, _translateEventsForTests } from "../../src/providers/runtime-provider";
import { QuotaManager } from "../../src/providers/quota";
import { SessionStore } from "../../src/sessions/store";
import { SessionHub } from "../../src/sessions/hub";
import { SessionTitler } from "../../src/agent/titles";

/** Mirrors `test/agent/titles.test.ts`'s own `setup`/`seedTurn` shape, over a REAL loopback fake
 *  instead of `FakeProvider` — proof that `RuntimeBackedProvider` (providers/runtime-provider.ts)
 *  actually speaks the wire the `@yanlinglabs/winter-provider-runtime` adapters expect, for both
 *  credential families lane 5 covers. */
function newStore(): SessionStore {
  return new SessionStore(mkdtempSync(join(tmpdir(), "winter-runtime-provider-home-")));
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
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-runtime-provider-secrets-")));
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
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-runtime-provider-secrets-")));
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
      const secrets = new FileSecretStore(mkdtempSync(join(tmpdir(), "winter-runtime-provider-secrets-")));
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

// P8d-13: the subscription-quota carry — closed for the one shape (`rate_limit`/`kind:
// "subscription-quota"`) that has a real consumer. Driven directly against `translateEvents`
// (exported test-only) rather than a real HTTP fake: reproducing the codex conformance package's
// own `rate_limit` wire frame would test that package's fake, not this file's translation.
describe("translateEvents — the P8d-13 subscription-quota carry", () => {
  async function* fakeRuntimeEvents(events: Array<Record<string, unknown>>): AsyncIterable<never> {
    for (const e of events) yield e as never;
  }

  test("a rate_limit/subscription-quota frame is reported via onSubscriptionQuota, never yielded as a ProviderEvent", async () => {
    const reported: Array<Record<string, unknown>> = [];
    const info = { limitType: "5h", remainingFraction: 0.2, resetsAt: "2026-09-13T00:00:00.000Z" };
    const events = _translateEventsForTests(
      fakeRuntimeEvents([
        { type: "rate_limit", kind: "subscription-quota", info },
        { type: "text_delta", text: "still streaming" },
        { type: "done", stopReason: "stop" },
      ]),
      (i) => reported.push(i),
    );
    const yielded = [];
    for await (const e of events) yielded.push(e);

    expect(reported).toEqual([info]);
    // The frame itself never became a ProviderEvent — only the delta and the done that followed it.
    expect(yielded).toEqual([{ type: "text_delta", delta: "still streaming" }, { type: "done", stopReason: "end_turn" }]);
  });

  test("with no onSubscriptionQuota callback, the frame is silently dropped (this module's pre-8d behaviour when nobody asks)", async () => {
    const events = _translateEventsForTests(fakeRuntimeEvents([{ type: "rate_limit", kind: "subscription-quota", info: { x: 1 } }, { type: "done", stopReason: "stop" }]));
    const yielded = [];
    for await (const e of events) yielded.push(e);
    expect(yielded).toEqual([{ type: "done", stopReason: "end_turn" }]);
  });

  test("QuotaManager.noteSubscriptionQuota records the LATEST snapshot, and it never feeds waitIfLimited", async () => {
    const q = new QuotaManager();
    expect(q.subscriptionQuota()).toBeUndefined();
    q.noteSubscriptionQuota({ remainingFraction: 0.5 });
    q.noteSubscriptionQuota({ remainingFraction: 0.1 }); // supersedes, never merges
    expect(q.subscriptionQuota()?.info).toEqual({ remainingFraction: 0.1 });
    // Purely informational — the manager is not "limited" just because a quota snapshot arrived.
    expect(q.state()).toEqual({ kind: "ok" });
    await q.waitIfLimited(); // must resolve immediately — nothing here ever blocks a turn
  });
});
