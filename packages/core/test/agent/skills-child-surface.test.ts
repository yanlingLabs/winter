// B1 (2026-09-22): the skills a runtime CHILD can load, as the agent SDK's own doors.
//
// Measured on the dist install: a Code session's first `Skill {"skill":"superpowers:using-superpowers"}`
// answered `unknown skill ... Available: (none)` with a `superpowers` plugin installed under
// `<home>/plugins/`. The child runs with `settingSources: []` (mode-options.ts), which switches off the
// SDK's own user/project skill discovery, and the daemon never passed `Options.plugins` — so the
// child's index was empty while the daemon's prompt still listed every skill it resolves.
//
// `Options.plugins` is the ONE skill door that survives `settingSources: []` (the SDK's
// `skills/store.ts`: "Plugin and builtin tiers are NOT source-gated"). `childSkillSurface` hands each
// plugin whose skills the daemon resolves to the child as a SKILLS-ONLY view — a directory under
// `<home>/cache/skill-plugins` whose only entry is a `skills` symlink — so that:
//   - the SDK names it by BASENAME (no manifest), i.e. exactly the directory name the daemon
//     qualifies `<plugin>:<skill>` with, whatever the plugin's own manifest calls itself;
//   - nothing else in the plugin rides along: its manifest `hooks`, `agents/*.md`, `commands/` and
//     MCP config would otherwise run or load inside the child without the daemon's exec consent.
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillStore } from "../../src/agent/skills";
import { skillPluginViewsRoot } from "../../src/agent/paths";
import { TrustStore } from "../../src/agent/trust";
import { buildWinterOptions } from "../../src/runtime-sdk/mode-options";

function realDir(): string { return realpathSync(mkdtempSync(join(tmpdir(), "winter-child-skills-"))); }
function writeSkill(root: string, dir: string, name: string, desc: string, body = "BODY") {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
}
function world() {
  const home = realDir();
  const trust = new TrustStore(join(home, "trust.json"));
  return { home, trust };
}

describe("SkillStore.childSkillSurface — the plugin skills a Winter child can load", () => {
  test("an installed plugin's skills reach the child as a skills-only local plugin named by its directory", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "superpowers", "skills"), "using-superpowers", "using-superpowers", "How to use skills");
    writeSkill(join(home, "plugins", "superpowers", "skills"), "brainstorming", "brainstorming", "Explore intent first");
    const s = new SkillStore({ winterHome: home, trust });

    const surface = s.childSkillSurface({ cwd: null });
    const view = join(home, "cache", "skill-plugins", "superpowers");
    expect(surface.plugins).toEqual([{ type: "local", path: view, skipMcpDiscovery: true }]);
    // Exactly the names the daemon itself lists for that tier, in its own precedence order.
    expect(surface.skills).toEqual(s.list({ cwd: null }).filter((m) => m.source === "plugin").map((m) => m.name));
    expect([...surface.skills].sort()).toEqual(["superpowers:brainstorming", "superpowers:using-superpowers"]);
    // The view is the plugin's REAL skills directory, reached through one symlink.
    expect(lstatSync(join(view, "skills")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(view, "skills"))).toBe(join(home, "plugins", "superpowers", "skills"));
    expect(existsSync(join(view, "skills", "using-superpowers", "SKILL.md"))).toBe(true);
  });

  test("the view carries NOTHING but skills — no manifest, hooks, agents, commands or MCP config — and self-heals", () => {
    const { home, trust } = world();
    const plugin = join(home, "plugins", "acme");
    writeSkill(join(plugin, "skills"), "ship", "ship", "Ship it");
    // A claude-format plugin whose manifest names itself differently and declares a hook.
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-renamed", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "touch /tmp/pwned" }] }] } }));
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(join(plugin, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: r\npermissionMode: bypassPermissions\n---\nx\n");
    mkdirSync(join(plugin, "commands"), { recursive: true });
    writeFileSync(join(plugin, "commands", "go.md"), "go");
    writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
    const s = new SkillStore({ winterHome: home, trust });

    const view = join(home, "cache", "skill-plugins", "acme");
    expect(s.childSkillSurface({ cwd: null }).skills).toEqual(["acme:ship"]);
    expect(readdirSync(view)).toEqual(["skills"]);

    // Something planted in the view (or a skills link re-pointed elsewhere) is gone at the next build.
    mkdirSync(join(view, ".claude-plugin"), { recursive: true });
    writeFileSync(join(view, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x", hooks: {} }));
    const elsewhere = realDir();
    const link = join(view, "skills");
    rmSync(link);
    symlinkSync(elsewhere, link);
    s.childSkillSurface({ cwd: null });
    expect(readdirSync(view)).toEqual(["skills"]);
    expect(readlinkSync(link)).toBe(join(plugin, "skills"));
    // Repairing never touches what either link pointed at.
    expect(existsSync(join(plugin, "skills", "ship", "SKILL.md"))).toBe(true);
    expect(existsSync(elsewhere)).toBe(true);
  });

  test("a `Skill(<name>)` deny rule removes that skill from what the child may invoke", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    writeSkill(join(home, "plugins", "p", "skills"), "beta", "beta", "B");
    const s = new SkillStore({ winterHome: home, trust });
    const surface = s.childSkillSurface({ cwd: null, deny: ["Skill(p:beta)", "Bash(rm:*)"] });
    expect(surface.skills).toEqual(["p:alpha"]);
    // The plugin itself still loads: the SDK's `skills` option is what hides and refuses `p:beta`.
    expect(surface.plugins.map((p) => p.path)).toEqual([join(home, "cache", "skill-plugins", "p")]);
  });

  test("a disabled plugin contributes nothing, and the disabled list is read LIVE (no restart)", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    writeSkill(join(home, "plugins", "q", "skills"), "gamma", "gamma", "G");
    let disabled: string[] = ["q"];
    const s = new SkillStore({ winterHome: home, trust, plugins: { disabled: () => disabled } });
    expect(s.childSkillSurface({ cwd: null }).skills).toEqual(["p:alpha"]);
    expect(s.list({ cwd: null }).some((m) => m.name === "q:gamma")).toBe(false);
    disabled = [];
    expect([...s.childSkillSurface({ cwd: null }).skills].sort()).toEqual(["p:alpha", "q:gamma"]);
    expect(s.list({ cwd: null }).some((m) => m.name === "q:gamma")).toBe(true);
  });

  test("no plugin skills → no plugins and no skills (the child's Options stay exactly as before)", () => {
    const { home, trust } = world();
    writeSkill(join(home, "skills"), "greet", "greet", "Say hi");
    const s = new SkillStore({ winterHome: home, trust });
    expect(s.childSkillSurface({ cwd: null })).toEqual({ plugins: [], skills: [], officialDeny: [] });
    expect(existsSync(join(home, "cache", "skill-plugins"))).toBe(false);
  });

  // Review (2026-09-23): a skill is CODE on a session's runtime — claude runs a skill's inline
  // `!`cmd`` and honours its `allowed-tools` without asking the host — so only a plugin the user
  // ENABLED (and, for a manifest plugin, granted `exec` consent to) hands its skills to a session, on
  // either leg.
  test("consent gate: only plugins in the live eligible set are handed over, and the rest say why", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "ok", "skills"), "alpha", "alpha", "A");
    writeSkill(join(home, "plugins", "unconsented", "skills"), "beta", "beta", "B");
    let eligible = new Set(["ok"]);
    const s = new SkillStore({ winterHome: home, trust, plugins: { sessionEligible: () => eligible } });
    const surface = s.childSkillSurface({ cwd: null });
    expect(surface.skills).toEqual(["ok:alpha"]);
    expect(surface.plugins.map((p) => p.path)).toEqual([join(home, "cache", "skill-plugins", "ok")]);
    const beta = s.list({ cwd: null }).find((m) => m.name === "unconsented:beta")!;
    expect(s.sessionAvailability(beta)).toEqual({ loadsInSessions: false, sessionNote: expect.stringContaining('"exec" consent') });
    // Live: consenting later reaches the next spawn; withdrawing prunes the view.
    eligible = new Set(["unconsented"]);
    expect(s.childSkillSurface({ cwd: null }).skills).toEqual(["unconsented:beta"]);
    expect(readdirSync(skillPluginViewsRoot(home))).toEqual(["unconsented"]);
  });

  test("a denied skill whose DIRECTORY differs from its frontmatter name gets a claude-spelling deny alias", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "dir-name", "front-name", "F");
    writeSkill(join(home, "plugins", "p", "skills"), "same", "same", "S");
    const s = new SkillStore({ winterHome: home, trust });
    const surface = s.childSkillSurface({ cwd: null, deny: ["Skill(p:front-name)", "Skill(p:same)"] });
    expect(surface.skills).toEqual([]);
    expect(surface.officialDeny).toEqual(["Skill(p:dir-name)"]);
  });

  test("names the SDK's own jails would refuse are never put in `skills` (the plugin still loads, so the child says why)", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "ok", "ok", "fine");
    writeSkill(join(home, "plugins", "p", "skills"), "bad", "Not A Slug", "refused by the slug jail");
    const s = new SkillStore({ winterHome: home, trust });
    const surface = s.childSkillSurface({ cwd: null });
    expect(surface.skills).toEqual(["p:ok"]);
    expect(surface.plugins).toHaveLength(1);
  });

  // Controller follow-up (2026-09-22): the views moved OUT of `<home>/runtimes`. A skill reads its own
  // supporting files by path ("see foo.md in this directory" — superpowers does it constantly), and
  // `<home>/runtimes` is denied to Read/Glob/Grep and the Bash sandbox on both legs. `<home>/cache` is
  // readable, disposable (Migration B skips `cache/**`), and the views' own subtree is WRITE-fenced —
  // a planted manifest there would be run by the next child as a plugin hook.
  test("the views live where the session can READ a skill's own files, and where it cannot WRITE", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "superpowers", "skills"), "brainstorming", "brainstorming", "B");
    const s = new SkillStore({ winterHome: home, trust });
    const view = s.childSkillSurface({ cwd: null }).plugins[0]!.path;
    expect(view.startsWith(join(home, "cache") + "/")).toBe(true);
    const options = buildWinterOptions({
      mode: "code", policy: "auto", sessionId: "00000000-0000-4000-8000-0000000000c1", home, cwd: realDir(),
      credentials: { byProvider: {} } as never, spawn: { pathToClaudeCodeExecutable: "/x/winter" },
      canUseTool: (async () => ({ behavior: "allow" as const })) as never, abort: new AbortController(), baseEnv: {},
    });
    const skillFile = join(view, "skills", "brainstorming", "SKILL.md");
    // READ: no Read/Glob/Grep deny rule and no sandbox denyRead root covers the view.
    const readDenyRoots = (options.permissions?.deny ?? [])
      .filter((r) => /^(Read|Glob|Grep)\(/.test(r))
      .map((r) => r.slice(r.indexOf("(") + 2, -1).replace(/\/\*\*$/, ""));
    for (const root of [...readDenyRoots, ...(options.sandbox?.filesystem?.denyRead ?? [])]) {
      expect({ root, covers: skillFile === root || skillFile.startsWith(root + "/") }).toEqual({ root, covers: false });
    }
    // WRITE: every write tool and the Bash sandbox are fenced off the whole `<home>/cache` (re-review
    // M-a) — the views AND the directories above them, which a write could otherwise swap for a link.
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(options.permissions?.deny).toContain(`${tool}(/${join(home, "cache")}/**)`);
    }
    expect(options.sandbox?.filesystem?.denyWrite).toContain(join(home, "cache"));
  });

  // Re-review M-a: `<home>/cache` ITSELF may be a link the user made on purpose (a cache on another
  // volume). The daemon never unlinks it: that spawn simply gets no plugin skills, with one log line,
  // and neither the link nor what it points at is touched.
  test("M-a: a symlinked <home>/cache is refused for this spawn — never unlinked, its target untouched", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    const elsewhere = realDir();
    writeFileSync(join(elsewhere, "user-file.txt"), "mine");
    // …including something shaped like a stale view, which a prune through the link would delete (I1).
    mkdirSync(join(elsewhere, "skill-plugins", "stale"), { recursive: true });
    writeFileSync(join(elsewhere, "skill-plugins", "stale", "precious.txt"), "keep me");
    symlinkSync(elsewhere, join(home, "cache"));
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    let surface: ReturnType<SkillStore["childSkillSurface"]>;
    try {
      surface = new SkillStore({ winterHome: home, trust }).childSkillSurface({ cwd: null });
    } finally {
      console.error = orig;
    }
    expect(surface).toEqual({ plugins: [], skills: [], officialDeny: [] });
    expect(lstatSync(join(home, "cache")).isSymbolicLink()).toBe(true);
    expect(readdirSync(elsewhere).sort()).toEqual(["skill-plugins", "user-file.txt"]);
    expect(readdirSync(join(elsewhere, "skill-plugins"))).toEqual(["stale"]);
    expect(existsSync(join(elsewhere, "skill-plugins", "stale", "precious.txt"))).toBe(true);
    expect(logs.filter((l) => l.includes(join(home, "cache")))).toHaveLength(1);
  });

  // Review I1 (2026-09-23), the probe reproduced: a planted `<views>/<plugin>` -> `victim/` link had
  // the victim's contents removed, because the rebuild listed and deleted THROUGH it.
  test("I1: a view planted as a link to someone else's directory is replaced — the victim is untouched", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    const victim = realDir();
    writeFileSync(join(victim, "precious.txt"), "keep me");
    mkdirSync(join(victim, "nested"), { recursive: true });
    writeFileSync(join(victim, "nested", "also.txt"), "keep me too");
    mkdirSync(skillPluginViewsRoot(home), { recursive: true });
    symlinkSync(victim, join(skillPluginViewsRoot(home), "p"));
    // …and a stale entry that is ALSO a link to the victim, to be pruned.
    symlinkSync(victim, join(skillPluginViewsRoot(home), "gone"));

    const s = new SkillStore({ winterHome: home, trust });
    expect(s.childSkillSurface({ cwd: null }).skills).toEqual(["p:alpha"]);
    expect(existsSync(join(victim, "precious.txt"))).toBe(true);
    expect(existsSync(join(victim, "nested", "also.txt"))).toBe(true);
    const view = join(skillPluginViewsRoot(home), "p");
    expect(lstatSync(view).isSymbolicLink()).toBe(false);
    expect(readdirSync(view)).toEqual(["skills"]);
    expect(existsSync(join(skillPluginViewsRoot(home), "gone"))).toBe(false);
  });

  // (I1's `<home>/cache`-swapped-for-a-link case: since re-review M-a the link is never unlinked — the
  // spawn is refused instead; see the "M-a: a symlinked <home>/cache" test above, which also pins that
  // nothing is worked through it.)

  test("a rebuild removes the views of plugins that were removed or disabled", () => {
    const { home, trust } = world();
    writeSkill(join(home, "plugins", "keep", "skills"), "a", "a", "A");
    writeSkill(join(home, "plugins", "gone", "skills"), "b", "b", "B");
    writeSkill(join(home, "plugins", "off", "skills"), "c", "c", "C");
    let disabled: string[] = [];
    const s = new SkillStore({ winterHome: home, trust, plugins: { disabled: () => disabled } });
    s.childSkillSurface({ cwd: null });
    expect(readdirSync(skillPluginViewsRoot(home)).sort()).toEqual(["gone", "keep", "off"]);
    rmSync(join(home, "plugins", "gone"), { recursive: true });
    disabled = ["off"];
    expect(s.childSkillSurface({ cwd: null }).skills).toEqual(["keep:a"]);
    expect(readdirSync(skillPluginViewsRoot(home))).toEqual(["keep"]);
    // Pruning a view never touches the plugin it pointed at.
    expect(existsSync(join(home, "plugins", "off", "skills", "c", "SKILL.md"))).toBe(true);
  });

  // Controller follow-up: nothing may claim a skill is usable in a session when it is not. The one
  // rule `childSkillSurface` filters by is the one `skills.list` reports, per skill.
  test("sessionAvailability: plugin skills load in sessions; every other tier says truthfully why not", () => {
    const { home, trust } = world();
    writeSkill(join(home, "skills"), "greet", "greet", "Say hi");
    writeSkill(join(home, "skills", "self"), "note", "note", "Notes");
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    writeSkill(join(home, "plugins", "p", "skills"), "bad", "Not A Slug", "refused by the jail");
    const s = new SkillStore({ winterHome: home, trust });
    const byName = new Map(s.list({ cwd: null }).map((m) => [m.name, s.sessionAvailability(m)]));
    expect(byName.get("p:alpha")).toEqual({ loadsInSessions: true });
    for (const name of ["greet", "note", "writing-skills", "p:Not A Slug"]) {
      const a = byName.get(name)!;
      expect(a.loadsInSessions).toBe(false);
      expect(typeof a.sessionNote).toBe("string");
      expect(a.sessionNote!.length).toBeGreaterThan(10);
    }
    expect(byName.get("greet")!.sessionNote).toContain("plugin");
  });

  test("the bare-named tiers (user, self, trusted project, builtin) have NO door into the child yet — never put in `skills`", () => {
    const { home, trust } = world();
    writeSkill(join(home, "skills"), "greet", "greet", "Say hi");
    writeSkill(join(home, "skills", "self"), "note", "note", "Notes");
    const cwd = realDir();
    trust.trust(cwd);
    writeSkill(join(cwd, ".winter", "skills"), "proj", "proj", "Project");
    writeSkill(join(home, "plugins", "p", "skills"), "alpha", "alpha", "A");
    const s = new SkillStore({ winterHome: home, trust });
    expect(s.childSkillSurface({ cwd }).skills).toEqual(["p:alpha"]);
  });
});
