// `tool_result.siteIcons` end to end: the runtime's own report (`winter_site_icons` on a host-facing
// tool_result block — the Winter agent SDK's WebFetch/WebSearch/Search, fixture-shaped) → the REAL
// projector's `tool_result`; the url checks; and the caps on history / the remote stream.
//
// (Until 2026-10-01 the daemon's own `Search` was a second producer, through a PostToolUse hook. `Search`
// is the agent SDK's built-in now and reports its citations' icons on its own block like the other two,
// so that path and its tests are gone; one test below pins that no hook step survived.)
import { describe, expect, test } from "bun:test";
import { SITE_ICONS_MAX, SessionEvent, ToolResultEvent } from "@yanlinglabs/winter-protocol";
import { sessionHooksFor } from "../../src/runtime-sdk/hooks";
import { cleanSiteIcons, siteIconUrl, siteIconsFromRuntimeBlock } from "../../src/runtime-sdk/site-icons";
import { capEvent } from "../../src/sessions/history";
import { filterRemoteStreamEvent } from "../../src/sessions/remote-stream";
import { accept, makeProjector } from "../projector/harness";

const SID = "s_site_icons";

describe("the SDK's Search reports its citations' icons on its own block", () => {
  // Fixture: what the agent SDK's `Search` (Exa answer mode) puts on its host-facing frame.
  const output = "The answer.\n\nSources:\n1. Alpha\n   https://alpha.example.com/a\n2. Beta\n   https://beta.example.org/b?x=1";
  const icons = [
    { url: "https://alpha.example.com/a", icon_url: "https://alpha.example.com/favicon.ico" },
    // A different host for the icon than the page — the url the TOOL names is drawn, never guessed.
    { url: "https://beta.example.org/b?x=1", icon_url: "https://cdn.example.net/beta/icon-32.png" },
  ];

  test("they ride the projected tool_result, in source order, and never the model's text", () => {
    const { projector } = makeProjector({ sessionId: SID, mode: "dispatch" });
    accept(projector, { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_s1", name: "Search", input: { query: "what?" } }] } } as never);
    const events = accept(projector, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_s1", content: output, winter_site_icons: icons }] } } as never);
    const call = events.find((e) => e.type === "tool_call") as Record<string, unknown> | undefined;
    const result = events.find((e) => e.type === "tool_result") as Record<string, unknown>;
    expect(result.output).toBe(output);
    expect(result.siteIcons).toEqual([
      { url: "https://alpha.example.com/a", iconUrl: "https://alpha.example.com/favicon.ico" },
      { url: "https://beta.example.org/b?x=1", iconUrl: "https://cdn.example.net/beta/icon-32.png" },
    ]);
    expect(String(result.output)).not.toContain("favicon");
    expect(ToolResultEvent.safeParse(result).success).toBe(true);
    expect(SessionEvent.safeParse(result).success).toBe(true);
    // The renderers see the host name the pair table gives it — the one the daemon's own Search had.
    if (call !== undefined) expect(call.name).toBe("Search");
  });

  test("no daemon-side hook step is left: the unmatched PostToolUse group is the plugin callback alone, in every mode", () => {
    for (const mode of ["code", "chat", "dispatch"] as const) {
      const unmatched = (sessionHooksFor({ sessionId: SID, roots: ["/tmp"], mode }).winter?.PostToolUse ?? []).filter((g) => g.matcher === undefined);
      expect(unmatched.flatMap((g) => g.hooks)).toHaveLength(1);
    }
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

  test("duplicates by page url are dropped (the first wins)", () => {
    const { projector } = makeProjector({ sessionId: SID });
    const frame = structuredClone(fetchFrame);
    frame.message.content[0]!.winter_site_icons.push({ url: "https://docs.example.com/page", icon_url: "https://docs.example.com/second.png" }, { url: "https://other.example.com/", icon_url: "https://other.example.com/o.png" });
    const events = accept(projector, frame as never);
    expect((events[0] as { siteIcons?: unknown }).siteIcons).toEqual([
      { url: "https://docs.example.com/page", iconUrl: "https://docs.example.com/static/icon.png" },
      { url: "https://other.example.com/", iconUrl: "https://other.example.com/o.png" },
    ]);
  });

  test("a block without the field projects exactly as before", () => {
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
