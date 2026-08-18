import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ResponsesSseParser } from "../../src/providers/responses-sse";

function feed(parser: ResponsesSseParser, file: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(readFileSync(join(import.meta.dir, "fixtures", file), "utf8"));
  const out = [];
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(...parser.push(bytes.subarray(i, i + chunkSize)));
  out.push(...parser.finish());
  return out;
}

describe("ResponsesSseParser", () => {
  test("text stream → deltas + usage + done", () => {
    const events = feed(new ResponsesSseParser(), "simple-text.sse");
    expect(events).toEqual([
      { type: "text_delta", delta: "Hel" },
      { type: "text_delta", delta: "lo" },
      { type: "usage", inputTokens: 12, outputTokens: 2 },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  test("tool call stream → tool_call with assembled args + done(tool_calls)", () => {
    const events = feed(new ResponsesSseParser(), "tool-call.sse");
    expect(events).toEqual([
      { type: "tool_call", callId: "call_abc", name: "bash", argsJson: '{"command":"ls"}' },
      { type: "usage", inputTokens: 40, outputTokens: 9 },
      { type: "done", stopReason: "tool_calls" },
    ]);
  });

  test("restores an encoded Responses tool name", () => {
    const parser = new ResponsesSseParser((name) => name === "norma_ZnVuY3Rpb25zLmV4ZWM" ? "functions.exec" : name);
    const chunk = new TextEncoder().encode(
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_fx","name":"norma_ZnVuY3Rpb25zLmV4ZWM","arguments":"{}"}}\n\n',
    );
    expect(parser.push(chunk)).toEqual([{ type: "tool_call", callId: "call_fx", name: "functions.exec", argsJson: "{}" }]);
  });

  test("unknown event types are ignored (forward compat)", () => {
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode('event: response.shiny.new\ndata: {"type":"response.shiny.new"}\n\n');
    expect(p.push(chunk)).toEqual([]);
  });

  test("reasoning item on output_item.done → reasoning_item event (id/status stripped, encrypted_content verbatim)", () => {
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode(
      'data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"s"}],"encrypted_content":"OPAQUE"}}\n\n'
    );
    const events = p.push(chunk);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("reasoning_item");
    expect(JSON.parse((events[0] as any).itemJson)).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "s" }],
      encrypted_content: "OPAQUE",
    });
  });

  test("reasoning item WITHOUT encrypted_content yields nothing (gate on replayable state, history-parity minor)", () => {
    // With reasoning effort UNSET (no include:["reasoning.encrypted_content"]), a backend may still
    // emit a summary-only reasoning item that carries NO encrypted_content — capturing + replaying it
    // would persist opaque state with nothing to restore. Capture ONLY the replayable ones.
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode(
      'data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"s"}]}}\n\n'
    );
    expect(p.push(chunk)).toEqual([]);
  });

  test("reasoning item with EMPTY encrypted_content also yields nothing (non-empty gate)", () => {
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode(
      'data: {"type":"response.output_item.done","item":{"id":"rs_1","type":"reasoning","status":"completed","summary":[],"encrypted_content":""}}\n\n'
    );
    expect(p.push(chunk)).toEqual([]);
  });

  test("unrecognized output_item.done item type still yields nothing (unchanged)", () => {
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode(
      'data: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call"}}\n\n'
    );
    expect(p.push(chunk)).toEqual([]);
  });

  test("CRLF line endings are normalized (proxy compat)", () => {
    const p = new ResponsesSseParser();
    const chunk = new TextEncoder().encode(
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Hi"}\r\n\r\n'
    );
    expect(p.push(chunk)).toEqual([{ type: "text_delta", delta: "Hi" }]);
  });

  test("CRLF split across push boundaries still parses", () => {
    const p = new ResponsesSseParser();
    const full = 'data: {"type":"response.output_text.delta","delta":"Yo"}\r\n\r\n';
    const bytes = new TextEncoder().encode(full);
    const cut = full.indexOf("\r\n\r\n") + 1; // split between \r and \n
    const out = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut)), ...p.finish()];
    expect(out).toEqual([{ type: "text_delta", delta: "Yo" }]);
  });
});
