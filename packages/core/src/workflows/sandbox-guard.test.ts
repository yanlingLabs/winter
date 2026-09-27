import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflowSeatbeltProfile } from "./sandbox";
import { KEYCHAIN_MACH_SERVICES, keychainSandboxState } from "./sandbox-guard";

const darwin = process.platform === "darwin";

describe("the workflow worker's Keychain-sandbox check (decision)", () => {
  test("sandboxed with every Keychain service denied is the only ok", () => {
    const fake = (sandboxed: number, allowed: readonly string[]) => (_pid: number, op: string | null, _type: number, name: string | null) =>
      op === null ? sandboxed : allowed.includes(name ?? "") ? 0 : 1;
    expect(keychainSandboxState(fake(1, []))).toEqual({ ok: true });
    expect(keychainSandboxState(fake(0, []))).toEqual({ ok: false, reason: "this process is not sandboxed" });
    for (const service of KEYCHAIN_MACH_SERVICES) {
      expect(keychainSandboxState(fake(1, [service]))).toEqual({ ok: false, reason: `the sandbox allows ${service} (the Keychain)` });
    }
  });

  test.skipIf(!darwin)("this test process itself is not sandboxed (the real FFI)", () => {
    expect(keychainSandboxState()).toEqual({ ok: false, reason: "this process is not sandboxed" });
  });
});

// The real FFI inside real seatbelts. The discriminating leg is a profile that ALLOWS a Keychain service: a
// mis-passed (garbage) name would be denied by any deny-default profile and read as "ok" — only a name that
// arrives intact can be allowed, so the refusal there proves the variadic argument is passed correctly.
describe.skipIf(!darwin)("the check inside sandbox-exec", () => {
  const dir = mkdtempSync(join(tmpdir(), "ws27-sbguard-"));
  const probe = join(dir, "probe.ts");
  writeFileSync(probe, `import { keychainSandboxState } from ${JSON.stringify(join(import.meta.dir, "sandbox-guard.ts"))};\nprocess.stdout.write(JSON.stringify(keychainSandboxState()));\n`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (profile: string) => {
    const r = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, process.execPath, probe], { stdout: "pipe", stderr: "pipe" });
    return JSON.parse(r.stdout.toString() || `{"stderr":${JSON.stringify(r.stderr.toString())}}`) as unknown;
  };
  const base = buildWorkflowSeatbeltProfile(process.execPath);

  test("the workflow profile: ok", () => {
    expect(run(base)).toEqual({ ok: true });
  });

  for (const service of KEYCHAIN_MACH_SERVICES) {
    test(`the workflow profile plus ${service}: refused`, () => {
      expect(run(`${base}(allow mach-lookup (global-name "${service}"))\n`)).toEqual({ ok: false, reason: `the sandbox allows ${service} (the Keychain)` });
    });
  }
});
