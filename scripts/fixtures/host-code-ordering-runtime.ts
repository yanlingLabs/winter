// Disposable child fixture. No production bootstrap, store, provider, shell or credential resolver.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const sdkRoot = process.env.WINTER_COWORK_SDK_FIXTURE_ROOT;
if (!sdkRoot) throw new Error("explicit SDK fixture root required");
const sdk = await import(pathToFileURL(join(sdkRoot, "packages/sdk/src/index.ts")).href);
const { runEngine } = await import(pathToFileURL(join(sdkRoot, "packages/runtime/src/engine.ts")).href);
const { Queue } = await import(pathToFileURL(join(sdkRoot, "packages/runtime/src/protocol/channel.ts")).href);
const index = process.argv.indexOf("--config-json");
if (index < 0) throw new Error("fixture config missing");
const config = JSON.parse(process.argv[index + 1]!);
const input = new Queue();
let carry = "", generations = 0;
const pump = (async () => {
  for await (const raw of Bun.stdin.stream()) {
    const split = sdk.splitFrames(carry + Buffer.from(raw).toString("utf8"), "");
    carry = split.carry;
    for (const frame of split.frames) input.write(frame);
  }
  input.end();
})();
await runEngine({ config, input, output: { write(frame: unknown) { process.stdout.write(sdk.encodeFrame(frame)); }, end() {} },
  provider: { async generate() {
    return generations++ === 0 ? { kind: "tool_use", calls: [{ id: "ordering-call", name: "Bash", input: { command: "fixture-never-executed" } }] } : { kind: "text", text: "fixture done" };
  } },
  tools: { async execute() { throw new Error("ordering fixture must deny before any tool executes"); } },
});
// The production child exits when its engine ends; stdin remains an SDK-owned stream.
process.exit(0);
