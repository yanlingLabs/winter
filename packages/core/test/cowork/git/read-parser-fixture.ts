import { OwnedGitReadCommandRunner } from "../../../src/cowork/git/read-owned-command";
import { expect } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ConfinedGitReadParser, type GitReadParserConfiguration } from "../../../src/cowork/git/read-parser-helper";
const fixtureCommands = new OwnedGitReadCommandRunner({ capacity: 2, wallMs: 15_000, outputBytes: 65_536, drainMs: 1_000 });
export async function parserFixtureCommand(home: string, args: string[], cwd?: string): Promise<{ output: string; code: number }> {
  const result = await fixtureCommands.run({ file: args[0]!, args: args.slice(1), cwd, env: { PATH: "/usr/bin:/bin", HOME: home, LC_ALL: "C" } });
  return { output: result.stdout + result.stderr, code: result.code };
}

export async function buildGitReadParserFixture(root: string) {
  mkdirSync(root, { recursive: true }); const cwd = join(root, "empty"); mkdirSync(cwd);
  const launcher = join(root, "launcher"), node = join(root, "node"), payload = join(root, "parser.cjs");
  copyFileSync(process.env.WINTER_GIT_READ_NODE_FIXTURE!, node); chmodSync(node, 0o700);
  const compiled = await parserFixtureCommand(root, ["/Library/Developer/CommandLineTools/usr/bin/clang", "-O2", "-Werror", "-isysroot", "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", resolve("../../apple/Cowork/WinterCoworkGitReadParser/launcher.c"), "-o", launcher]); expect(compiled.code).toBe(0);
  const bundled = await parserFixtureCommand(root, [process.execPath, "build", "--target=node", "--format=cjs", resolve("src/cowork/git/read-parser-entry.ts"), "--outfile", payload]); expect(bundled.code).toBe(0); chmodSync(payload, 0o600);
  const requirements: string[] = [];
  for (const [path, id] of [[launcher, "com.winter.core.test-git-launcher"], [node, "com.winter.core.test-git-parser-node"]]) {
    const signed = await parserFixtureCommand(root, ["/usr/bin/codesign", "--force", "--sign", "-", "--options", "runtime", "--identifier", id!, path!]); expect(signed.code).toBe(0);
    const metadata = await parserFixtureCommand(root, ["/usr/bin/codesign", "--display", "--verbose=4", path!]); const hash = /CDHash=([0-9a-f]+)/.exec(metadata.output); expect(hash).not.toBeNull(); requirements.push(`identifier "${id}" and cdhash H"${hash![1]}"`);
  }
  const config: GitReadParserConfiguration = { launcher, node, payload, cwd, launcherRequirement: requirements[0]!, nodeRequirement: requirements[1]!, payloadSha256: createHash("sha256").update(readFileSync(payload)).digest("hex") };
  return { config, parser: await ConfinedGitReadParser.admit(config) };
}
