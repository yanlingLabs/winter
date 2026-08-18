#!/usr/bin/env bun
/**
 * The from-source reproducibility recipe for the artifact scripts/fetch-libreoffice.ts vendors
 * (a headless, macOS arm64 LibreOffice product-set) -- as an EXECUTABLE script, not prose docs,
 * so the exact commands can never silently drift from what a markdown writeup claims. This is
 * the "documented, not run in CI" half of Task 1: it exists to be read, smoke-parsed (`--help`
 * or the no-args/`--dry-run` default, both side-effect-free), and someday actually run by a
 * human with hours, ~60GB free disk, and AC power -- NOT invoked by any automation, and NOT run
 * as part of this task (see .superpowers/sdd/2026-08-18-office-plumbing/task-1v2-report.md).
 *
 * Every fact below is transcribed from two primary sources, both in this repo:
 *   .superpowers/sdd/2026-08-18-office-plumbing/svp-probe-report.md   (recon, L0-L4 build phase)
 *   .superpowers/sdd/2026-08-18-office-plumbing/trim-gate-report.md   (v1->v2 trim, product-set assembly)
 * Re-read those for the evidence and reasoning behind each step; this file carries only the
 * actions, in the order they were actually run.
 *
 * --- The six steps, in order ---
 *   1. clone       -- LibreOffice/core, pinned commit, no depth-1 shortcut (a specific commit
 *                      needs to be reachable, and a shallow clone of an arbitrary historical SHA
 *                      is not guaranteed to work without --depth-with-a-date-cutoff gymnastics
 *                      the original probe didn't need -- it cloned master fresh and was already
 *                      at this commit).
 *   2. configure    -- MAKE=gmake-steered autogen.sh with the 32-flag v2 recipe (verbatim from
 *                      trim-gate-report.md). Do NOT add --disable-skia -- see the constant's own
 *                      comment for why that specific flag fails to compile on this platform.
 *   3. build        -- gmake gb_SUPPRESS_TESTS=T. Hours. No progress output beyond gmake's own.
 *   4. closure      -- runs build-libreoffice-closure-recipe.sh (a byte-for-byte copy of the
 *                      probe's own build-product-set-dylibs.sh, hash-pinned below) against a
 *                      dyld-traced run of the six gate fixtures plus one otool -L safety-net
 *                      pass, producing product-set/Frameworks/.
 *   5. fontconfig   -- writes a standalone fontconfig-workaround/fonts.conf (three <dir>
 *                      entries) NEXT TO product-set/, not baked into it -- the shipped
 *                      product-set/Resources/config/fontconfig/fonts.conf is intentionally left
 *                      untouched (matches what was actually verified: applied via the
 *                      FONTCONFIG_FILE env var at runtime, zero build-system patches). Baking it
 *                      into ExternalPackage_fontconfig_data.mk instead is a real, un-taken
 *                      option recon flagged -- see FONTCONFIG note below.
 *   6. licenses     -- copies the license text LICENSES/MANIFEST.md cites out of
 *                      core/workdir/UnpackedTarball/<project>/ into <out>/LICENSES/.
 *
 * Packaging (tar.zst) and uploading the GitHub release asset are deliberately NOT steps here --
 * those are one-time release-engineering actions a human decided to take this session (see the
 * report), not part of "reproduce the engine." `--print-package-command` prints the exact
 * packaging command as a convenience, but never runs it.
 *
 * --- Prerequisites (Homebrew), recorded from the actual run, not guessed ---
 * Explicit installs: autoconf, automake, nasm, gnu-sed, gperf (Apple ships 3.0.3; LO's configure
 * hard-requires >=3.1), meson, cmake (bundled harfbuzz + other externals build meson+ninja).
 * Pulled in transitively by those: m4, ninja, ca-certificates, python@3.14 -- no separate
 * install needed. Already present on the probe machine but REQUIRED and NOT auto-installed here
 * (install manually if absent): GNU make as `gmake` (Apple ships 3.81, last GPLv2 release,
 * licensing-frozen; LO's configure requires >=4.2 -- `brew install make`), and
 * pkg-config/pkgconf (`brew install pkg-config`).
 *
 * --- FONTCONFIG note (the un-taken build-system-patch option) ---
 * The runtime FONTCONFIG_FILE workaround this script reproduces is what was actually verified
 * (trim-gate-report.md Deliverable 3). Baking the same three <dir> entries into
 * external/fontconfig/ExternalPackage_fontconfig_data.mk instead (so a stock product-set needs
 * no runtime env var) is a real option the recon identified and NOBODY has implemented or
 * tested -- doing so would be this build's first-ever source-adjacent patch (the "zero source
 * patches" fact holds only for the code compiled INTO the dylibs, and even
 * ExternalPackage_fontconfig_data.mk is LO's own build-system glue, not upstream fontconfig's
 * source -- but it is still new, untested territory). Left as a documented option, not
 * implemented, so this script's "zero patches" claim stays true to what was actually proven.
 *
 * Usage:
 *   bun run scripts/build-libreoffice.ts                 (default: print the plan, do nothing)
 *   bun run scripts/build-libreoffice.ts --help           (usage only)
 *   bun run scripts/build-libreoffice.ts --dry-run         (same as no args, explicit)
 *   bun run scripts/build-libreoffice.ts --execute --workdir <dir> --out <dir> --core <checkout>
 *     (ACTUALLY runs steps 1-6 in sequence. Hours. Never invoked by this task or by any CI --
 *     see the header above. --core lets steps 5/6 target an existing checkout instead of
 *     re-cloning; steps 1-4 still clone fresh into --workdir unless --skip-clone is also given.)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./version-lib";

// ---------------------------------------------------------------------------
// Pinned facts. Transcribed verbatim from the two SDD reports cited above -- do not hand-edit
// without re-reading them; a drifted flag or commit here is worse than no recipe at all.
// ---------------------------------------------------------------------------
const LIBREOFFICE_CORE_REPO_URL = "https://github.com/LibreOffice/core";
const LIBREOFFICE_CORE_COMMIT = "11482c8f71bc76ed6260bc03b1576a52a788ab4f";

const GMAKE_PATH = "/opt/homebrew/bin/gmake";

const BREW_PACKAGES_TO_INSTALL = ["autoconf", "automake", "nasm", "gnu-sed", "gperf", "meson", "cmake"];
const BREW_PACKAGES_REQUIRED_BUT_NOT_AUTO_INSTALLED = ["make", "pkg-config"]; // must resolve to gmake>=4.2 / pkgconf -- probe machine already had both

// The v2 trimmed+merged configure line (trim-gate-report.md, "V2 configure flags + L0/L2
// evidence"). Do NOT add --disable-skia: vcl/osx/salframeview.mm and vcl/osx/salgdiutils.cxx
// reference SkiaHelper/AquaSkiaSalGraphicsImpl/CAMetalLayer unconditionally (no #if
// HAVE_FEATURE_SKIA guard) -- the Aqua vclplug is always compiled alongside svp on macOS (there
// is no svp-only mac backend yet), so that flag fails with 8 clang errors across those two files.
const CONFIGURE_FLAGS = [
  "--enable-headless",
  "--without-system-fontconfig",
  "--without-system-freetype",
  "--without-java",
  "--disable-firebird-sdbc",
  "--without-help",
  "--without-doxygen",
  "--disable-odk",
  "--disable-online-update",
  "--without-junit",
  "--enable-bogus-pkg-config",
  "--enable-mergelibs=more",
  "--disable-python",
  "--disable-postgresql-sdbc",
  "--disable-mariadb-sdbc",
  "--disable-pdfimport",
  "--disable-cups",
  "--disable-opencl",
  "--disable-opengl",
  "--disable-librelogo",
  "--disable-lotuswordpro",
  "--disable-sdremote",
  "--disable-report-builder",
  "--disable-cli",
  "--disable-extension-update",
  "--disable-coinmp",
  "--disable-dbus",
  "--disable-gio",
  "--disable-dconf",
  "--without-webdav",
  "--with-galleries=no",
  "--enable-option-checking=fatal",
];

const BUILD_ARGS = ["gb_SUPPRESS_TESTS=T"];

// build-libreoffice-closure-recipe.sh is a byte-for-byte copy of the probe workspace's
// build-product-set-dylibs.sh (kept as a real sibling .sh file, not inlined as a JS template
// string, specifically BECAUSE it contains bash `${var#pattern}` parameter expansion that would
// collide with JS template-literal `${...}` interpolation if embedded that way -- a landmine
// caught during review, not a style preference). Hash-pinned so drift between this copy and
// VERSION-PIN's own recorded CLOSURE_RECIPE_SHA256 is a loud failure, not a silent one.
const CLOSURE_RECIPE_SCRIPT_PATH = join(ROOT, "scripts", "build-libreoffice-closure-recipe.sh");
const CLOSURE_RECIPE_SHA256 = "dfe3b5d45770ca314f01da659b8b1a8c4c6ebcb7cfd76a6ee20312ce988d6ae5";

// The three <dir> entries recon found missing from the shipped fontconfig/fonts.conf (recon §4;
// re-verified in trim-gate-report.md Deliverable 3: without these, a macOS system font request
// like "Helvetica Neue" silently substitutes a bundled fallback serif instead of erroring).
const FONTCONFIG_DIRS = ["/System/Library/Fonts", "/Library/Fonts", "~/Library/Fonts"];

function fontconfigWorkaroundXml(cacheDir: string): string {
  const dirLines = FONTCONFIG_DIRS.map((d) => `  <dir>${d}</dir>`).join("\n");
  return (
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<!--\n` +
    `  Runtime fontconfig workaround (NOT baked into product-set/Resources/config/fontconfig/) --\n` +
    `  point FONTCONFIG_FILE at this file when launching an embedder. See this script's header\n` +
    `  comment ("FONTCONFIG note") for the un-taken build-system-patch alternative.\n-->\n` +
    `<fontconfig>\n${dirLines}\n  <cachedir>${cacheDir}</cachedir>\n</fontconfig>\n`
  );
}

// Sourced from core/workdir/UnpackedTarball/<project>/{COPYING,LICENSE}* -- exactly the files
// svp-probe-report.md's "Deliverable 4: licensing inventory" table cites, one entry per
// LICENSES/ subdirectory this recipe produces. Mirrors LICENSES/MANIFEST.md's own table; keep
// the two in sync if either changes.
const LICENSE_SOURCES: Record<string, string[]> = {
  cairo: ["COPYING", "COPYING-LGPL-2.1", "COPYING-MPL-1.1"],
  fontconfig: ["COPYING"],
  freetype: ["LICENSE.TXT"],
  icu: ["LICENSE"],
  skia: ["LICENSE"],
  curl: ["COPYING"],
  "nss/nss": ["COPYING"], // -> LICENSES/nss/
  "nss/nspr": ["LICENSE"], // -> LICENSES/nspr/
  liblangtag: ["COPYING"],
  lcms2: ["LICENSE"],
  pixman: ["COPYING"],
  raptor: ["LICENSE-2.0.txt", "COPYING.LIB", "COPYING"],
  rasqal: ["LICENSE-2.0.txt", "COPYING.LIB", "COPYING"],
  redland: ["LICENSE-2.0.txt", "COPYING.LIB", "COPYING"],
  liborcus: ["LICENSE"],
  clucene: ["COPYING"],
  gpgmepp: ["COPYING", "COPYING.LESSER"],
  libassuan: ["COPYING", "COPYING.LIB"],
  "libgpg-error": ["COPYING", "COPYING.LIB"],
  libmwaw: ["COPYING.LGPL", "COPYING.MPL"],
  libetonyek: ["COPYING"],
  libstaroffice: ["COPYING.LGPL", "COPYING.MPL"],
  libwpd: ["COPYING.LGPL", "COPYING.MPL"],
  libwpg: ["COPYING.LGPL", "COPYING.MPL"],
  libwps: ["COPYING.LGPL", "COPYING.MPL"],
  libodfgen: ["COPYING.LGPL", "COPYING.MPL"],
  librevenge: ["COPYING.LGPL", "COPYING.MPL"],
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const HELP = argv.includes("--help") || argv.includes("-h");
const EXECUTE = argv.includes("--execute");
const arg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WORKDIR = arg("--workdir");
const OUTDIR = arg("--out");
const CORE_PATH = arg("--core");

function printHelp(): void {
  console.log(
    `build-libreoffice.ts -- from-source reproducibility recipe for the headless macOS LibreOffice product-set.\n\n` +
      `  (no args)                Print the full plan (steps + exact commands). No side effects.\n` +
      `  --dry-run                Same as no args, explicit.\n` +
      `  --help, -h               This message.\n` +
      `  --execute                ACTUALLY run steps 1-6. Hours. Requires --workdir and --out;\n` +
      `                           --core <checkout> reuses an existing clone for steps 5/6\n` +
      `                           instead of re-cloning (steps 1-4 still need --workdir).\n\n` +
      `Pinned: LibreOffice/core @ ${LIBREOFFICE_CORE_COMMIT}\n` +
      `Read this file's header comment before ever passing --execute.\n`,
  );
}

// ---------------------------------------------------------------------------
// Step plan (printed in dry-run/default mode; executed in order under --execute).
// ---------------------------------------------------------------------------
interface StepCtx {
  workdir: string;
  outdir: string;
  corePath: string; // == workdir/core once cloned, or --core if given
}

interface Step {
  name: string;
  describe(ctx: { workdir: string; outdir: string; corePath: string }): string[];
  execute(ctx: StepCtx): void;
}

const steps: Step[] = [
  {
    name: "1. clone",
    describe: ({ workdir, corePath }) => [
      `git clone ${LIBREOFFICE_CORE_REPO_URL} ${corePath}`,
      `git -C ${corePath} checkout ${LIBREOFFICE_CORE_COMMIT}`,
      `(workdir: ${workdir})`,
    ],
    execute: (ctx) => {
      if (existsSync(ctx.corePath)) {
        console.log(`  ${ctx.corePath} already exists -- skipping clone, checking out pinned commit only.`);
      } else {
        run("git", ["clone", LIBREOFFICE_CORE_REPO_URL, ctx.corePath], { inherit: true });
      }
      run("git", ["-C", ctx.corePath, "checkout", LIBREOFFICE_CORE_COMMIT], { inherit: true });
    },
  },
  {
    name: "2. configure",
    describe: ({ corePath }) => [
      `brew install ${BREW_PACKAGES_TO_INSTALL.join(" ")}`,
      `  (required but not auto-installed here -- verify present: ${BREW_PACKAGES_REQUIRED_BUT_NOT_AUTO_INSTALLED.join(", ")})`,
      `cd ${corePath} && MAKE=${GMAKE_PATH} ./autogen.sh \\`,
      ...CONFIGURE_FLAGS.map((f, i) => `  ${f}${i < CONFIGURE_FLAGS.length - 1 ? " \\" : ""}`),
    ],
    execute: (ctx) => {
      console.log(`  brew install ${BREW_PACKAGES_TO_INSTALL.join(" ")}`);
      run("brew", ["install", ...BREW_PACKAGES_TO_INSTALL], { inherit: true });
      for (const pkg of BREW_PACKAGES_REQUIRED_BUT_NOT_AUTO_INSTALLED) {
        console.log(`  (verify present, not auto-installed: ${pkg})`);
      }
      run("./autogen.sh", CONFIGURE_FLAGS, { cwd: ctx.corePath, inherit: true, env: { MAKE: GMAKE_PATH } });
    },
  },
  {
    name: "3. build",
    describe: ({ corePath }) => [`cd ${corePath} && gmake ${BUILD_ARGS.join(" ")}   # hours`],
    execute: (ctx) => {
      run(GMAKE_PATH, BUILD_ARGS, { cwd: ctx.corePath, inherit: true });
    },
  },
  {
    name: "4. closure",
    describe: ({ outdir }) => [
      `(sha256 of build-libreoffice-closure-recipe.sh must equal ${CLOSURE_RECIPE_SHA256})`,
      `run the six gate fixtures with GATE_DYLD_TRACE=1 to populate dyld-traces/`,
      `build-libreoffice-closure-recipe.sh   # -> ${outdir}/product-set/Frameworks/`,
    ],
    execute: (ctx) => {
      const actual = createHash("sha256").update(readFileSync(CLOSURE_RECIPE_SCRIPT_PATH)).digest("hex");
      if (actual !== CLOSURE_RECIPE_SHA256) {
        throw new Error(
          `build-libreoffice-closure-recipe.sh has drifted from its pin\n` +
            `  expected: ${CLOSURE_RECIPE_SHA256}\n  actual:   ${actual}\n` +
            `Investigate before proceeding -- this script's closure step assumes the probe's exact,\n` +
            `proven dyld-trace-plus-otool-safety-net method, not whatever this file currently says.`,
        );
      }
      console.log(
        `  build-libreoffice-closure-recipe.sh hash OK. This step requires dyld-traces/ already\n` +
          `  populated by tracing the six gate fixtures (GATE_DYLD_TRACE=1, see run-gate.sh in the\n` +
          `  probe report) against ${ctx.corePath}/instdir first -- not automated here, since it\n` +
          `  depends on the fixture-running harness (spikes/office-lok-gate/), a separate concern\n` +
          `  from this build recipe. Run build-libreoffice-closure-recipe.sh by hand once traces exist.`,
      );
    },
  },
  {
    name: "5. fontconfig",
    describe: ({ outdir }) => [
      `write ${join(outdir, "fontconfig-workaround", "fonts.conf")}`,
      `  <dir> entries: ${FONTCONFIG_DIRS.join(", ")}`,
      `  (NOT baked into product-set/Resources/config/fontconfig/fonts.conf -- see FONTCONFIG note above)`,
    ],
    execute: (ctx) => {
      const dir = join(ctx.outdir, "fontconfig-workaround");
      mkdirSync(dir, { recursive: true });
      const cacheDir = join(dir, "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(dir, "fonts.conf"), fontconfigWorkaroundXml(cacheDir));
      console.log(`  wrote ${join(dir, "fonts.conf")}`);
    },
  },
  {
    name: "6. licenses",
    describe: ({ outdir }) => [
      `copy core/workdir/UnpackedTarball/<project>/{COPYING,LICENSE}* -> ${join(outdir, "LICENSES")}/<project>/`,
      `  (${Object.keys(LICENSE_SOURCES).length} projects, per LICENSES/MANIFEST.md's table)`,
      `also copy product-set/Resources/{LICENSE,LICENSE.html,NOTICE} -> LICENSES/libreoffice-core/`,
    ],
    execute: (ctx) => {
      const licDir = join(ctx.outdir, "LICENSES");
      for (const [project, files] of Object.entries(LICENSE_SOURCES)) {
        // "nss/nss" -> LICENSES/nss/, "nss/nspr" -> LICENSES/nspr/ (see LICENSE_SOURCES comment)
        const destName = project.includes("/") ? project.split("/")[1]! : project;
        const destDir = join(licDir, destName);
        mkdirSync(destDir, { recursive: true });
        for (const f of files) {
          const src = join(ctx.corePath, "workdir", "UnpackedTarball", project, f);
          if (!existsSync(src)) throw new Error(`missing license source: ${src}`);
          execFileSync("cp", [src, destDir]);
        }
      }
      const coreLicDir = join(licDir, "libreoffice-core");
      mkdirSync(coreLicDir, { recursive: true });
      const instdirResources = join(ctx.corePath, "instdir", "LibreOfficeDev.app", "Contents", "Resources");
      for (const f of ["LICENSE", "LICENSE.html", "NOTICE"]) {
        const src = join(instdirResources, f);
        if (existsSync(src)) execFileSync("cp", [src, coreLicDir]);
      }
      console.log(`  wrote ${Object.keys(LICENSE_SOURCES).length + 1} LICENSES/ subdirectories at ${licDir}`);
    },
  },
];

function run(cmd: string, args: string[], opts: { cwd?: string; inherit?: boolean; env?: Record<string, string> } = {}): void {
  execFileSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.inherit ? "inherit" : undefined,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
if (HELP) {
  printHelp();
  process.exit(0);
}

if (!EXECUTE) {
  console.log(
    `build-libreoffice.ts -- PLAN ONLY (no --execute given; this is also the default with no\n` +
      `flags at all -- see --help). Pinned: LibreOffice/core @ ${LIBREOFFICE_CORE_COMMIT}\n` +
      `(${LIBREOFFICE_CORE_REPO_URL}).\n`,
  );
  const placeholderCtx = { workdir: "<workdir>", outdir: "<out>", corePath: "<workdir>/core" };
  for (const step of steps) {
    console.log(`\n${step.name}`);
    for (const line of step.describe(placeholderCtx)) console.log(`  ${line}`);
  }
  console.log(
    `\nPackaging (not a step here -- one-time release engineering, run by hand when actually\n` +
      `re-cutting the vendored artifact):\n` +
      `  COPYFILE_DISABLE=1 tar -cf - -C <out> product-set LICENSES VERSION-PIN | zstd -T0 -19 -o <name>.tar.zst\n`,
  );
  process.exit(0);
}

// --execute path. Never invoked by this task -- see header comment.
if (!WORKDIR || !OUTDIR) {
  fail("--execute requires --workdir <dir> and --out <dir>. See --help.");
}
function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}\n`);
  process.exit(1);
}
const ctx: StepCtx = {
  workdir: WORKDIR!,
  outdir: OUTDIR!,
  corePath: CORE_PATH ?? join(WORKDIR!, "core"),
};
mkdirSync(ctx.workdir, { recursive: true });
mkdirSync(ctx.outdir, { recursive: true });
console.log(`Executing build-libreoffice.ts against workdir=${ctx.workdir} out=${ctx.outdir} core=${ctx.corePath}\n`);
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  step.execute(ctx);
}
console.log(`\nDone. See ${ctx.outdir} for product-set inputs (Frameworks/ from step 4 must be run manually -- see its own note).`);
