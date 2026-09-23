// WS-21 (spec §5.3, §5.5): "Both runtimes load enabled plugins natively, in code mode only. Skills
// appear as `plugin:skill`." — the daemon no longer builds a skills-only view for a Winter child
// (`SkillStore.childSkillSurface`/`<home>/cache/skill-plugins/`, spec's own "Supersedes" list) and
// `SkillStore`'s OWN plugin tier (`agent/skills.ts#discover`, L3-owned) still scans the RETIRED
// `<home>/plugins` layout — it is not this lane's file to fix (see the lane report's REQUEST FOR L3
// to delete that dead tier), so `skills.list`'s plugin half is built HERE, straight off Contract B's
// installed+enabled set, and the ipc/server.ts handler drops whatever stale `source:"plugin"`
// entries the SkillStore scan still produces before merging this in.
//
// A plugin's skills are claude-native content now (its own `skills/<name>/SKILL.md`, loaded by both
// runtimes directly once the plugin is enabled) — spec §5.4's "install+enable is itself the consent
// for a plugin's claude-native content" means every ENABLED plugin's skills load in a session; there
// is no separate exec-consent gate for skills any more (that was the pre-WS-21 rule, plugin-manifest
// .ts's own `requiredConsentClasses` no longer derives "exec" from shipped skills either).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listPlugins, type PluginManagerOptions } from "./sdk-plugin-api";

export interface PluginSkillMeta {
  name: string;
  description: string;
  source: "plugin";
  path: string;
  loadsInSessions: boolean;
  sessionNote?: string;
}

/** The frontmatter `name:`/`description:` lines out of a SKILL.md — a minimal, tolerant read (not
 *  a full YAML parser): malformed or missing frontmatter degrades to `{}` rather than throwing, the
 *  same "never bricks a skill" posture `SkillStore`'s own scanner takes. Skill IDENTITY is the
 *  directory name (spec §6.3 item 9 — an SDK-level fix, L1a's), so a frontmatter `name:` is read
 *  for display only and never overrides it here. */
function readSkillFrontmatter(path: string): { name?: string; description?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const m = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (m[1] === "name") out.name = value;
    else out.description = value;
  }
  return out;
}

/**
 * Every INSTALLED plugin's skills, named `<plugin>:<dir>` (the same namespacing
 * `SkillStore`'s own retired plugin tier used, spec §5.3's own spelling) — listed regardless of
 * enabled state, same "every skill stays listed, say truthfully whether a session can load it"
 * posture `SkillStore#sessionAvailability` already takes for its own tiers: a DISABLED plugin's
 * skills still appear, with `loadsInSessions:false` and a note to enable the plugin, rather than
 * vanishing outright. `options` is built the same way the plugin RPC block builds it
 * (`pluginManagerOptionsFor`) — same scope resolution, so `skills.list`'s plugin half and
 * `plugin.list`'s own listing can never disagree about which plugins are installed for a `cwd`.
 */
export async function pluginSkillsFor(options: PluginManagerOptions): Promise<PluginSkillMeta[]> {
  const plugins = await listPlugins(options);
  const out: PluginSkillMeta[] = [];
  for (const p of plugins) {
    const skillsDir = join(p.installPath, "skills");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // no skills/ dir — not every plugin ships one
    }
    for (const dir of dirs) {
      const skillMdPath = join(skillsDir, dir, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;
      const fm = readSkillFrontmatter(skillMdPath);
      const name = `${p.id}:${dir}`;
      const description = fm.description ?? "";
      out.push(
        p.enabled
          ? { name, description, source: "plugin", path: skillMdPath, loadsInSessions: true }
          : { name, description, source: "plugin", path: skillMdPath, loadsInSessions: false, sessionNote: `Enable the ${p.id} plugin to use its skills in Code sessions.` },
      );
    }
  }
  return out;
}
