import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CodexAuthStore, CodexOAuthProvider } from "../../src/providers/codex-oauth";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function store(): FileSecretStore {
  return new FileSecretStore(mkdtempSync(join(tmpdir(), "norma-codex-")));
}

async function seeded(access = "at_live"): Promise<CodexAuthStore> {
  const s = new CodexAuthStore(store());
  await s.save({ accessToken: access, refreshToken: "rt_live", idToken: null, accountId: "acct_7", expiresAt: Date.now() + 3600_000 });
  return s;
}

const sse = () => readFileSync(join(import.meta.dir, "fixtures", "simple-text.sse"), "utf8");

describe("CodexOAuthProvider", () => {
  test("sends parity headers, bearer token and account id; streams events", async () => {
    let headers: Record<string, string> = {};
    server = Bun.serve({
      port: 0,
      fetch(req) {
        headers = Object.fromEntries(req.headers.entries());
        return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const p = new CodexOAuthProvider({ authStore: await seeded(), backendUrl: `http://localhost:${server.port}` });
    const events = [];
    for await (const e of p.streamTurn({ model: "gpt-5.2-codex", input: [{ type: "message", role: "user", content: "hi" }] })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(headers["authorization"]).toBe("Bearer at_live");
    expect(headers["chatgpt-account-id"]).toBe("acct_7");
    expect(headers["openai-beta"]).toBe("responses=experimental");
    expect(headers["originator"]).toBe("norma"); // self-identify, not the codex first-party value (ToS mitigation A)
  });

  test("401 triggers ONE refresh then retry; refreshed token persisted", async () => {
    let calls = 0;
    let sawRefresh = false;
    let retryHeaders: Record<string, string> = {};
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/oauth/token") {
          sawRefresh = true;
          return Response.json({ access_token: "at_fresh", refresh_token: "rt_fresh", expires_in: 3600 });
        }
        calls++;
        if (calls === 1) return new Response("expired", { status: 401 });
        retryHeaders = Object.fromEntries(req.headers.entries());
        return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    const authStore = await seeded("at_stale");
    const p = new CodexOAuthProvider({
      authStore,
      backendUrl: `http://localhost:${server.port}`,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(sawRefresh).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect((await authStore.load())?.accessToken).toBe("at_fresh");
    expect(retryHeaders["chatgpt-account-id"]).toBe("acct_7");
    expect(retryHeaders["authorization"]).toBe("Bearer at_fresh");
  });

  test("401 twice yields an auth error (no refresh loop)", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/oauth/token") return Response.json({ access_token: "at_x", expires_in: 3600 });
        return new Response("nope", { status: 401 });
      },
    });
    const p = new CodexOAuthProvider({
      authStore: await seeded(),
      backendUrl: `http://localhost:${server.port}`,
      tokenUrl: `http://localhost:${server.port}/oauth/token`,
    });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("401") }]);
  });

  test("no stored tokens yields auth error telling the user to log in", async () => {
    const p = new CodexOAuthProvider({ authStore: new CodexAuthStore(store()), backendUrl: "http://localhost:1" });
    const events = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("norma login") }]);
  });
});

describe("CODEX_MODELS", () => {
  // 2026-07-10 user decision (4e-fix Task 2): gpt-5.5 and gpt-5.4/gpt-5.4-mini are FULLY
  // DEPRECATED — CODEX_MODELS is now EXACTLY the gpt-5.6 family (sol/terra/luna).
  // A configured settings.json model outside this list falls back at runtime to
  // DEFAULT_CODEX_MODEL (providers/manager.ts's live model resolver), not rejected here.
  //
  // 2026-07-31: this test asserted `372_000` — it PINNED the transcription error it was meant to
  // guard, which is why a 100,000-token mistake survived three weeks of green suites and killed
  // auto-compaction on every Codex model (see codex-config.ts's CODEX_MODELS doc comment). The
  // real window is 272,000, verified live. A pin copied from the same hand as the constant proves
  // nothing; the ONLY guard that can catch this class of drift is a comparison against the live
  // catalogue — test/providers/codex-models-drift.test.ts. Change this number only after that
  // guard's live half agrees.
  test("is EXACTLY the gpt-5.6 family — sol/terra/luna, 272K context, nothing else", () => {
    expect(CODEX_MODELS.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    for (const m of CODEX_MODELS) {
      expect(m.family).toBe("gpt-5");
      expect(m.contextWindow).toBe(272_000);
      expect(m.supportsVision).toBe(true);
    }
  });

  test("gpt-5.5 / gpt-5.4 / gpt-5.4-mini are deprecated — no longer in CODEX_MODELS", () => {
    for (const id of ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]) {
      expect(CODEX_MODELS.find((mi) => mi.id === id)).toBeUndefined();
    }
  });

  test("codex-auto-review is excluded (hidden model)", () => {
    expect(CODEX_MODELS.find((mi) => mi.id === "codex-auto-review")).toBeUndefined();
  });

  test("DEFAULT_CODEX_MODEL is gpt-5.6-sol and is itself a member of CODEX_MODELS", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(CODEX_MODELS.some((m) => m.id === DEFAULT_CODEX_MODEL)).toBe(true);
  });
});
