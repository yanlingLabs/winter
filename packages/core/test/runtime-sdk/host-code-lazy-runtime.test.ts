import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HostCodeExecutionService, installedHostCodeAdapter } from "../../src/runtime-sdk/host-code-broker";

// The agent runtime is loaded on the first adapter probe, not at module load (about 17 MB and 60 ms per daemon). These pin both halves:
// it is not a static import, and the lazy `require` is a LITERAL string so a bundler/compiler resolves it into the built winter-core.
const source = readFileSync(join(import.meta.dir, "../../src/runtime-sdk/host-code-broker.ts"), "utf8");

test("host-code-broker has no static import of the agent runtime, and its lazy require is a literal the bundler can resolve", () => {
  expect(source).not.toMatch(/^import[^;]*["']@yanlinglabs\/winter-agent-runtime["']/m);
  expect(source).toContain('require("@yanlinglabs/winter-agent-runtime")');
});

test("the first probe resolves the runtime (no module-not-found) and constructing the service does not probe", () => {
  expect(() => installedHostCodeAdapter()).not.toThrow();
  const service = new HostCodeExecutionService("/nonexistent-home-for-lazy-probe-test");
  expect((service as unknown as { resolvedAdapter?: unknown }).resolvedAdapter).toBeUndefined(); // lazy: nothing probed yet
  void (service as unknown as { adapter: unknown }).adapter;
  expect((service as unknown as { resolvedAdapter?: unknown }).resolvedAdapter).toBeDefined();   // first use probes once
});
