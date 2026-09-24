// Router 3279a1d (Contract A `escapeSandboxGlobPath`) — does the daemon's sandbox fence hold under a
// directory whose name holds `[`, on BOTH real binaries?
//
// claude reads a `sandbox.filesystem` entry holding any of `* ? [ ]` as a GLOB (a seatbelt regex), so a
// raw `[wip] app` entry is a character class that misses the literal directory. `childSandboxConfigFor`
// spells it `[[]wip] app`. Measured with the daemon's OWN list for a `[wip] app` project: the spelled list
// must stop a python and a redirect write into `.winter/skills` while an ordinary cwd write lands; the raw
// (literal) list is the control, and R.3 I-6 ASSERTS it — its writes land (the gap the spelling closes).
//
// The Winter leg (C-1, the R.3 SDK review): since agent SDK round 11 (`2a118c6`, claude's `Rt` port) the
// Winter runtime reads the same grammar. Measured with the daemon's OWN deny list for a `[wip] app`
// project: `childSandboxConfigFor` stops a python and a redirect write into `.winter/skills` while an
// ordinary cwd write lands; the literal `sandboxConfigFor` list (the recorded control) lets them through.
// That is why the daemon sends the spelled list on both legs.
//
// Same hermetic beds as the sibling measurements. GATED by `describeWithClaudeRuntime` /
// `describeWithWinterBinary`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as winterQuery } from "@yanlinglabs/winter-agent-sdk";
import { anthropicFake, startFake } from "@yanlinglabs/winter-provider-conformance";
import { childSandboxConfigFor, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";
import { describeWithWinterBinary } from "../helpers/winter-binary";

/** One sandboxed Bash turn on the real `claude`, its sandbox the daemon's OWN fence for a `[wip] app` project (inside a plain cwd — see below) —
 *  `childSandboxConfigFor` (what the official leg is sent) or, as the recorded control, the literal
 *  `sandboxConfigFor`. R.3 I-6: the same three writes as the Winter block — into the protected
 *  `<cwd>/.winter/skills` twice (python, which the permission layer cannot see, and a redirect) and once into
 *  an ordinary cwd file that MUST land (the proof the Bash call ran at all). */
async function officialRun(spelled: boolean): Promise<{ python: boolean; redirect: boolean; notes: boolean; messages: string[] }> {
  const bed = claudeRuntimeForTests();
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-sbx-glob-")));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const daemonHome = join(root, "winter-home");
  // The `[wip] app` project sits INSIDE a plain cwd. MEASURED (R.3 I-6): claude cannot write anything into
  // a cwd whose own path holds `[` — with no deny list at all, python, a redirect and `notes.md` all fail
  // (its own allow entry for the cwd is read as a glob too) — so a bed whose cwd IS `[wip] app` reads
  // "nothing landed" for every fence and would pass vacuously. The Winter runtime writes such a cwd fine.
  const project = join(root, "work", "[wip] app");
  const cwd = join(root, "work");
  for (const dir of [home, cfg, daemonHome, join(home, "tmp"), join(project, ".winter", "skills", "x")]) mkdirSync(dir, { recursive: true });
  const py = join(project, ".winter", "skills", "x", "SKILL.md");
  const redir = join(project, ".winter", "skills", "x", "r.md");
  const notes = join(project, "notes.md");
  const command = `python3 -c "open('${py}','w').write('x')"; echo x > '${redir}'; echo x > '${notes}'; true`;
  let served = false;
  const fake = await startFake({
    routes: [{
      path: "*",
      handler: async (_req, recorded) => {
        if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        if (!served && !recorded.body.includes("tool_result")) {
          served = true;
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command, description: "write into the project" })] }], stopReason: "tool_use" });
        }
        return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
      },
    }],
  });
  const messages: string[] = [];
  try {
    const q = query({
      prompt: "run the command you were scripted to run",
      options: {
        pathToClaudeCodeExecutable: bed.executable,
        model: LOOPBACK_MODEL_ID,
        cwd,
        settingSources: [],
        settings: { sandbox: { ...(spelled ? childSandboxConfigFor(daemonHome, project) : sandboxConfigFor(daemonHome, project)) } },
        maxTurns: 4,
        canUseTool: async (_tool, input) => ({ behavior: "allow", updatedInput: input }),
        env: {
          HOME: home, USER: "winter-measure", LOGNAME: "winter-measure", SHELL: "/bin/zsh", LANG: "en_US.UTF-8",
          TMPDIR: `${join(home, "tmp")}/`, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CLAUDE_CONFIG_DIR: cfg,
          ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: "sk-ant-fake-sandbox-glob-measurement-0000",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0",
        },
      },
    });
    for await (const message of q as AsyncIterable<SDKMessage>) {
      const m = message as { type: string; subtype?: string };
      messages.push(m.subtype === undefined ? m.type : `${m.type}/${m.subtype}`);
      if (m.type === "result") break;
    }
    return { python: existsSync(py), redirect: existsSync(redir), notes: existsSync(notes), messages };
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describeWithClaudeRuntime("router 3279a1d — the official-leg sandbox fence under a `[`-named project (the daemon's own deny list)", () => {
  test("the spelled fence stops the python and the redirect write into .winter/skills; notes.md lands; the literal list's writes land (the recorded control, ASSERTED)", async () => {
    const spelled = await officialRun(true);
    const literal = await officialRun(false);
    const view = (r: { python: boolean; redirect: boolean; notes: boolean }) => ({ python: r.python, redirect: r.redirect, notes: r.notes });
    console.error(`sandbox glob escape (official): spelled ${JSON.stringify(view(spelled))}; literal ${JSON.stringify(view(literal))}; ${spelled.messages.join(",")}`);
    expect(view(spelled)).toEqual({ python: false, redirect: false, notes: true });
    // R.3 I-6: the control is ASSERTED, not logged — a broken bed (the Bash call never running) would read
    // "nothing landed" everywhere and pass the line above vacuously.
    expect(view(literal)).toEqual({ python: true, redirect: true, notes: true });
  }, 180_000);
});

describeWithWinterBinary("C-1 — the Winter-leg sandbox fence under a `[`-named project (the daemon's own deny list)", (bin) => {
  /** One sandboxed Bash turn on the built `winter`, the sandbox being the daemon's OWN fence for this home
   *  and cwd — `childSandboxConfigFor` (what a spawn is sent) or, as the control, the literal
   *  `sandboxConfigFor`. The command writes into the protected `<cwd>/.winter/skills` twice (python, which
   *  the permission layer cannot see, and a redirect) and once into an ordinary cwd file. */
  async function run(dirName: string, spelled: boolean, command?: (cwd: string) => string, bed: { mkdirs?: string[]; probe?: string[] } = {}): Promise<{ python: boolean; redirect: boolean; notes: boolean; landed: Record<string, boolean> }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-sbx-c1-w-")));
    const home = join(root, "home");
    const daemonHome = join(root, "winter-home");
    const cwd = join(root, dirName);
    for (const dir of [home, join(home, "tmp"), daemonHome, join(cwd, ".winter", "skills", "x"), ...(bed.mkdirs ?? []).map((d) => join(cwd, d))]) mkdirSync(dir, { recursive: true });
    const py = join(cwd, ".winter", "skills", "x", "SKILL.md");
    const redir = join(cwd, ".winter", "skills", "x", "r.md");
    const notes = join(cwd, "notes.md");
    const script = command?.(cwd) ?? `python3 -c "open('${py}','w').write('x')"; echo x > '${redir}'; echo x > '${notes}'; true`;
    let served = false;
    const fake = await startFake({
      routes: [{
        path: "*",
        handler: async (_req, recorded) => {
          if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          if (!served && !recorded.body.includes("tool_result")) {
            served = true;
            return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: script, description: "write into the project" })] }], stopReason: "tool_use" });
          }
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
        },
      }],
    });
    try {
      const fence = spelled ? childSandboxConfigFor(daemonHome, cwd) : sandboxConfigFor(daemonHome, cwd);
      const q = winterQuery({
        prompt: "run the command you were scripted to run",
        options: {
          pathToClaudeCodeExecutable: bin,
          model: "anthropic/claude-sonnet-5",
          provider: { providerId: "anthropic", authRef: { kind: "inline", value: "sk-ant-loopback" }, connection: { baseUrl: fake.url, local: true } },
          cwd,
          sandbox: { ...fence, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
          canUseTool: async (_tool: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input }),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: `${join(home, "tmp")}/`, WINTER_HOME: home, WINTER_PROFILE: "test" },
        } as never,
      });
      for await (const m of q) if ((m as { type?: string }).type === "result") break;
      // R.3: probed BEFORE the bed is removed below (a `landedPaths` read after `run` returns sees nothing).
      const landed = Object.fromEntries((bed.probe ?? []).map((rel) => [rel, existsSync(join(cwd, rel))]));
      return { python: existsSync(py), redirect: existsSync(redir), notes: existsSync(notes), landed };
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("`[wip] app`: the spelled fence stops the python and the redirect write into .winter/skills; notes.md lands; the literal list is the recorded control (ASSERTED)", async () => {
    const spelled = await run("[wip] app", true);
    const literal = await run("[wip] app", false);
    const plain = await run("plain app", false);
    const view = (r: { python: boolean; redirect: boolean; notes: boolean }) => ({ python: r.python, redirect: r.redirect, notes: r.notes });
    console.error(`C-1 (winter): [wip] spelled ${JSON.stringify(view(spelled))}; [wip] literal ${JSON.stringify(view(literal))}; plain literal ${JSON.stringify(view(plain))}`);
    expect(view(spelled)).toEqual({ python: false, redirect: false, notes: true });
    expect(view(plain)).toEqual({ python: false, redirect: false, notes: true });
    // R.3 I-6: the control is ASSERTED — the literal list under `[wip] app` lets both writes through (at SDK
    // 5e37898; round 17's native `.winter` cover will stop them, and this line with it — a pin-dependent control).
    expect(view(literal)).toEqual({ python: true, redirect: true, notes: true });
  }, 180_000);

  // R.3 I-4: the any-depth project fence. From a session at the project root, a sandboxed Bash could plant
  // `.winter/<kind>` under a SUBDIRECTORY (a later session there loads it) through a path the Bash detector
  // cannot see — here python joins it from pieces. `childSandboxConfigFor` now carries
  // `<cwd>/**/.winter/<kind>` (a glob-shaped deny, a recursive regex on this runtime since round 11).
  test("R.3 I-4: an assembled python write into <cwd>/pkg/.winter/rules does not land; <cwd>/pkg/notes.md lands; the literal list is the control (ASSERTED)", async () => {
    const script = () => `python3 -c "open('pkg/.win'+'ter/rules/x.md','w').write('x')"; echo x > pkg/notes.md; true`;
    const bed = { mkdirs: ["pkg/.winter/rules"], probe: ["pkg/.winter/rules/x.md", "pkg/notes.md"] };
    const r = await run("plain app", true, script, bed);
    // R.3 re-review minor (a): the in-file control — the LITERAL list (no any-depth globs) lets the same write land.
    const control = await run("plain app", false, script, bed);
    console.error(`R.3 I-4 (winter): child ${JSON.stringify(r.landed)}; literal ${JSON.stringify(control.landed)}`);
    expect(r.landed).toEqual({ "pkg/.winter/rules/x.md": false, "pkg/notes.md": true });
    expect(control.landed).toEqual({ "pkg/.winter/rules/x.md": true, "pkg/notes.md": true });
  }, 180_000);

  // The ancestor-rename bypass (`mv .winter .w2 && … && mv .w2 .winter`) is closed by claude's `Ch`
  // only for `.claude`-shaped entries; the Winter runtime's cover for `.winter` lands in SDK round 17.
  // Needs the round-17 binary — do not assert it before the SDK pin carries it.
  test.todo("`[wip] app`: the ancestor-rename probe cannot plant .winter/skills/x/SKILL.md (needs the SDK round-17 binary)", async () => {
    // R.3 I-6: probed before the bed is removed (the old `landedPaths` read ran after it, so it read false always).
    const r = await run("[wip] app", true, () => "mv .winter .w2 && mkdir -p .w2/skills/x && echo > .w2/skills/x/SKILL.md && mv .w2 .winter; echo x > notes.md; true", { probe: [".winter/skills/x/SKILL.md", "notes.md"] });
    expect(r.landed).toEqual({ ".winter/skills/x/SKILL.md": false, "notes.md": true });
  }, 180_000);

  // R.3 re-review minor (b): the NESTED form of the rename bypass — a `.winter` built under another name in a
  // SUBDIRECTORY and renamed into place (`mkdir -p pkg/.w/rules && … && mv pkg/.w pkg/.winter`): the any-depth
  // glob fences `pkg/.winter/rules`, but a rename of an unfenced directory INTO that name is the known
  // rename-fence follow-up (the same gap as the ancestor-rename row above; SDK round 17's cover is for the
  // cwd's own `.winter`). Needs the binary that closes it — do not assert it before.
  test.todo("the nested-rename probe cannot plant pkg/.winter/rules/x.md (the known rename-fence follow-up)", async () => {
    const r = await run("plain app", true, () => "mkdir -p pkg/.w/rules && echo x > pkg/.w/rules/x.md && mv pkg/.w pkg/.winter; echo x > notes.md; true", { mkdirs: ["pkg"], probe: ["pkg/.winter/rules/x.md", "notes.md"] });
    expect(r.landed).toEqual({ "pkg/.winter/rules/x.md": false, "notes.md": true });
  }, 180_000);
});
