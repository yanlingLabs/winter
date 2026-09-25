// WS-21 R.2 carry (L3 round 4, minor 4) — do the daemon's BACKSLASH-ESCAPED rule paths match on the real
// `winter` binary at the integrated versions?
//
// Every literal path the daemon writes into a permission rule goes through `escapeRulePath` (`[`, `]`,
// `*`, `\` backslash-escaped; `?` raw), because the runtime reads rule paths as gitignore-style patterns
// (SV-6). A home or project named `r[1]*\x` must therefore be matched LITERALLY by the escaped rule — and,
// as the control, NOT by the raw spelling, whose `[1]` is a character class. This measures the deny side
// (the one the daemon relies on for its fences) with a real Write: the built `winter` binary
// (`WINTER_RUNTIME_EXECUTABLE`), the `winter-test/laneb` double (one Write to the path its prompt names),
// `Options.permissions.deny`. `acceptEdits` plus an allowing `canUseTool`: nothing but the deny rule can
// stop the write.
//
// MEASURED at agent SDK 5e37898 (claude's rule-content parse, from 6170adb on): every name below is denied
// on the Winter leg — the rows are real assertions. (WS-23: the official-leg half of this measurement —
// the pinned `claude` binary, and claude's own double-backslash grammar case — is gone with that leg; the
// router's `escapeRulePath` is still claude's rule-content escape over the gitignore escape, which is the
// grammar the Winter runtime reads.)
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as winterQuery } from "@yanlinglabs/winter-agent-sdk";
import { escapeRulePath } from "@yanlinglabs/winter-runtime-sdk";
import { fsRootAnchored } from "../../src/runtime-sdk/mode-options";
import { describeWithWinterBinary } from "../helpers/winter-binary";

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
function denyRules(dir: string, escaped: boolean | "single" | "double"): string[] {
  // `single`/`double`: the backslash spelled by hand (once / twice), independent of `escapeRulePath`.
  const spelled = escaped === "single" ? dir.replace(/\\/g, "\\\\") : escaped === "double" ? dir.replace(/\\/g, "\\\\\\\\") : escaped ? escapeRulePath(dir) : dir;
  const pattern = fsRootAnchored([spelled, "protected", "**"].join("/"));
  return [`Edit(${pattern})`, `Write(${pattern})`];
}

/** `[`, `]` and `*` in one name; the backslash in its own, so a leg that cannot take one is told apart;
 *  and parens (router 3279a1d's table escapes them at both layers). */
const NAMES = ["r[1]*x", "b\\x", "p (old)"] as const;

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

  // Real since the SDK pin reached 5e37898 (claude's rule-content parse on the Winter leg; at dd9f17d
  // neither spelling denied once the router escaped for claude).
  for (const name of NAMES) {
    test(`${JSON.stringify(name)}: the ESCAPED rule denies the write (the raw spelling is recorded as the control)`, async () => {
      const deniedEscaped = !(await writeUnder(name, true));
      const deniedRaw = !(await writeUnder(name, false));
      console.error(`R.2 rule-escape (winter) ${JSON.stringify(name)}: escaped rule denies=${deniedEscaped}; raw rule denies=${deniedRaw}`);
      expect(deniedEscaped).toBe(true);
    }, 60_000);
  }
});

describe("the bed's own premise", () => {
  test("the directory names carry characters escapeRulePath escapes", () => {
    for (const name of NAMES) expect(escapeRulePath(name)).not.toBe(name);
  });
});
