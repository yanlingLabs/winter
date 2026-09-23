// WS-21 R.2 carry (L3 round 4, minor 4) — do the daemon's BACKSLASH-ESCAPED rule paths match on BOTH real
// binaries at the integrated versions?
//
// Every literal path the daemon writes into a permission rule goes through `escapeRulePath` (`[`, `]`,
// `*`, `\` backslash-escaped; `?` raw), because both legs read rule paths as gitignore-style patterns
// now (SV-6). A home or project named `r[1]*\x` must therefore be matched LITERALLY by the escaped rule
// — and, as the control, NOT by the raw spelling, whose `[1]` is a character class. This measures the
// deny side (the one the daemon relies on for its fences) with a real Write on each leg:
//   - Winter: the built `winter` binary (`WINTER_RUNTIME_EXECUTABLE`), the `winter-test/laneb` double
//     (one Write to the path its prompt names), `Options.permissions.deny`;
//   - official: the pinned `claude` binary against the Anthropic loopback fake, the rules in the
//     flag-settings layer (`settings.permissions.deny`, the daemon's own official-leg carrier).
// `acceptEdits` plus an allowing `canUseTool`: nothing but the deny rule can stop the write.
//
// MEASURED (R.2, SDK dd9f17d / claude 0.3.250): `[`, `]` and `*` escaped once match literally on BOTH
// legs. A BACKSLASH does not: the Winter leg matches `escapeRulePath`'s single escape (`\\`), while
// claude matches only a DOUBLE escape (`\\\\` — its rule-content parse unescapes once before the
// gitignore layer sees the pattern). So a path holding a backslash is not fenced by the daemon's rules
// on the official leg today; the last test pins claude's grammar so whoever closes the gap has it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as winterQuery } from "@yanlinglabs/winter-agent-sdk";
import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { escapeRulePath, fsRootAnchored } from "../../src/runtime-sdk/mode-options";
import { describeWithWinterBinary } from "../helpers/winter-binary";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";

/** A directory whose NAME needs escaping (`name`), and the file a Write targets inside it. The session's
 *  cwd is a plain sibling: claude refuses a working directory whose name holds a backslash ("Can't access
 *  working directory … does not exist", measured), and the rule is about the PATH, not the cwd. */
function bed(prefix: string, name: string): { root: string; home: string; cwd: string; dir: string; target: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const cwd = join(root, "work");
  const dir = join(root, name);
  for (const d of [home, join(home, "tmp"), cwd, join(dir, "protected")]) mkdirSync(d, { recursive: true });
  return { root, home, cwd, dir, target: join(dir, "protected", "f.txt") };
}

/** The deny pair for `<dir>/protected/**`, its path spelled escaped (the daemon's way) or raw. */
function denyRules(dir: string, escaped: boolean | "double"): string[] {
  const spelled = escaped === "double" ? escapeRulePath(dir).replace(/\\\\/g, "\\\\\\\\") : escaped ? escapeRulePath(dir) : dir;
  const pattern = fsRootAnchored([spelled, "protected", "**"].join("/"));
  return [`Edit(${pattern})`, `Write(${pattern})`];
}

/** `[`, `]` and `*` in one name; the backslash in its own, so a leg that cannot take one is told apart. */
const NAMES = ["r[1]*x", "b\\x"] as const;

describeWithWinterBinary("R.2 carry — escaped rule paths on the Winter leg", (bin) => {
  async function writeUnder(name: string, escaped: boolean): Promise<boolean> {
    const b = bed("winter-rule-escape-w-", name);
    try {
      const q = winterQuery({
        prompt: b.target,
        options: {
          pathToClaudeCodeExecutable: bin,
          model: "winter-test/laneb",
          cwd: b.cwd,
          permissionMode: "acceptEdits",
          sandbox: { enabled: false },
          permissions: { deny: denyRules(b.dir, escaped) },
          canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: b.home, TMPDIR: b.home, WINTER_HOME: b.home, WINTER_PROFILE: "test", WINTER_TEST_PROVIDER: "laneb" },
        },
      });
      for await (const m of q) if ((m as { type?: string }).type === "result") break;
      return existsSync(b.target);
    } finally {
      rmSync(b.root, { recursive: true, force: true });
    }
  }

  for (const name of NAMES) {
    test(`${JSON.stringify(name)}: the ESCAPED rule denies the write (the raw spelling is recorded as the control)`, async () => {
      const deniedEscaped = !(await writeUnder(name, true));
      const deniedRaw = !(await writeUnder(name, false));
      console.error(`R.2 rule-escape (winter) ${JSON.stringify(name)}: escaped rule denies=${deniedEscaped}; raw rule denies=${deniedRaw}`);
      expect(deniedEscaped).toBe(true);
    }, 60_000);
  }
});

describeWithClaudeRuntime("R.2 carry — escaped rule paths on the official leg", () => {
  async function writeUnder(name: string, escaped: boolean | "double"): Promise<boolean> {
    const runtime = claudeRuntimeForTests();
    if (runtime === undefined) throw new Error("unreachable: the suite is skipped without a bed");
    const b = bed("winter-rule-escape-o-", name);
    const cfg = join(b.root, "cfg");
    mkdirSync(cfg, { recursive: true });
    let served = false;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          if (!served && !recorded.body.includes("tool_result")) {
            served = true;
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_write_1", name: "Write", jsonChunks: [JSON.stringify({ file_path: b.target, content: "escape measurement\n" })] }], stopReason: "tool_use" });
          }
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
        },
      }],
    });
    try {
      const q = claudeQuery({
        prompt: "write the file you were scripted to write",
        options: {
          pathToClaudeCodeExecutable: runtime.executable,
          model: LOOPBACK_MODEL_ID,
          cwd: b.cwd,
          permissionMode: "acceptEdits",
          settingSources: [],
          settings: { permissions: { deny: denyRules(b.dir, escaped) } },
          maxTurns: 4,
          canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
          env: {
            HOME: b.home, USER: "winter-measure", LOGNAME: "winter-measure", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
            TMPDIR: `${join(b.home, "tmp")}/`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CLAUDE_CONFIG_DIR: cfg,
            ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "sk-ant-fake-rule-escape-measurement-0000",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0",
          },
        },
      });
      for await (const m of q as AsyncIterable<SDKMessage>) if ((m as { type: string }).type === "result") break;
      return existsSync(b.target);
    } finally {
      await fake.close();
      rmSync(b.root, { recursive: true, force: true });
    }
  }

  test(`${JSON.stringify(NAMES[0])}: the ESCAPED rule denies the write (the raw spelling is recorded as the control)`, async () => {
    const deniedEscaped = !(await writeUnder(NAMES[0], true));
    const deniedRaw = !(await writeUnder(NAMES[0], false));
    console.error(`R.2 rule-escape (official) ${JSON.stringify(NAMES[0])}: escaped rule denies=${deniedEscaped}; raw rule denies=${deniedRaw}`);
    expect(deniedEscaped).toBe(true);
  }, 60_000);

  test(`${JSON.stringify(NAMES[1])}: claude's grammar — a backslash needs a DOUBLE escape (escapeRulePath's single one does not match)`, async () => {
    const deniedEscaped = !(await writeUnder(NAMES[1], true));
    const deniedDouble = !(await writeUnder(NAMES[1], "double"));
    console.error(`R.2 rule-escape (official) ${JSON.stringify(NAMES[1])}: single escape denies=${deniedEscaped}; double escape denies=${deniedDouble}`);
    expect(deniedEscaped).toBe(false);
    expect(deniedDouble).toBe(true);
  }, 60_000);
});

describe("the bed's own premise", () => {
  test("the cwd name carries every character escapeRulePath escapes", () => {
    const name = "r[1]*\\x";
    expect(escapeRulePath(name)).toBe("r\\[1\\]\\*\\\\x");
  });
});
