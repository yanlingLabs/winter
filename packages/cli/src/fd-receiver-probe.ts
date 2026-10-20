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

/** `winter-core __host-code-adapter-probe`: the compiled-binary proof that the host-code broker's SDK modules resolve inside the built binary. `installedHostCodeAdapter()` is the
 * function that loads them; a module missing from the bundle throws "Cannot find module" here. Whether the installed SDK offers an adapter at all is not asked (undefined is a
 * valid answer); only that the call does not throw. It touches no home, Keychain, daemon or launcher. */
export async function runHostCodeAdapterProbe(): Promise<{ ok: boolean; adapter?: boolean; error?: string }> {
  try {
    const { installedHostCodeAdapter } = await import("../../core/src/runtime-sdk/host-code-broker");
    return { ok: true, adapter: installedHostCodeAdapter() !== undefined };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** `winter-core __host-env-lazy-probe`: the compiled-binary proof that the activation seam's lazy `require("./host-env/environment")` resolves inside the built binary (the seam itself stays off;
 * this loads the module and checks its builder is a function, and builds no environment). It touches no home, Keychain, daemon or launcher. */
export async function runHostEnvLazyProbe(): Promise<{ ok: boolean; error?: string }> {
  try {
    const { loadCoworkHostEnvironmentModule } = await import("../../core/src/cowork/native-activation");
    const hostEnv = loadCoworkHostEnvironmentModule();
    return typeof hostEnv.createCoworkNativeProductionEnvironment === "function" ? { ok: true } : { ok: false, error: "the host-env module has no environment builder" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
