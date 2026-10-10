// ComputerV2 Phase 2 — the AppAdapter table: bundle id (and version conditions) → Winter's hand-written adapter. The
// built-in set lives in `apps/`; a test daemon may add its own (the live suite's fixture adapter, `wiring.ts`'s
// `ComputerUseInjection.adapters`). Every adapter is VALIDATED when the registry is built: names, classes, the caps
// (summary ≤ 120 characters, doc ≤ 600 bytes, guide ≤ 2,000 bytes) and unique guide ids — a bad table fails loudly.
import { chromiumAdapter } from "./apps/chromium";
import { finderAdapter } from "./apps/finder";
import { mailAdapter } from "./apps/mail";
import { notesAdapter } from "./apps/notes";
import { safariAdapter } from "./apps/safari";
import { xcodeAdapter } from "./apps/xcode";
import type { AppAdapter } from "./types";

export const EXTRA_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;
export const GUIDE_ID = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;
export const GUIDE_MAX_BYTES = 2_000;
export const SUMMARY_MAX_CHARS = 120;
export const DOC_MAX_BYTES = 600;
/** Names an extra may not take: `help`'s own topics, and what every object (or `await`) reads. */
const RESERVED_EXTRA_NAMES = new Set(["dict", "then", "constructor", "toString", "toJSON", "valueOf", "hasOwnProperty"]);

/** The initial adapters (spine §2.9's table). Never renamed without telling the controller. */
export const BUILTIN_ADAPTERS: readonly AppAdapter[] = [finderAdapter, safariAdapter, mailAdapter, notesAdapter, xcodeAdapter, chromiumAdapter];

/** Why this adapter table is unusable, one line per problem (empty: usable). */
export function adapterProblems(adapters: readonly AppAdapter[]): string[] {
  const problems: string[] = [];
  const guides = new Set<string>();
  const owner = new Map<string, number>();
  adapters.forEach((a, i) => {
    const who = a.bundleIds[0] ?? `adapter #${i}`;
    if (a.bundleIds.length === 0) problems.push(`${who}: no bundle ids`);
    for (const id of a.bundleIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) problems.push(`${who}: "${id}" is not a bundle id`);
      // Several adapters for one bundle id are allowed only with version conditions telling them apart.
      if (owner.has(id) && (a.versions === undefined || adapters[owner.get(id)!]!.versions === undefined)) problems.push(`${who}: ${id} has two adapters without version conditions`);
      owner.set(id, i);
    }
    for (const v of [a.versions?.min, a.versions?.max]) if (v !== undefined && !/^\d+(\.\d+)*$/.test(v)) problems.push(`${who}: version "${v}" is not dotted numbers`);
    if (a.guide !== undefined) {
      if (!GUIDE_ID.test(a.guide.id)) problems.push(`${who}: guide id "${a.guide.id}" is not "<key>@<rev>"`);
      if (guides.has(a.guide.id)) problems.push(`${who}: guide id "${a.guide.id}" is used twice`);
      guides.add(a.guide.id);
      const bytes = Buffer.byteLength(a.guide.text);
      if (bytes > GUIDE_MAX_BYTES) problems.push(`${who}: guide ${a.guide.id} is ${bytes} bytes (at most ${GUIDE_MAX_BYTES})`);
      if (a.guide.text.trim().length === 0) problems.push(`${who}: guide ${a.guide.id} is empty`);
    }
    const names = new Set<string>();
    for (const e of a.extras) {
      if (!EXTRA_NAME.test(e.name) || RESERVED_EXTRA_NAMES.has(e.name)) problems.push(`${who}: extra name "${e.name}" is not allowed`);
      if (names.has(e.name)) problems.push(`${who}: extra "${e.name}" is defined twice`);
      names.add(e.name);
      if (e.access !== "view" && e.access !== "click" && e.access !== "full") problems.push(`${who}: extra ${e.name} has no access class`);
      if (!e.signature.startsWith(`${e.name}(`)) problems.push(`${who}: extra ${e.name}'s signature does not start with its name`);
      if (/[\n\r]/.test(e.signature) || /[\n\r]/.test(e.summary)) problems.push(`${who}: extra ${e.name}'s signature and summary are one line each`);
      if (e.summary.length === 0 || e.summary.length > SUMMARY_MAX_CHARS) problems.push(`${who}: extra ${e.name}'s summary is ${e.summary.length} characters (1 to ${SUMMARY_MAX_CHARS})`);
      if (e.doc !== undefined && Buffer.byteLength(e.doc) > DOC_MAX_BYTES) problems.push(`${who}: extra ${e.name}'s doc is ${Buffer.byteLength(e.doc)} bytes (at most ${DOC_MAX_BYTES})`);
    }
  });
  return problems;
}

/** `a` vs `b` per dot component (`10.2` < `10.10`); missing components count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export class AdapterRegistry {
  private readonly byId = new Map<string, AppAdapter[]>();

  constructor(readonly adapters: readonly AppAdapter[] = BUILTIN_ADAPTERS) {
    const problems = adapterProblems(adapters);
    if (problems.length > 0) throw new Error(`the app adapter table is invalid: ${problems.join("; ")}`);
    for (const a of adapters) {
      for (const id of a.bundleIds) {
        const key = id.toLowerCase();
        this.byId.set(key, [...(this.byId.get(key) ?? []), a]);
      }
    }
  }

  /** Does any adapter for this bundle id state version conditions (so the app's version must be known)? */
  versioned(bundleId: string): boolean {
    return (this.byId.get(bundleId.toLowerCase()) ?? []).some((a) => a.versions !== undefined);
  }

  /** The adapter for this app at this version (`CFBundleShortVersionString`). An adapter with version conditions never
   *  matches an app whose version is unknown. */
  find(bundleId: string, version?: string): AppAdapter | undefined {
    for (const a of this.byId.get(bundleId.toLowerCase()) ?? []) {
      if (a.versions === undefined) return a;
      if (version === undefined || !/^\d+(\.\d+)*/.test(version)) continue;
      const v = /^\d+(\.\d+)*/.exec(version)![0];
      if (a.versions.min !== undefined && compareVersions(v, a.versions.min) < 0) continue;
      if (a.versions.max !== undefined && compareVersions(v, a.versions.max) > 0) continue;
      return a;
    }
    return undefined;
  }
}
