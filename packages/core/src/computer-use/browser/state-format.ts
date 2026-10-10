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
// largest subtrees, the focus path last. A `full: true` state is everything the page runtime read, up to
// `FULL_STATE_LINE_CAP` (its own read budget), and says where it was cut when it had to fold anyway (as the helper's
// does). A diff compares facets per ref and falls back to the full tree when more than half the elements changed.

export const STATE_LINE_CAP = 300;
/** A `full: true` state's hard cap: the page runtime's default read budget (`snapshot`'s `maxNodes`)… */
export const FULL_STATE_LINE_CAP = 4_000;
/** …and in bytes: a ComputerV2 result's text is cut at 64 KiB, and a full state's own cut line must survive it. */
export const FULL_STATE_BYTE_CAP = 48 * 1024;
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

/** The indented body of `roots`, folded to `lineCap` (the helper's algorithm). `whole` (`full: true`): also held to
 *  `byteCap` (UTF-8, its lines and newlines) so its cut line survives the result's own cap, folded to keep as much
 *  as fits (a long list keeps its head, its tail behind one marker), and a state that still had to fold ends with a
 *  line saying so. */
export function bodyLines(roots: readonly TabNode[], focusedRef: number | undefined, viewportFirst: boolean, lineCap = STATE_LINE_CAP,
                          whole = false, byteCap = FULL_STATE_BYTE_CAP): string[] {
  interface Item { node: TabNode; parent?: number; depth: number; descendants: number; outOfView: boolean; bytes: number; childIndex: number }
  const items: Item[] = [];
  const childrenOf = new Map<number, number[]>();
  const add = (n: TabNode, parent: number | undefined, depth: number, parentOff: boolean, childIndex: number): void => {
    const idx = items.length;
    const bytes = whole ? depth * 2 + utf8Length(nodeLine(n)) + 1 : 0;
    items.push({ node: n, ...(parent === undefined ? {} : { parent }), depth, descendants: 0, outOfView: parent !== undefined && n.off === true && !parentOff, bytes, childIndex });
    if (parent !== undefined) {
      const siblings = childrenOf.get(parent);
      if (siblings) siblings.push(idx); else childrenOf.set(parent, [idx]);
    }
    n.children.forEach((c, k) => add(c, idx, depth + 1, n.off === true, k));
  };
  roots.forEach((r, k) => add(r, undefined, 0, false, k));
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
  const shownBytes: number[] = new Array(items.length).fill(0);
  const summaries = new Set<number>();
  // A full state's tail cut: from this child on, a parent's children are folded behind one marker line.
  const tailFrom = new Map<number, number>();
  const liveTails = (): number => [...tailFrom.keys()].filter((p) => !hiddenAt[p] && !collapsed.has(p)).length;
  let bytes = 0;
  const recount = (): number => {
    let lines = 0;
    bytes = 0;
    summaries.clear();
    for (let i = 0; i < items.length; i++) {
      const p = items[i]!.parent;
      hiddenAt[i] = p === undefined ? false : hiddenAt[p]! || collapsed.has(p) || (tailFrom.has(p) && items[i]!.childIndex >= tailFrom.get(p)!);
      if (eliding && elidable.has(i) && !hiddenAt[i]) {
        hiddenAt[i] = true;
        if (p !== undefined) summaries.add(p);
      }
      if (!hiddenAt[i]) { lines += 1; bytes += items[i]!.bytes + (collapsed.has(i) ? 60 : 0); }
    }
    bytes += (summaries.size + liveTails()) * 90;
    shown.fill(0);
    shownBytes.fill(0);
    for (let i = items.length - 1; i >= 0; i--) {
      if (hiddenAt[i]) continue;
      const p = items[i]!.parent;
      if (p !== undefined) { shown[p]! += 1 + shown[i]!; shownBytes[p]! += items[i]!.bytes + shownBytes[i]!; }
    }
    return lines + summaries.size + liveTails();
  };
  let total = recount();
  if (viewportFirst && total > lineCap && elidable.size > 0) { eliding = true; total = recount(); }
  const preFolded = new Set(collapsed);
  const bodyBytes = whole ? byteCap - 512 : Number.POSITIVE_INFINITY;
  while (total > lineCap || bytes > bodyBytes) {
    let best: number | undefined;
    const size = (i: number): number => (eliding ? shown[i]! : items[i]!.descendants);
    // Only the byte cap binds: weighed in bytes, and a fold that hides less than its marker costs is none.
    const byBytes = total <= lineCap;
    const weight = (i: number): number => (byBytes ? shownBytes[i]! : size(i));
    const over = byBytes ? bytes - bodyBytes : total - lineCap;
    const fitting = whole ? 4 * over : Number.POSITIVE_INFINITY;
    const minWeight = byBytes ? 150 : 1;
    for (let pass = 0; pass < 3 && best === undefined; pass++) {
      let smallestEnough: number | undefined;
      for (let i = 0; i < items.length; i++) {
        if (size(i) <= 0 || weight(i) < minWeight || collapsed.has(i) || hiddenAt[i]) continue;
        if (pass < 2 && items[i]!.parent === undefined) continue;
        if (pass === 0 && focusPath.has(i)) continue;
        if (weight(i) <= fitting) { if (best === undefined || weight(i) > weight(best)) best = i; }
        else if (smallestEnough === undefined || weight(i) < weight(smallestEnough)) smallestEnough = i;
      }
      if (best === undefined) best = smallestEnough;
    }
    if (best === undefined) break;
    const kids = (childrenOf.get(best) ?? []).filter((k) => !hiddenAt[k]);
    if (whole && weight(best) * 4 > over * 5 && kids.length > 1) {
      // The only subtree big enough is far bigger than what is over (a long list): its head stays, its tail folds.
      let hid = 0;
      let from = kids.length;
      while (from > 1 && hid < over + (byBytes ? 90 : 1)) {
        from -= 1;
        const k = kids[from]!;
        hid += byBytes ? items[k]!.bytes + shownBytes[k]! : 1 + shown[k]!;
      }
      tailFrom.set(best, items[kids[from]!]!.childIndex);
      total = recount();
      continue;
    }
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
  const tailCount = new Map<number, number>();
  for (const [p, from] of tailFrom) {
    if (hiddenAt[p] || collapsed.has(p)) continue;
    tailCount.set(p, (childrenOf.get(p) ?? []).filter((k) => items[k]!.childIndex >= from).reduce((n, k) => n + 1 + descendantCount(items[k]!.node), 0));
  }
  const marked = new Set<number>();
  const tailMarked = new Set<number>();
  const out: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (hiddenAt[i]) {
      const p = it.parent;
      if (eliding && elidable.has(i) && p !== undefined && summaries.has(p) && !marked.has(p)) {
        marked.add(p);
        out.push(`${"  ".repeat(it.depth)}${outOfViewMarker(outOfViewCount.get(p) ?? 0, items[p]!.node.ref)}`);
      }
      if (p !== undefined && tailCount.has(p) && it.childIndex === tailFrom.get(p) && !tailMarked.has(p)) {
        tailMarked.add(p);
        out.push(`${"  ".repeat(it.depth)}… ${collapseMarker(tailCount.get(p)!, items[p]!.node.ref)}`);
      }
      continue;
    }
    let text = `${"  ".repeat(it.depth)}${nodeLine(it.node)}`;
    if (collapsed.has(i)) text += ` ${collapseMarker(descendantCount(it.node), it.node.ref)}`;
    else if (it.node.unread !== undefined && it.node.unread > 0) text += ` ${collapseMarker(it.node.unread, it.node.ref)}`;
    out.push(text);
  }
  const cut = [...collapsed].filter((i) => !preFolded.has(i) && !hiddenAt[i]);
  if (whole && (cut.length > 0 || eliding || tailCount.size > 0)) {
    const folded = cut.reduce((n, i) => n + descendantCount(items[i]!.node), 0) + [...outOfViewCount.values()].reduce((a, b) => a + b, 0)
      + [...tailCount.values()].reduce((a, b) => a + b, 0);
    out.push(wholeCutMarker(lineCap, folded, items.length > lineCap ? undefined : Math.floor(byteCap / 1024)));
  }
  return out;
}

function utf8Length(s: string): number { return Buffer.byteLength(s, "utf8"); }

/** The last line of a `full: true` state that still had to fold: at its line cap, or at its byte cap (`kb`) — the
 *  helper's wording. */
export function wholeCutMarker(cap: number, folded: number, kb?: number): string {
  return `… the full state is cut at ${kb === undefined ? `${cap.toLocaleString("en-US")} lines` : `${kb} KB`}: ${folded.toLocaleString("en-US")} elements are folded behind the "more" markers above — read each with state({within})`;
}

/** The full state's text. `whole` (`full: true`): folded only past `FULL_STATE_LINE_CAP`, and said when it is. */
export function fullState(h: TabHeader, roots: readonly TabNode[], viewportFirst: boolean, lineCap = STATE_LINE_CAP, whole = false): string {
  return [...headLines(h), ...bodyLines(roots, h.focusedRef, viewportFirst, whole ? Math.max(lineCap, FULL_STATE_LINE_CAP) : lineCap, whole)].join("\n");
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
