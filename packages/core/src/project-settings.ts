import { Settings } from "./settings";

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
