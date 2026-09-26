// WS-23: the embedded chat/dispatch Worker is reached, in the compiled binary, by a PLAIN relative path
// (`core`'s `COMPILED_EMBEDDED_WORKER_ENTRY`) to a file passed as a SECOND `bun build --compile`
// entrypoint. Bun names an extra entrypoint by its path relative to the entrypoints' common root, so
// the file's NAME, its DIRECTORY (beside `src/main.ts`) and both compile scripts are one contract —
// and nothing but `bun run verify:embedded` would otherwise notice it breaking. This pins it cheaply.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { COMPILED_EMBEDDED_WORKER_ENTRY } from "../../core/src/runtime-sdk/embedded";

const CLI_DIR = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> };
const WORKER_FILE = join(CLI_DIR, "src", basename(COMPILED_EMBEDDED_WORKER_ENTRY));

describe("compile:core carries the embedded Worker entry (WS-23)", () => {
  test("the compiled entry is a plain `./<file>.ts` beside src/main.ts, and that file exists", () => {
    expect(COMPILED_EMBEDDED_WORKER_ENTRY).toMatch(/^\.\/[\w-]+\.ts$/);
    expect(existsSync(WORKER_FILE)).toBe(true);
    expect(dirname(WORKER_FILE)).toBe(join(CLI_DIR, "src"));
  });

  test("both compile scripts pass src/main.ts AND the worker file as entrypoints", () => {
    for (const name of ["compile", "compile:core"]) {
      const entrypoints = manifest.scripts[name]!.split(/\s+/).filter((t) => t.startsWith("src/"));
      expect([name, entrypoints]).toEqual([name, ["src/main.ts", `src/${basename(COMPILED_EMBEDDED_WORKER_ENTRY)}`]]);
    }
  });

  test("the worker file is the daemon package's own Worker entry, and nothing else", () => {
    const source = readFileSync(WORKER_FILE, "utf8");
    const imports = [...source.matchAll(/^import\s+"([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@yanlinglabs/winter-core/embedded-worker"]);
  });
});
