// Builds the `winter` runtime binary from the SDK checkout AT THE PINNED TAG (P8b-2). The platform
// package is private and not on npm, and a compiled $bunfs daemon cannot createRequire it anyway,
// so the daemon always receives an explicit path. This script is how dev, tests and CI get one.
//   bun run build:winter                     # -> dist/winter (from ../winter-agent-sdk or $NORMA_WINTER_SDK_CHECKOUT)
//   bun run build:winter --out <path>
//   bun run build:winter --allow-untagged    # LOCAL EXPERIMENTS ONLY — never in CI
// Refuses unless the checkout's HEAD carries the tag v<REQUIRED_WINTER_AGENT_SDK> (a build from any
// other commit is a different binary than the peer the daemon is pinned to).
//
// `--allow-untagged` is named narrower than it is (review F-6): it skips the gate ENTIRELY, so it
// admits a checkout sitting on the WRONG tag just as readily as an untagged one. It exists for
// bisecting an SDK change locally. A binary built with it is not the pinned peer, must never be
// uploaded as one, and no CI path passes it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_WINTER_AGENT_SDK } from "../packages/core/src/runtime-sdk/versions";

/**
 * Is `tag` among the tags pointing at the checkout's HEAD?
 *
 * MEMBERSHIP, not name-matching (review F-4). `git describe --tags --exact-match HEAD` prints ONE
 * tag when HEAD carries several, so a correct checkout whose HEAD also happens to carry, say, a
 * `kit` tag could be refused for naming the wrong one. `--points-at` lists them all and this asks
 * whether the pinned tag is in the list.
 *
 * `found` is what was actually there — the empty string when HEAD carries no tag, git's own stderr
 * when the path is not a checkout at all — and is quoted back in the refusal.
 */
export function checkoutIsAtTag(checkout: string, tag: string): { ok: boolean; found: string } {
  const r = spawnSync("git", ["-C", checkout, "tag", "--points-at", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, found: (r.stderr || r.stdout || "").trim() };
  const tags = (r.stdout || "").split("\n").map((t) => t.trim()).filter(Boolean);
  return { ok: tags.includes(tag), found: tags.join(", ") };
}

export async function buildWinter(opts: { checkout?: string; out?: string; allowUntagged?: boolean } = {}): Promise<string> {
  const checkout = resolve(opts.checkout ?? process.env.NORMA_WINTER_SDK_CHECKOUT ?? resolve(import.meta.dir, "../../winter-agent-sdk"));
  const out = resolve(opts.out ?? resolve(import.meta.dir, "../dist/winter"));
  if (!existsSync(resolve(checkout, "scripts/build-runtime.ts"))) throw new Error(`build-winter: no SDK checkout at ${checkout} (set NORMA_WINTER_SDK_CHECKOUT)`);
  const tag = `v${REQUIRED_WINTER_AGENT_SDK}`;
  const at = checkoutIsAtTag(checkout, tag);
  if (!at.ok && !opts.allowUntagged) throw new Error(`build-winter: ${checkout}'s HEAD carries '${at.found || "no tag"}', not ${tag}; check out the pinned tag (or pass --allow-untagged for a local experiment — it skips this gate entirely, wrong tags included, and never runs in CI)`);
  const r = spawnSync("bun", ["run", "scripts/build-runtime.ts", "--out", out], { cwd: checkout, encoding: "utf8", stdio: "inherit", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`build-winter: build-runtime.ts exited ${r.status}`);
  if (!existsSync(out)) throw new Error(`build-winter: ${out} was not produced`);
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2); const outIx = args.indexOf("--out");
  const out = await buildWinter({ out: outIx >= 0 ? args[outIx + 1] : undefined, allowUntagged: args.includes("--allow-untagged") });
  console.log(out);
}
