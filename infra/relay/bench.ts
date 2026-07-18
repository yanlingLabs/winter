#!/usr/bin/env bun
/**
 * Concurrency bench for one relay (SP2b Task 6 Step 6). There is no TS/Bun iroh client (iroh-ffi
 * has no Node/Bun binding in this repo) -- so this drives N parallel REAL OS PROCESSES, each
 * running `norma-fake-phone probe-relay --url <url>` (binds a fresh iroh endpoint with ONLY that
 * relay configured, awaits `Endpoint.online()`, prints `ok`), and measures success rate and
 * p50/p95 wall-clock time-to-online. If `--ssh-host` is given, also captures the relay's own
 * `systemctl status`/`free -m` over SSH right after the burst, for a memory-per-connection data
 * point (recorded in README.md alongside the 10k scaling extrapolation).
 *
 * `--n` (default 200) is bounded by THIS MACHINE's open-file-descriptor limit (`ulimit -n`) far
 * more than by anything relay-side -- each probe process opens several fds (UDP socket(s), TLS
 * to the relay for the initial handshake, etc). Raise `ulimit -n` before pushing `--n` much past
 * a few hundred on a stock macOS shell (`launchctl limit maxfiles` default is often 256/unlimited
 * per-process soft limit ~ a few thousand -- verify locally with `ulimit -n` before a big run).
 *
 * Usage:
 *   bun infra/relay/bench.ts --url https://relay-1.yanlinglabs.com./ [--n 200] [--ssh-host ubuntu@relay-1.yanlinglabs.com]
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NORMAKIT_DIR = join(HERE, "..", "..", "apple", "NormaKit");

interface Args {
  url: string;
  n: number;
  sshHost?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let url = "";
  let n = 200;
  let sshHost: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") url = argv[++i] ?? "";
    else if (argv[i] === "--n") n = Number(argv[++i]);
    else if (argv[i] === "--ssh-host") sshHost = argv[++i];
  }
  if (!url) {
    console.error("usage: bun infra/relay/bench.ts --url <relay-url> [--n 200] [--ssh-host user@host]");
    process.exit(2);
  }
  return { url, n, sshHost };
}

interface ProbeResult {
  ok: boolean;
  ms: number;
}

function runOneProbe(binPath: string, url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = Bun.spawn([binPath, "probe-relay", "--url", url], { stdout: "pipe", stderr: "pipe" });
    proc.exited.then((code) => resolve({ ok: code === 0, ms: Date.now() - start }));
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function main(): Promise<void> {
  const { url, n, sshHost } = parseArgs();

  console.log("Building norma-fake-phone (release)...");
  execFileSync("swift", ["build", "-c", "release", "--product", "norma-fake-phone"], { cwd: NORMAKIT_DIR, stdio: "inherit" });
  const binPath =
    execFileSync("swift", ["build", "-c", "release", "--show-bin-path"], { cwd: NORMAKIT_DIR, encoding: "utf8" }).trim() +
    "/norma-fake-phone";

  const ulimitN = execFileSync("bash", ["-c", "ulimit -n"], { encoding: "utf8" }).trim();
  console.log(`ulimit -n on this machine: ${ulimitN} (bench --n=${n}) -- raise it first if --n approaches this.`);

  console.log(`Launching ${n} parallel probes against ${url}...`);
  const wallStart = Date.now();
  const results = await Promise.all(Array.from({ length: n }, () => runOneProbe(binPath, url)));
  const wallMs = Date.now() - wallStart;

  const successResults = results.filter((r) => r.ok);
  const times = successResults.map((r) => r.ms).sort((a, b) => a - b);
  const successCount = successResults.length;

  console.log(`\n=== Results (${url}) ===`);
  console.log(`  n=${n} success=${successCount} (${((successCount / n) * 100).toFixed(1)}%) wall=${wallMs}ms`);
  console.log(`  time-to-online: p50=${percentile(times, 0.5)}ms p95=${percentile(times, 0.95)}ms`);
  if (successCount < n) {
    console.log(`  ${n - successCount} probe(s) failed -- rerun with a lower --n or a raised ulimit -n if this looks fd-limit-related, not relay-side.`);
  }

  if (sshHost) {
    console.log(`\n=== Relay-side (${sshHost}) ===`);
    try {
      const out = execFileSync("ssh", [sshHost, "systemctl status iroh-relay --no-pager | head -10; echo ---; free -m"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      console.log(out);
    } catch (e: any) {
      console.log(`ssh check failed: ${e.message ?? e}`);
    }
  } else {
    console.log("\n(no --ssh-host given -- skipped relay-side systemctl/free capture)");
  }
}

main();
