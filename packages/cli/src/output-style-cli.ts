// Pure/isolatable logic behind `norma output-style ...`, split out of main.ts so it can be
// unit-tested without going through the top-level `if (import.meta.main)` dispatch. Mirrors
// model-cli.ts's split: main.ts (and tui/commands.ts's runOutputStyle) own the I/O
// (loadSettings/saveSettings/OutputStyleStore), this file owns the argv parse decision.

/** Parses `norma output-style`'s argv tail (everything after "output-style", i.e.
 *  process.argv.slice(3)). No arg → list; `--help`/`-h` → help; a single token → set that style.
 *  Mirrors model-cli.ts's parseModelArgs. */
export type OutputStyleAction =
  | { action: "list" }
  | { action: "help" }
  | { action: "set"; name: string };

export function parseOutputStyleArgs(argv: string[]): OutputStyleAction {
  const args = argv.filter((a) => a.length > 0);
  if (args.length === 0) return { action: "list" };
  if (args[0] === "--help" || args[0] === "-h") return { action: "help" };
  return { action: "set", name: args[0]! };
}
