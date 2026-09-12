// Builds the `winter` runtime binary from the SDK checkout AT THE PINNED TAG (P8b-2). The platform
// package is private and not on npm, and a compiled $bunfs daemon cannot createRequire it anyway,
// so the daemon always receives an explicit path. This script is how dev, tests and CI get one.
//   bun run build:winter                     # -> dist/winter (from ../winter-agent-sdk or $NORMA_WINTER_SDK_CHECKOUT)
//   bun run build:winter --out <path>
//   bun run build:winter --allow-untagged    # LOCAL EXPERIMENTS ONLY — never in CI
//   bun run build:winter --sign <identity>   # P8d-14: sign the freshly-built dist/winter
// Refuses unless the checkout's HEAD carries the tag v<REQUIRED_WINTER_AGENT_SDK> (a build from any
// other commit is a different binary than the peer the daemon is pinned to).
//
// `--allow-untagged` is named narrower than it is (review F-6): it skips the gate ENTIRELY, so it
// admits a checkout sitting on the WRONG tag just as readily as an untagged one. It exists for
// bisecting an SDK change locally. A binary built with it is not the pinned peer, must never be
// uploaded as one, and no CI path passes it.
//
// P8d-14 (8c carry): a dev `dist/winter` is ad-hoc-signed by `bun build --compile` itself
// (`Identifier=a.out`, controller measurement M2), and an ad-hoc signature's identity changes on
// every rebuild — which invalidates the Keychain ACL a prior `com.norma.core` consent grant was
// scoped to, so a rebuilt dev binary re-prompts for EVERY credential item on its next run
// (CLAUDE.md's "FIRST RUN AFTER A REBUILD" trap). `--sign <identity>` (or env
// `NORMA_WINTER_SIGN_IDENTITY`) re-signs the freshly-built binary with a STABLE identifier
// (`com.norma.winter` — the same identifier the Release embed step signs with, P8d-2) so the ACL
// survives rebuilds. `-` (ad-hoc) is explicitly ALLOWED here — this is a dev convenience, not the
// release gate, and an ad-hoc identity still gets the stable `--identifier`, which is the part
// that actually fixes the Keychain-reprompt trap; only the release pipeline requires a REAL team
// identity (release.ts's own signing checks).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REQUIRED_WINTER_AGENT_SDK } from "../packages/core/src/runtime-sdk/versions";

/** P8d-14: `codesign --force --sign <identity> --identifier com.norma.winter --options runtime
 *  --timestamp <path>` — the same identifier/flags the Release "Embed runtimes" script uses
 *  (P8d-2), so `codesign -dvv` on a dev-signed `dist/winter` and a Release-embedded one both show
 *  `Identifier=com.norma.winter`. Exported so the test can assert the exact argv without shelling
 *  out to a real `codesign` in a fixture. */
export function signWinterArgs(identity: string, path: string): string[] {
  return ["--force", "--sign", identity, "--identifier", "com.norma.winter", "--options", "runtime", "--timestamp", path];
}

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

export async function buildWinter(opts: { checkout?: string; out?: string; allowUntagged?: boolean; sign?: string } = {}): Promise<string> {
  const checkout = resolve(opts.checkout ?? process.env.NORMA_WINTER_SDK_CHECKOUT ?? resolve(import.meta.dir, "../../winter-agent-sdk"));
  const out = resolve(opts.out ?? resolve(import.meta.dir, "../dist/winter"));
  if (!existsSync(resolve(checkout, "scripts/build-runtime.ts"))) throw new Error(`build-winter: no SDK checkout at ${checkout} (set NORMA_WINTER_SDK_CHECKOUT)`);
  const tag = `v${REQUIRED_WINTER_AGENT_SDK}`;
  const at = checkoutIsAtTag(checkout, tag);
  if (!at.ok && !opts.allowUntagged) throw new Error(`build-winter: ${checkout}'s HEAD carries '${at.found || "no tag"}', not ${tag}; check out the pinned tag (or pass --allow-untagged for a local experiment — it skips this gate entirely, wrong tags included, and never runs in CI)`);
  const r = spawnSync("bun", ["run", "scripts/build-runtime.ts", "--out", out], { cwd: checkout, encoding: "utf8", stdio: "inherit", timeout: 300_000 });
  if (r.status !== 0) throw new Error(`build-winter: build-runtime.ts exited ${r.status}`);
  if (!existsSync(out)) throw new Error(`build-winter: ${out} was not produced`);
  const identity = opts.sign ?? process.env.NORMA_WINTER_SIGN_IDENTITY;
  if (identity) {
    const cs = spawnSync("codesign", signWinterArgs(identity, out), { encoding: "utf8", stdio: "inherit" });
    if (cs.status !== 0) throw new Error(`build-winter: codesign exited ${cs.status}`);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const ix = args.indexOf(name); return ix >= 0 ? args[ix + 1] : undefined; };
  const out = await buildWinter({ out: flag("--out"), allowUntagged: args.includes("--allow-untagged"), sign: flag("--sign") });
  console.log(out);
}
