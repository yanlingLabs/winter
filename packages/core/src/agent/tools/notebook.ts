import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "./registry";
import { resolveWithinAny } from "../paths";
import { withFileDiff } from "./diff-report";

const NotebookEditArgs = z.object({
  notebook_path: z.string().min(1),
  new_source: z.string(),
  cell_id: z.string().optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).optional(),
});

interface Cell { id?: string; cell_type: string; source: string | string[]; metadata?: unknown; outputs?: unknown[]; execution_count?: number | null }
interface Notebook { cells: Cell[]; [k: string]: unknown }

// nbformat stores source as an array of lines (each keeping its trailing newline). Match that.
function toLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  return parts.map((p, i) => (i < parts.length - 1 ? p + "\n" : p)).filter((_, i) => !(i === parts.length - 1 && parts[i] === ""));
}

export function registerNotebookTool(r: ToolRegistry, opts?: { deferred?: boolean }): void {
  r.register({
    name: "notebook_edit",
    description:
      "Edit a Jupyter notebook (.ipynb) at the cell level. edit_mode 'replace' (default) overwrites the cell's source (and cell_type if given); 'insert' adds a new cell after cell_id (or at the top if cell_id is omitted); 'delete' removes the cell. cell_id is required for replace and delete.",
    args: NotebookEditArgs,
    deferred: opts?.deferred,
    async run({ notebook_path, new_source, cell_id, cell_type, edit_mode }: z.infer<typeof NotebookEditArgs>, { roots, diffSink }) {
      const mode = edit_mode ?? "replace";
      const target = resolveWithinAny(roots, notebook_path);
      let beforeText: string;
      let nb: Notebook;
      // diff-tabs Task 6: `beforeText` is the exact on-disk bytes, captured before JSON.parse
      // (which doesn't preserve formatting) — the diff is over the SERIALIZED notebook JSON, the
      // whole file, same as write/edit conceptually (design spec §2).
      try { beforeText = readFileSync(target, "utf8"); nb = JSON.parse(beforeText); } catch (e) { throw new Error(`could not read/parse notebook ${notebook_path}: ${(e as Error).message}`); }
      if (!Array.isArray(nb.cells)) throw new Error(`${notebook_path} is not a valid notebook (no cells array)`);
      const idx = (id: string) => nb.cells.findIndex((c, i) => (c.id ?? String(i)) === id);

      if (mode === "insert") {
        const cell: Cell = { id: randomUUID().slice(0, 8), cell_type: cell_type ?? "code", source: toLines(new_source), metadata: {} };
        if (cell.cell_type === "code") { cell.outputs = []; cell.execution_count = null; }
        const at = cell_id ? idx(cell_id) : -1;
        if (cell_id && at === -1) throw new Error(`cell_id not found: ${cell_id}`);
        nb.cells.splice(at + 1, 0, cell); // after cell_id, or at 0 when cell_id omitted (at=-1 → splice(0))
      } else {
        if (!cell_id) throw new Error(`cell_id is required for ${mode}`);
        const at = idx(cell_id);
        if (at === -1) throw new Error(`cell_id not found: ${cell_id}`);
        if (mode === "delete") { nb.cells.splice(at, 1); }
        else { // replace
          const c = nb.cells[at]!;
          c.source = toLines(new_source);
          if (cell_type) c.cell_type = cell_type;
          if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; }
          else { delete c.outputs; delete c.execution_count; }
        }
      }
      const afterText = JSON.stringify(nb, null, 1) + "\n";
      writeFileSync(target, afterText);
      const plain = `notebook_edit ${mode} on ${notebook_path}${cell_id ? ` (cell ${cell_id})` : ""} — ${nb.cells.length} cells`;
      return withFileDiff(plain, notebook_path, beforeText, afterText, diffSink);
    },
  });
}
