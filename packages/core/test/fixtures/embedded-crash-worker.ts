// WS-23 review M-3: a daemon-side Worker entry for the embedded host — the REAL runtime Worker entry
// (the production bridge, imported for its side effect) plus one listener that throws, uncaught, once
// the session has received its first stdin chunk. Handed to a test daemon through
// `startDaemon({ embeddedHost: { workerEntry } })`; never compiled into anything.
import "@yanlinglabs/winter-agent-runtime/embedded-worker";
import { isMainThread } from "node:worker_threads";

declare const self: { addEventListener(type: "message", listener: (event: MessageEvent) => void): void };

if (!isMainThread) {
  let armed = false;
  self.addEventListener("message", (event: MessageEvent) => {
    if ((event.data as { kind?: string }).kind !== "stdin" || armed) return;
    armed = true;
    setTimeout(() => {
      throw new Error("fixture: the embedded session crashed mid-turn");
    }, 300);
  });
}
