import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildWorkflowSeatbeltProfile, sandboxAvailable } from "./sandbox";
import { sandboxAvailable as agentSandboxAvailable } from "../agent/sandbox";

function realTmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "norma-wf-sb-")));
}

describe("buildWorkflowSeatbeltProfile", () => {
  test("allows process-exec of EXACTLY the (canonicalized) self binary — literal form, not a blanket allow", () => {
    const self = join(realTmp(), "fake-bun");
    writeFileSync(self, "");
    const p = buildWorkflowSeatbeltProfile(self);
    expect(p).toContain(`(allow process-exec (literal "${self}"))`);
    // never the blanket form agent/sandbox.ts uses — this profile is strictly tighter
    expect(p).not.toMatch(/\(allow process-exec\)/);
  });

  test("denies process-fork — the exact op name, NOT the star form (process-fork* is an unbound variable that fails to load)", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(deny process-fork)");
    expect(p).not.toContain("process-fork*");
    expect(p).not.toContain("(allow process-fork)");
  });

  test("denies file-write* and network* everywhere, unconditionally — no opt-in flag exists (stricter than agent/sandbox.ts)", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(deny file-write*)");
    expect(p).toContain("(deny network*)");
    expect(p).not.toContain("(allow network*)");
    expect(p).not.toMatch(/\(allow file-write\*/); // no writable-roots carve-out at all — the child writes nothing
  });

  test("allows file-read* everywhere (bun must read its own binary/libs)", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(allow file-read*)");
  });

  test("canonicalizes the self-exec literal (macOS symlink resolution, e.g. /tmp -> /private/tmp)", () => {
    const rawDir = mkdtempSync(join(tmpdir(), "norma-wf-sb-"));
    const resolvedDir = realpathSync(rawDir);
    const rawSelf = join(rawDir, "fake-bun");
    writeFileSync(rawSelf, "");
    const resolvedSelf = join(resolvedDir, "fake-bun");
    const p = buildWorkflowSeatbeltProfile(rawSelf);
    expect(p).toContain(`(allow process-exec (literal "${resolvedSelf}"))`);
    expect(p).not.toContain(`(literal "${rawSelf}")`); // the raw (un-resolved) form must NOT appear, unless it happens to equal the resolved form
  });

  test("paths with quotes/backslashes are escaped in the profile (SBPL string literal safety)", () => {
    // a nonexistent path (canon() gracefully falls through to the raw string when realpath fails)
    const p = buildWorkflowSeatbeltProfile('/tmp/does-not-exist/we"ird\\bun');
    expect(p).toContain('(allow process-exec (literal "/tmp/does-not-exist/we\\"ird\\\\bun"))');
  });

  test("restricted mach-lookup set — identical to agent/sandbox.ts's bash profile, sufficient for bun startup", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(allow mach-lookup");
    for (const svc of [
      "com.apple.system.notification_center",
      "com.apple.system.logger",
      "com.apple.CoreServices.coreservicesd",
      "com.apple.bsd.dirhelper",
    ]) {
      expect(p).toContain(`(global-name "${svc}")`);
    }
  });

  test("allows signal(self), sysctl-read, and stdio write-data on /dev/null,/dev/stdout,/dev/stderr", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(allow signal (target self))");
    expect(p).toContain("(allow sysctl-read)");
    expect(p).toContain('(allow file-write-data (path "/dev/null") (path "/dev/stdout") (path "/dev/stderr"))');
  });

  test("denies by default and declares version 1", () => {
    const p = buildWorkflowSeatbeltProfile(join(realTmp(), "fake-bun"));
    expect(p).toContain("(version 1)");
    expect(p).toContain("(deny default)");
  });

  test("sandboxAvailable is re-exported from agent/sandbox verbatim (same function, same platform check)", () => {
    expect(sandboxAvailable).toBe(agentSandboxAvailable);
    expect(sandboxAvailable()).toBe(process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec"));
  });
});

// Integration: a REAL `/usr/bin/sandbox-exec` child, gated on sandboxAvailable() (macOS-only, per
// agent/test/sandbox-escape.test.ts's own `describe.skip` convention). Proves the profile is not just
// syntactically plausible SBPL but an ACTUALLY LOADABLE profile that (a) still lets bun boot and run
// to completion (the #1 risk the spike found: a blanket process-exec deny breaks sandbox-exec's own
// execvp of the target) and (b) genuinely contains a script running inside it — writeFileSync,
// execSync, and a real network connect all fail. Mirrors trackA-spike.ts's probe shape (write/exec/net
// probes, DENIED:/ALLOWED string markers) reduced to a single inline `bun -e` child, per the brief.
const d = sandboxAvailable() ? describe : describe.skip;

const PROBE_SCRIPT = `
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { connect } from "node:net";
function probeWrite() {
  try { writeFileSync("/tmp/norma-wf-sandbox-test-escape.txt", "x"); return "ALLOWED"; }
  catch (e) { return "DENIED:" + (e && e.code || e); }
}
function probeExec() {
  try { const r = execSync("echo hi"); return "ALLOWED:" + String(r).trim(); }
  catch (e) { return "DENIED:" + (e && e.code || e); }
}
function probeNet() {
  return new Promise((res) => {
    try {
      const s = connect({ host: "1.1.1.1", port: 80 });
      const done = (v) => { try { s.destroy(); } catch {} res(v); };
      s.on("connect", () => done("ALLOWED"));
      s.on("error", (e) => done("DENIED:" + (e && e.code || e)));
      setTimeout(() => done("DENIED:timeout"), 2500);
    } catch (e) { res("DENIED:" + (e && e.code || e)); }
  });
}
(async () => {
  const result = { write: probeWrite(), exec: probeExec(), net: await probeNet() };
  console.log("PROBE_RESULT:" + JSON.stringify(result));
})();
`;

d("buildWorkflowSeatbeltProfile: real sandbox-exec containment (integration)", () => {
  test("bun boots to completion under the profile (exit 0) AND write/exec/net are all denied inside it", () => {
    const bun = process.execPath; // the running bun binary — same shape as the runtime's self-spawn
    const probeFile = "/tmp/norma-wf-sandbox-test-escape.txt";
    try {
      const profile = buildWorkflowSeatbeltProfile(bun);
      const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, bun, "-e", PROBE_SCRIPT], {
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0); // bun started AND ran to completion — the #1 spike risk didn't recur
      const match = r.stdout.match(/PROBE_RESULT:(\{.*\})/);
      expect(match).not.toBeNull();
      const probe = JSON.parse(match![1]!) as { write: string; exec: string; net: string };
      expect(probe.write.startsWith("DENIED")).toBe(true); // writeFileSync contained
      expect(probe.exec.startsWith("DENIED")).toBe(true); // child_process.execSync contained
      expect(probe.net.startsWith("DENIED")).toBe(true); // net.connect contained
      expect(existsSync(probeFile)).toBe(false); // no out-of-band write landed, belt-and-suspenders
    } finally {
      try { require("node:fs").rmSync(probeFile, { force: true }); } catch {}
    }
  });
});
