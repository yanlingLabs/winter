import { z } from "zod";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithinAny } from "../paths";
import type { ToolRegistry } from "./registry";
import { withFileDiff } from "./diff-report";

export function registerWriteTools(r: ToolRegistry): void {
  r.register({
    name: "write",
    description: "Write a file (creates parent directories). Overwrites if it exists.",
    args: z.object({ path: z.string().min(1), content: z.string() }),
    // Out-of-root targets: the engine's dispatch loop (engine.ts's `dirGrant` branch) grants
    // session-scoped access to the containing directory BEFORE this ever runs, so by the time
    // resolveWithinAny reads `roots` here it already includes the grant — this only still throws
    // for a worktree-isolated child (deliberately excluded from grants — see engine.ts's doc
    // comment) or a bare ToolRegistry caller with no engine wiring at all (unit tests).
    async run({ path, content }, { roots, diffSink }) {
      const target = resolveWithinAny(roots, path);
      // diff-tabs Task 6: snapshot prior content BEFORE mutating. Missing file (the common case —
      // a brand-new path) reads as "" — the all-added new-file diff, per the design spec's
      // forcing fact ("for a write, the file's previous content exists nowhere"). Any OTHER read
      // failure (permissions, `target` being a directory, ...) is swallowed the same way: this
      // read exists ONLY to feed the diff and must never block the write itself — a real problem
      // with `target` still surfaces at the writeFileSync below, unchanged from today.
      let before = "";
      try { before = readFileSync(target, "utf8"); } catch { /* missing/unreadable → "" */ }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      const plain = `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`;
      return withFileDiff(plain, path, before, content, diffSink);
    },
  });

  r.register({
    name: "edit",
    description: "Replace an exact string in a file. old_string must match exactly (including whitespace) and, unless replace_all is true, be UNIQUE in the file — the edit fails otherwise. replace_all: true replaces every occurrence.",
    args: z.object({ path: z.string().min(1), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }),
    // Out-of-root targets: same grant-before-dispatch story as `write` above.
    async run({ path, old_string, new_string, replace_all }, { roots, diffSink }) {
      const target = resolveWithinAny(roots, path);
      const text = readFileSync(target, "utf8");
      const count = text.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (!replace_all && count > 1) throw new Error(`old_string matches ${count} occurrences in ${path} — provide a longer unique string`);
      const newText = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      writeFileSync(target, newText);
      // diff-tabs Task 6: `text` (already read above to locate old_string) IS the pre-mutation
      // snapshot — no second read.
      return withFileDiff(`edited ${path}`, path, text, newText, diffSink);
    },
  });
}
