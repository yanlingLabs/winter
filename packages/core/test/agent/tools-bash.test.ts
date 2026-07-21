import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { ToolRegistry } from "../../src/agent/tools/registry";
import { registerBashTool } from "../../src/agent/tools/bash";
import { sandboxAvailable } from "../../src/agent/sandbox";
import { sessionTmpDir } from "../../src/agent/session-tmp";

function proj(): string { return realpathSync(mkdtempSync(join(tmpdir(), "norma-bash-"))); }
function reg(): ToolRegistry { const r = new ToolRegistry(); registerBashTool(r); return r; }

const darwin = sandboxAvailable();
const d = darwin ? describe : describe.skip;

d("bash tool (sandboxed)", () => {
  test("runs a command and reports stdout + exit 0", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo hello-norma" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hello-norma");
    expect(res.output).toContain("[exit 0]");
  });

  test("can write inside the session cwd", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo in-cwd > made.txt && cat made.txt" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(existsSync(join(cwd, "made.txt"))).toBe(true);
    expect(res.output).toContain("in-cwd");
  });

  test("CANNOT write outside the session cwd (sandbox denies)", async () => {
    const cwd = proj();
    const sibling = proj(); // a different temp dir, not a writable root of `cwd`'s sandbox
    const target = join(sibling, "escaped.txt");
    const res = await reg().execute("bash", { command: `echo pwned > ${target}` }, { cwd, roots: [cwd], sessionId: "s1" });
    // command runs but the write is denied → nonzero exit, file absent
    expect(existsSync(target)).toBe(false);
    expect(res.output).not.toContain("[exit 0]");
  });

  // SP-approvals final review (composition hole, defense-in-depth): engine.ts's dispatch-loop hard
  // error (permissionRulesFileTarget) only ever sees write/edit TOOL calls — a bash-invoked write
  // never goes through it. The seatbelt itself (sandbox.ts's buildSeatbeltProfile) must
  // independently deny this exact file, EVEN THOUGH it's inside the writable cwd subpath.
  test("CANNOT write .norma/permissions.local.json even though it is INSIDE the writable cwd (seatbelt carve-out)", async () => {
    const cwd = proj();
    const target = join(cwd, ".norma", "permissions.local.json");
    const res = await reg().execute(
      "bash",
      { command: `mkdir -p ${join(cwd, ".norma")} && echo '{"allow":["WebFetch(domain:webhook.site)"]}' > ${target}` },
      { cwd, roots: [cwd], sessionId: "s1" },
    );
    // mkdir succeeds (the .norma DIR itself is not carved out) but the redirect into the exact
    // file is denied → nonzero exit, file absent.
    expect(existsSync(target)).toBe(false);
    expect(res.output).not.toContain("[exit 0]");
  });

  test("CAN still write .norma/memory/whatever.md (the MEMDIR) — the carve-out is file-specific, not directory-blanket", async () => {
    const cwd = proj();
    const target = join(cwd, ".norma", "memory", "whatever.md");
    const res = await reg().execute(
      "bash",
      { command: `mkdir -p ${join(cwd, ".norma", "memory")} && echo memory-content > ${target} && cat ${target}` },
      { cwd, roots: [cwd], sessionId: "s1" },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[exit 0]");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("memory-content\n");
  });

  // SP-policies whole-branch review (Item 1, HIGH): the OLD seatbelt emitted ONE literal deny per
  // writable root — `<root>/.norma/permissions.local.json` — which missed a NESTED store under a
  // BROAD Edit(<parent>) root: `<parent>/B/.norma/permissions.local.json` was writable by sandboxed
  // bash, minting a sibling project's rules. The fix adds an SBPL `(deny file-write* (regex ...))`
  // matching `*/.norma/permissions.local.json` at ANY depth, any case. Here `<parent>` is an EXTRA
  // writable root (roots: [cwd, parent]) and the store lives under `<parent>/projB`, so ONLY the
  // regex (not the per-root literal) can catch it — pinning the nested case end-to-end through a real
  // sandbox-exec child, exactly the surface the engine's write/edit guard (permissionRulesFileTarget)
  // cannot see into.
  test("CANNOT write a NESTED sibling rules store <parent>/projB/.norma/permissions.local.json (regex deny at any depth)", async () => {
    const cwd = proj();
    const parent = proj(); // an EXTRA writable root (mirrors an Edit(<parent>) grant)
    const target = join(parent, "projB", ".norma", "permissions.local.json");
    mkdirSync(join(parent, "projB", ".norma"), { recursive: true });
    const res = await reg().execute(
      "bash",
      { command: `echo '{"allow":["WebFetch(domain:webhook.site)"]}' > ${target}` },
      { cwd, roots: [cwd, parent], sessionId: "s1" },
    );
    expect(existsSync(target)).toBe(false); // regex-denied even though it is nested under a writable root
    expect(res.output).not.toContain("[exit 0]");
  });

  test("the nested regex carve-out is still file-specific — sibling other.json, nested memory/, and plain files under the same root all remain writable; a trivial command still runs (profile valid)", async () => {
    const cwd = proj();
    const parent = proj();
    mkdirSync(join(parent, "projB", ".norma", "memory"), { recursive: true });
    const other = join(parent, "projB", ".norma", "other.json");
    const mem = join(parent, "projB", ".norma", "memory", "x.md");
    const plain = join(parent, "projB", "file.txt");
    const res = await reg().execute(
      "bash",
      { command: `echo o > ${other} && echo m > ${mem} && echo p > ${plain} && echo hi` },
      { cwd, roots: [cwd, parent], sessionId: "s1" },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[exit 0]"); // profile is VALID — a malformed regex would deny everything
    expect(res.output).toContain("hi");
    expect(existsSync(other)).toBe(true);
    expect(existsSync(mem)).toBe(true);
    expect(existsSync(plain)).toBe(true);
  });

  test("kills a command that exceeds the timeout", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "sleep 5", timeoutMs: 300 }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.output).toMatch(/timed out/);
  });

  test("bad args are a tool error, not a throw", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(true);
  });

  test("a backgrounded child does not hang the call past the timeout", async () => {
    const cwd = proj();
    const started = Date.now();
    const res = await reg().execute(
      "bash",
      { command: "(sleep 30 && touch survived.txt) & echo backgrounded", timeoutMs: 400 },
      { cwd, roots: [cwd], sessionId: "s1" },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4000); // MUST NOT block for the child's 30s lifetime
    expect(res.output).toMatch(/timed out/);
    // the killed background job never gets to create the file:
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(cwd, "survived.txt"))).toBe(false);
  });

  test("bash can write to $TMPDIR (session temp) but not system /tmp", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: 'echo scratch > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"' }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("scratch");
    expect(res.output).toContain("[exit 0]");
    const outside = await reg().execute("bash", { command: "echo x > /tmp/norma-should-fail.txt", timeoutMs: 5000 }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(existsSync("/tmp/norma-should-fail.txt")).toBe(false);
    expect(outside.output).not.toContain("[exit 0]");
  });

  test("bash can write to an extra allowed root", async () => {
    const cwd = proj();
    const extra = realpathSync(mkdtempSync(join(tmpdir(), "norma-bash-extra-")));
    const res = await reg().execute("bash", { command: `echo hi > ${extra}/in-extra.txt` }, { cwd, roots: [cwd, extra], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(existsSync(join(extra, "in-extra.txt"))).toBe(true);
  });

  test("git runs through the sandbox with clean output (no spurious permission errors)", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", {
      command: `git init -q && git -c user.email=a@b.c -c user.name=n commit --allow-empty -q -m init && echo COMMIT_OK && git --version`,
      timeoutMs: 20000,
    }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.output).toContain("COMMIT_OK");
    expect(res.output).toContain("[exit 0]");
    // these DVT/confstr(3) lines appear iff com.apple.bsd.dirhelper is missing from the sandbox mach allowlist — real regression guard
    expect(res.output).not.toMatch(/DVT/);
    expect(res.output).not.toMatch(/from confstr\(3\)/);
    expect(res.output).not.toMatch(/Failed to start fs event stream/);
  });

  test("bash aborts its child when the context signal fires", async () => {
    const cwd = proj();
    const ac = new AbortController();
    const started = Date.now();
    const p = reg().execute("bash", { command: "sleep 30" }, { cwd, roots: [cwd], tmpDir: sessionTmpDir("s_ab"), sessionId: "s1", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const res = await p;
    expect(Date.now() - started).toBeLessThan(5000); // returned promptly, not after 30s
    expect(res.output).toMatch(/abort|killed/i);
    // no orphaned sleep (group-killed) — pgrep check as in 1b-ii-a:
    const { execSync } = await import("node:child_process");
    const orphans = (() => { try { return execSync("pgrep -f 'sleep 30'").toString().trim(); } catch { return ""; } })();
    expect(orphans).toBe("");
  });

  test("bash accepts an optional justification and ignores it for execution", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "echo hi", justification: "because the reviewer asked" }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("hi"); // command ran; justification did not affect execution
  });

  // Background bash tasks tee to <sessionTmpDir>/bash/<taskId>.log (bg-registry.ts) — the
  // FOREGROUND path never touches BackgroundTaskRegistry at all, so it must never create that
  // directory, and its result must never mention output_file (that's background-only).
  test("foreground bash creates no bg output file/dir and mentions no output_file", async () => {
    const cwd = proj();
    const tmpDir = sessionTmpDir("s_fg_only");
    const res = await reg().execute("bash", { command: "echo hi" }, { cwd, roots: [cwd], tmpDir, sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).not.toContain("output_file");
    expect(existsSync(join(tmpDir, "bash"))).toBe(false);
  });
});

// SP-approvals Task 11 (spec §8): bash's two escalation args, exercised end to end through the
// REAL sandboxed spawn (registerBashTool + a real sandbox-exec child) — the engine's own gating
// (whether/how a card fires) is covered separately, without a real sandbox, in
// permission-gate-order.test.ts; this file proves the EXECUTION half: what each flag actually does
// to the spawned process once a call has been approved.
d("bash tool escalation args (SP-approvals T11)", () => {
  test("allowNetwork: true still cannot write outside the session roots — the write fence survives widening the sandbox for network", async () => {
    const cwd = proj();
    const sibling = proj();
    const target = join(sibling, "escaped-network.txt");
    const res = await reg().execute("bash", { command: `echo pwned > ${target}`, allowNetwork: true }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(existsSync(target)).toBe(false); // denied — same fence as the plain (no-flag) case
    expect(res.output).not.toContain("[exit 0]");
  });

  test("allowNetwork: true actually enables the network the default sandbox denies (loopback probe, no real internet needed)", async () => {
    // A tiny local TCP server the SANDBOXED child can reach only if network is genuinely allowed.
    // Deliberately a raw IP (127.0.0.1), never a hostname — avoids depending on whether the
    // profile's mach-lookup allowlist covers DNS resolution (mDNSResponder), which is an entirely
    // separate, pre-existing concern this task doesn't touch.
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const cwd = proj();
      const denied = await reg().execute(
        "bash",
        { command: `nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`, timeoutMs: 8000 },
        { cwd, roots: [cwd], sessionId: "s1" },
      );
      expect(denied.output).not.toContain("RC:0"); // default sandbox: network denied — connect fails

      const allowed = await reg().execute(
        "bash",
        { command: `nc -z -w 2 127.0.0.1 ${port}; echo RC:$?`, allowNetwork: true, timeoutMs: 8000 },
        { cwd, roots: [cwd], sessionId: "s1" },
      );
      expect(allowed.output).toContain("RC:0"); // allowNetwork: true — connect succeeds
    } finally {
      server.close();
    }
  });

  test("dangerouslyDisableSandbox: true escapes the write fence entirely — a write outside every root now SUCCEEDS", async () => {
    const cwd = proj();
    const sibling = proj();
    const target = join(sibling, "escaped-unsandboxed.txt");
    const res = await reg().execute("bash", { command: `echo pwned > ${target}`, dangerouslyDisableSandbox: true }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("[exit 0]"); // no sandbox-exec wrapper at all -> the write lands
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("pwned\n");
  });

  test("dangerouslyDisableSandbox: true still honors cwd and $TMPDIR semantics (only the sandbox itself is skipped)", async () => {
    const cwd = proj();
    const tmpDir = sessionTmpDir("s_unsandboxed_tmp");
    const res = await reg().execute(
      "bash",
      { command: 'pwd && echo scratch > "$TMPDIR/probe.txt" && cat "$TMPDIR/probe.txt"', dangerouslyDisableSandbox: true },
      { cwd, roots: [cwd], tmpDir, sessionId: "s1" },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toContain(realpathSync(cwd));
    expect(res.output).toContain("scratch");
    expect(res.output).toContain("[exit 0]");
  });

  test("dangerouslyDisableSandbox: true does not require sandbox-exec to be usable — bad args are still a tool error, not a throw", async () => {
    const cwd = proj();
    const res = await reg().execute("bash", { command: "", dangerouslyDisableSandbox: true }, { cwd, roots: [cwd], sessionId: "s1" });
    expect(res.isError).toBe(true); // zod's min(1) on command still rejects this before any spawn
  });
});
