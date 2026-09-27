// WS-27 review: the RUNTIME's workflow-worker seatbelt profile, as the installed package would render it.
//
// An embedded session's Workflow tool is spawned by the runtime (`@yanlinglabs/winter-agent-runtime`), under
// the runtime's own `buildWorkflowWorkerSeatbeltProfile` — which the package does not export. The Keychain
// guard's tests and `verify:embedded` run the worker under core's `buildWorkflowSeatbeltProfile` instead,
// so this reads the runtime's builder out of its installed `dist/` and renders it (the run-directory
// read-denies, which only ever narrow it, left out), for a byte comparison with core's.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function canon(p: string): string { try { return realpathSync(p); } catch { return p; } }
function sbplString(p: string): string { return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

/** The runtime's worker profile for `selfExecPath`, without its optional run-directory read-denies. */
export function renderRuntimeWorkflowProfile(selfExecPath: string): string {
  const entry = Bun.resolveSync("@yanlinglabs/winter-agent-runtime/workflow-worker", join(import.meta.dir, ".."));
  const dist = dirname(dirname(entry));
  let source: string | undefined;
  for (const file of readdirSync(dist).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(join(dist, file), "utf8");
    const at = text.indexOf("function buildWorkflowWorkerSeatbeltProfile(");
    if (at >= 0) { source = text.slice(at, text.indexOf("\n}\n", at)); break; }
  }
  if (source === undefined) throw new Error("the installed runtime has no buildWorkflowWorkerSeatbeltProfile — re-pin the workflow profile test");
  const machBlock = /const machRules = \[([\s\S]*?)\]/.exec(source)?.[1];
  const template = /return `([\s\S]*?)`;/.exec(source)?.[1];
  if (machBlock === undefined || template === undefined) throw new Error("the runtime's workflow profile builder changed shape — re-pin the workflow profile test");
  const services = [...machBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  const machRules = services.map((s) => `  (global-name "${sbplString(s)}")`).join("\n");
  return template
    .replace("${sbplString(self)}", sbplString(canon(selfExecPath)))
    .replace("${machRules}", machRules)
    .replace("${denyRunDirRule}", "");
}
