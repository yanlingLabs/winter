// Runs `bun test` (from packages/core) as N sequential native shards: `bun test --shard=K/N`.
//
// Why: Bun 1.3.14 has an intermittent use-after-free that can crash ONE long `bun test` process
// (after ~7 min, ~70 Workers spawned and terminated, ~1.4 GB RSS; "Segmentation fault at address 0xA",
// exit 133). Smaller processes lower the odds. Every shard is a fresh `bun test` in this directory, so
// it loads the same bunfig preload (per-process temp root, throwaway Keychain service) and env.
//
//   bun scripts/test-shards.ts [N]    run shards 1..N (default 3); every shard runs even if one fails
//
// The step fails if ANY shard exits non-zero or dies on a signal, prints no "Ran X tests across Y files"
// summary (a crash), runs 0 files, or the shards do not look like an exact partition of the test files
// (see `verdict`). Bun's own `--shard` does the split, so discovery always matches bun's.
import { Glob } from "bun";

export interface ShardResult {
  shard: number;
  /** Process exit code; null when it died on a signal. */
  exitCode: number | null;
  signal?: string | null;
  /** From bun's "Ran X tests across Y files" line; null when the line never appeared. */
  tests: number | null;
  files: number | null;
}

export function parseSummary(output: string): { tests: number; files: number } | null {
  const m = [...output.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)].pop();
  return m ? { tests: Number(m[1]), files: Number(m[2]) } : null;
}

/**
 * Pure aggregation: the list of problems (empty = pass). `minFiles` is a lower bound on the discovered
 * files (a plain glob of the usual patterns; bun may find more, never fewer).
 */
export function verdict(results: ShardResult[], total: number, minFiles: number): string[] {
  const problems: string[] = [];
  if (results.length !== total) problems.push(`expected ${total} shard results, got ${results.length}`);
  for (let s = 1; s <= total; s++) {
    const r = results.find((x) => x.shard === s);
    if (!r) {
      problems.push(`shard ${s}/${total} has no result`);
      continue;
    }
    if (r.exitCode !== 0) problems.push(`shard ${s}/${total} failed (exit ${r.exitCode ?? "none"}, signal ${r.signal ?? "none"})`);
    if (r.files === null || r.tests === null) problems.push(`shard ${s}/${total} printed no "Ran N tests across M files" summary`);
    else if (r.files <= 0) problems.push(`shard ${s}/${total} ran 0 files`);
  }
  const counted = results.filter((r) => r.files !== null);
  if (counted.length === total) {
    const sizes = counted.map((r) => r.files as number);
    const sum = sizes.reduce((a, b) => a + b, 0);
    if (Math.max(...sizes) - Math.min(...sizes) > 1) problems.push(`shards are not an even split: ${sizes.join(" + ")}`);
    if (sum < minFiles) problems.push(`shards ran ${sum} files, fewer than the ${minFiles} the glob finds: files were dropped`);
  }
  return problems;
}

function globCount(): number {
  let n = 0;
  for (const f of new Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scanSync({ onlyFiles: true })) {
    if (!f.split("/").some((p) => p === "node_modules")) n++;
  }
  return n;
}

async function runShard(shard: number, total: number): Promise<ShardResult> {
  console.log(`::group::shard ${shard}/${total}`);
  console.log(`=== shard ${shard}/${total} ===`);
  const proc = Bun.spawn(["bun", "test", `--shard=${shard}/${total}`], { stdout: "pipe", stderr: "pipe" });
  let tail = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      sink.write(text);
      tail = (tail + text).slice(-4096);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  await proc.exited;
  console.log("::endgroup::");
  const sum = parseSummary(tail);
  return { shard, exitCode: proc.exitCode, signal: proc.signalCode, tests: sum?.tests ?? null, files: sum?.files ?? null };
}

if (import.meta.main) {
  const total = Number(process.argv[2] ?? 3);
  if (!Number.isInteger(total) || total < 1) {
    console.error("usage: test-shards.ts [N]");
    process.exit(2);
  }
  const minFiles = globCount();
  const results: ShardResult[] = [];
  for (let s = 1; s <= total; s++) results.push(await runShard(s, total));
  for (const r of results) console.log(`shard ${r.shard}/${total}: ${r.tests ?? "?"} tests across ${r.files ?? "?"} files, exit ${r.exitCode ?? r.signal}`);
  const problems = verdict(results, total, minFiles);
  const sum = (k: "tests" | "files") => results.reduce((a, r) => a + (r[k] ?? 0), 0);
  console.log(`total: ${sum("tests")} tests across ${sum("files")} files (glob lower bound ${minFiles})`);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log("shard guard OK");
}
