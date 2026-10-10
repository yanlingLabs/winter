// Xcode (`com.apple.dt.Xcode`): its open workspaces' schemes, and a build of a workspace's ACTIVE scheme — through its
// dictionary (`workspace document`, `active scheme`, `build`, `last scheme action result`). `build` returns at once in
// Xcode; the extra polls the result's `completed` until it is done or the script's time runs short.
//
// The workspace an extra builds is the BOUND window's own document (`document of window id <it>` — an Xcode window's
// scripting id is its window-server id), or one the agent names — never Xcode's front document, which may be another
// window's. A bound window Xcode cannot find, or one showing no workspace, is `NoWindow`.
import { AutomationFailure } from "../../errors";
import type { AppAdapter, AdapterScope } from "../types";
import { appScript, intArg, optsArg, rows, stringArg, text } from "./common";
import { XCODE_GUIDE } from "../guides/xcode";


/** The lines that put the workspace in `d`: the one the agent named, else the bound window's own document — or return a
 *  sentinel `noWorkspace` turns into `NoWindow`. */
function workspaceLines(scope: AdapterScope, name: string | undefined): string[] {
  if (name !== undefined) {
    return [`if not (exists workspace document ${text(name)}) then return "NOWORKSPACE"`, `set d to workspace document ${text(name)}`];
  }
  const w = scope.window();
  return [
    `if not (exists window id ${w}) then return "NOWINDOW"`,
    `set d to document of window id ${w}`,
    "if d is missing value then return \"NOTWORKSPACE\"",
    "try",
    "  set probe to name of active scheme of d",
    "on error",
    "  return \"NOTWORKSPACE\"",
    "end try",
  ];
}

/** A workspace sentinel as the typed failure (nothing else returned). */
function noWorkspace(scope: AdapterScope, result: string | null, name: string | undefined): void {
  const r = (result ?? "").trim();
  if (r === "NOWINDOW") throw new AutomationFailure("NoWindow", "Xcode has no window with the bound window's id — it may have closed; bind an Xcode workspace window again (apps.open). Nothing was done.");
  if (r === "NOTWORKSPACE") throw new AutomationFailure("NoWindow", "the bound Xcode window shows no workspace or project — bind a workspace's window, or name it: { workspace: \"<name>\" } (schemes() lists them). Nothing was done.");
  if (r === "NOWORKSPACE") throw new AutomationFailure("NoWindow", `Xcode has no open workspace named ${JSON.stringify(name ?? "")} — schemes() lists the open ones. Nothing was done.`);
}

interface BuildState { workspace: string; id?: string; status: string; completed: boolean; error?: string; errors: string[]; replaced?: true }

/** A scheme action result's id as Xcode gives it. */
function resultId(v: unknown, what: string): string {
  const id = stringArg(v, what, 200).trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw Object.assign(new TypeError(`${what} takes a build id from build()`), { name: "TypeError" });
  return id;
}

/**
 * One read of a scheme action result: THE one `id` names (the result `build` returned — Xcode keeps each until a newer
 * action replaces it, then that id is gone: `replaced`), or, with no id, the workspace's last one.
 */
async function readResult(scope: AdapterScope, workspace: string | undefined, id?: string): Promise<BuildState | undefined> {
  const result = await scope.applescript(appScript(scope.app.bundleId, [
    ...workspaceLines(scope, workspace),
    ...(id === undefined
      ? ["set r to last scheme action result of d", "if r is missing value then return my winterText(name of d)"]
      : ["try", `  set r to scheme action result id ${text(id)} of d`, "on error", "  return \"REPLACED\"", "end try"]),
    "set out to my winterText(name of d) & winterTAB & ((status of r) as text) & winterTAB & ((completed of r) as text) & winterTAB & my winterText(error message of r) & winterLF",
    "set k to 0",
    "repeat with e in (build errors of r)",
    "  set k to k + 1",
    "  if k > 20 then exit repeat",
    "  set out to out & \"E\" & winterTAB & my winterText(message of e) & winterLF",
    "end repeat",
    "return out",
  ], { handlers: ["text"] }), { timeoutMs: 15_000 });
  noWorkspace(scope, result, workspace);
  if ((result ?? "").trim() === "REPLACED") return { workspace: workspace ?? "", ...(id === undefined ? {} : { id }), status: "replaced", completed: true, errors: [], replaced: true };
  const lines = rows(result, 2);
  const head = (result ?? "").split(/\r?\n|\r/)[0]?.split("\t") ?? [];
  if (head.length < 4) return undefined;
  return {
    workspace: head[0] ?? "", ...(id === undefined ? {} : { id }), status: head[1] ?? "", completed: (head[2] ?? "").trim() === "true",
    ...(head[3] !== undefined && head[3].length > 0 ? { error: head.slice(3).join("\t").slice(0, 2_000) } : {}),
    errors: lines.filter((r) => r[0] === "E").map((r) => (r[1] ?? "").slice(0, 500)),
  };
}

const shape = (s: BuildState): Record<string, unknown> => ({
  workspace: s.workspace, ...(s.id === undefined ? {} : { id: s.id }), status: s.status, completed: s.completed,
  ...(s.error === undefined ? {} : { error: s.error }), errors: s.errors,
});

export const xcodeAdapter: AppAdapter = {
  bundleIds: ["com.apple.dt.Xcode"],
  guide: { id: "xcode@3", text: XCODE_GUIDE },
  extras: [
    {
      name: "schemes", access: "view",
      signature: "schemes(): Promise<{ workspace: string; bound: boolean; active?: string; schemes: string[] }[]>",
      summary: "each open workspace's schemes and active scheme; bound marks the bound window's",
      doc: "Every open workspace (read only), with its schemes and active scheme; bound: true for the bound window's own workspace. build() builds that one unless you name another.",
      async run(scope) {
        const result = await scope.applescript(appScript(scope.app.bundleId, [
          "set boundName to \"\"",
          "try",
          `  set boundName to my winterText(name of document of window id ${scope.window()})`,
          "end try",
          "set out to \"\"",
          "repeat with d in workspace documents",
          "  set act to \"\"",
          "  try",
          "    set act to my winterText(name of active scheme of d)",
          "  end try",
          "  set n to my winterText(name of d)",
          "  set out to out & \"W\" & winterTAB & (n = boundName) & winterTAB & act & winterTAB & n & winterLF",
          "  repeat with s in (schemes of d)",
          "    set out to out & \"S\" & winterTAB & my winterText(name of s) & winterLF",
          "  end repeat",
          "end repeat",
          "return out",
        ], { handlers: ["text"] }), { timeoutMs: 20_000 });
        const out: Array<{ workspace: string; bound: boolean; active?: string; schemes: string[] }> = [];
        for (const r of rows(result, 2)) {
          if (r[0] === "W") {
            const [isBound, act, name] = (r[1] ?? "").split("\t");
            out.push({ workspace: name ?? "", bound: (isBound ?? "").trim() === "true", ...(act ? { active: act } : {}), schemes: [] });
          } else if (r[0] === "S" && out.length > 0) out[out.length - 1]!.schemes.push(r[1] ?? "");
        }
        return out;
      },
    },
    {
      name: "build", access: "full",
      signature: "build(o?: { workspace?: string; waitMs?: number }): Promise<{ workspace: string; id: string; status: string; completed: boolean; error?: string; errors: string[] }>",
      summary: "builds the bound window's workspace (or a named one) — its active scheme — and waits",
      doc: "Xcode's build command on the BOUND window's workspace (or { workspace } by name), for its active scheme and run destination. Waits up to { waitMs } (default: the script's time left) polling THIS build's own result; completed: false means it is still building — call buildStatus({ id }) later. status \"replaced\": a newer action replaced it. errors: the first 20 build error messages.",
      async run(scope, args) {
        const o = optsArg(args[0], "build()", ["workspace", "waitMs"]);
        const workspace = o.workspace === undefined ? undefined : stringArg(o.workspace, "build({ workspace })", 300);
        const waitMs = scope.clampWait(o.waitMs === undefined ? 300_000 : intArg(o.waitMs, "build({ waitMs })", 0, 300_000));
        const started = await scope.applescript(appScript(scope.app.bundleId, [
          ...workspaceLines(scope, workspace),
          // Keep THIS build's own result, by its id: never "the last result", which a later action replaces.
          "set r to build d",
          "return \"WS:\" & my winterText(name of d) & winterTAB & my winterText(id of r)",
        ], { handlers: ["text"] }), { timeoutMs: 15_000 });
        noWorkspace(scope, started, workspace);
        const [wsPart, idPart] = (started ?? "").trim().split("\t");
        const name = (wsPart ?? "").replace(/^WS:/, "").trim();
        const id = (idPart ?? "").trim();
        if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error("Xcode started the build but gave no result id to follow — read it with buildStatus()");
        scope.say(`started a build of ${workspace === undefined ? "the bound window's workspace" : "the named workspace"} (its active scheme)`);
        const deadline = Date.now() + Math.max(0, waitMs - 1_500);
        // Polled the same way it was started (the bound window's workspace, or the named one) — and by its own id.
        let state = await readResult(scope, workspace, id);
        while (state !== undefined && !state.completed && Date.now() < deadline) {
          if (!(await scope.sleep(1_000))) break;
          state = await readResult(scope, workspace, id);
        }
        if (state === undefined) return { workspace: name, id, status: "not yet started", completed: false, errors: [] };
        if (!state.completed) scope.say(`the build is still running — call buildStatus({ id: ${JSON.stringify(id)} }) in a later step`);
        return shape(state);
      },
    },
    {
      name: "buildStatus", access: "view",
      signature: "buildStatus(o?: { id?: string; workspace?: string }): Promise<{ workspace: string; id?: string; status: string; completed: boolean; error?: string; errors: string[] } | null>",
      summary: "a build's result — { id } from build(), else the last one — for the bound window's workspace (or a named one)",
      doc: "{ id } (from build()) reads THAT build's result (status \"replaced\" once a newer action replaced it); without one, the workspace's last action result.",
      async run(scope, args) {
        const o = optsArg(args[0], "buildStatus()", ["id", "workspace"]);
        const workspace = o.workspace === undefined ? undefined : stringArg(o.workspace, "buildStatus({ workspace })", 300);
        const state = await readResult(scope, workspace, o.id === undefined ? undefined : resultId(o.id, "buildStatus({ id })"));
        return state === undefined ? null : shape(state);
      },
    },
  ],
};
