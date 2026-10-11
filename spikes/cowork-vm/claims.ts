import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Probe-only coordination. A crash leaves its directory; never break it by PID. */
export function acquireOrchestrator(fixture: string) {
  const path = join(fixture, ".orchestrator-claim");
  mkdirSync(path, { mode: 0o700 });
  const token = randomUUID();
  writeFileSync(join(path, "token"), token, { mode: 0o600, flag: "wx" });
  return { token, release(provenStopped: boolean) { if (provenStopped) rmSync(path, { recursive: true }); } };
}

export function assertOrchestrator(fixture: string, token?: string) {
  const path = join(fixture, ".orchestrator-claim");
  if (!existsSync(path) || !token || readFileSync(join(path, "token"), "utf8") !== token) throw new Error("fixture has another active/uncertain orchestrator");
}
