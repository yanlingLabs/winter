import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { readRawSettings, Settings } from "./settings";

/** Keys never taken from a project/local overlay (top level only): `provider` is an exfil/MITM
 *  line and a provider-type change requires a daemon restart; `plugins` consent is its own
 *  user-initiated flow (a repo file must not be able to grant it). */
const OVERLAY_EXCLUDED = new Set(["provider", "plugins"]);
/** Keys never traversed at ANY depth: raw JSON.parse output can carry own "__proto__" etc.;
 *  recursing through them reaches Object.prototype (global prototype pollution). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge one raw overlay into the accumulator (mutates acc). Objects recurse; arrays and
 *  scalars replace. The permissions union-arrays are fixed up by the caller AFTER this (it
 *  snapshots their pre-merge values), so plain replacement here is fine. */
function deepAssign(acc: Record<string, unknown>, overlay: Record<string, unknown>, top: boolean): void {
  for (const [k, v] of Object.entries(overlay)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (top && OVERLAY_EXCLUDED.has(k)) continue;
    if (isObj(v) && isObj(acc[k])) deepAssign(acc[k] as Record<string, unknown>, v, false);
    else acc[k] = typeof v === "object" && v !== null ? structuredClone(v) : v;
  }
}

/** Union an overlay's array onto the PRE-merge snapshot (dedup, stringified). Returns undefined
 *  when the overlay doesn't touch this array — the caller then leaves acc as deepAssign left it. */
function unionArrays(pre: unknown, ov: unknown): string[] | undefined {
  if (!Array.isArray(ov)) return undefined;
  const base = Array.isArray(pre) ? pre.map(String) : [];
  return [...new Set([...base, ...ov.map(String)])];
}

/** Deep-merge raw overlay objects onto a validated base, in order (later wins). Scalars/objects
 *  last-wins; `permissions.{allow,additionalDirectories}` and `permissions.dangerousDomains.added`
 *  UNION across layers; `provider`/`plugins` never come from an overlay. The result is re-validated;
 *  an overlay that produces an invalid Settings makes the whole merge fail SAFE to `base`. */
export function mergeSettings(base: Settings, overlays: Record<string, unknown>[]): Settings {
  if (!overlays.length) return base;
  const acc = structuredClone(base) as Record<string, any>;
  for (const raw of overlays) {
    if (!isObj(raw)) continue;
    const ov = raw as Record<string, any>;
    const preAllow = acc.permissions?.allow;
    const preDirs = acc.permissions?.additionalDirectories;
    const preDang = acc.permissions?.dangerousDomains?.added;
    deepAssign(acc, ov, true);
    const mAllow = unionArrays(preAllow, ov.permissions?.allow);
    if (mAllow) { acc.permissions ??= {}; acc.permissions.allow = mAllow; }
    const mDirs = unionArrays(preDirs, ov.permissions?.additionalDirectories);
    if (mDirs) { acc.permissions ??= {}; acc.permissions.additionalDirectories = mDirs; }
    const mDang = unionArrays(preDang, ov.permissions?.dangerousDomains?.added);
    if (mDang) {
      acc.permissions ??= {};
      acc.permissions.dangerousDomains ??= {};
      acc.permissions.dangerousDomains.added = mDang;
    }
  }
  const parsed = Settings.safeParse(acc);
  return parsed.success ? parsed.data : base;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** lstat-derived cache signature for one overlay file: "absent" when the path doesn't exist OR
 *  isn't a regular file — which ALSO refuses a symlinked settings file itself, no separate check
 *  needed: an lstat'd symlink's own `isFile()` is false regardless of what it points to, so it
 *  collapses into the same bucket a missing file gets. A real regular file's lstat IS its stat (no
 *  symlink hop to resolve), so mtimeMs/size are safe to read straight off it. */
function fileSig(lstat: Stats | null): string {
  return lstat && lstat.isFile() ? `${lstat.mtimeMs}:${lstat.size}` : "absent";
}

interface ResolverCacheEntry {
  baseRef: Settings; // the exact object base() returned when this was computed — SettingsWatcher
  // hot-swaps in a NEW object on reload, so `!==` here catches every reload without a deep compare.
  trusted: boolean;
  projectSig: string;
  localSig: string;
  effective: Settings;
}

/**
 * Cwd-keyed, mtime-cached "effective settings" read-through: `base()` deep-merged (mergeSettings
 * above) with a project's `.norma/settings.json` and `.norma/settings.local.json` — BOTH
 * trust-gated (fix-wave A1: gitignored is not a trust boundary — a repo can `git add -f` a
 * settings.local.json, so it needs the same gate the committed file gets). A session with no cwd,
 * an untrusted cwd, or any read failure sees `base()` back verbatim — the SAME object, never a copy.
 *
 * A cache hit requires ALL of: the same `base()` reference (a hot-settings reload swaps the whole
 * object, so a merge computed from the old one must not survive it), the same trust bit (trusting
 * a project mid-session must invalidate immediately, not wait for a file edit), and both overlay
 * files' lstat signature unchanged. A hit costs one trust() call plus a couple of lstats — no
 * reads, no merge.
 *
 * Symlink refusal mirrors permission-rules.ts's `projectRulesFor` (the reviewed precedent this
 * pattern comes from): `<cwd>/.norma` must be a real directory and each settings file a real
 * regular file, or that project's overlays are treated as absent. This matters for the identical
 * reason it does there — the write-fence denies agent writes into a real `.norma` store, but a
 * symlinked `.norma` (or a symlinked settings file) pointing at agent-writable space elsewhere
 * would let overlay content bypass that fence once a later task wires `permissions.allow` through
 * this resolver.
 *
 * Torn-read handling: a settings file that lstat says IS a regular file but fails to parse
 * (`readRawSettings` -> null — e.g. a concurrent non-atomic write, `addLocalDir` writes that way)
 * is dropped from THIS call's merge but never cached — the next `effective()` call re-reads rather
 * than pinning a bad merge under the torn file's signature until it changes again.
 */
export class ProjectSettingsResolver {
  private readonly cache = new Map<string, ResolverCacheEntry>();

  constructor(private readonly deps: { base: () => Settings | null; trust: { isTrusted(dir: string): boolean } }) {}

  effective(cwd: string | null): Settings | null {
    const base = this.deps.base();
    if (!cwd || !base) return base;

    const trusted = this.deps.trust.isTrusted(cwd);
    const dotNorma = join(cwd, ".norma");
    const projectPath = join(dotNorma, "settings.json");
    const localPath = join(dotNorma, "settings.local.json");

    // A symlinked `.norma` would let the per-file lstats below silently follow it into
    // agent-controlled space — lstat only refuses to follow the FINAL path component, and
    // `.norma` is an earlier component once joined with a filename, so checking the files alone
    // can never catch a swapped parent. Only trust the per-file lstats when it's a real directory.
    const dotNormaLstat = lstatOrNull(dotNorma);
    const dotNormaOk = !!dotNormaLstat && dotNormaLstat.isDirectory();
    const projectSig = fileSig(dotNormaOk ? lstatOrNull(projectPath) : null);
    const localSig = fileSig(dotNormaOk ? lstatOrNull(localPath) : null);

    const cached = this.cache.get(cwd);
    if (cached && cached.baseRef === base && cached.trusted === trusted && cached.projectSig === projectSig && cached.localSig === localSig) {
      return cached.effective;
    }

    const overlays: Record<string, unknown>[] = [];
    let cacheable = true;
    if (trusted && projectSig !== "absent") {
      const raw = readRawSettings(projectPath);
      if (raw) overlays.push(raw);
      else cacheable = false; // torn read — don't pin this under the current (torn) signature
    }
    // fix-wave A1: settings.local.json is trust-gated too, exactly like the project file just
    // above — a repo can `git add -f` a `.norma/settings.local.json` (gitignore is advisory, a
    // force-committed file checks out on a clone same as any other tracked file), so gitignored
    // is NOT a trust boundary. An untrusted cwd applies NEITHER overlay; matches CC ("a
    // repository-committed .claude/settings.local.json still requires workspace trust"). `localSig`
    // is still computed above unconditionally (the cache key is unchanged) — only the READ is
    // gated here; the cache sig already includes `trusted`, so a trust-flip re-resolves correctly.
    if (trusted && localSig !== "absent") {
      const raw = readRawSettings(localPath);
      if (raw) overlays.push(raw);
      else cacheable = false;
    }

    const effective = mergeSettings(base, overlays); // overlays.length === 0 -> returns base verbatim
    if (cacheable) this.cache.set(cwd, { baseRef: base, trusted, projectSig, localSig, effective });
    else this.cache.delete(cwd);
    return effective;
  }
}
