// ComputerV2 (2026-10-08) — per-primitive timing telemetry (spec §15, spine §5): one JSON line per primitive in
// `<home>/logs/automation-metrics.jsonl`, rotated at 8 MB (one previous file kept, the daemon log's own rule).
// NO CONTENT ever: no code, no typed text, no screen text, no image bytes — ids, names, numbers.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PrimitiveMetric {
  ts: number;
  sessionId: string;
  callId: string;
  primitive: string;
  /** Daemon wall time for the primitive, ms (policy, locks and the helper round trip included). */
  ms: number;
  /** The helper round trip alone, ms (0 for a primitive that never reached the helper). */
  helperMs: number;
  rung?: number;
  settleMs?: number;
  settleExit?: "quiet" | "cap";
  imageBytes?: number;
  /** The typed failure, when the primitive failed (`StaleRef`, `TargetBusy`, …). */
  error?: string;
  /** The helper's error code behind it (`unsupported`, `window_elsewhere`, …), when the helper refused. */
  errorCode?: string;
  /**
   * THE DESKTOP SWITCH (the ruling, 2026-10-10 — every switch is counted): the visits this primitive made to its
   * window's desktop (`count`, their total `ms`, whether the user was back after every one — `returned` — and
   * whether they took over during one — `userMoved`).
   */
  visit?: { count: number; ms: number; returned: boolean; userMoved?: boolean };
  /** How the run's desktop-switch prompt ended for this primitive: a person's `allow`/`refuse`, `timeout-allow`
   *  (no answer within the minute), `aborted`, or the run's earlier answer reused (`run-allowance`/`run-refusal`). */
  visitAnswer?: "allow" | "refuse" | "timeout-allow" | "aborted" | "run-allowance" | "run-refusal";
  /** Where a person answered it: the session's `card`, the helper's on-screen `panel`; or `timeout`, `none`. */
  visitVia?: "card" | "panel" | "timeout" | "none";
}

export const AUTOMATION_METRICS_MAX_BYTES = 8 * 1024 * 1024;

export class AutomationTelemetry {
  readonly path: string;
  private dirEnsured = false;
  private writes = 0;

  constructor(home: string, private readonly maxBytes: number = AUTOMATION_METRICS_MAX_BYTES) {
    this.path = join(home, "logs", "automation-metrics.jsonl");
  }

  primitive(metric: PrimitiveMetric): void {
    try {
      if (!this.dirEnsured) { mkdirSync(dirname(this.path), { recursive: true }); this.dirEnsured = true; }
      // The size check is cheap but not free: once every 64 lines, and on the first.
      if (this.writes++ % 64 === 0) this.rotateIfLarge();
      appendFileSync(this.path, `${JSON.stringify(metric)}\n`);
    } catch { /* telemetry never fails a primitive */ }
  }

  private rotateIfLarge(): void {
    try {
      if (statSync(this.path).size >= this.maxBytes) renameSync(this.path, `${this.path}.1`);
    } catch { /* absent: nothing to rotate */ }
  }
}
