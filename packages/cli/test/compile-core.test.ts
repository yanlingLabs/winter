// WS-23: the embedded chat/dispatch Worker is reached, in the compiled binary, by a PLAIN relative path
// (`core`'s `COMPILED_EMBEDDED_WORKER_ENTRY`) to a file passed as a SECOND `bun build --compile`
// entrypoint. Bun names an extra entrypoint by its path relative to the entrypoints' common root, so
// the file's NAME, its DIRECTORY (beside `src/main.ts`) and both compile scripts are one contract —
// and nothing but `bun run verify:embedded` would otherwise notice it breaking. This pins it cheaply.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { COMPILED_EMBEDDED_WORKER_ENTRY } from "../../core/src/runtime-sdk/embedded";

const CLI_DIR = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };
const WORKER_FILE = join(CLI_DIR, "src", basename(COMPILED_EMBEDDED_WORKER_ENTRY));
/** The Worker graph's real source, bundled ALONE into the gitignored bundle the worker file imports. */
const WORKER_SOURCE_REL = "src/embedded-worker.source.ts";
const WORKER_BUNDLE_REL = ".build/embedded-worker.bundle.js";

describe("compile:core carries the embedded Worker entry (WS-23)", () => {
  test("the compiled entry is a plain `./<file>.ts` beside src/main.ts, and that file exists", () => {
    expect(COMPILED_EMBEDDED_WORKER_ENTRY).toMatch(/^\.\/[\w-]+\.ts$/);
    expect(existsSync(WORKER_FILE)).toBe(true);
    expect(dirname(WORKER_FILE)).toBe(join(CLI_DIR, "src"));
  });

  test("both compile scripts pre-bundle the worker graph ALONE, then pass src/main.ts AND the worker file as entrypoints", () => {
    for (const name of ["compile", "compile:core"]) {
      const steps = manifest.scripts[name]!.split("&&").map((s) => s.trim().split(/\s+/));
      expect([name, steps.length]).toEqual([name, 2]);
      const [prebundle, compile] = steps as [string[], string[]];
      // Step 1: the worker's graph, bundled on its own — never beside src/main.ts.
      expect([name, prebundle.slice(0, 2), prebundle.filter((t) => t.startsWith("src/"))]).toEqual([name, ["bun", "build"], [WORKER_SOURCE_REL]]);
      expect([name, prebundle.includes("--compile")]).toEqual([name, false]);
      expect([name, prebundle[prebundle.indexOf("--target") + 1], prebundle[prebundle.indexOf("--outfile") + 1]]).toEqual([name, "bun", WORKER_BUNDLE_REL]);
      // Step 2: the compile, whose second entrypoint is the plain-path Worker file.
      expect([name, compile.slice(0, 3), compile.filter((t) => t.startsWith("src/"))]).toEqual([
        name,
        ["bun", "build", "--compile"],
        ["src/main.ts", `src/${basename(COMPILED_EMBEDDED_WORKER_ENTRY)}`],
      ]);
    }
  });

  // SECURITY (no-autoload): by default a `bun build --compile` binary reads the bunfig.toml (its
  // `preload` runs as the binary) and .env of the directory it is STARTED in. `winter` is a symlink to
  // `winter-core` that users run inside arbitrary repositories, so both are switched off at compile
  // time; the setting is baked into the executable, so every self-spawn (`__workflow-worker`,
  // `__runtime-workflow-worker`) inherits it. `bun run verify:runtimes` proves it on the real binary.
  test("both compile scripts switch off the cwd bunfig.toml and .env autoloads", () => {
    for (const name of ["compile", "compile:core"]) {
      const compile = manifest.scripts[name]!.split("&&").map((s) => s.trim().split(/\s+/))[1]!;
      expect([name, compile.includes("--no-compile-autoload-bunfig"), compile.includes("--no-compile-autoload-dotenv")]).toEqual([name, true, true]);
    }
  });

  test("the worker file imports only the pre-built bundle, and the bundle's source is the daemon package's own Worker entry", () => {
    const importsOf = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/^import\s+"([^"]+)";$/gm)].map((m) => m[1]!);
    expect(importsOf(WORKER_FILE)).toEqual([`../${WORKER_BUNDLE_REL}`]);
    expect(importsOf(join(CLI_DIR, WORKER_SOURCE_REL))).toEqual(["@yanlinglabs/winter-core/embedded-worker"]);
  });

  // The regression itself (a release blocker for 0.118.0): with the npm-installed runtime, bundling
  // the Worker graph BESIDE src/main.ts (which dynamically `import()`s winter-core and the protocol)
  // left zod wrapped in `__esm` with no `init_*()` call from the runtime's MCP client, so the Worker
  // threw `new ZodLazy` at load. Build exactly what `compile:core` builds, minus `--compile`, and load
  // the Worker bundle: it must evaluate cleanly (off the main thread it installs nothing and exits).
  test("the Worker bundle built beside src/main.ts evaluates without error", async () => {
    const out = mkdtempSync(join(tmpdir(), "winter-worker-bundle-"));
    try {
      const run = (args: string[]): { code: number | null; stderr: string } => {
        const r = spawnSync(process.execPath, args, { cwd: CLI_DIR, encoding: "utf8", timeout: 60_000 });
        return { code: r.status, stderr: r.stderr ?? "" };
      };
      const pre = run(["build", WORKER_SOURCE_REL, "--target", "bun", "--outfile", WORKER_BUNDLE_REL]);
      expect([pre.code, pre.stderr.includes("error")]).toEqual([0, false]);
      const both = run(["build", "src/main.ts", `src/${basename(COMPILED_EMBEDDED_WORKER_ENTRY)}`, "--target", "bun", "--outdir", out]);
      expect([both.code, both.stderr.includes("error")]).toEqual([0, false]);
      const load = run([join(out, basename(COMPILED_EMBEDDED_WORKER_ENTRY).replace(/\.ts$/, ".js"))]);
      expect([load.code, load.stderr.trim()]).toEqual([0, ""]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

// The daemon seeds the skills Winter ships (`computer-use`) into `<home>/sdk/skills` from text EMBEDDED in the
// binary (`core/src/migration/builtin-skills.ts`, a bun text import). A compiled `winter-core` has no
// `packages/core/skills/` to read — `import.meta.url` there is a virtual path — so the proof is a real
// `bun build --compile` of that module, run from a directory that holds no repo.
describe("compile:core carries the skills it seeds (the managed copy of computer-use)", () => {
  const CORE_DIR = join(CLI_DIR, "..", "core");
  const SEED_MODULE = join(CORE_DIR, "src", "migration", "builtin-skills.ts");

  test("the seeding module reads no path at run time: the text arrives by import, never by import.meta, __dirname or a skills/ directory", () => {
    const code = readFileSync(SEED_MODULE, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(code).toMatch(/import computerUseSkill from "\.\.\/\.\.\/skills\/computer-use\/SKILL\.md" with \{ type: "text" \};/);
    expect(code).not.toMatch(/import\.meta|__dirname|__filename|process\.cwd|readdirSync/);
  });

  test("a compiled binary seeds the exact bytes of packages/core/skills/computer-use/SKILL.md into a fresh home, from a directory with no repo", () => {
    const out = mkdtempSync(join(tmpdir(), "winter-seed-compile-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "winter-seed-cwd-"));
    try {
      const entry = join(out, "entry.ts");
      writeFileSync(entry, `import { seedBuiltinSkills } from ${JSON.stringify(SEED_MODULE)};\nconsole.log(JSON.stringify(seedBuiltinSkills(process.argv[2]!)));\n`);
      const bin = join(out, "seeder");
      const build = spawnSync(process.execPath, ["build", "--compile", "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", entry, "--outfile", bin], { cwd: CLI_DIR, encoding: "utf8", timeout: 100_000 });
      expect([build.status, (build.stderr ?? "").includes("error")]).toEqual([0, false]);
      const home = join(out, "home");
      const run = spawnSync(bin, [home], { cwd: elsewhere, encoding: "utf8", timeout: 30_000 });
      expect([run.status, run.stderr.trim()]).toEqual([0, ""]);
      expect(JSON.parse(run.stdout.trim())).toEqual({ skills: { "computer-use": "seeded" } });
      const seeded = readFileSync(join(home, "sdk", "skills", "computer-use", "SKILL.md"), "utf8");
      expect(seeded).toBe(readFileSync(join(CORE_DIR, "skills", "computer-use", "SKILL.md"), "utf8"));
      expect(seeded.startsWith("---\nname: computer-use\n")).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 150_000);
});

