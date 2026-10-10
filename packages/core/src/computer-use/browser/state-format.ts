// ComputerV2 Phase 2 — a browser tab's state as the model reads it: the Phase 1 grammar (the helper's
// `StateFormatter`/`StateDiff`, ported) with the tab's own header and lines.
//
//   Tab "Checkout — Shop" — https://shop.example.com/cart · focused [12] · settled 120 ms
//   dialog confirm "Leave this page?" — [91] button "OK" · [92] button "Cancel"
//   [1] main
//     [2] heading "Your cart" (level 2)
//     [3] link "Continue shopping" → shop.example.com
//     [6] iframe "Payment" (pay.example.com)
//       [7] text field "Card number" value=<redacted>
//
// Two spaces per level; past 300 lines what lies out of view folds first (a whole-tab, non-full state), then the
// largest subtrees, the focus path last. A diff compares facets per ref and falls back to the full tree when more
// than half the elements changed.

export const STATE_LINE_CAP = 300;
const VALUE_CAP = 200;
const URL_CAP = 200;

export interface TabNode {
  ref: number;
  role: string;
  name?: string;
  value?: string;
  showEmptyValue?: boolean;
  secure?: boolean;
  states: string[];
  level?: number;
  href?: string;
  origin?: string;
  items?: number;
  off?: boolean;
  unread?: number;
  /** A sentence about this node's content the engine adds (a frame it could not read). */
  note?: string;
  children: TabNode[];
}

export interface TabDialogLine {
  type: string;
  message: string;
  okRef: number;
  cancelRef?: number;
  promptRef?: number;
  promptText?: string;
}

export interface TabHeader {
  title: string;
  url: string;
  focusedRef?: number;
  /** Undefined when no settle was asked for (the clause is omitted). */
  settle?: { settled: boolean; ms: number };
  newPage?: boolean;
  unread?: number;
  dialog?: TabDialogLine;
  /** Lines after the header and the dialog (a file chooser the page opened, a download it started). */
  notes?: string[];
}

export function quote(s: string): string {
  let out = "\"";
  for (const ch of s) {
    switch (ch) {
      case "\"": out += "\\\""; break;
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default: out += ch;
    }
  }
  return `${out}"`;
}

const cut = (s: string, n = VALUE_CAP): string => ([...s].length <= n ? s : `${[...s].slice(0, n).join("")}…`);

export function headerLine(h: TabHeader): string {
  const parts: string[] = [];
  if (h.focusedRef !== undefined) parts.push(`focused [${h.focusedRef}]`);
  if (h.settle !== undefined) parts.push(h.settle.settled ? `settled ${h.settle.ms} ms` : `not settled after ${h.settle.ms} ms`);
  if (h.newPage === true) parts.push("new page");
  if (h.unread !== undefined && h.unread > 0) parts.push(`read cut short: at least ${h.unread.toLocaleString("en-US")} elements not read (the "more" markers show where)`);
  const head = `Tab ${quote(cut(h.title || "(untitled)", 120))} — ${cut(h.url, URL_CAP)}`;
  return parts.length === 0 ? head : `${head} · ${parts.join(" · ")}`;
}

export function dialogLine(d: TabDialogLine): string {
  const buttons: string[] = [];
  if (d.type === "prompt" && d.promptRef !== undefined) buttons.push(`[${d.promptRef}] text field value=${quote(cut(d.promptText ?? ""))}`);
  buttons.push(`[${d.okRef}] button "OK"`);
  if (d.cancelRef !== undefined) buttons.push(`[${d.cancelRef}] button "Cancel"`);
  return `dialog ${d.type} ${quote(cut(d.message, 300))} — ${buttons.join(" · ")}`;
}

function headLines(h: TabHeader): string[] {
  const out = [headerLine(h)];
  if (h.dialog !== undefined) out.push(dialogLine(h.dialog));
  for (const n of h.notes ?? []) out.push(n);
  return out;
}

/** `"…"` for a value, `<redacted>` for a secure or secret-looking one, nothing when it says nothing. */
export function renderedValue(n: TabNode): string | undefined {
  if (n.secure === true || n.value === "<redacted>") return "<redacted>";
  if (n.value === undefined) return undefined;
  if (n.value.length === 0) return n.showEmptyValue === true ? "\"\"" : undefined;
  if (n.value === n.name) return undefined;
  return quote(cut(n.value));
}

/** One node's line, without indentation or a fold marker. */
export function nodeLine(n: TabNode): string {
  let s = `[${n.ref}] ${n.role}`;
  if (n.name !== undefined && n.name.length > 0) s += ` ${quote(cut(n.name))}`;
  const v = renderedValue(n);
  if (v !== undefined) s += ` value=${v}`;
  const paren: string[] = [];
  if (n.origin !== undefined) paren.push(n.origin);
  if (n.items !== undefined) paren.push(n.items === 1 ? "1 item" : `${n.items} items`);
  if (n.level !== undefined) paren.push(`level ${n.level}`);
  paren.push(...n.states);
  if (paren.length > 0) s += ` (${paren.join(", ")})`;
  if (n.href !== undefined) s += ` → ${n.href}`;
  if (n.note !== undefined) s += ` — ${n.note}`;
  return s;
}

const collapseMarker = (count: number, ref: number): string => `(${count} more — state({within:${ref}}))`;
const outOfViewMarker = (count: number, ref: number): string => `… ${count} more out of view — scroll, or state({within:${ref}})`;

function descendantCount(n: TabNode): number {
  let c = 0;
  for (const k of n.children) c += 1 + descendantCount(k);
  return c;
}

/** The indented body of `roots`, folded to `lineCap` (the helper's algorithm). */
export function bodyLines(roots: readonly TabNode[], focusedRef: number | undefined, viewportFirst: boolean, lineCap = STATE_LINE_CAP): string[] {
  interface Item { node: TabNode; parent?: number; depth: number; descendants: number; outOfView: boolean }
  const items: Item[] = [];
  const add = (n: TabNode, parent: number | undefined, depth: number, parentOff: boolean): void => {
    const idx = items.length;
    items.push({ node: n, ...(parent === undefined ? {} : { parent }), depth, descendants: 0, outOfView: parent !== undefined && n.off === true && !parentOff });
    for (const c of n.children) add(c, idx, depth + 1, n.off === true);
  };
  for (const r of roots) add(r, undefined, 0, false);
  for (let i = items.length - 1; i >= 0; i--) {
    const p = items[i]!.parent;
    if (p !== undefined) items[p]!.descendants += 1 + items[i]!.descendants;
  }
  const focusPath = new Set<number>();
  if (focusedRef !== undefined) {
    let i = items.findIndex((it) => it.node.ref === focusedRef);
    if (i >= 0) {
      focusPath.add(i);
      for (let p = items[i]!.parent; p !== undefined; p = items[p]!.parent) { focusPath.add(p); i = p; }
    }
  }
  const elidable = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!it.outOfView || focusPath.has(i)) continue;
    if (it.parent !== undefined) elidable.add(i);
  }
  const collapsed = new Set<number>(items.flatMap((it, i) =>
    it.parent !== undefined && it.node.states.includes("collapsed") && it.node.children.length > 0 && !focusPath.has(i) ? [i] : []));
  let eliding = false;
  const hiddenAt: boolean[] = new Array(items.length).fill(false);
  const shown: number[] = new Array(items.length).fill(0);
  const summaries = new Set<number>();
  const recount = (): number => {
    let lines = 0;
    summaries.clear();
    for (let i = 0; i < items.length; i++) {
      const p = items[i]!.parent;
      hiddenAt[i] = p === undefined ? false : hiddenAt[p]! || collapsed.has(p);
      if (eliding && elidable.has(i) && !hiddenAt[i]) {
        hiddenAt[i] = true;
        if (p !== undefined) summaries.add(p);
      }
      if (!hiddenAt[i]) lines += 1;
    }
    shown.fill(0);
    for (let i = items.length - 1; i >= 0; i--) {
      if (hiddenAt[i]) continue;
      const p = items[i]!.parent;
      if (p !== undefined) shown[p]! += 1 + shown[i]!;
    }
    return lines + summaries.size;
  };
  let total = recount();
  if (viewportFirst && total > lineCap && elidable.size > 0) { eliding = true; total = recount(); }
  while (total > lineCap) {
    let best: number | undefined;
    const size = (i: number): number => (eliding ? shown[i]! : items[i]!.descendants);
    for (let pass = 0; pass < 3 && best === undefined; pass++) {
      for (let i = 0; i < items.length; i++) {
        if (size(i) <= 0 || collapsed.has(i) || hiddenAt[i]) continue;
        if (pass < 2 && items[i]!.parent === undefined) continue;
        if (pass === 0 && focusPath.has(i)) continue;
        if (best === undefined || size(i) > size(best)) best = i;
      }
    }
    if (best === undefined) break;
    collapsed.add(best);
    total = recount();
  }
  const outOfViewCount = new Map<number, number>();
  if (eliding) {
    for (const i of elidable) {
      const p = items[i]!.parent;
      if (p !== undefined && summaries.has(p)) outOfViewCount.set(p, (outOfViewCount.get(p) ?? 0) + 1 + descendantCount(items[i]!.node));
    }
  }
  const marked = new Set<number>();
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (hiddenAt[i]) {
      const p = it.parent;
      if (eliding && elidable.has(i) && p !== undefined && summaries.has(p) && !marked.has(p)) {
        marked.add(p);
        out.push(`${"  ".repeat(it.depth)}${outOfViewMarker(outOfViewCount.get(p) ?? 0, items[p]!.node.ref)}`);
      }
      continue;
    }
    let text = `${"  ".repeat(it.depth)}${nodeLine(it.node)}`;
    if (collapsed.has(i)) text += ` ${collapseMarker(descendantCount(it.node), it.node.ref)}`;
    else if (it.node.unread !== undefined && it.node.unread > 0) text += ` ${collapseMarker(it.node.unread, it.node.ref)}`;
    out.push(text);
  }
  return out;
}

/** The full state's text. */
export function fullState(h: TabHeader, roots: readonly TabNode[], viewportFirst: boolean, lineCap = STATE_LINE_CAP): string {
  return [...headLines(h), ...bodyLines(roots, h.focusedRef, viewportFirst, lineCap)].join("\n");
}

// ── snapshots and diffs ─────────────────────────────────────────────────────────────────────────

interface Facets { role: string; name?: string; value?: string; states: string[]; items?: number; extra: string; line: string }

export interface TabSnapshot {
  id: string;
  /** The `within` ref it was scoped to: diffs compare only snapshots of the same scope. */
  scope?: number;
  facets: Map<number, Facets>;
  order: number[];
}

export function makeSnapshot(id: string, roots: readonly TabNode[], scope?: number): TabSnapshot {
  const facets = new Map<number, Facets>();
  const order: number[] = [];
  const visit = (n: TabNode): void => {
    if (!facets.has(n.ref)) {
      order.push(n.ref);
      const name = n.name === undefined || n.name.length === 0 ? undefined : quote(cut(n.name));
      const value = renderedValue(n);
      facets.set(n.ref, {
        role: n.role, ...(name === undefined ? {} : { name }), ...(value === undefined ? {} : { value }), states: [...n.states],
        ...(n.items === undefined ? {} : { items: n.items }), extra: `${n.level ?? ""}|${n.href ?? ""}|${n.origin ?? ""}`, line: nodeLine(n),
      });
    }
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return { id, ...(scope === undefined ? {} : { scope }), facets, order };
}

export interface TabDiff { text: string; changedRatio: number }

/** The diff of `next` against `old`, or the change ratio alone when it is over half (the caller prints the full tree). */
export function diffState(h: TabHeader, old: TabSnapshot, next: TabSnapshot, lineCap = STATE_LINE_CAP): TabDiff {
  const added: number[] = [];
  const modified: Array<{ ref: number; changes: string[] }> = [];
  for (const ref of next.order) {
    const n = next.facets.get(ref)!;
    const o = old.facets.get(ref);
    if (o === undefined) { added.push(ref); continue; }
    const c: string[] = [];
    if (o.role !== n.role) c.push(`role ${o.role} → ${n.role}`);
    if (o.name !== n.name) c.push(`name ${o.name ?? "none"} → ${n.name ?? "none"}`);
    if (o.value !== n.value) c.push(`value ${o.value ?? "none"} → ${n.value ?? "none"}`);
    if (o.states.join(",") !== n.states.join(",")) c.push(`states (${o.states.join(", ")}) → (${n.states.join(", ")})`);
    if (o.items !== n.items) c.push(`items ${o.items ?? "none"} → ${n.items ?? "none"}`);
    if (o.extra !== n.extra && c.length === 0) c.push(`now ${n.line}`);
    if (c.length > 0) modified.push({ ref, changes: c });
  }
  const nextRefs = new Set(next.order);
  const removed = old.order.filter((r) => !nextRefs.has(r));
  const union = new Set([...old.order, ...next.order]).size;
  const changed = added.length + removed.length + modified.length;
  const changedRatio = union === 0 ? 0 : Math.min(1, changed / union);
  let body: string[] = [
    ...added.map((r) => `+ ${next.facets.get(r)!.line}`),
    ...modified.map((m) => `~ [${m.ref}] ${m.changes.join("; ")}`),
    ...removed.map((r) => `- [${r}]`),
  ];
  if (body.length === 0) body = ["(no changes)"];
  if (body.length > lineCap) {
    const more = body.length - lineCap;
    body = [...body.slice(0, lineCap), `… (${more} more changes — state({full:true}))`];
  }
  return { text: [...headLines(h), ...body].join("\n"), changedRatio };
}
