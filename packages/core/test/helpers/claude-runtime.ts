// P8c Task 1.2 — the real-runtime test bed, Winter's own mirror of the router's own
// `test/official/support.ts` `officialRuntimeBed` (that file is NOT importable — it lives in a
// sibling repo's `test/` tree, never published). Same three resolutions, same reasons:
//
//  1. the pinned CLI binary, resolved THROUGH THE WRAPPER's own `require` (never this file's) so a
//     stray platform version in a global bun cache is never picked up ahead of the pinned wrapper;
//  2. hermeticity — a fresh `HOME`/`CLAUDE_CONFIG_DIR` per session, no ambient `ANTHROPIC_API_KEY`,
//     the loopback fake bound to `127.0.0.1:0`;
//  3. `describeWithClaudeRuntime` skips (with a printed reason) when the optional platform package
//     was not installed, and THROWS instead under `WINTER_CLAUDE_REQUIRE_RUNTIME=1` (the CI gate,
///    P8c-9) — a missing binary must never read as "the suite has nothing to say" in CI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe } from "bun:test";
import { anthropicFake, startFake, type FakeServer, type RecordedRequest } from "@yanlinglabs/winter-provider-conformance";

export type AnthropicTurnScript = Parameters<typeof anthropicFake.anthropicTurnResponse>[0];

export interface ClaudeRuntimeBed {
  /** An explicit path, never a bare command name (WS-14 §5.1). */
  executable: string;
  version: string;
}

let cached: ClaudeRuntimeBed | undefined;
let resolutionFailure: string | undefined;

/**
 * Resolves the pinned platform binary, or records why it could not be resolved. Mirrors the
 * router's own `officialRuntimeBed`: a missing OPTIONAL dependency is a legitimate, quiet skip; a
 * version mismatch between the wrapper and the platform package THROWS (a loud failure a green
 * suite must never paper over — WS-02 §6).
 */
export function claudeRuntimeForTests(): ClaudeRuntimeBed | undefined {
  if (cached !== undefined) return cached;
  if (resolutionFailure !== undefined) return undefined;
  const wrapperRequire = createRequire(import.meta.url);
  let wrapperPackageJson: string;
  try {
    wrapperPackageJson = wrapperRequire.resolve("@anthropic-ai/claude-agent-sdk/package.json");
  } catch {
    resolutionFailure = "the @anthropic-ai/claude-agent-sdk wrapper is not installed";
    return undefined;
  }
  const insideWrapper = createRequire(wrapperPackageJson);
  const platformName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  let platformPackageJson: string;
  try {
    platformPackageJson = insideWrapper.resolve(`${platformName}/package.json`);
  } catch {
    resolutionFailure = `no platform package for ${process.platform}-${process.arch}: the optional dependency was not installed, so the real-runtime proofs cannot run here`;
    return undefined;
  }
  const platformDir = dirname(platformPackageJson);
  const platformVersion = (JSON.parse(readFileSync(platformPackageJson, "utf8")) as { version: string }).version;
  const wrapperVersion = (JSON.parse(readFileSync(wrapperPackageJson, "utf8")) as { version: string }).version;
  if (platformVersion !== wrapperVersion) {
    throw new Error(`the platform runtime is ${platformVersion} but the wrapper is ${wrapperVersion} — a mixed pair is not the pinned artifact (WS-02 §6)`);
  }
  const executable = join(platformDir, "claude");
  if (!existsSync(executable)) throw new Error(`the platform package at ${platformDir} carries no runtime binary`);
  cached = { executable, version: wrapperVersion };
  return cached;
}

/**
 * `describe(name, fn)`, run only when the real runtime bed resolves. Skips (with a printed reason)
 * on a normal dev/CI machine missing the optional platform package; THROWS under
 * `WINTER_CLAUDE_REQUIRE_RUNTIME=1` (P8c-9's CI gate — a required suite that silently skipped is
 * worse than one that never ran).
 */
export function describeWithClaudeRuntime(name: string, fn: () => void): void {
  const bed = (() => {
    try {
      return claudeRuntimeForTests();
    } catch (err) {
      if (process.env.WINTER_CLAUDE_REQUIRE_RUNTIME === "1") throw err;
      console.warn(`[claude runtime bed] SKIPPING ${name} — ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();
  if (bed === undefined) {
    if (process.env.WINTER_CLAUDE_REQUIRE_RUNTIME === "1") {
      throw new Error(`WINTER_CLAUDE_REQUIRE_RUNTIME=1 and the real official runtime is unavailable: ${resolutionFailure ?? "unknown reason"}`);
    }
    console.warn(`[claude runtime bed] SKIPPING ${name} — ${resolutionFailure ?? "unknown reason"}`);
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}

/** A throwaway hermetic home: `HOME` and (via the router's own spool default) the config dir both
 *  live under one `mkdtemp` root — nothing this test writes can ever reach `~/.claude`. */
export interface HermeticOfficialHome {
  root: string;
  home: string;
}

const roots: string[] = [];

export function hermeticOfficialHome(prefix = "official"): HermeticOfficialHome {
  const root = mkdtempSync(join(tmpdir(), `winter-${prefix}-`));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}

export function cleanupHermeticOfficialHomes(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * A loopback fake serving a SCRIPT of Anthropic-shaped assistant turns, one per model request
 * (repeating the last) — built on `@yanlinglabs/winter-provider-conformance`'s own SSE frame
 * builder, so the wire shape is the SAME fixture-verified shape the router's own conformance suite
 * pins, never a hand-rolled JSON guess.
 */
export async function withAnthropicLoopback<T>(
  turns: readonly AnthropicTurnScript[],
  fn: (fake: FakeServer, requests: () => RecordedRequest[]) => Promise<T>,
  opts: { delayFirstResponseMs?: number } = {},
): Promise<T> {
  let firstResponseServed = false;
  const fake = await startFake({
    routes: [
      {
        path: "*",
        handler: async (_req, recorded) => {
          if (opts.delayFirstResponseMs !== undefined && !firstResponseServed) {
            firstResponseServed = true;
            await new Promise((resolve) => setTimeout(resolve, opts.delayFirstResponseMs));
          }
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            // Turn selection is by CONVERSATION STATE (how many `tool_result` blocks this request's
            // own messages already carry), never by a raw request count — the router's own
            // `test/official/support.ts` `scriptedLoopback` uses the identical rule, and for the
            // identical reason: the runtime can make side requests (a title, a summary) that a bare
            // counter would misattribute a scripted turn to.
            const index = Math.min(countToolResultBlocks(recorded.body), turns.length - 1);
            const turn = turns[Math.max(index, 0)] ?? { blocks: [{ type: "text", chunks: ["ok"] }] };
            return anthropicFake.anthropicTurnResponse(turn);
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ],
  });
  function countToolResultBlocks(rawBody: string): number {
    let body: { messages?: Array<{ content?: unknown }> };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return 0;
    }
    let count = 0;
    for (const message of body.messages ?? []) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) if (block["type"] === "tool_result") count += 1;
    }
    return count;
  }
  try {
    return await fn(fake, () => fake.requests);
  } finally {
    await fake.close();
  }
}

/** The pinned test model id every scripted loopback answers for. */
export const LOOPBACK_MODEL_ID = "claude-sonnet-4-5-20250929";
