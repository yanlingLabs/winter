// Deterministic split of `bun test` (run from packages/core) into N processes.
//
// Why: Bun 1.3.14 has an intermittent use-after-free that crashes ONE long `bun test` process
// (after ~7 min, ~70 Workers spawned and terminated, ~1.4 GB RSS). Bun 1.3.14 has no `--shard`,
// so CI runs the suite as several smaller processes. Each shard is a fresh `bun test`, so it gets
// the same bunfig preload (test/preload.ts: per-process temp root, throwaway Keychain service).
//
//   bun scripts/test-shard.ts --list                 every test file, sorted (one per line)
//   bun scripts/test-shard.ts --shard 2/3 --list     the files shard 2 of 3 runs
//   bun scripts/test-shard.ts --shard 2/3            run shard 2 of 3 (extra args go to `bun test`)
//   bun scripts/test-shard.ts --check [N]            assert N shards (default 3) cover the list exactly once
//   bun scripts/test-shard.ts --all [N]              run every shard sequentially; fail if any fails
//
// Discovery mirrors bun's default: *.test / *_test / *.spec / *_spec with a js/ts-family extension,
// skipping node_modules and dot-directories.
import { Glob } from "bun";

const PATTERN = "**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}";

export function listTestFiles(cwd: string = process.cwd()): string[] {
  const out: string[] = [];
  for (const f of new Glob(PATTERN).scanSync({ cwd, onlyFiles: true })) {
    if (f.split("/").some((p) => p === "node_modules" || p.startsWith("."))) continue;
    out.push(f);
  }
  return out.sort();
}

/** Round-robin over the sorted list: file i goes to shard (i mod n) + 1. */
export function shardOf(files: string[], shard: number, total: number): string[] {
  return files.filter((_, i) => i % total === shard - 1);
}

function runShard(files: string[], extra: string[]): number {
  // "./" makes bun treat each argument as a path, not a substring filter.
  const proc = Bun.spawnSync(["bun", "test", ...extra, ...files.map((f) => `./${f}`)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  return proc.exitCode ?? 1;
}

function check(files: string[], total: number): void {
  const seen = new Map<string, number>();
  for (let s = 1; s <= total; s++) for (const f of shardOf(files, s, total)) seen.set(f, (seen.get(f) ?? 0) + 1);
  const dropped = files.filter((f) => !seen.has(f));
  const dup = [...seen].filter(([, n]) => n !== 1).map(([f]) => f);
  const unknown = [...seen.keys()].filter((f) => !files.includes(f));
  if (files.length === 0 || dropped.length || dup.length || unknown.length) {
    console.error(`shard coverage FAILED: files=${files.length} dropped=${dropped} duplicated=${dup} unknown=${unknown}`);
    process.exit(1);
  }
  const sizes = Array.from({ length: total }, (_, i) => shardOf(files, i + 1, total).length);
  console.log(`shard coverage OK: ${files.length} files, ${total} shards (${sizes.join(" + ")}), each exactly once`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const files = listTestFiles();
  const flag = (n: string) => args.indexOf(n);
  const num = (n: string) => {
    const i = flag(n);
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isInteger(v) && v >= 1 ? v : 3;
  };
  if (flag("--check") >= 0) {
    check(files, num("--check"));
  } else if (flag("--all") >= 0) {
    const total = num("--all");
    let failed = 0;
    for (let s = 1; s <= total; s++) {
      const mine = shardOf(files, s, total);
      console.log(`::group::shard ${s}/${total} (${mine.length} files)`);
      console.log(`=== shard ${s}/${total}: ${mine.length} files ===`);
      const code = runShard(mine, []);
      console.log("::endgroup::");
      if (code !== 0) {
        console.error(`shard ${s}/${total} FAILED (exit ${code})`);
        failed++;
      }
    }
    process.exit(failed ? 1 : 0);
  } else if (flag("--shard") < 0 && flag("--list") >= 0) {
    console.log(files.join("\n"));
  } else {
    const i = flag("--shard");
    const m = i >= 0 ? /^(\d+)\/(\d+)$/.exec(args[i + 1] ?? "") : null;
    if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) {
      console.error("usage: test-shard.ts --list | --shard K/N [--list] | --check [N] | --all [N]");
      process.exit(2);
    }
    const mine = shardOf(files, Number(m[1]), Number(m[2]));
    if (flag("--list") >= 0) console.log(mine.join("\n"));
    else process.exit(runShard(mine, args.filter((a, j) => j !== i && j !== i + 1)));
  }
}
