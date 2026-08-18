import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenAICompatibleProvider, buildRequestBody, mapInput, wireToolName } from "../../src/providers/openai-compatible";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; });

function serveSse(file: string, opts: { status?: number; headers?: Record<string, string>; capture?: (body: any) => void } = {}) {
  const sse = readFileSync(join(import.meta.dir, "fixtures", file), "utf8");
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/responses") return new Response("nope", { status: 404 });
      opts.capture?.(await req.json());
      if (opts.status && opts.status !== 200) return new Response("err", { status: opts.status, headers: opts.headers });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  return `http://localhost:${server.port}`;
}

async function collect(iter: AsyncIterable<any>) {
  const out = []; for await (const e of iter) out.push(e); return out;
}

describe("OpenAICompatibleProvider", () => {
  test("streams a text turn and shapes the request body correctly", async () => {
    let body: any;
    const base = serveSse("simple-text.sse", { capture: (b) => { body = b; } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk-test" });
    const events = await collect(p.streamTurn({
      model: "gpt-5.2",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "run a command", parameters: { type: "object" } }],
    }));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "end_turn" });
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.delta).join("")).toBe("Hello");
    expect(body.model).toBe("gpt-5.2");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("be brief");
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(body.tools).toEqual([{ type: "function", name: "bash", description: "run a command", parameters: { type: "object" }, strict: false }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual([]);
  });

  test("401 yields an auth error event", async () => {
    const base = serveSse("simple-text.sse", { status: 401 });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "bad" });
    const events = await collect(p.streamTurn({ model: "m", input: [] }));
    expect(events).toEqual([{ type: "error", code: "auth", message: expect.stringContaining("401") }]);
  });

  test("429 with Retry-After yields rate_limit with retryAfterMs", async () => {
    const base = serveSse("simple-text.sse", { status: 429, headers: { "retry-after": "3" } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk" });
    const events = await collect(p.streamTurn({ model: "m", input: [] }));
    expect(events[0]).toMatchObject({ type: "error", code: "rate_limit", retryAfterMs: 3000 });
  });

  test("tool_result input items map to function_call_output", async () => {
    let body: any;
    const base = serveSse("simple-text.sse", { capture: (b) => { body = b; } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk" });
    await collect(p.streamTurn({
      model: "m",
      input: [{ type: "tool_result", callId: "call_abc", output: "file1\nfile2" }],
    }));
    expect(body.input).toEqual([{ type: "function_call_output", call_id: "call_abc", output: "file1\nfile2" }]);
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe("auto");
  });

  test("function_call history items map to Responses function_call entries", async () => {
    let body: any;
    const base = serveSse("simple-text.sse", { capture: (b) => { body = b; } });
    const p = new OpenAICompatibleProvider({ baseUrl: base, apiKey: "sk" });
    await collect(p.streamTurn({
      model: "m",
      input: [
        { type: "message", role: "user", content: "list files" },
        { type: "function_call", callId: "call_1", name: "glob", argsJson: '{"pattern":"*"}' },
        { type: "tool_result", callId: "call_1", output: "a.txt" },
      ],
    }));
    expect(body.input[1]).toEqual({ type: "function_call", call_id: "call_1", name: "glob", arguments: '{"pattern":"*"}' });
    expect(body.input[2]).toEqual({ type: "function_call_output", call_id: "call_1", output: "a.txt" });
  });

  test("encodes dotted tools on the Responses wire and restores them on the inbound stream", async () => {
    let body: any;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = await req.json();
        const wire = wireToolName("functions.exec");
        const sse = `data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_fx","name":"${wire}","arguments":"{\\"source\\":\\"tools.text('x')\\"}"}}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const p = new OpenAICompatibleProvider({ baseUrl: `http://localhost:${server.port}`, apiKey: "sk" });
    const events = await collect(p.streamTurn({
      model: "m",
      input: [{ type: "function_call", callId: "old", name: "functions.exec", argsJson: "{}" }],
      tools: [{ name: "functions.exec", description: "run", parameters: { type: "object" } }],
    }));
    expect(body.tools[0].name).toBe(wireToolName("functions.exec"));
    expect(body.input[0].name).toBe(wireToolName("functions.exec"));
    expect(events[0]).toEqual({ type: "tool_call", callId: "call_fx", name: "functions.exec", argsJson: '{"source":"tools.text(\'x\')"}' });
  });

  test("consumer break mid-stream cancels the reader (no connection leak)", async () => {
    // Bun's HTTP server does not propagate client-side reader.cancel() to the server-side
    // ReadableStream.cancel() callback within a short window, so we spy on the client reader
    // instead: patch globalThis.fetch to intercept reader.cancel() calls on the response body.
    let cancelled = false;
    const origFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async function (...args: Parameters<typeof fetch>) {
        const res = await origFetch(...args);
        if (res.body) {
          const origGetReader = res.body.getReader.bind(res.body);
          (res.body as any).getReader = function () {
            const reader = origGetReader();
            const origCancel = reader.cancel.bind(reader);
            (reader as any).cancel = function (...a: any[]) {
              cancelled = true;
              return origCancel(...a);
            };
            return reader;
          };
        }
        return res;
      },
      { preconnect: origFetch.preconnect },
    ) as typeof fetch;
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"a"}\n\n'));
            // never close — simulates a long stream
          },
          cancel() {},
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const p = new OpenAICompatibleProvider({ baseUrl: `http://localhost:${server.port}`, apiKey: "sk" });
      for await (const e of p.streamTurn({ model: "m", input: [] })) {
        if (e.type === "text_delta") break; // consumer bails early
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("abort mid-stream yields done(aborted)", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        let intervalId: ReturnType<typeof setInterval>;
        const stream = new ReadableStream({
          start(controller) {
            intervalId = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"a"}\n\n'));
              } catch { clearInterval(intervalId); }
            }, 10);
          },
          cancel() { clearInterval(intervalId); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const ctrl = new AbortController();
    const p = new OpenAICompatibleProvider({ baseUrl: `http://localhost:${server.port}`, apiKey: "sk" });
    const events: any[] = [];
    for await (const e of p.streamTurn({ model: "m", input: [], signal: ctrl.signal })) {
      events.push(e);
      if (e.type === "text_delta") ctrl.abort();
    }
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "aborted" });
  });

  test("connection refused yields a network error event", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl: "http://localhost:1", apiKey: "sk" });
    const events: any[] = [];
    for await (const e of p.streamTurn({ model: "m", input: [] })) events.push(e);
    expect(events).toEqual([{ type: "error", code: "network", message: expect.any(String) }]);
  });

  test("403 maps to auth; 503 maps to server", async () => {
    const base403 = serveSse("simple-text.sse", { status: 403 });
    const p1 = new OpenAICompatibleProvider({ baseUrl: base403, apiKey: "sk" });
    expect((await collect(p1.streamTurn({ model: "m", input: [] })))[0]).toMatchObject({ type: "error", code: "auth" });
    server?.stop(true);
    const base503 = serveSse("simple-text.sse", { status: 503 });
    const p2 = new OpenAICompatibleProvider({ baseUrl: base503, apiKey: "sk" });
    expect((await collect(p2.streamTurn({ model: "m", input: [] })))[0]).toMatchObject({ type: "error", code: "server" });
  });
});

describe("buildRequestBody reasoningEffort", () => {
  const baseReq = {
    model: "gpt-5.6-sol",
    instructions: "be brief",
    input: [{ type: "message", role: "user", content: "hi" } as const],
    tools: [],
  };

  // Test-pin (task spec): when reasoningEffort is unset, the body must be BYTE-IDENTICAL to the
  // pre-reasoning-effort shape — no `reasoning` key present at all, not even `reasoning: undefined`.
  test("no reasoning field when reasoningEffort is unset — byte-identical to the fixture body", () => {
    const body = buildRequestBody(baseReq);
    expect("reasoning" in body).toBe(false);
    const fixture = {
      model: "gpt-5.6-sol",
      instructions: "be brief",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
    };
    expect(JSON.stringify(body)).toBe(JSON.stringify(fixture));
  });

  test("reasoning.effort is present when reasoningEffort is set", () => {
    const body = buildRequestBody({ ...baseReq, reasoningEffort: "high" });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("include:[\"reasoning.encrypted_content\"] is requested whenever reasoning is configured", () => {
    const body = buildRequestBody({ ...baseReq, reasoningEffort: "low" });
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });
});

describe("mapInput reasoning passthrough", () => {
  test("reasoning input items pass through itemJson verbatim (opaque, never inspected)", () => {
    const itemJson = '{"type":"reasoning","summary":[],"encrypted_content":"X"}';
    const out = mapInput([{ type: "reasoning", itemJson } as any]);
    expect(out).toEqual([{ type: "reasoning", summary: [], encrypted_content: "X" }]);
  });
});

describe("mapInput image (Phase 5 CU)", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  test("image item maps to a user message with input_image (spike-verified shape)", () => {
    const out = mapInput([{ type: "image", imageUrl: dataUrl }]);
    expect(out).toEqual([
      { type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] },
    ]);
  });
  test("alt rides as a leading input_text part", () => {
    const out = mapInput([{ type: "image", imageUrl: dataUrl, alt: "screen after click" }]);
    expect(out).toEqual([
      {
        type: "message", role: "user",
        content: [
          { type: "input_text", text: "screen after click" },
          { type: "input_image", image_url: dataUrl },
        ],
      },
    ]);
  });
  test("image_url is a plain data-URL string, not the chat-completions {url} object", () => {
    const out = mapInput([{ type: "image", imageUrl: dataUrl }]) as any[];
    expect(out[0].content[0].image_url).toBe(dataUrl);
    expect(typeof out[0].content[0].image_url).toBe("string");
  });
});

describe("mapInput audio", () => {
  test("maps transient WAV audio into the Responses input_audio part", () => {
    expect(mapInput([{ type: "audio", dataUrl: "data:audio/wav;base64,AAAA" }])).toEqual([
      { type: "message", role: "user", content: [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }] },
    ]);
  });
});
