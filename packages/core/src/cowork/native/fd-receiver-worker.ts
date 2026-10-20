// The shared receiver thread of fd-channel.ts (see ReceiverHub there): one blocking loop that polls a control socket and every
// registered data socket and posts what it receives. It owns no descriptor; the main thread closes each data descriptor after
// the `end` event for it.
import { runHubLoop } from "./fd-channel";

declare const self: Worker;
self.onmessage = (message: MessageEvent<{ control: number }>) => {
  runHubLoop(message.data.control, (id, event) => {
    // Message bytes move without a copy; descriptor numbers are plain integers valid in this whole process.
    if (event.kind === "data") self.postMessage({ id, event }, [event.data.buffer]); else self.postMessage({ id, event });
  });
};
