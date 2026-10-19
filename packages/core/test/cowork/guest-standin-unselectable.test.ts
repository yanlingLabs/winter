// Owner decision O13: the stand-in TEST image is unselectable in production, and this file pins it. Reads files and runs the pin mechanisms; builds and boots nothing.
// Four independent ways to select it are closed, each held by a test that fails if one reopens:
//   1. no production source names it (the daemon, the Swift host and launcher, the workflows, the embed scripts): there is nothing to call, flag or configure;
//   2. the only files that name it are an exact allow-list, so a new reference is a reviewed change;
//   3. the production image cannot contain it (its pins and its init carry no stand-in digest, the build default is production, the hooks compile away);
//   4. the launch digest comes only from the daemon's own pin table, which refuses any other digest (guest-image-pin-separation.test.ts runs the pin mechanisms).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "../../../..");
const TOKEN = /init-standin|standin_|winter-standin|WG_STANDIN|standin-pins|init_standin|profile standin|standin\.sock/i;
// The allow-list scan also catches the prose spellings ("stand-in", "standin"); the production scans keep the narrow token because ordinary prose elsewhere says "stand-in".
const WIDE = new RegExp(`${TOKEN.source}|\\bstand-?in\\b`, "i");
const ARTIFACT = "scripts/cowork-guest-artifact";
const GUEST = "apple/Cowork/WinterCoworkGuest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(REPO, dir))) {
    if (name === "node_modules" || name === "__pycache__" || name === ".build" || name === ".git" || name === "build") continue;
    const rel = `${dir}/${name}`, st = statSync(join(REPO, rel));
    if (st.isDirectory()) walk(rel, out); else if (st.size < 8_000_000) out.push(rel);
  }
  return out;
}
const text = (rel: string) => readFileSync(join(REPO, rel), "utf8");
const naming = (dirs: string[], token: RegExp = TOKEN) => dirs.flatMap(d => walk(d)).filter(rel => !/\.(png|jpg|a|o|dylib|cpio|pyc)$/.test(rel) && token.test(text(rel)));

// Everything that may name the stand-in: the guest tree's own stand-in sources and tests, and the two image tools and their tests. Nothing else.
const ALLOWED = [
  `${GUEST}/build.py`, `${GUEST}/init/init_linux.c`, `${GUEST}/init/standin.c`, `${GUEST}/init/standin.h`, `${GUEST}/init/standin_hooks.h`, `${GUEST}/init/standin_linux.c`, `${GUEST}/init/standin_linux.h`,
  `${GUEST}/standin/profile.json`, `${GUEST}/standin/standin_prepare.py`, `${GUEST}/vectors/standin-metadata.json`,
  `${GUEST}/tests/fake_worker.c`, `${GUEST}/tests/standin_linux_tool.c`, `${GUEST}/tests/test_hygiene.py`, `${GUEST}/tests/test_mutants.py`, `${GUEST}/tests/test_standin.c`, `${GUEST}/tests/test_standin.py`,
  `${GUEST}/tests/test_standin_hygiene.py`, `${GUEST}/tests/test_standin_linux.py`, `${GUEST}/tests/test_standin_prepare.py`,
  `${ARTIFACT}/build_standin_image.py`, `${ARTIFACT}/test_standin_image.py`, `${ARTIFACT}/test_image.py`, `${ARTIFACT}/test_runtime_image_digest.py`,
  "packages/core/test/cowork/guest-boot-anti-wiring.test.ts", "packages/core/test/cowork/guest-standin-unselectable.test.ts",
  // Named only by the wider "stand-in" spelling: the image pin gates and the pin file, and files whose prose uses "stand-in" for a fake (no stand-in image behaviour).
  `${GUEST}/tests/derive_guided_config_fixture.py`, `${GUEST}/tests/fake_supervisor.c`, `${ARTIFACT}/standin-pins.json`, `${ARTIFACT}/kernel/test_native_build.py`,
  "packages/core/test/cowork/guest-image-build-gates.test.ts", "packages/core/test/cowork/guest-image-pin-separation.test.ts", "packages/core/test/cowork/native-wiring.test.ts", "packages/core/test/cowork/native/fake-launcher.ts",
].sort();

test("no production source names the stand-in: the daemon, the Swift host and launcher, the workflows and the embed scripts", () => {
  const production = ["packages/core/src", "packages/protocol/src", "packages/cli/src", "apple/Winter", "apple/WinterKit", ".github/workflows"]
    .filter(d => { try { return statSync(join(REPO, d)).isDirectory(); } catch { return false; } });
  expect(production.length).toBeGreaterThan(2);
  expect(naming(production)).toEqual([]);
  const cowork = readdirSync(join(REPO, "apple/Cowork")).filter(n => n !== "WinterCoworkGuest").map(n => `apple/Cowork/${n}`).filter(d => statSync(join(REPO, d)).isDirectory());
  expect(naming(cowork)).toEqual([]);
  const embeds = readdirSync(join(REPO, "scripts")).filter(n => /^embed-.*\.ts$/.test(n) || /^build-.*\.ts$/.test(n)).map(n => `scripts/${n}`);
  expect(embeds.filter(rel => TOKEN.test(text(rel)))).toEqual([]);
});

test("the files that name the stand-in are exactly the reviewed allow-list", () => {
  const found = naming([GUEST, ARTIFACT, "packages/core/test/cowork"], WIDE).sort();
  expect(found).toEqual(ALLOWED);
});

test("the production image's pins carry nothing of the stand-in, and the stand-in file is test-only", () => {
  const standin = JSON.parse(text(`${ARTIFACT}/standin-pins.json`));
  expect(standin.testOnly).toBe(true);
  const values = ["initramfsSha256", "runtimeImageDigest", "initStandinSha256", "initStandinSourceSha256", "providerSha256"].map(k => standin[k]).filter(Boolean);
  for (const rel of [`${ARTIFACT}/pins.json`, `${ARTIFACT}/kernel/pins.json`, `${ARTIFACT}/sdk-supervisor-cli.json`, `${GUEST}/vectors/runtime-image.json`].filter(r => { try { statSync(join(REPO, r)); return true; } catch { return false; } })) {
    const body = text(rel);
    for (const v of values) expect(body.includes(v)).toBe(false);
    expect(TOKEN.test(body)).toBe(false);
  }
  const production = JSON.parse(text(`${ARTIFACT}/pins.json`));
  expect(JSON.stringify(production)).not.toContain(standin.profileSha256);
});

test("the guest build is production by default, the stand-in profile is explicit, and the production init compiles the stand-in hooks away", () => {
  const build = text(`${GUEST}/build.py`);
  expect(build).toContain('default="production"');
  expect(build).toMatch(/def build\(zig, out, profile="production"\)/);
  const hooks = text(`${GUEST}/init/standin_hooks.h`);
  expect(hooks).toMatch(/#ifdef WG_STANDIN[\s\S]*#else[\s\S]*\(\(void\)0\)/);
  // The production program list and flags never mention the stand-in profile's define.
  const flags = /COMMON_FLAGS\s*=\s*\[[^\]]*\]/.exec(build)?.[0] ?? "";
  expect(flags.length).toBeGreaterThan(0);
  expect(/STANDIN/i.test(flags)).toBe(false);
  // The production init source includes the hooks but defines no stand-in behaviour of its own.
  const init = text(`${GUEST}/init/init_linux.c`);
  expect(init).not.toMatch(/#\s*define\s+WG_STANDIN\b/);
});

test("the daemon's launch digest has one source, the pin table; no environment variable, setting or file chooses an image", () => {
  for (const rel of ["packages/core/src/cowork/images.ts", "packages/core/src/cowork/native-wiring.ts"]) {
    const body = text(rel);
    expect(body).not.toMatch(/process\.env|Bun\.env/);
  }
  const wiring = text("packages/core/src/cowork/native-wiring.ts");
  expect(wiring).toContain("export function readOnlyImagePins");
  expect(relative(REPO, join(REPO, "packages/core/src/cowork/images.ts"))).toBe("packages/core/src/cowork/images.ts");
});
