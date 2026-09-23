// MEASUREMENT (lane B, 2026-09-22) — on a REAL, spawned `winter` child, under the daemon's own
// `buildWinterOptions`: does a SAVED allow rule take effect without asking the host, and does the
// control-plane DENY still beat a saved allow rule that matches the same call?
//
// The scripted `winter-test/laneb` double makes exactly ONE `Write` to the path on the prompt's last
// line (`provider/mock.ts`). The session runs under `ask`, and `canUseTool` REFUSES everything and
// records what it was asked, so:
//   1. with NO saved rule, a Write in the working directory reaches `canUseTool` and is refused;
//   2. with the saved rule `Edit`, the SAME Write lands and `canUseTool` is never asked — the rule
//      reached the child and the child applied it itself;
//   3. with the same `Edit` rule, a Write to `<home>/settings.json` (a control-plane file) is refused
//      and never lands — deny before allow.
// HERMETIC: `env` is built by `buildChildEnv` from a temp home; the model is a scripted double.
// SKIPS without a binary (`describeWithWinterBinary`).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool } from "@yanlinglabs/winter-agent-sdk";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import { buildWinterOptions } from "../../src/runtime-sdk/mode-options";
import type { ModelTag } from "../../src/runtime-sdk/model-tag";
import { createHostPromptQueue } from "../../src/runtime-sdk/prompt-queue";
import { describeWithWinterBinary } from "../helpers/winter-binary";

async function writeOnce(bin: string, opts: { home: string; cwd: string; target: string; persistedAllow?: string[] }): Promise<{ asked: string[] }> {
  const asked: string[] = [];
  const canUseTool: CanUseTool = async (name) => {
    asked.push(name);
    return { behavior: "deny", message: "measurement: the host refuses everything" };
  };
  const options = buildWinterOptions({
    mode: "code", policy: "ask", sessionId: crypto.randomUUID(), home: opts.home, cwd: opts.cwd,
    model: "winter-test/laneb" as ModelTag, credentials: { byProvider: {} } as unknown as CredentialPresence,
    systemPrompt: "You are a measurement.", exaKeyPresent: false,
    spawn: { pathToClaudeCodeExecutable: bin }, canUseTool, abort: new AbortController(),
    baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: opts.home, TMPDIR: opts.home },
    ...(opts.persistedAllow === undefined ? {} : { persistedAllow: opts.persistedAllow }),
  });
  const queue = createHostPromptQueue();
  const q = query({ prompt: queue, options });
  queue.push(opts.target);
  try {
    for await (const m of q) {
      if (process.env.WINTER_DEBUG_MEASURE === "1") console.warn(JSON.stringify(m).slice(0, 600));
      if ((m as { type?: string }).type === "result") break;
    }
  } finally {
    if (!queue.closed) queue.close();
  }
  return { asked };
}

describeWithWinterBinary("saved allow rules on a real winter child — applied natively, and never over a deny", (bin) => {
  test("no rule → asked and refused; `Edit` saved → written unasked; `Edit` saved → a control-plane file is still denied", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "winter-allow-measure-home-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "winter-allow-measure-cwd-")));
    try {
      const first = join(cwd, "first.txt");
      const without = await writeOnce(bin, { home, cwd, target: first });
      expect(without.asked).toContain("Write");
      expect(existsSync(first)).toBe(false);

      const second = join(cwd, "second.txt");
      const withRule = await writeOnce(bin, { home, cwd, target: second, persistedAllow: ["Edit"] });
      expect(existsSync(second)).toBe(true);
      expect(withRule.asked).not.toContain("Write");

      const controlPlane = join(home, "settings.json");
      const fenced = await writeOnce(bin, { home, cwd, target: controlPlane, persistedAllow: ["Edit"] });
      expect(existsSync(controlPlane)).toBe(false);
      expect(fenced.asked).not.toContain("Write"); // refused by the deny rule, before any ask
    } finally {
      for (const dir of [home, cwd]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }, 120_000);
});
