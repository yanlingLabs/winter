// Pure/isolatable logic behind `norma workflow ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch. Mirrors
// output-style-cli.ts's split: main.ts owns the I/O (WorkflowStore for list/save — file-direct,
// NO daemon round-trip, same "a setting/store switch must not need the daemon" precedent as
// output-style/model — plus NormaClient.workflowRun for `run`, which DOES need the daemon since
// that's where workflows actually execute), this file owns the argv parse decision only.

/** Parses `norma workflow`'s argv tail (everything after "workflow", i.e.
 *  process.argv.slice(3)). No arg → list; `--help`/`-h` → help; `run <name> [json-args]` → run
 *  (args stays the raw argv token — main.ts JSON.parses it right before the RPC call, same
 *  "parser stays pure, main.ts does the I/O-adjacent conversion" split as everywhere else in this
 *  file); `save <name> [file]` → save (an omitted file means "read source from stdin" — decided in
 *  main.ts, not here, since that's I/O). Any other/unrecognized first token (including a bare
 *  "run"/"save" missing its required `<name>`) falls back to help, same as a bad invocation of any
 *  other norma subcommand printing its usage rather than guessing. Mirrors model-cli.ts's
 *  parseModelArgs / output-style-cli.ts's parseOutputStyleArgs. */
export type WorkflowCliAction =
  | { action: "list" }
  | { action: "help" }
  | { action: "run"; name: string; args?: string }
  | { action: "save"; name: string; file?: string };

export function parseWorkflowArgs(argv: string[]): WorkflowCliAction {
  const args = argv.filter((a) => a.length > 0);
  if (args.length === 0 || args[0] === "list") return { action: "list" }; // explicit `list` token — the usage line advertises `norma workflow [list]`
  if (args[0] === "--help" || args[0] === "-h") return { action: "help" };

  if (args[0] === "run") {
    const name = args[1];
    if (!name) return { action: "help" };
    const rest = args[2];
    return rest !== undefined ? { action: "run", name, args: rest } : { action: "run", name };
  }

  if (args[0] === "save") {
    const name = args[1];
    if (!name) return { action: "help" };
    const file = args[2];
    return file !== undefined ? { action: "save", name, file } : { action: "save", name };
  }

  return { action: "help" };
}
