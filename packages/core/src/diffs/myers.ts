// In-repo Myers line diff. No dependency on purpose (repo constraint).
// `patch` is hunk sections only — the diff store's header line owns file metadata.

export interface LineDiff { patch: string; added: number; removed: number; hunkCount: number }

const MAX_DIFF_LINES = 30_000; // O(ND) guard: past this, emit whole-file replace

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

function myersOps(a: Line[], b: Line[]): Op[] {
  // Standard O(ND) greedy with trace; falls back to replace-everything when huge.
  const N = a.length, M = b.length;
  if (N + M > MAX_DIFF_LINES * 2) {
    const ops: Op[] = [];
    for (let i = 0; i < N; i++) ops.push({ tag: "del", a: i });
    for (let j = 0; j < M; j++) ops.push({ tag: "ins", b: j });
    return ops;
  }
  const max = N + M;
  const offset = max;
  let v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]))
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x]!.text === b[y]!.text && a[x]!.eol === b[y]!.eol) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { trace.push(v.slice()); break outer; }
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = N, y = M;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push({ tag: "eq", a: x, b: y }); }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ tag: "ins", b: y }); }
      else { x--; ops.push({ tag: "del", a: x }); }
    }
  }
  return ops.reverse();
}

function renderLine(prefix: string, line: Line): string {
  return prefix + line.text + "\n" + (line.eol ? "" : "\\ No newline at end of file\n");
}

export function computeLineDiff(before: string, after: string, context = 3): LineDiff {
  const a = splitLines(before), b = splitLines(after);
  const ops = myersOps(a, b);
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
