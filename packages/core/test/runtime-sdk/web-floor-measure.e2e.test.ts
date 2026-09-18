// MEASUREMENT (2026-09-18, the web-tools floor on both legs) — does the REAL, pinned `claude`
// binary honour the two things `runtime-sdk/hooks.ts`'s dangerous-domain floor depends on?
//
//   1. `updatedInput` from a `PreToolUse` hook on a `WebSearch` call. It is TYPED on both SDKs
//      (`PreToolUseHookSpecificOutput.updatedInput`) and had never been measured for this tool on
//      either. The floor's whole WebSearch arm is that one field: a search has no target host to
//      check before it runs, so the only thing a host can do is carry its exclusion list into the
//      call. If the binary ignored it, the arm would be a silent no-op — the exact failure this file
//      exists to make impossible.
//   2. A `PreToolUse` `deny` for `WebFetch` — that it blocks the fetch AND that Winter's own refusal
//      text is what the model is told.
//
// Plus the cheap third thing that decides whether the matchers work at all: does the official binary
// report the same `tool_name`s (`WebFetch`/`WebSearch`) Winter's Options.hooks matchers are keyed on?
//
// WHAT IS UNDER TEST is the SHIPPED object: `sessionHooksFor(...).official`, the very value
// `session-driver.ts`'s `assembleOfficial` threads into the official leg, with a live plugin hook
// facade ahead of it — so claude's own composition of "an unmatched plugin group that answers
// nothing" + "a matched floor group that answers a no-decision transform" is what gets measured,
// never a hand-rolled single hook that could pass while the real object fails.
//
// This drives `@anthropic-ai/claude-agent-sdk`'s own `query()` rather than a whole official-leg
// session (`official-leg.e2e.test.ts`'s `buildWorld`). The router's hook pass-through is ALREADY
// measured there (that file's M4 test: a `sessionHooksFor(...).official` bash-reviewer deny blocks a
// real Bash call through the router on this leg), so what is left unproven is strictly a property of
// the BINARY — and reaching it through the smallest hermetic harness that still uses the real
// `Options.hooks` transport is the honest way to ask about it.
//
// HERMETICITY. Nothing here may touch the network, `~/.claude`, or a real credential:
//   - `env` REPLACES `process.env` entirely for the child when it is supplied (measured in the SDK's
//     own `sdk.mjs`: `In = ne ? {...ne} : {...process.env}`), so the env below is the whole truth.
//     `HOME` and `CLAUDE_CONFIG_DIR` are fresh mkdtemps; `ANTHROPIC_API_KEY` is a fake string;
//     `ANTHROPIC_BASE_URL` is the loopback fake.
//   - a PROXY TRAP (the sibling conformance suite's own device) answers 502 to anything that tries to
//     leave the box and records its first line, with `NO_PROXY` exempting loopback. Every test
//     asserts the trap saw NOTHING — which, for the WebFetch case, is also the proof that the deny
//     landed BEFORE the tool ran (claude's WebFetch preflights a HARDCODED Anthropic host that does
//     not follow `ANTHROPIC_BASE_URL`, so a fetch that actually ran would show up there).
//
// GATED TWICE, and never runs by default: `WINTER_MEASURE_WEB_FLOOR=1` must be set (it spawns a real
// binary and takes tens of seconds), and `describeWithClaudeRuntime` skips without the optional
// platform package (throwing instead under `WINTER_CLAUDE_REQUIRE_RUNTIME=1`).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type HookCallback, type HookCallbackMatcher, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake, type FakeServer } from "@yanlinglabs/winter-provider-conformance";
import { SHIPPED_DANGEROUS_DOMAINS } from "../../src/agent/dangerous-domains";
import { sessionHooksFor, type HookFacadeLike } from "../../src/runtime-sdk/hooks";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

const ENABLED = process.env.WINTER_MEASURE_WEB_FLOOR === "1";

type Body = Record<string, unknown>;

/** The inner `WebSearch` pass, recognised by the SERVER TOOL in its tool list — never by arrival
 *  order (the main loop can make side requests). Same rule the sibling conformance suite uses. */
function isInnerSearchRequest(body: Body): boolean {
  const tools = Array.isArray(body["tools"]) ? (body["tools"] as Body[]) : [];
  return tools.some((t) => t["type"] === "web_search_20250305");
}

function serverToolOf(body: Body): Body | undefined {
  const tools = Array.isArray(body["tools"]) ? (body["tools"] as Body[]) : [];
  return tools.find((t) => t["type"] === "web_search_20250305");
}

function hasToolResult(body: Body): boolean {
  for (const message of Array.isArray(body["messages"]) ? (body["messages"] as Body[]) : []) {
    const content = message["content"];
    if (Array.isArray(content) && (content as Body[]).some((b) => b["type"] === "tool_result")) return true;
  }
  return false;
}

interface WireToolResult {
  content: string;
  isError: boolean;
}

/** Every `tool_result` block in a captured request body, keyed by `tool_use_id` — what actually went
 *  back to the model, which is where a hook deny has to be visible for the deny to mean anything. */
function toolResultsOf(body: Body): Map<string, WireToolResult> {
  const out = new Map<string, WireToolResult>();
  for (const message of Array.isArray(body["messages"]) ? (body["messages"] as Body[]) : []) {
    const content = message["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content as Body[]) {
      if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
      const raw = block["content"];
      const text = typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? (raw as Body[]).map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : JSON.stringify(b))).join("")
          : JSON.stringify(raw);
      out.set(block["tool_use_id"] as string, { content: text, isError: block["is_error"] === true });
    }
  }
  return out;
}

/** Anything that tried to leave the box, recorded by first request line and answered 502. */
function startProxyTrap(): { url: string; hits: string[]; stop(): void } {
  const hits: string[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        hits.push(data.toString().split("\r\n")[0] ?? "");
        socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        socket.end();
      },
    },
  });
  return { url: `http://127.0.0.1:${listener.port}`, hits, stop: () => listener.stop(true) };
}

interface Measured {
  /** Every POST body the loopback received, in arrival order. */
  requests: Body[];
  /** Every SDK message the query yielded. */
  messages: SDKMessage[];
  /** `tool_name` per PreToolUse invocation of the FLOOR groups, in order — the matcher proof. */
  hookCalls: Array<{ toolName: string; input: unknown }>;
  trapHits: string[];
}

/**
 * One headless turn of the real binary, with the REAL `sessionHooksFor(...).official` as
 * `Options.hooks`, against a loopback that answers `firstTurn` to the main loop's first request.
 */
async function measure(opts: {
  binary: string;
  firstTurn: Parameters<typeof anthropicFake.anthropicTurnResponse>[0];
  dangerousDomainsAdded?: () => readonly string[] | undefined;
}): Promise<Measured> {
  const root = mkdtempSync(join(tmpdir(), "winter-web-floor-measure-"));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  for (const dir of [home, cfg, cwd, join(home, "tmp")]) mkdirSync(dir, { recursive: true });
  const trap = startProxyTrap();
  const hookCalls: Array<{ toolName: string; input: unknown }> = [];

  // A live plugin facade ahead of the floor group: it answers `ok` (no verdict), which is exactly the
  // shape whose composition with a no-decision transform has never been measured on this leg.
  const hookFacade: HookFacadeLike = { async runFor() { return [{ pluginId: "measure-probe", result: { status: "ok", stdout: "" } }]; } };

  const built = sessionHooksFor({
    sessionId: "s_measure",
    roots: [cwd],
    hookFacade,
    ...(opts.dangerousDomainsAdded === undefined ? {} : { dangerousDomainsAdded: opts.dangerousDomainsAdded }),
  });
  // `sessionHooksFor` types `.official` as `unknown` (the router's `OptionsTemplatePolicy.hooks`
  // declares nothing narrower), so THIS cast is the one place in the repo that states the claim
  // `hooks.ts`'s own header makes in prose — the object built for the Winter leg IS claude's
  // `Options["hooks"]` shape. If the two SDKs' hook shapes ever diverge for real, the measurement
  // below is what notices.
  const official = built.official as NonNullable<Options["hooks"]>;
  // Observe the floor groups' own invocations without replacing them: each matched group's callback
  // is wrapped, so what RUNS is still the shipped closure and what is recorded is the `tool_name` the
  // binary handed it.
  const hooks: NonNullable<Options["hooks"]> = {
    ...official,
    PreToolUse: (official.PreToolUse ?? []).map((group): HookCallbackMatcher =>
      group.matcher === undefined
        ? group
        : {
            ...group,
            hooks: group.hooks.map((hook): HookCallback => async (input, id, extra) => {
              const pre = input as { tool_name?: unknown; tool_input?: unknown };
              if (pre.tool_name === "WebFetch" || pre.tool_name === "WebSearch") hookCalls.push({ toolName: String(pre.tool_name), input: pre.tool_input });
              return hook(input, id, extra);
            }),
          },
    ),
  };

  let fake: FakeServer | undefined;
  try {
    fake = await startFake({
      routes: [
        {
          path: "*",
          handler: async (_req, recorded) => {
            if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) {
              return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
            }
            let body: Body = {};
            try { body = JSON.parse(recorded.body) as Body; } catch { /* a non-JSON body falls through as empty */ }
            // Routed BY CONTENT, three ways: the inner search pass, the main loop's follow-up (it
            // carries a tool_result), and the first main request.
            if (isInnerSearchRequest(body)) return anthropicFake.anthropicTurnResponse({ model: LOOPBACK_MODEL_ID, blocks: [{ type: "text", chunks: ["nothing relevant was found."] }] });
            if (hasToolResult(body)) return anthropicFake.anthropicTurnResponse({ model: LOOPBACK_MODEL_ID, blocks: [{ type: "text", chunks: ["done."] }] });
            return anthropicFake.anthropicTurnResponse(opts.firstTurn);
          },
        },
      ],
    });

    const messages: SDKMessage[] = [];
    for await (const message of query({
      prompt: "do the one tool call you were scripted to do, then stop",
      options: {
        pathToClaudeCodeExecutable: opts.binary,
        model: LOOPBACK_MODEL_ID,
        cwd,
        hooks,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 4,
        env: {
          HOME: home,
          USER: "winter-measure",
          LOGNAME: "winter-measure",
          SHELL: "/bin/zsh",
          LANG: "en_US.UTF-8",
          TMPDIR: `${join(home, "tmp")}/`,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          CLAUDE_CONFIG_DIR: cfg,
          ANTHROPIC_BASE_URL: fake.url,
          ANTHROPIC_API_KEY: "sk-ant-fake-web-floor-measurement-0000",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
          CLAUDE_CODE_MAX_RETRIES: "0",
          HTTPS_PROXY: trap.url,
          HTTP_PROXY: trap.url,
          https_proxy: trap.url,
          http_proxy: trap.url,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
      },
    })) {
      messages.push(message);
    }

    const requests: Body[] = [];
    for (const recorded of fake.requests) {
      if (recorded.method !== "POST") continue;
      try { requests.push(JSON.parse(recorded.body) as Body); } catch { /* skipped: a non-JSON POST is not a model request */ }
    }
    // Structural facts only (never the system/tools prose) — the same logging discipline the sibling
    // conformance family keeps, and what makes a run's evidence readable in a report.
    console.error(`[web-floor] ${requests.length} loopback request(s); hook fired for [${hookCalls.map((c) => c.toolName).join(",")}]; ${trap.hits.length} trap hit(s)`);
    for (const [i, body] of requests.entries()) {
      const serverTool = serverToolOf(body);
      const parts = [`#${i + 1}`, `tools=${Array.isArray(body["tools"]) ? (body["tools"] as Body[]).length : 0}`, `messages=${Array.isArray(body["messages"]) ? (body["messages"] as Body[]).length : 0}`];
      if (serverTool !== undefined) parts.push(`web_search_20250305 blocked_domains=${JSON.stringify(serverTool["blocked_domains"])}`, `allowed_domains=${JSON.stringify(serverTool["allowed_domains"])}`);
      const results = [...toolResultsOf(body).entries()];
      if (results.length > 0) parts.push(`tool_results=${JSON.stringify(results.map(([id, r]) => [id, r.isError, r.content.slice(0, 400)]))}`);
      console.error(`[web-floor]   ${parts.join(" ")}`);
    }
    return { requests, messages, hookCalls, trapHits: [...trap.hits] };
  } finally {
    await fake?.close();
    trap.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function toolUseTurn(name: string, input: unknown): Parameters<typeof anthropicFake.anthropicTurnResponse>[0] {
  return {
    model: LOOPBACK_MODEL_ID,
    stopReason: "tool_use",
    blocks: [{ type: "tool_use", id: `toolu_${name.toLowerCase()}_measure`, name, jsonChunks: [JSON.stringify(input)] }],
  };
}

describe.skipIf(!ENABLED)("web-floor measurement (WINTER_MEASURE_WEB_FLOOR=1)", () => {
  describeWithClaudeRuntime("the real claude binary vs. sessionHooksFor(...).official", () => {
    const binary = claudeRuntimeForTests()!.executable;

    test("WebSearch: the floor injected through `updatedInput` reaches the OUTBOUND inner search request", async () => {
      const added = ["measured-floor-marker.example"];
      const got = await measure({ binary, firstTurn: toolUseTurn("WebSearch", { query: "winter release notes" }), dangerousDomainsAdded: () => added });

      // (a) the binary reports the name the matcher is keyed on, and hands the hook the model's input
      expect(got.hookCalls.map((c) => c.toolName)).toEqual(["WebSearch"]);
      expect(got.hookCalls[0]!.input).toEqual({ query: "winter release notes" });

      // (b) the inner search request the binary SENT carries the list the hook injected
      const inner = got.requests.filter(isInnerSearchRequest);
      expect(inner.length, `no inner web_search request was made; ${got.requests.length} request(s) seen`).toBeGreaterThan(0);
      const serverTool = serverToolOf(inner[0]!)!;
      expect(serverTool["blocked_domains"]).toEqual([...SHIPPED_DANGEROUS_DOMAINS, ...added]);
      expect(serverTool["allowed_domains"]).toBeUndefined();

      // (c) hermetic: nothing left the box
      expect(got.trapHits).toEqual([]);
    }, 180_000);

    test("WebFetch: a floor host is DENIED, Winter's own refusal is what the model is told, and the fetch never ran", async () => {
      const got = await measure({ binary, firstTurn: toolUseTurn("WebFetch", { url: "https://pastebin.com/raw/measured", prompt: "what does this say?" }) });

      expect(got.hookCalls.map((c) => c.toolName)).toEqual(["WebFetch"]);

      // The wire, not stdout: the request that FOLLOWS the deny is where the model is actually told.
      const followUp = got.requests.filter((body) => hasToolResult(body));
      expect(followUp.length, `no follow-up request carried a tool_result; ${got.requests.length} request(s) seen`).toBeGreaterThan(0);
      const results = [...toolResultsOf(followUp[followUp.length - 1]!).values()];
      expect(results.length).toBeGreaterThan(0);
      const denial = results.find((r) => r.content.includes("dangerous-domain safety floor"));
      expect(denial, `no tool_result carried the floor refusal; saw ${JSON.stringify(results).slice(0, 600)}`).toBeDefined();
      expect(denial!.content).toContain("pastebin.com matches the blocked entry pastebin.com");
      expect(denial!.isError).toBe(true);
      // The requested url is never echoed back into the model's context.
      expect(denial!.content).not.toContain("/raw/measured");

      // Nothing left the box — which for WebFetch is ALSO the proof the deny landed before the tool:
      // its preflight targets a hardcoded Anthropic host that does not follow ANTHROPIC_BASE_URL, so a
      // fetch that actually ran would be recorded here.
      expect(got.trapHits).toEqual([]);
    }, 180_000);

    test("WebSearch with an allow-list of nothing but floor entries is DENIED (no blocked_domains is ever added beside it)", async () => {
      const got = await measure({ binary, firstTurn: toolUseTurn("WebSearch", { query: "where to drop this", allowed_domains: ["pastebin.com", "0x0.st"] }) });
      expect(got.hookCalls.map((c) => c.toolName)).toEqual(["WebSearch"]);
      expect(got.requests.filter(isInnerSearchRequest)).toEqual([]); // the search never ran at all
      const followUp = got.requests.filter((body) => hasToolResult(body));
      const results = [...toolResultsOf(followUp[followUp.length - 1] ?? {}).values()];
      expect(results.some((r) => r.content.includes("dangerous-domain safety floor"))).toBe(true);
      expect(got.trapHits).toEqual([]);
    }, 180_000);
  });
});
