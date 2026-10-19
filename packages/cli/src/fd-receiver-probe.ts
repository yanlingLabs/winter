// `winter-core __fd-receiver-probe`: the compiled-binary proof that the Cowork native channel's receiver thread starts. It opens a socketpair, registers one end with the
// shared receiver hub (which constructs its Worker from the compiled entry), sends one line into the other end and prints the line the hub delivers. It touches no home, no
// Keychain, no daemon and no launcher; it exists for `scripts/verify-fd-receiver-compiled.ts`.
import { FdLineChannel, closeDescriptor, sendMessage, socketPair } from "../../core/src/cowork/native/fd-channel";

export async function runChannelReceiverProbe(): Promise<{ ok: boolean; line?: string; error?: string }> {
  const [near, far] = socketPair("stream");
  const channel = new FdLineChannel(near, { maxLine: 4096, maxRights: 0 });
  try {
    sendMessage(far, new TextEncoder().encode("fd-receiver-probe\n"));
    const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the receiver thread delivered nothing within 10 s")), 10_000));
    const first = await Promise.race([channel.lines()[Symbol.asyncIterator]().next(), timeout]);
    return first.done === true ? { ok: false, error: "the channel ended before a line" } : { ok: first.value.trim() === "fd-receiver-probe", line: first.value.trim() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    try { await channel.close(); } catch { /* closed */ }
    closeDescriptor(far);
  }
}
