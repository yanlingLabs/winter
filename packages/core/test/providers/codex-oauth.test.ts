import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../../src/auth/secret-store";
import { CodexAuthStore, CodexOAuthProvider } from "../../src/providers/codex-oauth";
import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from "../../src/providers/codex-config";
import { wireToolName } from "../../src/providers/openai-compatible";

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

  test("uses valid Responses names on the wire and restores dotted internal tool names", async () => {
    const internalName = "functions.exec";
    const wireName = wireToolName(internalName);
    let body: any;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = await req.json();
        return new Response(
          `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: wireName, arguments: "{}" } })}\n\n`
          + `data: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const p = new CodexOAuthProvider({ authStore: await seeded(), backendUrl: `http://localhost:${server.port}` });
    const events = [];
    for await (const event of p.streamTurn({
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [{ name: internalName, description: "run a cell", parameters: { type: "object" } }],
    })) events.push(event);

    expect(body.tools[0].name).toBe(wireName);
    expect(events).toContainEqual({ type: "tool_call", callId: "call-1", name: internalName, argsJson: "{}" });
  });
});

describe("use_responses_lite — never-send pin", () => {
  // .superpowers/investigations/2026-07-30-tool-mode.md §5.1: the live catalogue advertises
  // `use_responses_lite: true` on ALL THREE gpt-5.6 models (sol/terra/luna). codex-rs treats that
  // flag as server-signalled permission to rewrite the request DESTRUCTIVELY
  // (core/src/client.rs build_responses_request):
  //   - `tools` moves off the top level into `input[0]` as an `additional_tools` developer item
  //   - `instructions` becomes "" (the real instructions become a developer message instead)
  //   - `parallel_tool_calls` is forced `false`
  // There are open upstream bug reports against this exact shape: codex issue #31894 — tools
  // becoming unreliably callable ("I can't run `ls` because no shell execution tool is available");
  // #31870/#31882 — 400s on Azure and any non-ChatGPT-backend provider, which would be fatal for
  // Norma's BYO-key path. Norma has deliberately never implemented this path: every live probe
  // recorded in the investigation ran the STANDARD shape against these same
  // use_responses_lite:true-advertising models and worked, which is the empirical proof that the
  // standard shape is correct and sufficient. This test is a NEVER-SEND pin, not a feature test:
  // its only job is to fail loudly the day someone adds the header "because the server advertises
  // it". If that day comes, the fix is NOT to make this test pass — it is to re-open the
  // investigation's "do not adopt" conclusion first.
  test.each(CODEX_MODELS.map((m) => m.id))(
    "%s: the codex-oauth request never carries x-openai-internal-codex-responses-lite, and the standard shape/headers still go out",
    async (model) => {
      let headers: Record<string, string> = {};
      let body: any;
      server = Bun.serve({
        port: 0,
        async fetch(req) {
          headers = Object.fromEntries(req.headers.entries());
          body = await req.json();
          return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
        },
      });
      const p = new CodexOAuthProvider({ authStore: await seeded(), backendUrl: `http://localhost:${server.port}` });
      const events = [];
      for await (const e of p.streamTurn({
        model,
        input: [{ type: "message", role: "user", content: "hi" }],
        tools: [{ name: "bash", description: "run a command", parameters: { type: "object" } }],
      })) events.push(e);
      expect(events.at(-1)).toMatchObject({ type: "done" });

      // THE PIN: the header must never appear, under any casing (fetch/Bun normalize header
      // names to lowercase on the receiving `Headers` object, so this checks the wire form).
      expect(headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();

      // Opposite direction, so this test cannot pass vacuously against a broken request path: the
      // standard headers Norma DOES send must still be present.
      expect(headers["originator"]).toBe("norma");
      expect(headers["openai-beta"]).toBe("responses=experimental");

      // The standard BODY shape must be intact too — exactly what use_responses_lite would have
      // rewritten, per the investigation's account of build_responses_request:
      expect(body.tools.length).toBeGreaterThan(0); // tools NOT relocated off the top level…
      expect(body.input.some((i: any) => i.type === "additional_tools")).toBe(false); // …into input
      // M5 (whole-branch review): `not.toBe("")` PASSES on `undefined`, so an `instructions` that
      // stopped being built at all — a rename, a dropped field — would have read as "not emptied".
      // Assert the type, which is the only form that distinguishes "present and non-empty" from
      // "absent". `.length` is the other half: a string is present AND says something.
      expect(typeof body.instructions).toBe("string"); // instructions NOT emptied
      expect(body.instructions.length).toBeGreaterThan(0);
      expect(body.parallel_tool_calls).toBe(true); // NOT forced false
    },
  );
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
