import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY_NAME, parseProbe, withBrokenEntry } from "./verify-fd-receiver-compiled";

// The pure half of `verify:fd-receiver` (the compile and the run are the gate itself, never part of the test sweep).
describe("verify:fd-receiver helpers", () => {
  test("the gate's entry string is the one fd-channel.ts uses in a compiled binary, and fd-channel.ts uses it only when compiled", () => {
    // read as text: scripts do not import cowork/native (the anti-wiring pin)
    const source = readFileSync(join(import.meta.dir, "..", "packages", "core", "src", "cowork", "native", "fd-channel.ts"), "utf8");
    expect(source).toContain(`export const COMPILED_FD_RECEIVER_WORKER_ENTRY = "${ENTRY_NAME}";`);
    expect(source).toContain("inCompiledBinary() ? COMPILED_FD_RECEIVER_WORKER_ENTRY : new URL(");
  });
  test("parseProbe finds the probe's JSON line among other output", () => {
    expect(parseProbe("noise\n{\"ok\":true,\"line\":\"x\"}\n")).toEqual({ ok: true, line: "x" });
    expect(parseProbe("{\"ok\":\"yes\"}\nnot json\n{broken")).toBeUndefined();
    expect(parseProbe("")).toBeUndefined();
  });
  test("withBrokenEntry renames every occurrence at the same length, and refuses a binary without the entry", () => {
    const bytes = Buffer.concat([Buffer.from("a"), Buffer.from(ENTRY_NAME), Buffer.from("b"), Buffer.from(ENTRY_NAME)]);
    const broken = withBrokenEntry(bytes)!;
    expect(broken.length).toBe(bytes.length);
    expect(broken.includes(Buffer.from(ENTRY_NAME))).toBe(false);
    expect(withBrokenEntry(Buffer.from("nothing here"))).toBeNull();
  });
  test("the gate also runs the host-code adapter probe on the compiled binary, and main.ts routes it to a probe that only calls installedHostCodeAdapter()", () => {
    const gate = readFileSync(join(import.meta.dir, "verify-fd-receiver-compiled.ts"), "utf8");
    expect(gate).toContain('runChild(good, ["__host-code-adapter-probe"]');
    expect(gate).toContain("do not resolve inside the compiled daemon");
    const root = join(import.meta.dir, "..", "packages", "cli", "src");
    expect(readFileSync(join(root, "main.ts"), "utf8")).toContain('process.argv[2] === "__host-code-adapter-probe"');
    const probe = readFileSync(join(root, "fd-receiver-probe.ts"), "utf8");
    expect(probe).toContain("installedHostCodeAdapter()");
    expect(probe).toContain('import("../../core/src/runtime-sdk/host-code-broker")');
  });
  test("package.json names the gate", () => {
    expect(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).scripts["verify:fd-receiver"]).toBe("bun run scripts/verify-fd-receiver-compiled.ts");
  });
});
