// In-repo Myers line diff. No dependency on purpose (repo constraint).
// `patch` is hunk sections only — the diff store's header line owns file metadata.
// Trace memory capped at DIFF_TRACE_BUDGET_BYTES; beyond it the non-common middle degrades to whole-replace.

export interface LineDiff { patch: string; added: number; removed: number; hunkCount: number }

const DIFF_TRACE_BUDGET_BYTES = 32 * 1024 * 1024; // 32 MB budget for trace snapshots

interface Line { text: string; eol: boolean } // eol=false only ever on the last line

function splitLines(s: string): Line[] {
  if (s === "") return [];
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") { out.push({ text: s.slice(start, i), eol: true }); start = i + 1; }
  }
  if (start < s.length) out.push({ text: s.slice(start), eol: false });
  return out;
}

type Op = { tag: "eq" | "del" | "ins"; a?: number; b?: number };

function linesEqual(a: Line, b: Line): boolean {
  return a.text === b.text && a.eol === b.eol;
}

function myersOps(a: Line[], b: Line[], context: number): Op[] {
  // Compute prefix: leading equal lines.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && linesEqual(a[prefix]!, b[prefix]!)) {
    prefix++;
  }

  // Compute suffix: trailing equal lines, capped to not overlap prefix.
  let suffix = 0;
  const maxSuffix = Math.max(0, Math.min(a.length, b.length) - prefix);
  while (suffix < maxSuffix && linesEqual(a[a.length - 1 - suffix]!, b[b.length - 1 - suffix]!)) {
    suffix++;
  }

  // Extract middle slices.
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);

  // Handle empty middle after trimming.
  if (aMid.length === 0 && bMid.length === 0) return [];

  // Standard O(ND) greedy with trace on the middle; falls back to replace-everything when memory-constrained.
  const N = aMid.length, M = bMid.length;
  const max = N + M;
  const snapshotBytes = 4 * (2 * (N + M) + 1);
  const maxD = Math.max(64, Math.floor(DIFF_TRACE_BUDGET_BYTES / Math.max(1, snapshotBytes)));

  const offset = max;
  let v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let reachedEnd = false;
  outer: for (let d = 0; d <= maxD && d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!))
        ? v[offset + k + 1]!
        : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && linesEqual(aMid[x]!, bMid[y]!)) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { trace.push(v.slice()); reachedEnd = true; break outer; }
    }
  }

  // If memory budget exhausted, fall back to whole-file replace for the middle region.
  const ops: Op[] = [];
  if (!reachedEnd) {
    // Whole-file replace: all dels then all inss on the middle region.
    for (let i = 0; i < N; i++) ops.push({ tag: "del", a: prefix + i });
    for (let j = 0; j < M; j++) ops.push({ tag: "ins", b: prefix + j });
  } else {
    // Backtrack.
    let x = N, y = M;
    for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
      const vd = trace[d]!;
      const k = x - y;
      const prevK = (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) ? k + 1 : k - 1;
      const prevX = vd[offset + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; ops.push({ tag: "eq", a: prefix + x, b: prefix + y }); }
      if (d > 0) {
        if (x === prevX) { y--; ops.push({ tag: "ins", b: prefix + y }); }
        else { x--; ops.push({ tag: "del", a: prefix + x }); }
      }
    }
    ops.reverse();
  }

  // Add prefix context: last `context` lines from prefix as eq ops.
  // Add suffix context: first `context` lines from suffix as eq ops.
  // This ensures context lines from trim boundaries are available for hunk grouping.
  const prefixContextOps: Op[] = [];
  for (let i = Math.max(0, prefix - context); i < prefix; i++) {
    prefixContextOps.push({ tag: "eq", a: i, b: i });
  }
  const suffixContextOps: Op[] = [];
  for (let i = 0; i < Math.min(context, suffix); i++) {
    suffixContextOps.push({ tag: "eq", a: a.length - suffix + i, b: b.length - suffix + i });
  }

  return [...prefixContextOps, ...ops, ...suffixContextOps];
}

function renderLine(prefix: string, line: Line): string {
  return prefix + line.text + "\n" + (line.eol ? "" : "\\ No newline at end of file\n");
}

export function computeLineDiff(before: string, after: string, context = 3): LineDiff {
  const a = splitLines(before), b = splitLines(after);
  const ops = myersOps(a, b, context);
  if (!ops.some((o) => o.tag !== "eq")) return { patch: "", added: 0, removed: 0, hunkCount: 0 };

  // Group ops into hunks: a hunk is a run of changes plus `context` eq-lines either side;
  // hunks whose context would touch or overlap merge into one.
  type Hunk = { start: number; end: number }; // op-index range [start, end)
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.tag !== "eq") changed.push(i); });
  const hunks: Hunk[] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context), end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }

  let patch = "", added = 0, removed = 0;
  for (const h of hunks) {
    let aStart = -1, bStart = -1, aCount = 0, bCount = 0, body = "";
    for (let i = h.start; i < h.end; i++) {
      const op = ops[i]!;
      if (op.tag === "eq") {
        if (aStart < 0) { aStart = op.a!; bStart = op.b!; }
        aCount++; bCount++; body += renderLine(" ", a[op.a!]!);
      } else if (op.tag === "del") {
        if (aStart < 0) { aStart = op.a!; bStart = op.b ?? bStartFromContext(ops, i); }
        aCount++; removed++; body += renderLine("-", a[op.a!]!);
      } else {
        if (bStart < 0) { bStart = op.b!; aStart = aStartFromContext(ops, i); }
        bCount++; added++; body += renderLine("+", b[op.b!]!);
      }
    }
    if (aStart < 0) aStart = 0;
    if (bStart < 0) bStart = 0;
    const aHdr = aCount === 0 ? `${aStart},0` : `${aStart + 1},${aCount}`;
    const bHdr = bCount === 0 ? `${bStart},0` : `${bStart + 1},${bCount}`;
    patch += `@@ -${aHdr} +${bHdr} @@\n` + body;
  }
  return { patch, added, removed, hunkCount: hunks.length };
}

// When a hunk opens on a del/ins, derive the counterpart start from the nearest
// neighbouring op so hunk headers stay correct.
function bStartFromContext(ops: Op[], i: number): number {
  for (let j = i - 1; j >= 0; j--) { const o = ops[j]!; if (o.b !== undefined) return o.b + 1; }
  for (let j = i + 1; j < ops.length; j++) { const o = ops[j]!; if (o.b !== undefined) return o.b; }
  return 0;
}
function aStartFromContext(ops: Op[], i: number): number {
  for (let j = i - 1; j >= 0; j--) { const o = ops[j]!; if (o.a !== undefined) return o.a + 1; }
  for (let j = i + 1; j < ops.length; j++) { const o = ops[j]!; if (o.a !== undefined) return o.a; }
  return 0;
}
