// `tool_result.siteIcons` end to end: Exa's citation `favicon` → the daemon's own `Search` (the
// REAL definition, through the REAL capability server door) → the REAL Search PostToolUse hook
// from `sessionHooksFor` → the REAL projector's `tool_result`. Plus the runtime's own report
// (`winter_site_icons` on a host-facing tool_result block — the Winter agent SDK's WebFetch/
// WebSearch, fixture-shaped), the url checks, and the caps on history / the remote stream.
import { afterEach, describe, expect, test } from "bun:test";
import type { HookCallbackMatcher, PostToolUseHookInput } from "@yanlinglabs/winter-agent-sdk";
import type { WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";
import { SITE_ICONS_MAX, SessionEvent, ToolResultEvent } from "@yanlinglabs/winter-protocol";
import { researchCapability } from "../../src/capabilities/research";
import type { CapabilitySession } from "../../src/capabilities/server";
import { SEARCH_CAPABILITY_TOOL, sessionHooksFor } from "../../src/runtime-sdk/hooks";
import {
  attachSiteIcons, cleanSiteIcons, clearSiteIcons, noteKnownSiteIcons, siteIconSessions, siteIconUrl,
  siteIconsFromRuntimeBlock, siteIconsInText, takeSiteIcons,
} from "../../src/runtime-sdk/site-icons";
import { capEvent } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { accept, makeProjector } from "../projector/harness";

const SID = "s_site_icons";
afterEach(() => { clearSiteIcons(SID); clearSiteIcons("s_other"); });

const CITATIONS = [
  { title: "Alpha", url: "https://alpha.example.com/a", favicon: "https://alpha.example.com/favicon.ico" },
  // A different host for the icon than the page — the url the TOOL names is drawn, never guessed.
  { title: "Beta", url: "https://beta.example.org/b?x=1", favicon: "https://cdn.example.net/beta/icon-32.png" },
  // No favicon from Exa: nothing for this page (the client falls back to /favicon.ico itself).
  { title: "Gamma", url: "https://gamma.example.com/g" },
  // A plain-http favicon is never sent.
  { title: "Delta", url: "https://delta.example.com/d", favicon: "http://delta.example.com/favicon.ico" },
  // Withheld by the dangerous-domain floor: neither shown to the model nor iconed.
  { title: "Bad", url: "https://evil.example/x", favicon: "https://evil.example/favicon.ico" },
];

function exaFetch(citations: unknown[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ answer: "The answer.", citations }), { status: 200 })) as unknown as typeof fetch;
}

function searchServer(citations: unknown[], sessionId = SID): WinterMcpServerInstance {
  const session: CapabilitySession = { sessionId, mode: "dispatch", cwd: "/tmp", roots: ["/tmp"] };
  const search = { secret: async () => "k", fetchFn: exaFetch(citations), dangerousDomainsAdded: () => ["evil.example"] };
  return researchCapability(session, { search }).instance as WinterMcpServerInstance;
}

async function runSearch(citations: unknown[], sessionId = SID): Promise<string> {
  const res = await searchServer(citations, sessionId).callTool("Search", { query: "what?" }) as { content: Array<{ text: string }>; isError: boolean };
  expect(res.isError).toBe(false);
  return res.content.map((c) => c.text).join("\n");
}

/** What the runtime does for a PostToolUse on the Search tool: run every UNMATCHED group's callbacks
 *  (the Search icon hook lives in one and filters on `tool_name` itself). */
function searchPostHook(sessionId = SID): HookCallbackMatcher {
  const groups = (sessionHooksFor({ sessionId, roots: ["/tmp"] }).winter?.PostToolUse ?? []).filter((g) => g.matcher === undefined);
  if (groups.length === 0) throw new Error("no unmatched PostToolUse group");
  return {
    hooks: [async (input, id, opts) => {
      let last: unknown = {};
      for (const g of groups) for (const h of g.hooks) last = await h(input, id, opts);
      return last as never;
    }],
  };
}

function postInput(toolUseId: string, response: unknown): PostToolUseHookInput {
  return { session_id: SID, transcript_path: "", cwd: "/tmp", hook_event_name: "PostToolUse", tool_name: SEARCH_CAPABILITY_TOOL, tool_input: { query: "what?" }, tool_use_id: toolUseId, tool_response: response };
}

const abortSignal = () => new AbortController().signal;

describe("Search → hook → projector", () => {
  test("Exa's favicons ride the projected tool_result, in source order, and never the model's text", async () => {
    const output = await runSearch(CITATIONS);
    // The model-visible text names the sources but carries no icon url at all.
    expect(output).toContain("https://alpha.example.com/a");
    expect(output).not.toContain("favicon");
    expect(output).not.toContain("cdn.example.net");
    expect(output).not.toContain("evil.example");

    const hook = searchPostHook();
    expect(SEARCH_CAPABILITY_TOOL).toBe("mcp__winter__research__Search");
    await hook.hooks[0]!(postInput("toolu_s1", output), "toolu_s1", { signal: abortSignal() });

    const { projector } = makeProjector({ sessionId: SID, mode: "dispatch" });
    accept(projector, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_s1", name: SEARCH_CAPABILITY_TOOL, input: { query: "what?" } }] } } as never);
    const events = accept(projector, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s1", content: output }] } } as never);
    const result = events.find((e) => e.type === "tool_result") as Record<string, unknown>;
    expect(result.output).toBe(output);
    expect(result.siteIcons).toEqual([
      { url: "https://alpha.example.com/a", iconUrl: "https://alpha.example.com/favicon.ico" },
      { url: "https://beta.example.org/b?x=1", iconUrl: "https://cdn.example.net/beta/icon-32.png" },
    ]);
    expect(ToolResultEvent.safeParse(result).success).toBe(true);
    expect(SessionEvent.safeParse(result).success).toBe(true);

    // The take is destructive: a replayed result of the same call carries nothing.
    expect(takeSiteIcons(SID, "toolu_s1")).toBeUndefined();
  });

  test("the model-visible output is byte-identical with and without Exa favicons", async () => {
    const withIcons = await runSearch(CITATIONS);
    clearSiteIcons(SID);
    const without = await runSearch(CITATIONS.map(({ favicon: _f, ...rest }) => rest));
    expect(withIcons).toBe(without);
  });

  test("no favicons from Exa → no siteIcons field at all", async () => {
    const output = await runSearch(CITATIONS.map(({ favicon: _f, ...rest }) => rest));
    await searchPostHook().hooks[0]!(postInput("toolu_s2", output), "toolu_s2", { signal: abortSignal() });
    const { projector } = makeProjector({ sessionId: SID });
    const events = accept(projector, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s2", content: output }] } } as never);
    expect(Object.keys(events[0]!)).not.toContain("siteIcons");
  });

  test("another session's Search never lends this one its icons", async () => {
    const output = await runSearch(CITATIONS, "s_other");
    await searchPostHook().hooks[0]!(postInput("toolu_s3", output), "toolu_s3", { signal: abortSignal() });
    expect(takeSiteIcons(SID, "toolu_s3")).toBeUndefined();
  });

  test("another tool's result naming the same urls attaches nothing (the unmatched hook filters on tool_name)", async () => {
    const output = await runSearch(CITATIONS);
    await searchPostHook().hooks[0]!({ ...postInput("toolu_x", output), tool_name: "WebFetch" }, "toolu_x", { signal: abortSignal() });
    expect(takeSiteIcons(SID, "toolu_x")).toBeUndefined();
  });

  test("a non-string tool_response is ignored, never thrown on", async () => {
    await runSearch(CITATIONS);
    const out = await searchPostHook().hooks[0]!(postInput("toolu_s4", { not: "text" }), "toolu_s4", { signal: abortSignal() });
    expect(out).toEqual({});
    expect(takeSiteIcons(SID, "toolu_s4")).toBeUndefined();
  });
});

describe("the runtime's own report (winter_site_icons on the block)", () => {
  // Fixture: what the Winter agent SDK's WebFetch puts on its host-facing tool_result block.
  const fetchFrame = {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_wf", content: "digest", winter_site_icons: [{ url: "https://docs.example.com/page", icon_url: "https://docs.example.com/static/icon.png" }] }] },
  };

  test("is carried onto the event, in the protocol's camelCase", () => {
    const { projector } = makeProjector({ sessionId: SID });
    const events = accept(projector, fetchFrame as never);
    expect(events[0]).toMatchObject({ type: "tool_result", callId: "toolu_wf", output: "digest", siteIcons: [{ url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/static/icon.png" }] });
    expect(SessionEvent.safeParse(events[0]).success).toBe(true);
  });

  test("malformed entries are dropped; an all-bad list leaves the field off", () => {
    expect(siteIconsFromRuntimeBlock({ winter_site_icons: "nope" })).toBeUndefined();
    expect(siteIconsFromRuntimeBlock({ winter_site_icons: [null, 3, { url: "https://a.example.com" }, { url: "javascript:alert(1)", icon_url: "https://a.example.com/i.png" }] })).toBeUndefined();
    expect(siteIconsFromRuntimeBlock({ winter_site_icons: [{ url: "https://a.example.com/", icon_url: "https://a.example.com/i.png" }] })).toEqual([{ url: "https://a.example.com/", iconUrl: "https://a.example.com/i.png" }]);
  });

  test("merged with an attached list, deduplicated by page url (the attached one first)", () => {
    attachSiteIcons(SID, "toolu_m", [{ url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/a.ico" }]);
    const { projector } = makeProjector({ sessionId: SID });
    const frame = structuredClone(fetchFrame);
    frame.message.content[0]!.tool_use_id = "toolu_m";
    frame.message.content[0]!.winter_site_icons.push({ url: "https://other.example.com/", icon_url: "https://other.example.com/o.png" });
    const events = accept(projector, frame as never);
    expect((events[0] as { siteIcons?: unknown }).siteIcons).toEqual([
      { url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/a.ico" },
      { url: "https://other.example.com/", iconUrl: "https://other.example.com/o.png" },
    ]);
  });

  test("a block without the field (today's pinned runtime) projects exactly as before", () => {
    const { projector } = makeProjector({ sessionId: SID });
    const events = accept(projector, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } } as never);
    expect(events[0]).toEqual({ type: "tool_result", sessionId: SID, threadId: "main", callId: "t1", output: "x", isError: false, seq: (events[0] as { seq: number }).seq, ts: (events[0] as { ts: number }).ts } as never);
  });
});

describe("url checks and bounds", () => {
  test("https only, no credentials, no whitespace, within the length cap", () => {
    expect(siteIconUrl("https://a.example.com/favicon.ico")).toBe("https://a.example.com/favicon.ico");
    expect(siteIconUrl("http://a.example.com/favicon.ico")).toBeUndefined();
    expect(siteIconUrl("data:image/png;base64,AAAA")).toBeUndefined();
    expect(siteIconUrl("javascript:alert(1)")).toBeUndefined();
    expect(siteIconUrl("https://user:pw@a.example.com/i.png")).toBeUndefined();
    expect(siteIconUrl("https://a.example.com/" + "x".repeat(3000))).toBeUndefined();
    expect(siteIconUrl(42)).toBeUndefined();
    // Re-serialised by URL: non-ASCII is percent-encoded, so the wire regex always holds.
    expect(siteIconUrl("https://a.example.com/ï.png")).toBe("https://a.example.com/%C3%AF.png");
  });

  test("at most SITE_ICONS_MAX entries, one per page url", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ url: `https://s${i % 15}.example.com/`, iconUrl: `https://s${i}.example.com/i.png` }));
    const clean = cleanSiteIcons(many)!;
    expect(clean).toHaveLength(SITE_ICONS_MAX);
    expect(new Set(clean.map((c) => c.url)).size).toBe(SITE_ICONS_MAX);
  });

  test("a url found only as the head of a longer one does not match", () => {
    noteKnownSiteIcons(SID, [{ url: "https://a.example.com/x", iconUrl: "https://a.example.com/i.png" }]);
    expect(siteIconsInText(SID, "see https://a.example.com/xy")).toBeUndefined();
    expect(siteIconsInText(SID, "see https://a.example.com/x\n")).toEqual([{ url: "https://a.example.com/x", iconUrl: "https://a.example.com/i.png" }]);
  });

  test("clearSiteIcons drops both the known pairs and any pending attachment", () => {
    noteKnownSiteIcons(SID, [{ url: "https://a.example.com/x", iconUrl: "https://a.example.com/i.png" }]);
    attachSiteIcons(SID, "t9", [{ url: "https://a.example.com/x", iconUrl: "https://a.example.com/i.png" }]);
    clearSiteIcons(SID);
    expect(siteIconsInText(SID, "https://a.example.com/x")).toBeUndefined();
    expect(takeSiteIcons(SID, "t9")).toBeUndefined();
    expect(siteIconSessions()).toBe(0);
  });

  test("history and the remote stream keep a maximal siteIcons intact beside a capped output", () => {
    const longUrl = (i: number, kind: string) => `https://s${i}.example.com/${kind}/` + "p".repeat(1900);
    const event = {
      type: "tool_result", seq: 5, sessionId: SID, ts: 1, threadId: "main", callId: "c1", isError: false,
      output: "o".repeat(200 * 1024),
      siteIcons: Array.from({ length: SITE_ICONS_MAX }, (_, i) => ({ url: longUrl(i, "page"), iconUrl: longUrl(i, "icon") })),
    } as SessionEvent;
    expect(SessionEvent.safeParse(event).success).toBe(true);
    const capped = capEvent(event) as Extract<SessionEvent, { type: "tool_result" }>;
    expect(capped.siteIcons).toEqual((event as Extract<SessionEvent, { type: "tool_result" }>).siteIcons);
    expect(capped.output.length).toBeLessThan(event.type === "tool_result" ? event.output.length : 0);
    expect(SessionEvent.safeParse(capped).success).toBe(true);
    const streamed = filterRemoteStreamEvent(event) as Extract<SessionEvent, { type: "tool_result" }> | null;
    expect(streamed?.siteIcons).toEqual(capped.siteIcons);
  });

  test("the schema refuses an http url, an empty list and an 11th entry", () => {
    const base = { type: "tool_result", seq: 1, sessionId: SID, ts: 1, threadId: "main", callId: "c", output: "", isError: false };
    const ok = { url: "https://a.example.com/", iconUrl: "https://a.example.com/i.png" };
    expect(SessionEvent.safeParse({ ...base, siteIcons: [ok] }).success).toBe(true);
    expect(SessionEvent.safeParse({ ...base, siteIcons: [{ ...ok, iconUrl: "http://a.example.com/i.png" }] }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, siteIcons: [] }).success).toBe(false);
    expect(SessionEvent.safeParse({ ...base, siteIcons: Array.from({ length: SITE_ICONS_MAX + 1 }, () => ok) }).success).toBe(false);
  });
});
