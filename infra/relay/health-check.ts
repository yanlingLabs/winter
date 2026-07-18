#!/usr/bin/env bun
/**
 * Health-checks one or more production relays (SP2b Task 6 Step 3): dual-stack DNS resolution,
 * TLS certificate validity/issuer/days-left, an HTTPS identity probe (the relay's own `GET /`
 * page -- pinned from the real iroh-relay v1.0.2 binary's response, verified locally during
 * this task), and a REAL iroh connectivity probe via `swift run norma-fake-phone probe-relay
 * --url <url>` (binds an endpoint with ONLY that relay configured and awaits `Endpoint.online()`
 * -- i.e. the relay actually accepted a real iroh client, not just a bare HTTPS GET).
 *
 * Usage: bun infra/relay/health-check.ts [hostname ...]
 *   Defaults to relay-1.yanlinglabs.com and relay-2.yanlinglabs.com.
 *
 * Exit code 0 iff every check on every host passed.
 */
import { resolve4, resolve6 } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NORMAKIT_DIR = join(HERE, "..", "..", "apple", "NormaKit");

const DEFAULT_HOSTS = ["relay-1.yanlinglabs.com", "relay-2.yanlinglabs.com"];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkDNS(host: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  try {
    const v4 = await resolve4(host);
    results.push({ name: "DNS A", ok: v4.length > 0, detail: v4.join(", ") || "<empty>" });
  } catch (e) {
    results.push({ name: "DNS A", ok: false, detail: String(e) });
  }
  try {
    const v6 = await resolve6(host);
    results.push({ name: "DNS AAAA", ok: v6.length > 0, detail: v6.join(", ") || "<empty>" });
  } catch (e) {
    results.push({ name: "DNS AAAA", ok: false, detail: String(e) });
  }
  return results;
}

function checkTLS(host: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        resolve({ name: "TLS cert", ok: false, detail: "no peer certificate returned" });
        return;
      }
      const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000);
      const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? "?";
      resolve({ name: "TLS cert", ok: daysLeft > 0, detail: `issuer=${issuer} valid_to=${cert.valid_to} (${daysLeft}d left)` });
    });
    socket.on("error", (err) => resolve({ name: "TLS cert", ok: false, detail: String(err) }));
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ name: "TLS cert", ok: false, detail: "connection timed out" });
    });
  });
}

async function checkHTTPS(host: string): Promise<CheckResult> {
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    const ok = res.status === 200 && text.includes("Iroh Relay");
    return { name: "HTTPS identity", ok, detail: ok ? `status=${res.status} (Iroh Relay page)` : `status=${res.status} body=${text.slice(0, 80)}` };
  } catch (e) {
    return { name: "HTTPS identity", ok: false, detail: String(e) };
  }
}

/**
 * `swift run` builds on first invocation (slow) but is otherwise the simplest correct way to
 * invoke the CLI without duplicating `bench.ts`'s own release-build path here.
 */
function checkIrohProbe(url: string): CheckResult {
  try {
    const out = execFileSync("swift", ["run", "norma-fake-phone", "probe-relay", "--url", url], {
      cwd: NORMAKIT_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    const lastLine = out.trim().split("\n").filter(Boolean).pop() ?? out.trim();
    return { name: "iroh probe", ok: lastLine === "ok", detail: lastLine };
  } catch (e: any) {
    const detail = typeof e.stdout === "string" && e.stdout ? e.stdout.trim() : (e.message ?? String(e));
    return { name: "iroh probe", ok: false, detail };
  }
}

async function main(): Promise<void> {
  const hosts = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_HOSTS;
  let allOK = true;
  for (const host of hosts) {
    console.log(`\n=== ${host} ===`);
    const results: CheckResult[] = [];
    results.push(...(await checkDNS(host)));
    results.push(await checkTLS(host));
    results.push(await checkHTTPS(host));
    // Trailing-dot form -- see relay-config.json / RelayConfigTrust's own comment on why.
    results.push(checkIrohProbe(`https://${host}./`));
    for (const r of results) {
      console.log(`  [${r.ok ? "OK  " : "FAIL"}] ${r.name}: ${r.detail}`);
      if (!r.ok) allOK = false;
    }
  }
  console.log(allOK ? "\nAll checks passed." : "\nSome checks FAILED.");
  process.exit(allOK ? 0 : 1);
}

main();
