// WS-23 review I-2: the REAL runtime Worker entry plus one listener that, in a session on the
// `winter-test/hang` double, posts a line that is NOT a frame onto stdout mid-turn. The wrapper's
// `query()` then throws `ProtocolDecodeError` and ends its iteration WITHOUT the engine ending -- the
// hang turn never completes, so nothing but the host can stop it. That is exactly the hazard the
// review names (an oversized frame cannot produce it on this topology: the bridge posts each frame
// whole, and `maxBufferSize` bounds only an unterminated carry). Sessions on any other model are left alone.
import "@yanlinglabs/winter-agent-runtime/embedded-worker";
import { isMainThread } from "node:worker_threads";

declare const self: { addEventListener(type: "message", listener: (event: MessageEvent) => void): void };

if (!isMainThread) {
  let garble = false;
  let armed = false;
  self.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as { kind?: string; argv?: string[] };
    if (message.kind === "start") garble = (message.argv ?? []).some((a) => a.includes('"model":"winter-test/hang"'));
    if (message.kind !== "stdin" || !garble || armed) return;
    armed = true;
    setTimeout(() => postMessage({ kind: "stdout", chunk: "this line is not a protocol frame\n" }), 300);
  });
}
