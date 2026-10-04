// WS-27: MCP URL-mode elicitation — the handler the daemon sets as `Options.onElicitation`, and its broker.
import { describe, expect, test } from "bun:test";
import { SessionEvent, type NewSessionEvent } from "@yanlinglabs/winter-protocol";
import { ELICITATION_MESSAGE_MAX_LENGTH, ELICITATION_URL_MAX_LENGTH } from "@yanlinglabs/winter-protocol";
import { checkElicitationUrl, elicitationHandlerFor, elicitationTurnTracker, ElicitationBroker, type UrlElicitationDeps } from "../../src/runtime-sdk/url-elicitation";

/** A distinctive one-time code: every url below carries it, so "not in the log" is never vacuous. */
const CODE = "OTC-9f3a-NOTINLOG";
const URL_OK = `https://auth.example.com/connect?code=${CODE}&state=s1`;

function harness(over: Partial<UrlElicitationDeps> = {}) {
  const events: NewSessionEvent[] = [];
  const logs: string[] = [];
  const broker = new ElicitationBroker();
  const handler = elicitationHandlerFor({
    sessionId: "s1", mode: "code", policy: () => "ask", broker,
    emit: (e) => {
      // The schema the store would apply: an event the daemon emits must be a valid stored line.
      SessionEvent.parse({ ...e, seq: events.length + 1, ts: 1 });
      events.push(e);
    },
    log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    now: () => 1_000,
    ...over,
  });
  const ask = (req: Parameters<typeof handler>[0], signal = new AbortController().signal) => handler(req, { signal, requestId: "r1" });
  return { events, logs, broker, handler, ask };
}

const urlRequest = (url: string = URL_OK, extra: Record<string, unknown> = {}) =>
  ({ serverName: "linear", message: "Connect your workspace", mode: "url" as const, url, elicitationId: "e1", ...extra });

/** Waits until the card is on the wire (the handler emits synchronously after its first await-free steps). */
async function cardRaised(h: ReturnType<typeof harness>): Promise<string> {
  for (let i = 0; i < 50 && h.events.length === 0; i++) await Bun.sleep(1);
  const card = h.events[0] as Extract<NewSessionEvent, { type: "elicitation_requested" }>;
  expect(card.type).toBe("elicitation_requested");
  return card.elicitationId;
}

describe("checkElicitationUrl", () => {
  test("https is accepted, normalized, and its host set apart", () => {
    expect(checkElicitationUrl("https://Example.COM/a b".replace(" ", "%20"))).toEqual({ ok: true, url: "https://example.com/a%20b", host: "example.com", origin: "https://example.com" });
    // An internationalized host reads in punycode — a look-alike cannot pass as the real name.
    const idn = checkElicitationUrl("https://exаmple.com/"); // Cyrillic "а"
    expect(idn.ok && idn.host.startsWith("xn--")).toBe(true);
  });

  test("anything that is not a plain https url is refused, and no reason repeats the url", () => {
    const refused = [
      `http://auth.example.com/?code=${CODE}`,
      `javascript:alert('${CODE}')`,
      `data:text/html,${CODE}`,
      `file:///etc/passwd?${CODE}`,
      `https://user:${CODE}@auth.example.com/`,
      `https://auth.example.com@evil.example/?${CODE}`,
      `https://auth.example.com/ ${CODE}`,
      `https://auth.example.com/\n${CODE}`,
      `https://${"a".repeat(ELICITATION_URL_MAX_LENGTH)}.example/?${CODE}`,
      "not a url",
      "",
      undefined,
    ];
    for (const raw of refused) {
      const r = checkElicitationUrl(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain(CODE);
    }
  });
});

describe("elicitationHandlerFor", () => {
  test("a URL-mode request raises a card and the user's accept is the answer", async () => {
    const h = harness();
    const pending = h.ask(urlRequest());
    const id = await cardRaised(h);
    expect(h.events[0]).toMatchObject({
      type: "elicitation_requested", sessionId: "s1", threadId: "main", mode: "url",
      serverName: "linear", message: "Connect your workspace", host: "auth.example.com", origin: "https://auth.example.com",
      issuedAt: 1_000,
    });
    expect(h.broker.pendingIds("s1")).toEqual([id]);
    // The url lives in the broker while the card is pending — and only then.
    expect(h.broker.urlFor("s1", id)).toEqual({ url: URL_OK, host: "auth.example.com" });
    expect(h.broker.respond("s1", id, "accept", "orb")).toEqual({ ok: true, alreadyResolved: false });
    expect(await pending).toEqual({ action: "accept" });
    expect(h.events[1]).toEqual({ type: "elicitation_resolved", sessionId: "s1", threadId: "main", elicitationId: id, action: "accept", by: "orb" });
    expect(h.broker.urlFor("s1", id)).toBeUndefined();
    // First response wins.
    expect(h.broker.respond("s1", id, "decline", "orb")).toEqual({ ok: true, alreadyResolved: true });
  });

  test("decline is the user's other answer", async () => {
    const h = harness();
    const pending = h.ask(urlRequest());
    h.broker.respond("s1", await cardRaised(h), "decline", "orb");
    expect(await pending).toEqual({ action: "decline" });
    expect(h.events[1]).toMatchObject({ type: "elicitation_resolved", action: "decline" });
  });

  test("the full url is never persisted and never in a log line — the origin at most", async () => {
    const h = harness();
    const pending = h.ask(urlRequest());
    const id = await cardRaised(h);
    expect(h.broker.urlFor("s1", id)?.url).toContain(CODE);
    h.broker.respond("s1", id, "accept", "orb");
    await pending;
    expect(JSON.stringify(h.events)).not.toContain(CODE);
    expect(JSON.stringify(h.events)).not.toContain("/connect");
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line).not.toContain(CODE);
    expect(h.logs.some((l) => l.includes("origin=https://auth.example.com"))).toBe(true);
    // A refused url is not logged either.
    const r = harness();
    await r.ask(urlRequest(`http://auth.example.com/?code=${CODE}`));
    await r.ask(urlRequest(`https://u:${CODE}@auth.example.com/`));
    expect(r.logs).toHaveLength(2);
    for (const line of r.logs) expect(line).not.toContain(CODE);
  });

  test("form mode, and a request naming no mode, are declined without a card", async () => {
    const h = harness();
    expect(await h.ask({ serverName: "linear", message: "Your name?", mode: "form", requestedSchema: { type: "object" } })).toEqual({ action: "decline" });
    expect(await h.ask({ serverName: "linear", message: "Your name?" })).toEqual({ action: "decline" });
    expect(h.events).toEqual([]);
    expect(h.logs.every((l) => l.includes("only URL-mode elicitation is supported"))).toBe(true);
  });

  test("a non-https, credential-bearing, whitespace-carrying or over-cap url is declined without a card", async () => {
    const h = harness();
    for (const url of [
      "http://auth.example.com/", "javascript:alert(1)", "data:text/html,x", "https://a:b@auth.example.com/",
      "https://auth.example.com/ x", `https://auth.example.com/?q=${"x".repeat(ELICITATION_URL_MAX_LENGTH)}`,
    ]) {
      expect(await h.ask(urlRequest(url))).toEqual({ action: "decline" });
    }
    expect(await h.ask({ serverName: "linear", message: "m", mode: "url" })).toEqual({ action: "decline" });
    expect(h.events).toEqual([]);
  });

  test("an over-long message and server name are capped for display, not refused", async () => {
    const h = harness();
    const pending = h.ask(urlRequest(URL_OK, { message: "m".repeat(ELICITATION_MESSAGE_MAX_LENGTH + 500), serverName: `s\n${"n".repeat(400)}` }));
    const id = await cardRaised(h);
    const card = h.events[0] as Extract<NewSessionEvent, { type: "elicitation_requested" }>;
    expect(card.message.length).toBe(ELICITATION_MESSAGE_MAX_LENGTH);
    expect(card.message.endsWith("…")).toBe(true);
    expect(card.serverName.length).toBe(128);
    expect(card.serverName).not.toContain("\n");
    h.broker.respond("s1", id, "decline", "orb");
    await pending;
  });

  test("bidi override, isolate and mark characters are stripped from the server name and the message", async () => {
    const h = harness();
    const bidi = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f";
    const pending = h.ask(urlRequest(URL_OK, { serverName: `li${bidi}near`, message: `Con${bidi}nect\nnow` }));
    const id = await cardRaised(h);
    const card = h.events[0] as Extract<NewSessionEvent, { type: "elicitation_requested" }>;
    expect(card.serverName).toBe("linear");
    expect(card.message).toBe("Connect\nnow");
    h.broker.respond("s1", id, "decline", "orb");
    await pending;
  });

  test("a dispatch child keeps its never-prompt rule and declines; a dispatch or chat session cards", async () => {
    const child = harness({ origin: "dispatch-child" });
    expect(await child.ask(urlRequest())).toEqual({ action: "decline" });
    expect(child.events).toEqual([]);
    expect(child.logs[0]).toContain("dispatch child never prompts");
    for (const mode of ["dispatch", "chat"] as const) {
      const h = harness({ mode });
      const pending = h.ask(urlRequest());
      h.broker.respond("s1", await cardRaised(h), "accept", "orb");
      expect(await pending).toEqual({ action: "accept" });
    }
  });

  test("a dont-ask session declines without a card; bypass still cards (never an automatic open)", async () => {
    const quiet = harness({ policy: () => "dont-ask" });
    expect(await quiet.ask(urlRequest())).toEqual({ action: "decline" });
    expect(quiet.events).toEqual([]);
    const bypass = harness({ policy: () => "bypass" });
    const pending = bypass.ask(urlRequest());
    const id = await cardRaised(bypass);
    await Bun.sleep(5);
    expect(bypass.broker.pendingIds("s1")).toEqual([id]); // still waiting on the user
    bypass.broker.respond("s1", id, "decline", "orb");
    expect(await pending).toEqual({ action: "decline" });
  });

  test("an aborted signal answers cancel and withdraws the card", async () => {
    const h = harness();
    const ac = new AbortController();
    const pending = h.ask(urlRequest(), ac.signal);
    const id = await cardRaised(h);
    ac.abort();
    expect(await pending).toEqual({ action: "cancel" });
    expect(h.events[1]).toEqual({ type: "elicitation_resolved", sessionId: "s1", threadId: "main", elicitationId: id, action: "cancel", by: "aborted" });
    expect(h.broker.pendingIds("s1")).toEqual([]);
    // Already aborted before the card: cancel, and no card at all.
    const pre = harness();
    const done = new AbortController(); done.abort();
    expect(await pre.ask(urlRequest(), done.signal)).toEqual({ action: "cancel" });
    expect(pre.events).toEqual([]);
  });

  test("an unanswered card is cancelled at its timeout", async () => {
    const h = harness({ timeoutMs: 20 });
    const pending = h.ask(urlRequest());
    const id = await cardRaised(h);
    expect(await pending).toEqual({ action: "cancel" });
    expect(h.events[1]).toMatchObject({ type: "elicitation_resolved", action: "cancel", by: "timeout" });
    expect(h.broker.urlFor("s1", id)).toBeUndefined();
  });

  test("a card is tagged with the turn running when it was raised; a turn's end cancels only its own cards", async () => {
    let turn: number | undefined = 1;
    const t = harness({ currentTurn: () => turn });
    const first = t.ask(urlRequest());
    await cardRaised(t);
    turn = undefined; // raised between turns
    const between = t.handler(urlRequest(), { signal: new AbortController().signal, requestId: "r2" });
    await Bun.sleep(5);
    expect(t.broker.pendingIds("s1")).toHaveLength(2);
    expect(t.broker.cancelTurn("other", 1, "turn-ended")).toBe(0);
    expect(t.broker.cancelTurn("s1", 2, "turn-ended")).toBe(0);
    expect(t.broker.cancelTurn("s1", 1, "turn-ended")).toBe(1);
    expect(await first).toEqual({ action: "cancel" });
    expect(t.broker.pendingIds("s1")).toEqual(["el_r2"]);
    t.broker.respond("s1", "el_r2", "decline", "orb");
    expect(await between).toEqual({ action: "decline" });
  });

  test("the turn tracker: a main turn's end cancels its cards; a subagent's turn end and a card between turns are left alone", async () => {
    const broker = new ElicitationBroker();
    const turns = elicitationTurnTracker(broker, "s1");
    const tagged = elicitationHandlerFor({ sessionId: "s1", mode: "code", policy: () => "ask", broker, emit: () => {}, log: { info: () => {}, error: () => {} }, currentTurn: () => turns.current() });
    const ask = (id: string) => tagged(urlRequest(), { signal: new AbortController().signal, requestId: id });
    turns.observe({ type: "turn_started", threadId: "main" });
    expect(turns.current()).toBe(1);
    const inTurn = ask("a");
    await Bun.sleep(2);
    // A subagent's turn events are not the main turn's: nothing is cancelled, the count is untouched.
    turns.observe({ type: "turn_started", threadId: "toolu_child" });
    turns.observe({ type: "turn_completed", threadId: "toolu_child" });
    expect(turns.current()).toBe(1);
    expect(broker.pendingIds("s1")).toEqual(["el_a"]);
    turns.observe({ type: "turn_completed", threadId: "main" });
    expect(await inTurn).toEqual({ action: "cancel" });
    expect(turns.current()).toBeUndefined();
    // Raised between turns: the next turn's end leaves it alone.
    const between = ask("b");
    await Bun.sleep(2);
    turns.observe({ type: "turn_started", threadId: "main" });
    turns.observe({ type: "turn_completed", threadId: "main" });
    expect(broker.pendingIds("s1")).toEqual(["el_b"]);
    broker.respond("s1", "el_b", "decline", "orb");
    expect(await between).toEqual({ action: "decline" });
  });

  test("the turn tracker: a main turn_started INSIDE an open turn (a message folded into it — agent SDK 0.0.44) starts nothing, and the turn's one end still cancels its earlier card", async () => {
    const broker = new ElicitationBroker();
    const turns = elicitationTurnTracker(broker, "s1");
    const tagged = elicitationHandlerFor({ sessionId: "s1", mode: "code", policy: () => "ask", broker, emit: () => {}, log: { info: () => {}, error: () => {} }, currentTurn: () => turns.current() });
    turns.observe({ type: "turn_started", threadId: "main" });
    const beforeFold = tagged(urlRequest(), { signal: new AbortController().signal, requestId: "a" });
    await Bun.sleep(2);
    turns.observe({ type: "turn_started", threadId: "main" });   // the folded message's announcement
    expect(turns.current()).toBe(1);
    turns.observe({ type: "turn_completed", threadId: "main" }); // the running turn's ONE terminal
    expect(await beforeFold).toEqual({ action: "cancel" });
    expect(broker.pendingIds("s1")).toEqual([]);
    // and the next real turn is a new one
    turns.observe({ type: "turn_started", threadId: "main" });
    expect(turns.current()).toBe(2);
  });

  test("a card that cannot be raised declines and leaves nothing pending", async () => {
    const broker = new ElicitationBroker();
    const logs: string[] = [];
    const handler = elicitationHandlerFor({
      sessionId: "s1", mode: "code", policy: () => "ask", broker,
      emit: () => { throw new Error(`disk full ${CODE}`); },
      log: { info: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    expect(await handler(urlRequest(), { signal: new AbortController().signal, requestId: "r1" })).toEqual({ action: "decline" });
    expect(broker.pendingIds("s1")).toEqual([]);
    for (const line of logs) expect(line).not.toContain(CODE);
  });
});
