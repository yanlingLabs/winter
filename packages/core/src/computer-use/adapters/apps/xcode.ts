// Xcode (`com.apple.dt.Xcode`): its open workspaces' schemes, and a build of a workspace's ACTIVE scheme — through its
// dictionary (`workspace document`, `active scheme`, `build`, `last scheme action result`). `build` returns at once in
// Xcode; the extra polls the result's `completed` until it is done or the script's time runs short.
import type { AppAdapter, AdapterScope } from "../types";
import { appScript, intArg, optsArg, rows, stringArg, text } from "./common";

const GUIDE = `Xcode's extras work on its open workspaces without bringing Xcode forward:
- schemes() lists each open workspace (front first) with its schemes and its active scheme;
- build() builds the front workspace's ACTIVE scheme for its active run destination (as Product › Build does), waits for it within the script's time, and returns its status (succeeded, failed, error occurred, cancelled, or still running) with the first build errors; { workspace: "Name" } picks another open workspace, { waitMs } waits less;
- buildStatus() reads the last build's result again later.
To build another scheme, the user (or you, in Xcode's scheme menu) must make it the active one first — build() never changes it. A long build: pass a larger timeoutMs to the script, or call buildStatus() in a later call.`;

/** `workspace document "<name>"`, or the front one. */
const workspaceRef = (name: string | undefined): string => (name === undefined ? "workspace document 1" : `workspace document ${text(name)}`);

interface BuildState { workspace: string; status: string; completed: boolean; error?: string; errors: string[] }

/** One read of the workspace's last scheme action result. */
async function readResult(scope: AdapterScope, workspace: string | undefined): Promise<BuildState | undefined> {
  const result = await scope.applescript(appScript(scope.app.bundleId, [
    `set d to ${workspaceRef(workspace)}`,
    "set r to last scheme action result of d",
    "if r is missing value then return my winterText(name of d)",
    "set out to my winterText(name of d) & winterTAB & ((status of r) as text) & winterTAB & ((completed of r) as text) & winterTAB & my winterText(error message of r) & winterLF",
    "set k to 0",
    "repeat with e in (build errors of r)",
    "  set k to k + 1",
    "  if k > 20 then exit repeat",
    "  set out to out & \"E\" & winterTAB & my winterText(message of e) & winterLF",
    "end repeat",
    "return out",
  ], { handlers: ["text"] }), { timeoutMs: 15_000 });
  const lines = rows(result, 2);
  const head = (result ?? "").split(/\r?\n|\r/)[0]?.split("\t") ?? [];
  if (head.length < 4) return undefined;
  return {
    workspace: head[0] ?? "", status: head[1] ?? "", completed: (head[2] ?? "").trim() === "true",
    ...(head[3] !== undefined && head[3].length > 0 ? { error: head.slice(3).join("\t").slice(0, 2_000) } : {}),
    errors: lines.filter((r) => r[0] === "E").map((r) => (r[1] ?? "").slice(0, 500)),
  };
}

const shape = (s: BuildState): Record<string, unknown> => ({
  workspace: s.workspace, status: s.status, completed: s.completed, ...(s.error === undefined ? {} : { error: s.error }), errors: s.errors,
});

export const xcodeAdapter: AppAdapter = {
  bundleIds: ["com.apple.dt.Xcode"],
  guide: { id: "xcode@1", text: GUIDE },
  extras: [
    {
      name: "schemes", access: "view",
      signature: "schemes(): Promise<{ workspace: string; active?: string; schemes: string[] }[]>",
      summary: "each open workspace's schemes and its active scheme",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "set out to \"\"",
          "repeat with d in workspace documents",
          "  set act to \"\"",
          "  try",
          "    set act to my winterText(name of active scheme of d)",
          "  end try",
          "  set out to out & \"W\" & winterTAB & act & winterTAB & my winterText(name of d) & winterLF",
          "  repeat with s in (schemes of d)",
          "    set out to out & \"S\" & winterTAB & my winterText(name of s) & winterLF",
          "  end repeat",
          "end repeat",
          "return out",
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        const out: Array<{ workspace: string; active?: string; schemes: string[] }> = [];
        for (const r of rows(result, 2)) {
          if (r[0] === "W") {
            const [act, name] = (r[1] ?? "").split("\t");
            out.push({ workspace: name ?? "", ...(act ? { active: act } : {}), schemes: [] });
          } else if (r[0] === "S" && out.length > 0) out[out.length - 1]!.schemes.push(r[1] ?? "");
        }
        return out;
      },
    },
    {
      name: "build", access: "full",
      signature: "build(o?: { workspace?: string; waitMs?: number }): Promise<{ workspace: string; status: string; completed: boolean; error?: string; errors: string[] }>",
      summary: "builds a workspace's active scheme and waits for the result",
      doc: "Xcode's build command on the front workspace (or { workspace }), for its active scheme and run destination. Waits up to { waitMs } (default: the script's time left) polling the result; completed: false means it is still building — call buildStatus() later. errors: the first 20 build error messages.",
      async run(scope, args) {
        const o = optsArg(args[0], "build()", ["workspace", "waitMs"]);
        const workspace = o.workspace === undefined ? undefined : stringArg(o.workspace, "build({ workspace })", 300);
        const waitMs = scope.clampWait(o.waitMs === undefined ? 300_000 : intArg(o.waitMs, "build({ waitMs })", 0, 300_000));
        const started = await scope.applescript(appScript(scope.app.bundleId, [
          `set d to ${workspaceRef(workspace)}`,
          "build d",
          "return my winterText(name of d)",
        ], { handlers: ["text"] }), { timeoutMs: 15_000 });
        const name = (started ?? "").trim() || workspace;
        scope.say(`started a build of ${name === undefined ? "the front workspace" : "the workspace"}'s active scheme`);
        const deadline = Date.now() + Math.max(0, waitMs - 1_500);
        let state = await readResult(scope, name);
        while (state !== undefined && !state.completed && Date.now() < deadline) {
          if (!(await scope.sleep(1_000))) break;
          state = await readResult(scope, name);
        }
        if (state === undefined) return { workspace: name ?? "", status: "not yet started", completed: false, errors: [] };
        if (!state.completed) scope.say("the build is still running — call buildStatus() in a later step");
        return shape(state);
      },
    },
    {
      name: "buildStatus", access: "view",
      signature: "buildStatus(o?: { workspace?: string }): Promise<{ workspace: string; status: string; completed: boolean; error?: string; errors: string[] } | null>",
      summary: "the last build's result for the front workspace (or a named one)",
      async run(scope, args) {
        const o = optsArg(args[0], "buildStatus()", ["workspace"]);
        const workspace = o.workspace === undefined ? undefined : stringArg(o.workspace, "buildStatus({ workspace })", 300);
        const state = await readResult(scope, workspace);
        return state === undefined ? null : shape(state);
      },
    },
  ],
};
