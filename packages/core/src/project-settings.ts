import { lstatSync, type Stats } from "node:fs";
import { join } from "node:path";
import { readRawSettings, Settings, legacyProjectFilesReadEnabled } from "./settings";
import { LEGACY_PROJECT_DIR } from "./legacy-names";

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

/** Union an overlay's array onto the PRE-merge snapshot (dedup). Returns undefined when the
 *  overlay doesn't touch this array — the caller then leaves acc as deepAssign left it. fix-wave F
 *  (M3): non-string entries (e.g. a malformed `permissions.allow: [123]`) are FILTERED OUT, never
 *  coerced via String() — a stray number silently becoming a look-alike rule string is worse than
 *  just dropping it. Applied to both the base snapshot and the overlay array before the union. */
function unionArrays(pre: unknown, ov: unknown): string[] | undefined {
  if (!Array.isArray(ov)) return undefined;
  const isString = (x: unknown): x is string => typeof x === "string";
  const base = Array.isArray(pre) ? pre.filter(isString) : [];
  return [...new Set([...base, ...ov.filter(isString)])];
}

/** Deep-merge raw overlay objects onto a validated base, in order (later wins). Scalars/objects
 *  last-wins; `permissions.{allow,additionalDirectories}` and `permissions.dangerousDomains.added`
 *  UNION across layers; `provider`/`plugins` never come from an overlay. fix-wave G (M2): each
 *  overlay is applied and validated ONE AT A TIME — a single overlay that produces an invalid
 *  Settings is rolled back and skipped (its keys never land), but every OTHER overlay (earlier or
 *  later in the list) still applies. A type-typo in a trusted settings.json must not silently
 *  discard a perfectly valid settings.local.json layered on top of it. Returns the last valid
 *  state — `base` itself if every overlay is bad (or the only one is). */
export function mergeSettings(base: Settings, overlays: Record<string, unknown>[]): Settings {
  if (!overlays.length) return base;
  let acc = structuredClone(base) as Record<string, any>;
  let lastValid: Settings = base;
  for (const raw of overlays) {
    if (!isObj(raw)) continue;
    const ov = raw as Record<string, any>;
    // Full pre-overlay snapshot (not just base) — a rollback restores "every EARLIER overlay that
    // validated fine", so a later overlay in the chain keeps building on those, not on base alone.
    const preSnapshot = structuredClone(acc);
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
    const parsed = Settings.safeParse(acc);
    if (parsed.success) lastValid = parsed.data;
    else acc = preSnapshot; // this overlay alone broke validation — roll back, skip it, keep going
  }
  return lastValid;
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
  // Phase 9c (P9c-4): the legacy project dir's own file signatures — needed IN THE CACHE KEY
  // because while `projectSig`/`localSig` read "absent" (the Winter-named files don't exist), the
  // effective settings are being read through these instead; without them here, editing the legacy
  // overlay file while purely on the fallback path would serve a stale cached merge forever.
  legacyProjectSig: string;
  legacyLocalSig: string;
  // Review M1 (P9c-4): whether the legacy project/local file was ACTUALLY read into `effective` —
  // mirrors the exact condition the read below gates on (including `trusted`, which the signatures
  // above deliberately do NOT encode — an untrusted cwd can have a non-"absent" legacy signature
  // while never having read it). `legacyOverlayPathsUsed` reads these, never the raw signatures.
  usedLegacyProject: boolean;
  usedLegacyLocal: boolean;
  effective: Settings;
}

/**
 * Cwd-keyed, mtime-cached "effective settings" read-through: `base()` deep-merged (mergeSettings
 * above) with a project's `.winter/settings.json` and `.winter/settings.local.json` — BOTH
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
 * pattern comes from): `<cwd>/.winter` must be a real directory and each settings file a real
 * regular file, or that project's overlays are treated as absent. This matters for the identical
 * reason it does there — the write-fence denies agent writes into a real `.winter` store, but a
 * symlinked `.winter` (or a symlinked settings file) pointing at agent-writable space elsewhere
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
    const dotWinter = join(cwd, ".winter");
    const projectPath = join(dotWinter, "settings.json");
    const localPath = join(dotWinter, "settings.local.json");

    // A symlinked `.winter` would let the per-file lstats below silently follow it into
    // agent-controlled space — lstat only refuses to follow the FINAL path component, and
    // `.winter` is an earlier component once joined with a filename, so checking the files alone
    // can never catch a swapped parent. Only trust the per-file lstats when it's a real directory.
    const dotWinterLstat = lstatOrNull(dotWinter);
    const dotWinterOk = !!dotWinterLstat && dotWinterLstat.isDirectory();
    const projectSig = fileSig(dotWinterOk ? lstatOrNull(projectPath) : null);
    const localSig = fileSig(dotWinterOk ? lstatOrNull(localPath) : null);

    // Phase 9c (P9c-4): the legacy project dir, file-by-file — a legacy overlay file is only ever
    // consulted when its Winter-named counterpart is absent (`projectSig`/`localSig` === "absent")
    // AND `legacy.readLegacyProjectFiles` is on. Same symlink-safety shape as `.winter` above: a
    // symlinked legacy dir is treated as absent, never followed. `legacyProjectFilesReadEnabled`
    // reads `base` directly — no separate settings dep needed, `effective()` already has it.
    const legacyOn = legacyProjectFilesReadEnabled(base);
    const dotLegacy = join(cwd, LEGACY_PROJECT_DIR);
    const dotLegacyLstat = legacyOn ? lstatOrNull(dotLegacy) : null;
    const dotLegacyOk = !!dotLegacyLstat && dotLegacyLstat.isDirectory();
    const legacyProjectPath = join(dotLegacy, "settings.json");
    const legacyLocalPath = join(dotLegacy, "settings.local.json");
    const useLegacyProject = legacyOn && dotLegacyOk && projectSig === "absent";
    const useLegacyLocal = legacyOn && dotLegacyOk && localSig === "absent";
    const legacyProjectSig = fileSig(useLegacyProject ? lstatOrNull(legacyProjectPath) : null);
    const legacyLocalSig = fileSig(useLegacyLocal ? lstatOrNull(legacyLocalPath) : null);

    const cached = this.cache.get(cwd);
    if (
      cached && cached.baseRef === base && cached.trusted === trusted &&
      cached.projectSig === projectSig && cached.localSig === localSig &&
      cached.legacyProjectSig === legacyProjectSig && cached.legacyLocalSig === legacyLocalSig
    ) {
      return cached.effective;
    }

    const overlays: Record<string, unknown>[] = [];
    let cacheable = true;
    const readLegacyProject = trusted && useLegacyProject && legacyProjectSig !== "absent";
    const readLegacyLocal = trusted && useLegacyLocal && legacyLocalSig !== "absent";
    let usedLegacyProject = false;
    let usedLegacyLocal = false;
    if (trusted && projectSig !== "absent") {
      const raw = readRawSettings(projectPath);
      if (raw) overlays.push(raw);
      else cacheable = false; // torn read — don't pin this under the current (torn) signature
    } else if (readLegacyProject) {
      const raw = readRawSettings(legacyProjectPath);
      if (raw) { overlays.push(raw); usedLegacyProject = true; }
      else cacheable = false;
    }
    // fix-wave A1: settings.local.json is trust-gated too, exactly like the project file just
    // above — a repo can `git add -f` a `.winter/settings.local.json` (gitignore is advisory, a
    // force-committed file checks out on a clone same as any other tracked file), so gitignored
    // is NOT a trust boundary. An untrusted cwd applies NEITHER overlay; matches CC ("a
    // repository-committed .claude/settings.local.json still requires workspace trust"). `localSig`
    // is still computed above unconditionally (the cache key is unchanged) — only the READ is
    // gated here; the cache sig already includes `trusted`, so a trust-flip re-resolves correctly.
    if (trusted && localSig !== "absent") {
      const raw = readRawSettings(localPath);
      if (raw) overlays.push(raw);
      else cacheable = false;
    } else if (readLegacyLocal) {
      const raw = readRawSettings(legacyLocalPath);
      if (raw) { overlays.push(raw); usedLegacyLocal = true; }
      else cacheable = false;
    }

    const effective = mergeSettings(base, overlays); // overlays.length === 0 -> returns base verbatim
    if (cacheable) {
      this.cache.set(cwd, { baseRef: base, trusted, projectSig, localSig, legacyProjectSig, legacyLocalSig, usedLegacyProject, usedLegacyLocal, effective });
    } else {
      this.cache.delete(cwd);
    }
    return effective;
  }

  /**
   * Review M1 (P9c-4): which legacy overlay file(s), if any, `cwd`'s effective settings ACTUALLY
   * read from — full paths, for `ContextAssembler`'s combined per-turn deprecation notice. Calls
   * `effective(cwd)` itself first (idempotent — the same cache this class already maintains), so a
   * caller never needs to sequence "resolve settings, then ask this" as two separate steps. Empty
   * for a null/untrusted cwd, a flag-off resolution, or one where nothing fell back.
   */
  legacyOverlayPathsUsed(cwd: string | null): string[] {
    if (!cwd) return [];
    this.effective(cwd); // ensure this cwd's cache entry reflects the CURRENT files/flag/trust
    const cached = this.cache.get(cwd);
    if (!cached) return [];
    const paths: string[] = [];
    if (cached.usedLegacyProject) paths.push(join(cwd, LEGACY_PROJECT_DIR, "settings.json"));
    if (cached.usedLegacyLocal) paths.push(join(cwd, LEGACY_PROJECT_DIR, "settings.local.json"));
    return paths;
  }
}
