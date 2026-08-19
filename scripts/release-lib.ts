/**
 * Pure, unit-tested parts of the release pipeline (scripts/release.ts). Nothing in this file
 * shells out, touches the filesystem, or reads process.argv — every real-world check (identity
 * lookup, notary profile probe, gh auth, git tree/tag state) lives in release.ts and is wired
 * into `preflight()` as a closure; this module only aggregates results and renders text.
 */

export interface Preflight {
  ok: boolean;
  failures: string[];
}

/**
 * Runs every named check and aggregates ALL failures at once (never short-circuits on the
 * first one) so a release attempt can be told everything wrong in a single pass. Each check
 * returns `null` on pass or the exact user-facing failure line on fail.
 */
export function preflight(opts: { checks: Record<string, () => string | null> }): Preflight {
  const failures: string[] = [];
  for (const check of Object.values(opts.checks)) {
    const line = check();
    if (line !== null) failures.push(line);
  }
  return { ok: failures.length === 0, failures };
}

// Distribution backbone (design spec 2026-07-15-release-pipeline-design.md) — GitHub Releases
// is the sole download host; matches the `origin` remote and project.yml's SUFeedURL. Exported
// so release.ts's publish tail (gh release URL, cask url) shares this single source of truth.
export const GH_REPO = "yanlingLabs/norma";

/**
 * Renders one Sparkle appcast `<item>` for the update-check enclosure (the `.zip`). Schema
 * mirrors scripts/sparkle-feed-gate.ts's local test appcast: title/version/shortVersionString,
 * an optional `sparkle:channel` for beta, minimumSystemVersion, and the signed enclosure.
 */
export function appcastItem(i: {
  version: string;
  zipName: string;
  edSignature: string;
  length: number;
  beta: boolean;
  minSystem: string;
}): string {
  const url = `https://github.com/${GH_REPO}/releases/download/v${i.version}/${i.zipName}`;
  const channel = i.beta ? "\n      <sparkle:channel>beta</sparkle:channel>" : "";
  return `    <item>
      <title>${i.version}</title>
      <sparkle:version>${i.version}</sparkle:version>
      <sparkle:shortVersionString>${i.version}</sparkle:shortVersionString>${channel}
      <sparkle:minimumSystemVersion>${i.minSystem}</sparkle:minimumSystemVersion>
      <enclosure url="${url}" sparkle:edSignature="${i.edSignature}" length="${i.length}" type="application/octet-stream"/>
    </item>`;
}

/** Interpolates a brew cask template (T3's packaging/norma.rb.tmpl) — `{{version}}`/`{{sha256}}`/`{{url}}`. */
export function caskFrom(tmpl: string, i: { version: string; sha256: string; url: string }): string {
  return tmpl
    .replaceAll("{{version}}", i.version)
    .replaceAll("{{sha256}}", i.sha256)
    .replaceAll("{{url}}", i.url);
}

export interface DmgStageOp {
  kind: "copy" | "symlink";
  /** copy: absolute source path to copy from. symlink: the link TARGET it should point to. */
  source: string;
  /** Path, relative to the stage dir, where this entry lands. */
  destName: string;
}

/**
 * Plans the DMG staging directory layout: the (already notarized+stapled) app copied in,
 * plus the conventional `/Applications` symlink so a user can drag-install. Pure — returns an
 * operation list; release.ts performs the actual copy/symlink before handing the dir to
 * `hdiutil create -srcfolder`.
 */
export function dmgStagePlan(appPath: string): DmgStageOp[] {
  const appName = appPath.split("/").filter(Boolean).pop();
  if (!appName || !appName.endsWith(".app")) {
    throw new Error(`dmgStagePlan: expected a path ending in .app, got "${appPath}"`);
  }
  return [
    { kind: "copy", source: appPath, destName: appName },
    { kind: "symlink", source: "/Applications", destName: "Applications" },
  ];
}

/**
 * Bundle-relative paths the §11b artifact identity scan deliberately does NOT read, as anchored
 * regexes against POSIX-relative paths (`Contents/…`) inside `Norma.app`.
 *
 * Added by panel-cef Task 5, and kept as narrow as the measurement allowed. The scan reads every
 * shipped byte as text and fails closed on any hit; embedding Chromium adds 317MB of it, so the
 * question was which of that — if any — has to stop being read.
 *
 * MEASURED, not assumed. Scanning the whole vendored CEF 151.3.16 framework with the guard's own
 * pattern produced exactly ONE hit across 317MB and 227 resource entries:
 * `Resources/sw.lproj/locale.pak` — a Swahili noun (Chromium's translation of a UI category
 * label) whose spelling happens to contain one of the guarded substrings. Not an identity leak:
 * a natural-language collision inside a compiled translation blob, in a file that came from CEF's
 * CDN and never touched this machine's compiler.
 *
 * So the exclusion is the CLASS that hit and nothing else: `*.lproj` locale packs, which are
 * Chromium's translations into ~220 languages and thus the one place in the bundle where such a
 * collision is inevitable and meaningless. Deliberately NOT excluded, and still fully scanned:
 *   - the 224MB `Chromium Embedded Framework` Mach-O itself,
 *   - all five `Libraries/*.dylib`,
 *   - every non-locale resource (`resources.pak`, `chrome_*_percent.pak`, `icudtl.dat`,
 *     `v8_context_snapshot.arm64.bin`, `gpu_shader_cache.bin`, `Info.plist`),
 *   - `Contents/Resources/Licenses/CREDITS.html` — 19.6MB of third-party contributor names, the
 *     obvious candidate for exclusion, measured at ZERO hits and therefore left in,
 *   - and every byte Norma actually compiles: the app, the five CEF helpers, norma-core,
 *     NormaHelper, Sparkle.
 * That last group is where the leaks this gate exists for (absolute builder paths in Mach-O debug
 * stabs, v0.2.001) actually happen, and none of it is excluded.
 *
 * Widening this list is a security decision, not a build fix. A future CEF bump that trips the
 * gate somewhere else should be investigated, not appended to.
 */
// `Versions/[^/]+/` because project.yml embeds the framework in the standard macOS VERSIONED
// layout (Versions/A/Resources/…), not the flat one CEF ships — see that script's comment for
// why. Anchored on the version segment rather than skipping it, so the top-level `Resources`
// SYMLINK (…framework/Resources -> Versions/Current/Resources) is deliberately not matched: the
// scan walker never follows symlinks, so a locale pack is reachable by exactly one path.
export const NAME_SCAN_EXCLUSIONS: readonly RegExp[] = [
  /^Contents\/Frameworks\/Chromium Embedded Framework\.framework\/Versions\/[^/]+\/Resources\/[^/]+\.lproj$/,
  // editor-plumbing Task 1 — a DIFFERENT rationale from the rule above, deliberately not
  // dressed up as the same one. The CEF rule is REACTIVE: a real scan found one genuine
  // collision (a Swahili word) and was narrowed to exactly that class. This rule is
  // PROPHYLACTIC: scanning the vendored Monaco tree at implement time (scripts/fetch-monaco.ts,
  // ~14MB of vs/) with this same guard found ZERO hits — nothing is currently being hidden by
  // it. It exists anyway because vs/ is minified third-party JS this repo does not author or
  // review, re-minted wholesale on every version bump — unlike CEF's one-time-found lproj
  // pattern, a future Monaco bump changing every byte of a 14MB minified blob is exactly the
  // kind of event that could produce a fresh, meaningless collision with no advance warning,
  // and there is no practical way to diff-review minified output for that ahead of time.
  // Directory-anchored (`(\/|$)`) rather than a bare prefix so the scan walker prunes the whole
  // vs/ subtree as one excluded node — same shape as the lproj rule above — while a name that
  // merely starts with "vs" (e.g. a hypothetical "vsx" sibling) does not accidentally match.
  // The in-repo `EditorAssets/app` page shell (Norma's OWN code, landed by Task 4) is
  // deliberately NOT covered by this pattern and stays fully scanned — only vendored, unreviewed
  // third-party bytes get this treatment.
  /^Contents\/Resources\/EditorAssets\/vs(\/|$)/,
  // office-plumbing wave — a THIRD rationale, closer to the CEF rule's above than the Monaco
  // rule's: a real scan of the vendored LibreOffice product-set (Contents/Resources/LibreOffice,
  // 3,296 files) with this guard's own pattern found exactly ONE hit, in this one file. IANA's
  // language-subtag registry is a plain-text catalogue of every registered language/region/variant
  // subtag and its human-readable name, in dozens of languages — the guard's pattern happens to
  // also be the correctly-spelled name of one of them. Not an identity leak: this file is
  // unmodified upstream registry data (liblangtag's own vendored copy, itself sourced from IANA),
  // never touched by this machine's compiler, and the match is a natural-language collision —
  // deliberately NOT named
  // here (the collision's own substring/language name is exactly what this guard exists to keep
  // out of a tracked file, so republishing it in this comment would be the leak class itself).
  // Zero hits everywhere else in the tree, including every Mach-O this repo itself compiles or
  // links. Anchored to this ONE file, not a directory — every other file in liblangtag/, and
  // every other file in the LibreOffice tree, stays fully scanned.
  /^Contents\/Resources\/LibreOffice\/Resources\/liblangtag\/language-subtag-registry\.xml$/,
];

export interface NameScanPlanInputs {
  /** Absolute path of the bundle root being scanned. */
  root: string;
  /**
   * Entry names directly inside an absolute directory path. MUST omit symlinks — `find -type f`
   * (what the guard runs on every emitted target) does not traverse them, so emitting one would
   * make the caller's file-count partition disagree with reality, and a symlinked directory would
   * otherwise let an excluded subtree be reached by a second, unexcluded path.
   */
  listDir: (absPath: string) => string[];
  /** Whether an absolute path is a directory. MUST NOT follow symlinks (lstat, not stat). */
  isDir: (absPath: string) => boolean;
  /** Matched against a POSIX path relative to `root`; `""` is the root itself. */
  isExcluded: (relPath: string) => boolean;
}

export interface NameScanPlanResult {
  /** Absolute paths to hand the guard — their union is the whole bundle minus `excluded`. */
  targets: string[];
  /** Absolute paths deliberately left unscanned. Empty means "scanned everything". */
  excluded: string[];
}

/**
 * Partitions a bundle into the coarsest set of paths that covers everything EXCEPT the excluded
 * subtrees — the pure half of release.ts §11b's identity scan.
 *
 * The guard (`name-guard.sh artifacts`) recurses into whatever paths it is given, with no
 * exclusion mechanism of its own, and it lives outside this repo where no review can see it. So
 * the exclusion is expressed here instead, by handing the guard a target list that simply does
 * not contain the excluded paths — the guard is unchanged and unaware.
 *
 * "Coarsest" matters for auditability: a subtree with nothing excluded inside it is emitted as
 * ONE path, so the emitted list stays ~20 entries instead of thousands, and a human reading the
 * release log can see exactly what was and wasn't read. With no exclusions matching anything,
 * this returns `{ targets: [root], excluded: [] }` — byte-identical behaviour to scanning the
 * bundle whole, which is what a CEF-less build gets.
 *
 * Pure: every filesystem touch is an injected callback, so the walk is unit-testable without a
 * 420MB app bundle on disk. release.ts additionally asserts the partition against real `find`
 * counts before calling the guard — this function returning a wrong answer must not be able to
 * silently under-scan a release.
 */
export function nameScanPlan(i: NameScanPlanInputs): NameScanPlanResult {
  const abs = (rel: string) => (rel === "" ? i.root : `${i.root}/${rel}`);

  interface Node {
    targets: string[];
    excluded: string[];
    /** True when nothing in this subtree was excluded, so the subtree can be emitted whole. */
    clean: boolean;
  }

  const walk = (rel: string): Node => {
    if (i.isExcluded(rel)) return { targets: [], excluded: [abs(rel)], clean: false };
    if (!i.isDir(abs(rel))) return { targets: [abs(rel)], excluded: [], clean: true };

    const children = i.listDir(abs(rel)).map((name) => walk(rel === "" ? name : `${rel}/${name}`));
    if (children.every((c) => c.clean)) return { targets: [abs(rel)], excluded: [], clean: true };
    return {
      targets: children.flatMap((c) => c.targets),
      excluded: children.flatMap((c) => c.excluded),
      clean: false,
    };
  };

  const root = walk("");
  return { targets: root.targets, excluded: root.excluded };
}

export interface AppcastInsertPlanInputs {
  dryRun: boolean;
  version: string;
  /** Current contents of the appcast this run would insert into (read by release.ts from
   * whichever file `target` below resolves to — always `releases/appcast.xml` on disk, since
   * that's the only copy that exists; the preview file is only ever an OUTPUT). */
  appcastXml: string;
  /** The rendered `<item>` block (release-lib's `appcastItem()`) to insert for this version. */
  item: string;
}

export interface AppcastInsertPlanResult {
  /** Where release.ts should write `updatedXml` when `action` is "insert": "preview" ->
   * out/release/<v>-dryrun/appcast-preview.xml ONLY (dry-run — F1 fix: never the tracked file;
   * `d3054fa3` moved every dry-run artifact under the `-dryrun` suffix, and release.ts's own
   * mirror of this sentence says the same);
   * "repo" -> releases/appcast.xml (real run — release.ts must do this write from inside its
   * `!DRY_RUN` publish tail, not before). */
  target: "preview" | "repo";
  /** "insert": updatedXml is ready to write. "skip": an <item> for this exact
   * <sparkle:version> is already present — F2 fix, makes re-running (e.g. --resume-publish
   * after a partial failure) idempotent instead of appending a duplicate. */
  action: "insert" | "skip";
  updatedXml?: string;
}

/**
 * Decides where a release's appcast `<item>` should land and whether it needs inserting at
 * all — the pure half of release.ts §10's appcast step (the impure half — reading the real
 * file, writing it, git add/commit/push — stays in release.ts). `--dry-run` always targets
 * "preview" (mirrors `publishGuard`'s dry-run-wins-first shape); a real run targets "repo". A
 * version already present in `appcastXml` (matched by an exact `<sparkle:version>` element) is
 * always "skip", in both modes, so a re-run never appends a duplicate `<item>`. Throws if an
 * insert is needed but `appcastXml` has no `</channel>` to insert before — same "can't find the
 * anchor" failure release.ts used to check for inline.
 */
export function appcastInsertPlan(i: AppcastInsertPlanInputs): AppcastInsertPlanResult {
  const target = i.dryRun ? "preview" : "repo";
  const alreadyPresent = i.appcastXml.includes(`<sparkle:version>${i.version}</sparkle:version>`);
  if (alreadyPresent) return { target, action: "skip" };
  if (!i.appcastXml.includes("</channel>")) {
    throw new Error("appcastXml is missing </channel> — cannot insert the item");
  }
  const updatedXml = i.appcastXml.replace("</channel>", `${i.item}\n  </channel>`);
  return { target, action: "insert", updatedXml };
}

export interface ResolveSigningIdentityInputs {
  /** release.ts's `NORMA_SIGN_IDENTITY` escape hatch — when set, returned as-is with no lookup
   * at all (so `identitiesOutput` doesn't even need to be real, letting a differently-provisioned
   * keychain, e.g. CI, skip `security find-identity` entirely). */
  envOverride?: string;
  /** Raw stdout of `security find-identity -v -p codesigning`. */
  identitiesOutput: string;
  teamId: string;
}

/**
 * Resolves the ONE codesigning identity every `--sign` call in release.ts should use, as a
 * 40-hex-char SHA-1 hash — never a display name — so no legal/company name needs to live in this
 * codebase, and the app resign, its nested/embedded binaries, and the DMG are always signed by
 * the exact same, unambiguous identity (never "whichever Developer ID Application cert happens to
 * match first," which could pick a different identity, e.g. a personal one alongside the org's,
 * if more than one is present in the keychain). Scans `identitiesOutput` line by line for one
 * naming BOTH "Developer ID Application" and `(<teamId>)`, and returns that line's hash. Throws a
 * clear, actionable error when no such line exists.
 */
export function resolveSigningIdentity(i: ResolveSigningIdentityInputs): string {
  if (i.envOverride) return i.envOverride;
  for (const line of i.identitiesOutput.split("\n")) {
    const m = line.match(/([0-9A-Fa-f]{40})\s+"([^"]+)"/);
    if (!m) continue;
    const [, hash, name] = m;
    if (name!.includes("Developer ID Application") && name!.includes(`(${i.teamId})`)) {
      return hash!;
    }
  }
  throw new Error(`no Developer ID Application identity for team ${i.teamId} — create it in Xcode`);
}

export interface PublishGuardInputs {
  dryRun: boolean;
  resumePublish: boolean;
  tagExists: boolean;
  releaseExists: boolean;
  version: string;
}

export interface PublishGuardResult {
  action: "dry-run-skip" | "abort" | "publish" | "resume";
  /** dry-run-skip: the skip-list (what would have run). abort: the exact failure line(s).
   * publish/resume: empty. */
  lines: string[];
}

/**
 * Decides what the publish tail should do, given the current tag/release state. `--dry-run`
 * always wins first (never reachable past it, regardless of other flags) and reports a
 * skip-list instead of aborting. Otherwise: an existing tag or release aborts loudly (exact
 * lines, aggregated like `preflight`) unless `--resume-publish` was passed, in which case a
 * MISSING release is itself an abort ("nothing to resume") and an existing one proceeds as
 * "resume" (upload-missing-only; release.ts does the querying).
 */
export function publishGuard(i: PublishGuardInputs): PublishGuardResult {
  const v = i.version;
  if (i.dryRun) {
    return {
      action: "dry-run-skip",
      lines: [
        `gh release create v${v} --title "Norma ${v}" + upload Norma-${v}.zip + Norma-${v}.dmg`,
        `commit + push releases/appcast.xml`,
        `git tag v${v} && git push origin v${v}`,
      ],
    };
  }
  if (i.resumePublish) {
    if (!i.releaseExists) {
      return {
        action: "abort",
        lines: [`--resume-publish given but release v${v} does not exist — nothing to resume`],
      };
    }
    return { action: "resume", lines: [] };
  }
  const aborts: string[] = [];
  if (i.tagExists) {
    aborts.push(
      `tag v${v} already exists — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (i.releaseExists) {
    aborts.push(
      `release v${v} already exists on GitHub — aborting to avoid double-publish (pass --resume-publish if a prior publish attempt partially completed)`,
    );
  }
  if (aborts.length > 0) return { action: "abort", lines: aborts };
  return { action: "publish", lines: [] };
}

/**
 * Provider-catalogue staleness nudge (T2 review M2). `CODEX_MODELS`'s context windows are
 * hand-held constants re-derived from a live `/models` call; the date of that derivation lives in
 * `CODEX_MODELS_VERIFIED` (packages/core/src/providers/codex-config.ts).
 *
 * WARN-ONLY, and deliberately so. A date-triggered FAILURE would redden a green pipeline on a day
 * nobody touched code, and the reflexive repair for that is to bump the date without checking
 * anything — which destroys the guard's meaning. It lives in the RELEASE pipeline rather than in
 * the test suite because that is the moment the number actually ships and a human is watching the
 * output; a `console.warn` inside a 229-file test run is invisible.
 *
 * Pure and injectable (`now`) so it is unit-testable without waiting 120 days.
 */
export function catalogueStaleness(i: { verified: string; now: Date; staleAfterDays?: number }): {
  stale: boolean;
  ageDays: number;
  line: string | null;
} {
  const budget = i.staleAfterDays ?? 120;
  const parsed = Date.parse(i.verified);
  if (Number.isNaN(parsed)) {
    return {
      stale: true,
      ageDays: NaN,
      line: `WARNING: CODEX_MODELS_VERIFIED is not a parseable date ("${i.verified}") — the catalogue staleness nudge cannot run.`,
    };
  }
  const ageDays = Math.floor((i.now.getTime() - parsed) / 86_400_000);
  if (ageDays <= budget) return { stale: false, ageDays, line: null };
  return {
    stale: true,
    ageDays,
    line:
      `WARNING: Codex model catalogue last verified ${i.verified} (${ageDays} days ago, budget ${budget}). ` +
      `This release ships CODEX_MODELS' context windows as constants; a stale window silently breaks ` +
      `auto-compaction. Re-derive: NORMA_CODEX_LIVE_DRIFT=1 bun test codex-models-drift`,
  };
}
