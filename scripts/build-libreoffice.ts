#!/usr/bin/env bun
/**
 * The from-source reproducibility recipe for the artifact scripts/fetch-libreoffice.ts vendors
 * (a headless, macOS arm64 LibreOffice product-set) -- as an EXECUTABLE script, not prose docs,
 * so the exact commands can never silently drift from what a markdown writeup claims. This is
 * the "documented, not run in CI" half of Task 1: it exists to be read, smoke-parsed (`--help`
 * or the no-args/`--dry-run` default, both side-effect-free), and someday actually run by a
 * human with hours, ~60GB free disk, and AC power -- NOT invoked by any automation, and NOT run
 * as part of this task (see git history for that work).
 *
 * Every fact below is transcribed from primary sources recorded during development -- private
 * SDD process docs, not committed in this repo. See the release notes at
 * https://github.com/yanlingLabs/norma/releases/tag/vendor-libreoffice-20260819 and git history
 * for the evidence and reasoning behind each step; this file carries only the actions, in the
 * order they were actually run.
 *
 * --- RE-CUT (privacy scrub), 2026-08-19 ---
 * The first cut of this artifact (vendor-libreoffice-20260818) leaked the builder's macOS
 * account name in plaintext: 152 `__FILE__`-literal occurrences across 8 of 66 dylibs (compiled
 * in via absolute build paths, because a plain `./configure && make` never saw this repo's own
 * `-ffile-prefix-map`/`-oso_prefix` privacy flags -- those only cover project.yml's Swift/ObjC++
 * targets) plus two LibreOffice-native identity fields, `Resources/versionrc`'s `Vendor=` and
 * `Resources/registry/main.xcd`'s `ooVendor`, which default to `$USER`/`id -u -n` when
 * `--with-vendor` is unset (configure.ac ~15626-15645) -- exactly what shipped. That asset was
 * deleted from GitHub; this cut fixes the root cause with four changes rather than trying to
 * scrub bytes after the fact:
 *   - CC/CXX gain `-ffile-prefix-map`/`-fdebug-prefix-map` for BUILDDIR only (deliberately NOT
 *     $HOME -- see the dedicated note at this function's definition below for why a second,
 *     $HOME-sourced map turned out to be a leak vector in its own right, found and reverted this
 *     session) -- appended to config_host.mk's ALREADY-configured CC/CXX lines in a NEW step 3, run AFTER step 2
 *     (configure) completes, never as a CC/CXX environment override passed INTO `./autogen.sh`.
 *     This post-configure timing is not a style choice: this platform's configure.ac has
 *     `if test -z "$save_CC"; then ... fi` guarding its ENTIRE macOS toolchain block (CC, CXX,
 *     AND separately AR/NM/STRIP/LIBTOOL/RANLIB, all via `xcrun -find`) -- a non-empty
 *     user-supplied CC/CXX skips that whole block, silently dropping
 *     `-target arm64-apple-macos -mmacosx-version-min=11.0 -isysroot <SDK>` (and letting
 *     AR/NM/STRIP/RANLIB fall back to bare, PATH-resolved names). Confirmed empirically (not
 *     assumed) by reconfiguring both ways and diffing config_host.mk's `export CC=`/`export AR=`
 *     etc. lines against a known-good prior run -- costly to discover after the fact, since a
 *     wrong guess here means re-running an hours-long build. Appending post-configure sidesteps
 *     the gate entirely: `./autogen.sh` runs in its completely default, already-proven mode, and
 *     only the two `export CC=`/`export CXX=` LINES in the already-generated config_host.mk get a
 *     literal string append (this file's own steps still print the equivalent shell form for a
 *     human running by hand).
 *   - `-Wl,-oso_prefix,...` (this repo's own project.yml Release-config precedent for the Mach-O
 *     N_OSO-debug-map leak class -- see privacy-scrub-public.md/release-0-2-002-shipped.md) was
 *     TRIED and REVERTED: baked into CC/CXX alongside the prefix-map flags, it broke cairo's
 *     externally-built meson project with genuine C type errors in cairo-contour.c (`invalid
 *     operands to binary expression ('cairo_int64_t' and 'cairo_int64_t')`, etc.) -- meson's own
 *     compiler-capability probe compiles trip `-Wl,...: 'linker' input unused
 *     [-Wunused-command-line-argument]` on every pure-compile invocation (a `-Wl` flag is legitimately
 *     inert until link time), and something in that probing path reads the presence of this
 *     warning as "capability absent," flipping cairo's `HAVE_UINT64_T`-equivalent detection to
 *     the wrong answer and corrupting its 64-bit-integer emulation choice. Confirmed by isolated
 *     retry: removing only the `-Wl,-oso_prefix` pair (keeping the two `-*-prefix-map` pairs)
 *     let cairo rebuild clean with no other change. It is NOT part of the final flag set here.
 *   - `--with-vendor=Norma` replaces the default $USER-derived OOO_VENDOR.
 *   - The chosen `--workdir` MUST resolve to a path containing NO identifying substrings (no
 *     account name, no hostname fragment) -- the prefix-map flags remap the compiler's OWN
 *     `__FILE__`/DWARF path embeddings, but do NOT touch arbitrary `-D` preprocessor defines a
 *     module's own gbuild makefile bakes in from `$(SRCDIR)`/`$(BUILDDIR)`. Measured, not
 *     assumed: `sal/Library_sal.mk` has `-DSRCDIR="\"$(SRCDIR)\""`, consumed by
 *     `sal/osl/all/log.cxx` to strip the source root from log messages at runtime -- a canary
 *     rebuild of just that one file, AFTER the prefix-map fix above, still embedded the
 *     builder's account name verbatim, because it never went through `__FILE__` or DWARF at all;
 *     it is a plain string literal from the command line. Patching every such makefile across
 *     this ~40k-line build system is neither exhaustive-searchable nor compatible with the
 *     zero-source-patches constraint (Global Constraint, binding per VERSION-PIN) -- the only
 *     complete fix is for the string these mechanisms all ultimately copy (SRCDIR/BUILDDIR
 *     itself) to never have carried the identity in the first place. Step 6's gate is what
 *     actually enforces this if a future workdir choice violates it -- it does not special-case
 *     the SRCDIR mechanism, it just re-scans the finished bytes.
 *   - A new step 6 byte-scans the entire assembled product-set/ for the builder's account name,
 *     $HOME's basename, the machine hostname, and any bare `/Users/<name>` fragment -- all
 *     derived at RUNTIME (never hardcoded in this committed file, for the same reason
 *     release-lib.ts's real name-guard patterns live outside this repo entirely: a hardcoded
 *     pattern here would publish the very string it exists to keep out) -- and FAILS the build
 *     on any hit, making a leaking artifact from this recipe unproducible rather than merely
 *     unlikely.
 *
 * --- The eight steps, in order ---
 *   1. clone       -- LibreOffice/core, pinned commit, no depth-1 shortcut (a specific commit
 *                      needs to be reachable, and a shallow clone of an arbitrary historical SHA
 *                      is not guaranteed to work without --depth-with-a-date-cutoff gymnastics
 *                      the original probe didn't need -- it cloned master fresh and was already
 *                      at this commit). --workdir itself must be identity-free -- see the RE-CUT
 *                      note above; this script does not and cannot enforce that choice for you.
 *   2. configure    -- MAKE=gmake-steered autogen.sh with the 33-flag v2+scrub recipe (32 flags
 *                      verbatim from the release notes linked above plus --with-vendor=Norma). Deliberately
 *                      NO CC/CXX override -- see the RE-CUT note above for why. Do NOT add
 *                      --disable-skia -- see the constant's own comment for why that specific
 *                      flag fails to compile on this platform.
 *   3. scrub CC/CXX -- appends the prefix-map flags (RE-CUT note above -- NOT oso_prefix, reverted)
 *                      onto the `export CC=`/`export CXX=` lines config_host.mk ALREADY has after
 *                      step 2 -- not a configure-time input.
 *   4. build        -- gmake gb_SUPPRESS_TESTS=T. Hours. No progress output beyond gmake's own.
 *   5. closure      -- runs build-libreoffice-closure-recipe.sh (a byte-for-byte copy of the
 *                      probe's own build-product-set-dylibs.sh, hash-pinned below) against a
 *                      dyld-traced run of the six gate fixtures plus one otool -L safety-net
 *                      pass, producing product-set/Frameworks/ -- plus a ditto copy of the
 *                      built instdir's Resources/ to product-set/Resources/ (real directory,
 *                      not a symlink -- see fetch-libreoffice.ts's header for why a symlink in
 *                      installPath's ancestry silently loads the WRONG Resources/ instead of
 *                      failing loudly).
 *   6. name-scan gate -- byte-scans product-set/ for the builder's identity (see RE-CUT note
 *                      above). FAILS the whole recipe on any hit. Must run AFTER step 5 (nothing
 *                      to scan before Resources/ is placed) and BEFORE step 8 packages anything.
 *   7. fontconfig   -- writes a standalone fontconfig-workaround/fonts.conf (three <dir>
 *                      entries) NEXT TO product-set/, not baked into it -- the shipped
 *                      product-set/Resources/config/fontconfig/fonts.conf is intentionally left
 *                      untouched (matches what was actually verified: applied via the
 *                      FONTCONFIG_FILE env var at runtime, zero build-system patches). Baking it
 *                      into ExternalPackage_fontconfig_data.mk instead is a real, un-taken
 *                      option recon flagged -- see FONTCONFIG note below.
 *   8. licenses     -- copies the license text LICENSES/MANIFEST.md cites out of
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
 * (see the release notes linked above). Baking the same three <dir> entries into
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
 *     (ACTUALLY runs steps 1-8 in sequence. Hours. Never invoked by this task or by any CI --
 *     see the header above. --workdir MUST be an identity-free path -- see the RE-CUT note.
 *     --core lets steps 7/8 target an existing checkout instead of re-cloning; steps 1-4 still
 *     clone fresh into --workdir unless --skip-clone is also given.)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
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

// ---------------------------------------------------------------------------
// RE-CUT scrub: path-prefix maps for CC/CXX (NOT CFLAGS/CXXFLAGS -- see below), appended to
// config_host.mk's CC/CXX by step 3's execute(), AFTER step 2 (configure) has already run to
// completion -- never passed as a CC/CXX environment override INTO ./autogen.sh. Both prefix-map
// targets are deliberately unambiguous nonsense paths (never real directories) so a remapped
// string is obviously synthetic if it ever surfaces in a bug report.
// ---------------------------------------------------------------------------
const PREFIX_MAP_BUILDDIR_TARGET = "/norma-build"; // replaces the corePath (BUILDDIR == SRCDIR for
// this in-tree configure) -- LOAD-BEARING: a scratchpad-style workdir path can easily contain the
// builder's account name (e.g. a Claude-harness tmp scratchpad literally embeds
// "-Users-<name>-..." as a directory-name component) -- see the --workdir requirement below.
//
// THERE IS DELIBERATELY NO SEPARATE $HOME PREFIX-MAP TARGET. An earlier revision of this recipe
// also mapped homedir()=/norma-home, "as a second, unconditional map, because nothing guarantees
// BUILDDIR stays under $HOME." That reasoning is what caused the exact leak class step 6 exists
// to catch: `-ffile-prefix-map=<SOURCE>=<TARGET>` is a remap INSTRUCTION, and <SOURCE> is data --
// when SOURCE is `homedir()` (a per-account absolute path), the flag's own ARGUMENT TEXT contains
// the identity it is trying to scrub, verbatim, as an ordinary CC/CXX string. Any build step that
// records "the compiler invocation used to build me" (not `__FILE__`, not DWARF -- a THIRD class)
// republishes that flag text wholesale -- and TWO INDEPENDENT instances of this class were found
// in ONE shipped file, not one: curl's own `./configure` writes a `buildinfo.txt` with a `CC=`
// line copied verbatim from the environment and compiles that string into `libcurl.dylib` for its
// own version/diagnostics reporting; separately, OpenSSL's generated `buildinf.h` does the exact
// same thing (a `compiler_flags` string literal, identifiable by the `-DOPENSSL_BUILDING_OPENSSL`
// text beside it) and reaches the SAME shipped dylib a second way -- statically linked in via
// `libcrypto.a`/`libssl.a`, since this build's curl uses `--with-openssl`. A rebuild that fixes
// curl's own `./configure` re-run does NOT touch openssl's already-built `.a` archives -- gmake's
// dependency tracking has no reason to invalidate a static library just because a downstream
// consumer's flags changed, so the stale banner rides in through the linker untouched. Both
// embedders were caught by the SAME single mechanism -- step 6's gate re-scanning finished bytes,
// not a source-level audit of curl or openssl -- which is exactly why this recipe scans output
// instead of trying to enumerate every such mechanism up front: it does not need to know curl and
// openssl do this, only that nothing they produce is allowed to contain the pattern.
// The BUILDDIR map does not have this problem: the --workdir requirement below means its SOURCE
// argument (`corePath`) is chosen to contain no identity in the first place, so a build step that
// captures *this* flag's text republishes a string that was already clean going in. Given that,
// a second, HOME-scoped map adds no coverage this recipe's threat model needs -- the byte-scan
// gate found zero `/Users/<name>` hits anywhere in the tree once BUILDDIR itself was neutral,
// meaning nothing in this build actually references $HOME during compilation -- while adding a
// flag whose own argument is exactly the string this whole recipe exists to keep out of the
// product. Any prefix-map SOURCE argument must itself be identity-free before it is trusted; do
// not re-add a homedir()-sourced map without re-deriving this reasoning.
//
// WHY CC/CXX AND NOT CFLAGS/CXXFLAGS: LibreOffice's gbuild has REPLACE, not additive, semantics
// for the CFLAGS/CXXFLAGS/OBJCXXFLAGS *environment* variables at the per-object-file level --
// solenv/gbuild/LinkTarget.mk's `gb_LinkTarget__get_cflags`/`get_cxxflags`/`get_objcxxflags` are
// literally `$(if $(CFLAGS),$(CFLAGS),$(call gb_LinkTarget__get_debugflags,...))`: a non-empty
// CFLAGS/CXXFLAGS env var REPLACES gbuild's own per-target debug/optimization flags for EVERY
// translation unit in the build (T_CFLAGS/T_CXXFLAGS still keep their base include/define/warning
// flags via `gb_LinkTarget_CXXFLAGS` -- only the debug/opt portion is swapped), not appended to
// them -- confirmed by reading LinkTarget.mk directly (not assumed), because a wrong guess here
// costs an entire re-run of an hours-long build. Silently dropping -O2 (or whatever debug/opt
// flags gbuild would have chosen) build-wide is exactly the kind of "measure, don't guess" trap
// this recipe exists to avoid.
//
// WHY POST-CONFIGURE AND NOT A CC/CXX ENVIRONMENT OVERRIDE EITHER: configure.ac's macOS block is
// `if test -z "$save_CC"; then CC="\`xcrun -find clang\`"; CC+=" -target arm64-apple-macos
// -mmacosx-version-min=... -isysroot ..."; ...; AR=\`xcrun -find ar\`; NM=...; STRIP=...;
// RANLIB=...; fi` -- ALL of it gated on CC being UNSET at that point. A user-supplied CC (even
// just "clang" with flags appended) makes `save_CC` non-empty and skips the WHOLE block: not just
// the `+=` target/sysroot decoration (confirmed empirically: config_host.mk's exported CC/CXX had
// no `-target`/`-isysroot`/`-mmacosx-version-min` at all when CC was pre-set), but also AR/NM/
// STRIP/RANLIB silently falling back to bare, PATH-resolved names instead of `xcrun -find`'s
// absolute, toolchain-pinned ones. None of that is what this recipe wants to change. The fix:
// let step 2 configure in its completely default, already-proven mode, then have step 3 read
// back the config_host.mk it just wrote and APPEND to the two `export CC=`/`export CXX=` lines
// textually -- this mirrors how this codebase's OWN release pipeline does the same remap for its
// Swift/ObjC++ targets (project.yml Release config, `-ffile-prefix-map $(HOME)=/builder` +
// `-Wl,-oso_prefix,$(HOME)/`), same technique (compiler-string append), different application
// point (post-configure file edit here, vs. a build-setting field there).
//
// `-Wl,-oso_prefix,PREFIX/` was TRIED alongside the two -*-prefix-map flags below, motivated by
// this codebase's own prior incident (privacy-scrub-public.md / release-0-2-002-shipped.md: ld64
// separately embeds linked object files' OWN absolute build paths into Mach-O N_OSO debug-map
// stabs, a linker-level leak unrelated to and not fixed by any compiler-level __FILE__/DWARF
// remap) -- and REVERTED after it broke cairo's meson-based external build with genuine C type
// errors (meson's compiler-capability probes trip clang's "argument unused during compilation"
// warning on every pure-compile invocation carrying a `-Wl` flag, and something in that probing
// path reads the warning as "capability absent," flipping a `HAVE_UINT64_T`-equivalent detection
// and corrupting cairo's 64-bit-integer emulation choice -- confirmed by an isolated retry that
// removed only this flag pair and rebuilt cairo clean). It is NOT in the flags this function
// returns. The N_OSO leak class it would have addressed is not exercised in practice here: the
// neutral-workdir requirement (RE-CUT note above) means BUILDDIR never contains the identity to
// begin with (and there is deliberately no second, HOME-sourced map -- see the note above this
// function), so there is nothing for an N_OSO stab to leak even unscrubbed.
function prefixMapFlags(builddir: string): string[] {
  return [
    `-ffile-prefix-map=${builddir}=${PREFIX_MAP_BUILDDIR_TARGET}`,
    `-fdebug-prefix-map=${builddir}=${PREFIX_MAP_BUILDDIR_TARGET}`,
  ];
}

// The v2 trimmed+merged configure line (see the release notes linked in this file's own header
// for the "V2 configure flags + L0/L2 evidence" behind it) plus one RE-CUT addition,
// --with-vendor=Norma: unset, LibreOffice's own configure
// (configure.ac ~15626-15645) defaults OOO_VENDOR to $USERNAME/$USER/`id -u -n` -- i.e. the
// builder's own macOS account name -- and bakes it verbatim into Resources/versionrc's `Vendor=`
// line and Resources/registry/main.xcd's `ooVendor` property. That is exactly the second leak
// class this re-cut exists to close (the first being the compiled-in __FILE__ paths the
// CC/CXX prefix maps above handle). Do NOT add --disable-skia: vcl/osx/salframeview.mm and
// vcl/osx/salgdiutils.cxx reference SkiaHelper/AquaSkiaSalGraphicsImpl/CAMetalLayer
// unconditionally (no #if HAVE_FEATURE_SKIA guard) -- the Aqua vclplug is always compiled
// alongside svp on macOS (there is no svp-only mac backend yet), so that flag fails with 8 clang
// errors across those two files.
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
  "--with-vendor=Norma",
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

// The three <dir> entries recon found missing from the shipped fontconfig/fonts.conf (re-verified
// per the release notes linked in this file's own header: without these, a macOS system font
// request like "Helvetica Neue" silently substitutes a bundled fallback serif instead of erroring).
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
// the release notes' own "licensing inventory" table cites (linked in this file's own header),
// one entry per LICENSES/ subdirectory this recipe produces. Mirrors LICENSES/MANIFEST.md's own
// table; keep the two in sync if either changes.
const LICENSE_SOURCES: Record<string, string[]> = {
  cairo: ["COPYING", "COPYING-LGPL-2.1", "COPYING-MPL-1.1"],
  fontconfig: ["COPYING"],
  freetype: ["LICENSE.TXT"],
  icu: ["LICENSE"],
  skia: ["LICENSE"],
  curl: ["COPYING"],
  openssl: ["LICENSE.txt"], // RE-CUT addition: curl's --with-openssl statically links libcrypto.a/
  // libssl.a into libcurl.dylib (confirmed: no separate libssl/libcrypto dylib ships in
  // product-set/Frameworks/, so this code is only reachable through curl's binary) -- omitted
  // from every prior cut of this table, including the one the original shipping vendor tree's
  // own LICENSES/MANIFEST.md was generated from; not a privacy issue (Apache-2.0, no stronger-
  // than-LGPL concern) but a real completeness gap in "every third-party dependency backing the
  // 66 dylibs", closed here because this RE-CUT was re-deriving LICENSES/ from scratch anyway.
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
      `  --execute                ACTUALLY run steps 1-8. Hours. Requires --workdir and --out;\n` +
      `                           --core <checkout> reuses an existing clone for steps 7/8\n` +
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
      `  (deliberately NO CC/CXX override -- see the RE-CUT note's save_CC paragraph above;`,
      `  step 3 does the CC/CXX scrub AFTER this step, not as an input to it.)`,
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
    name: "3. scrub CC/CXX",
    describe: ({ corePath }) => {
      const flags = prefixMapFlags(corePath).join(" ");
      return [
        `append to config_host.mk's ALREADY-WRITTEN "export CC=" / "export CXX=" lines:`,
        `  ${flags}`,
        `(a text edit of a generated file, not a reconfigure -- see the RE-CUT note above for why`,
        `this must happen after step 2, not as CC/CXX passed into it. If ${join(corePath, "config_host.mk")}`,
        `has no such lines, step 2 did not complete -- do not proceed.)`,
      ];
    },
    execute: (ctx) => {
      const configHostMkPath = join(ctx.corePath, "config_host.mk");
      if (!existsSync(configHostMkPath)) {
        throw new Error(`${configHostMkPath} does not exist -- run step 2 (configure) first.`);
      }
      const flags = prefixMapFlags(ctx.corePath).join(" ");
      const lines = readFileSync(configHostMkPath, "utf8").split("\n");
      let ccEdited = false;
      let cxxEdited = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.startsWith("export CC=")) {
          lines[i] += ` ${flags}`;
          ccEdited = true;
        } else if (lines[i]!.startsWith("export CXX=")) {
          lines[i] += ` ${flags}`;
          cxxEdited = true;
        }
      }
      if (!ccEdited || !cxxEdited) {
        throw new Error(
          `${configHostMkPath} has no "export CC=" and/or "export CXX=" line -- refusing to\n` +
            `proceed with an un-scrubbed or partially-scrubbed config_host.mk.`,
        );
      }
      writeFileSync(configHostMkPath, lines.join("\n"));
      console.log(`  appended BUILDDIR-only prefix-map flags to CC and CXX in ${configHostMkPath}`);
    },
  },
  {
    name: "4. build",
    describe: ({ corePath }) => [`cd ${corePath} && gmake ${BUILD_ARGS.join(" ")}   # hours`],
    execute: (ctx) => {
      run(GMAKE_PATH, BUILD_ARGS, { cwd: ctx.corePath, inherit: true });
    },
  },
  {
    name: "5. closure",
    describe: ({ outdir, corePath }) => [
      `(sha256 of build-libreoffice-closure-recipe.sh must equal ${CLOSURE_RECIPE_SHA256})`,
      `run the six gate fixtures with GATE_DYLD_TRACE=1 to populate dyld-traces/`,
      `build-libreoffice-closure-recipe.sh   # -> ${outdir}/product-set/Frameworks/`,
      `ditto ${corePath}/instdir/LibreOfficeDev.app/Contents/Resources ${outdir}/product-set/Resources`,
      `  (real directory copy, NOT a symlink -- see fetch-libreoffice.ts header for why a`,
      `  symlink in installPath's ancestry silently loads the wrong Resources/ instead of`,
      `  failing loudly. This is also where the OOO_VENDOR-derived versionrc/main.xcd fields`,
      `  live -- always re-copy Resources/ from a FRESH instdir on every re-cut; reusing an`,
      `  old product-set/Resources/ silently keeps whatever identity was baked into it.)`,
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
          `  from this build recipe. Run build-libreoffice-closure-recipe.sh by hand once traces exist.\n` +
          `  Then ditto-copy Resources/ from a FRESH instdir as shown above -- not automated here\n` +
          `  either, for the same reason (this step verifies/documents; it does not itself touch\n` +
          `  the filesystem beyond the hash check, matching its pre-existing shape). Both halves\n` +
          `  MUST be re-done from this build's own instdir -- never reuse either half from a\n` +
          `  prior product-set/, or step 6 below is scanning stale, possibly still-leaking bytes.`,
      );
    },
  },
  {
    name: "6. name-scan gate",
    describe: ({ outdir }) => [
      `byte-scan every regular file under ${join(outdir, "product-set")} for:`,
      `  - the builder's account name (os.userInfo().username)`,
      `  - $HOME's basename (basename(os.homedir()))`,
      `  - the machine hostname (os.hostname()), and its part before the first "." if any`,
      `  - any bare /Users/<name> path fragment (catches a leak that doesn't literally`,
      `    contain this machine's specific identity strings, e.g. a differently-shaped path)`,
      `Patterns are derived at RUNTIME, never hardcoded in this file -- see the RE-CUT note at`,
      `the top of this file for why. FAILS (non-zero exit) on any hit, naming every match.`,
      `CAVEAT (found packaging the -r2 asset this recipe describes): this step runs BEFORE step 8`,
      `(licenses) and only scans product-set/ -- so it does NOT cover LICENSES/ or a hand-authored`,
      `VERSION-PIN, both of which ship inside the final tarball per fetch-libreoffice.ts's "three`,
      `top-level entries" contract. A hand-authored VERSION-PIN is exactly the kind of file that`,
      `can reintroduce this leak by accident: prose EXPLAINING the scrub is a natural place to`,
      `reach for a concrete illustrative example, and "e.g. /Users/<the builder's real account>"`,
      `is that leak. Before packaging, re-run this same scan (this file's runNameScanGate, or the`,
      `standalone recut/run-name-scan.mjs) against the FULL staged tarball root -- product-set/,`,
      `LICENSES/, and VERSION-PIN together -- not just product-set/ alone.`,
    ],
    execute: (ctx) => {
      runNameScanGate(join(ctx.outdir, "product-set"));
    },
  },
  {
    name: "7. fontconfig",
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
    name: "8. licenses",
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
// RE-CUT name-scan gate (step 6). Byte-level (Buffer/string content), not filename-level -- the
// leak this exists to catch is bytes __FILE__-compiled into Mach-O debug stabs and text config
// fields, not a file named after a person. Every pattern is derived from THIS machine's live
// identity at call time -- nothing here is a literal string checked into git, for the same
// reason release.ts's real name-guard.sh lives outside every repo entirely (see its own comment
// in scripts/release.ts, "11b. Identity gate"): a hardcoded pattern in a tracked file would
// publish the very string it exists to keep out.
// ---------------------------------------------------------------------------
interface ScanHit {
  file: string;
  pattern: string;
}

function collectPatterns(): { label: string; needle: string }[] {
  const patterns: { label: string; needle: string }[] = [];
  const add = (label: string, needle: string | undefined) => {
    if (needle && needle.length >= 3) patterns.push({ label, needle });
  };
  add("account name", userInfo().username);
  add("$HOME basename", basename(homedir()));
  const host = hostname();
  add("hostname", host);
  const shortHost = host.split(".")[0];
  if (shortHost && shortHost !== host) add("hostname (short)", shortHost);
  // De-dupe by lowercased needle -- username and $HOME basename are almost always identical on
  // a normal single-user macOS install, and reporting the same hit twice under two labels would
  // just be noise in the failure output.
  const seen = new Set<string>();
  return patterns.filter((p) => {
    const key = p.needle.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Case-sensitive on purpose (unlike the username/hostname patterns above, which lowercase both
// sides): "/Users/" is a fixed, capitalized macOS path prefix, so matching it case-sensitively
// avoids false-triggering on an unrelated lowercase "users" substring in, say, LibreOffice's own
// UI/help text -- a real risk given how much of product-set/Resources/ is localized strings.
const USERS_PATH_RE = /\/Users\/[A-Za-z0-9_.-]+/;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Never follow symlinks -- matches release-lib.ts's nameScanPlan() rule exactly (a
      // symlinked subtree would otherwise let content be reached, and therefore double-counted
      // or inconsistently scanned, by two different paths).
      if (entry.isSymbolicLink()) continue;
      const p = join(dir, entry.name);
      if (lstatSync(p).isDirectory()) rec(p);
      else out.push(p);
    }
  };
  rec(root);
  return out;
}

function runNameScanGate(productSetDir: string): void {
  if (!existsSync(productSetDir)) {
    throw new Error(`name-scan gate: ${productSetDir} does not exist -- run step 5 (closure) first.`);
  }
  const patterns = collectPatterns();
  console.log(
    `  scanning for ${patterns.length} identity pattern(s) -- ${patterns.map((p) => p.label).join(", ")} --` +
      ` plus any bare /Users/<name> path fragment`,
  );
  const files = walkFiles(productSetDir);
  const hits: ScanHit[] = [];
  for (const file of files) {
    const buf = readFileSync(file);
    // One string materialization per file, reused for every pattern below -- not one per
    // pattern -- product-set/ is ~488MB total including a 126.8MB single dylib, so redoing this
    // per-pattern would multiply an already-nontrivial cost for no benefit.
    const hay = buf.toString("latin1"); // byte-preserving for the ASCII content every observed
    // leak actually is (build paths, __FILE__ literals, versionrc/main.xcd fields) -- this is
    // not a general-purpose text decode, just a safe 1:1 byte<->char view for substring search.
    const hayLower = hay.toLowerCase();
    for (const { label, needle } of patterns) {
      if (hayLower.includes(needle.toLowerCase())) hits.push({ file, pattern: label });
    }
    if (USERS_PATH_RE.test(hay)) hits.push({ file, pattern: "/Users/<name> path fragment" });
  }
  console.log(`  scanned ${files.length} files under ${productSetDir}`);
  if (hits.length > 0) {
    const byFile = new Map<string, Set<string>>();
    for (const h of hits) {
      if (!byFile.has(h.file)) byFile.set(h.file, new Set());
      byFile.get(h.file)!.add(h.pattern);
    }
    const lines = [...byFile.entries()].map(([f, pats]) => `    ${f}: ${[...pats].join(", ")}`);
    throw new Error(
      `name-scan gate FAILED: ${byFile.size} file(s) with an identity hit -- refusing to produce\n` +
        `a leaking artifact.\n${lines.join("\n")}\n` +
        `Investigate before re-running. Do not add an exclusion for this without first proving\n` +
        `(measured, not assumed) the hit is a meaningless collision -- same bar release-lib.ts's\n` +
        `NAME_SCAN_EXCLUSIONS comment documents for its own two exclusions (one reactive, found\n` +
        `and investigated first; one prophylactic, measured at zero hits before being added).`,
    );
  }
  console.log(`  name-scan gate PASSED -- zero hits across ${files.length} files.`);
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
console.log(
  `\nDone. See ${ctx.outdir} for product-set inputs (step 5's Frameworks/ closure AND Resources/\n` +
    `ditto-copy must both be run manually -- see step 5's own note -- BEFORE step 6's name-scan\n` +
    `gate can do anything meaningful; it already ran above against whatever was on disk at the\n` +
    `time, so re-run this script, or at least step 6 by hand, after placing them).`,
);
