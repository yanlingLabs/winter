import { ProviderEvent } from "./types";

/**
 * Incremental SSE frame splitter + Responses-API event mapper.
 * One instance per request/turn — sawToolCall state does not reset between responses.
 */
export class ResponsesSseParser {
  private buf = "";
  private decoder = new TextDecoder();
  private sawToolCall = false;

  constructor(private readonly fromWireToolName: (name: string) => string = (name) => name) {}

  push(chunk: Uint8Array): ProviderEvent[] {
    // Normalize after appending so \r\n split across two push() calls is handled correctly.
    this.buf = (this.buf + this.decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    const out: ProviderEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const frame = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const mapped = this.mapFrame(frame);
      if (mapped) out.push(...mapped);
    }
    return out;
  }

  /** Flush at stream end (handles a final frame without trailing blank line). */
  finish(): ProviderEvent[] {
    const rest = this.buf.trim();
    this.buf = "";
    if (!rest) return [];
    return this.mapFrame(rest) ?? [];
  }

  private mapFrame(frame: string): ProviderEvent[] | null {
    let dataLine = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!dataLine || dataLine === "[DONE]") return null;
    let data: any;
    try { data = JSON.parse(dataLine); } catch { return null; } // tolerate junk frames
    switch (data.type) {
      case "response.output_text.delta":
        return [{ type: "text_delta", delta: String(data.delta ?? "") }];
      case "response.output_item.done":
        // whole-branch #2: capture ONLY reasoning items that carry a non-empty encrypted_content —
        // the replayable ones. `include:["reasoning.encrypted_content"]` is sent iff reasoning
        // effort is configured; with it unset, a backend-emitted summary-only reasoning item has no
        // encrypted_content, so capturing/replaying it would restore nothing. A falsy value
        // (undefined/null/"") falls through to the `return null` below (unchanged for that shape).
        if (data.item?.type === "reasoning" && data.item.encrypted_content) {
          // Codex parity: capture the completed reasoning item; strip `id` (always cleared when
          // store:false — codex client.rs prepare_response_items_for_request) and `status` (never
          // echoed back; not modeled by codex either). encrypted_content is preserved VERBATIM —
          // opaque sensitive state: never log itemJson (spec §B8).
          const { id: _id, status: _status, ...item } = data.item;
          return [{ type: "reasoning_item", itemJson: JSON.stringify(item) }];
        }
        if (data.item?.type === "function_call") {
          this.sawToolCall = true;
          return [{
            type: "tool_call",
            callId: String(data.item.call_id),
            name: this.fromWireToolName(String(data.item.name)),
            argsJson: String(data.item.arguments ?? ""),
          }];
        }
        return null;
      case "response.completed": {
        const out: ProviderEvent[] = [];
        const u = data.response?.usage;
        if (u) out.push({ type: "usage", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 });
        out.push({ type: "done", stopReason: this.sawToolCall ? "tool_calls" : "end_turn" });
        return out;
      }
      case "response.failed":
        return [{ type: "error", code: "server", message: String(data.response?.error?.message ?? "response.failed") }];
      default:
        return null; // forward compat: ignore unknown event types (incl. argument deltas — we use the final item)
    }
  }
}
