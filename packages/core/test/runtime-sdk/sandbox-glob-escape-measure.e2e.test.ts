// Router 3279a1d (Contract A `escapeSandboxGlobPath`) — does the daemon's sandbox fence hold under a
// directory whose name holds `[`, on BOTH real binaries?
//
// claude reads a `sandbox.filesystem` entry holding any of `* ? [ ]` as a GLOB (a seatbelt regex), so a
// raw `[wip] app` entry is a character class that misses the literal directory. `childSandboxConfigFor`
// spells it `[[]wip] app`. Measured with a sandboxed Bash write into the fenced directory: the spelled
// entry must stop it; the raw entry is recorded as the control (the gap the spelling closes).
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
import { escapeSandboxGlobPath } from "@yanlinglabs/winter-runtime-sdk";
import { childSandboxConfigFor, sandboxConfigFor } from "../../src/runtime-sdk/mode-options";
import { claudeRuntimeForTests, describeWithClaudeRuntime, LOOPBACK_MODEL_ID } from "../helpers/claude-runtime";
import { describeWithWinterBinary } from "../helpers/winter-binary";

async function sandboxedWriteLands(spelled: boolean): Promise<{ landed: boolean; messages: string[] }> {
  const bed = claudeRuntimeForTests();
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-sbx-glob-")));
  const home = join(root, "home");
  const cfg = join(root, "cfg");
  const cwd = join(root, "cwd");
  const fenced = join(cwd, "[wip] app");
  for (const dir of [home, cfg, cwd, fenced, join(home, "tmp")]) mkdirSync(dir, { recursive: true });
  const target = join(fenced, "f.txt");
  let served = false;
  const fake = await startFake({
    routes: [{
      path: "*",
      handler: async (_req, recorded) => {
        if (!(recorded.path === "/v1/messages" && recorded.method === "POST")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        if (!served && !recorded.body.includes("tool_result")) {
          served = true;
          return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "tool_use", id: "call_bash_1", name: "Bash", jsonChunks: [JSON.stringify({ command: `echo measured > '${target}'`, description: "write into the fenced dir" })] }], stopReason: "tool_use" });
        }
        return anthropicFake.anthropicTurnResponse({ blocks: [{ type: "text", chunks: ["done"] }], stopReason: "end_turn" });
      },
    }],
  });
  const messages: string[] = [];
  try {
    const q = query({
      prompt: "write the file you were scripted to write",
      options: {
        pathToClaudeCodeExecutable: bed.executable,
        model: LOOPBACK_MODEL_ID,
        cwd,
        settingSources: [],
        settings: { sandbox: { enabled: true, filesystem: { denyWrite: [spelled ? escapeSandboxGlobPath(fenced) : fenced] } } },
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
    return { landed: existsSync(target), messages };
  } finally {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describeWithClaudeRuntime("router 3279a1d — the official-leg sandbox fence under a `[`-named directory", () => {
  test("the escapeSandboxGlobPath-spelled denyWrite stops a sandboxed Bash write; the raw spelling is the recorded control", async () => {
    const spelled = await sandboxedWriteLands(true);
    const raw = await sandboxedWriteLands(false);
    console.error(`sandbox glob escape (official): spelled deny -> write landed=${spelled.landed}; raw deny -> write landed=${raw.landed}; ${spelled.messages.join(",")}`);
    expect(spelled.landed).toBe(false);
  }, 90_000);
});

describeWithWinterBinary("C-1 — the Winter-leg sandbox fence under a `[`-named project (the daemon's own deny list)", (bin) => {
  /** One sandboxed Bash turn on the built `winter`, the sandbox being the daemon's OWN fence for this home
   *  and cwd — `childSandboxConfigFor` (what a spawn is sent) or, as the control, the literal
   *  `sandboxConfigFor`. The command writes into the protected `<cwd>/.winter/skills` twice (python, which
   *  the permission layer cannot see, and a redirect) and once into an ordinary cwd file. */
  async function run(dirName: string, spelled: boolean, command?: (cwd: string) => string, bed: { mkdirs?: string[]; probe?: string[] } = {}): Promise<{ python: boolean; redirect: boolean; notes: boolean; cwd: string; landedPaths: (rel: string) => boolean; landed: Record<string, boolean> }> {
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
      return { python: existsSync(py), redirect: existsSync(redir), notes: existsSync(notes), cwd, landedPaths: (rel) => existsSync(join(cwd, rel)), landed };
    } finally {
      await fake.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("`[wip] app`: the spelled fence stops the python and the redirect write into .winter/skills; notes.md lands; the literal list is the recorded control", async () => {
    const spelled = await run("[wip] app", true);
    const literal = await run("[wip] app", false);
    const plain = await run("plain app", false);
    const view = (r: { python: boolean; redirect: boolean; notes: boolean }) => ({ python: r.python, redirect: r.redirect, notes: r.notes });
    console.error(`C-1 (winter): [wip] spelled ${JSON.stringify(view(spelled))}; [wip] literal ${JSON.stringify(view(literal))}; plain literal ${JSON.stringify(view(plain))}`);
    expect(view(spelled)).toEqual({ python: false, redirect: false, notes: true });
    expect(view(plain)).toEqual({ python: false, redirect: false, notes: true });
  }, 180_000);

  // R.3 I-4: the any-depth project fence. From a session at the project root, a sandboxed Bash could plant
  // `.winter/<kind>` under a SUBDIRECTORY (a later session there loads it) through a path the Bash detector
  // cannot see — here python joins it from pieces. `childSandboxConfigFor` now carries
  // `<cwd>/**/.winter/<kind>` (a glob-shaped deny, a recursive regex on this runtime since round 11).
  test("R.3 I-4: an assembled python write into <cwd>/pkg/.winter/rules does not land; <cwd>/pkg/notes.md lands", async () => {
    const r = await run("plain app", true, () => `python3 -c "open('pkg/.win'+'ter/rules/x.md','w').write('x')"; echo x > pkg/notes.md; true`, {
      mkdirs: ["pkg/.winter/rules"], probe: ["pkg/.winter/rules/x.md", "pkg/notes.md"],
    });
    console.error(`R.3 I-4 (winter): ${JSON.stringify(r.landed)}`);
    expect(r.landed).toEqual({ "pkg/.winter/rules/x.md": false, "pkg/notes.md": true });
  }, 180_000);

  // The ancestor-rename bypass (`mv .winter .w2 && … && mv .w2 .winter`) is closed by claude's `Ch`
  // only for `.claude`-shaped entries; the Winter runtime's cover for `.winter` lands in SDK round 17.
  // Needs the round-17 binary — do not assert it before the SDK pin carries it.
  test.todo("`[wip] app`: the ancestor-rename probe cannot plant .winter/skills/x/SKILL.md (needs the SDK round-17 binary)", async () => {
    const r = await run("[wip] app", true, () => "mv .winter .w2 && mkdir -p .w2/skills/x && echo > .w2/skills/x/SKILL.md && mv .w2 .winter; true");
    expect(r.landedPaths(".winter/skills/x/SKILL.md")).toBe(false);
  }, 180_000);
});
