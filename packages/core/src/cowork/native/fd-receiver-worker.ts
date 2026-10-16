// Worker thread of FdReceiver (fd-channel.ts): blocks in poll(2) and recvmsg(2) on a private descriptor and posts each message
// to the main thread. It owns no descriptor; the receiver that started it closes them after this thread has ended.
import { runReceiveLoop } from "./fd-channel";

declare const self: Worker;
self.onmessage = (message: MessageEvent<{ fd: number; wake: number; maxBytes: number; maxRights: number }>) => {
  const { fd, wake, maxBytes, maxRights } = message.data;
  runReceiveLoop(fd, wake, maxBytes, maxRights, event => {
    // Message bytes move without a copy; descriptor numbers are plain integers valid in this whole process.
    if (event.kind === "data") self.postMessage(event, [event.data.buffer]); else self.postMessage(event);
  });
};
