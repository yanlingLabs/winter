// Builds the `winter` runtime binary from the SDK checkout AT THE PINNED TAG (P8b-2). The platform
// package is private and not on npm, and a compiled $bunfs daemon cannot createRequire it anyway,
// so the daemon always receives an explicit path. This script is how dev, tests and CI get one.
//   bun run build:winter                # -> dist/winter (from ../winter-agent-sdk or $NORMA_WINTER_SDK_CHECKOUT)
//   bun run build:winter --out <path>
// Refuses unless the checkout's HEAD is exactly tag v<REQUIRED_WINTER_AGENT_SDK> (a build from any
// other commit is a different binary than the peer the daemon is pinned to).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_WINTER_AGENT_SDK } from "../packages/core/src/runtime-sdk/versions";

export function checkoutIsAtTag(checkout: string, tag: string): { ok: boolean; describe: string } {
  const r = spawnSync("git", ["-C", checkout, "describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" });
  const describe = (r.stdout || r.stderr || "").trim();
  return { ok: r.status === 0 && describe === tag, describe };
}

export async function buildWinter(opts: { checkout?: string; out?: string; allowUntagged?: boolean } = {}): Promise<string> {
  const checkout = resolve(opts.checkout ?? process.env.NORMA_WINTER_SDK_CHECKOUT ?? resolve(import.meta.dir, "../../winter-agent-sdk"));
  const out = resolve(opts.out ?? resolve(import.meta.dir, "../dist/winter"));
  if (!existsSync(resolve(checkout, "scripts/build-runtime.ts"))) throw new Error(`build-winter: no SDK checkout at ${checkout} (set NORMA_WINTER_SDK_CHECKOUT)`);
  const tag = `v${REQUIRED_WINTER_AGENT_SDK}`;
  const at = checkoutIsAtTag(checkout, tag);
  if (!at.ok && !opts.allowUntagged) throw new Error(`build-winter: ${checkout} is at '${at.describe}', not ${tag}; check out the pinned tag (or pass --allow-untagged for a local experiment — never in CI)`);
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
