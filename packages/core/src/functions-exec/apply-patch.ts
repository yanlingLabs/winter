import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWithinAny } from "../agent/paths";
import { parseCodexPatch, type PatchHunk, type PatchOperation } from "./patch";

interface Snapshot {
  requestedPath: string;
  path: string;
  bytes?: Buffer;
}

function splitFile(content: string): { lines: string[]; newline: "\n" | "\r\n"; trailingNewline: boolean } {
  const firstLineFeed = content.indexOf("\n");
  const newline = firstLineFeed > 0 && content[firstLineFeed - 1] === "\r" ? "\r\n" : "\n";
  const trailingNewline = content.endsWith(newline);
  const body = trailingNewline ? content.slice(0, -newline.length) : content;
  return { lines: body.length === 0 ? [] : body.split(newline), newline, trailingNewline };
}

function joinFile(lines: string[], newline: "\n" | "\r\n", trailingNewline: boolean): string {
  return lines.length === 0 ? "" : `${lines.join(newline)}${trailingNewline ? newline : ""}`;
}

function matchingLineIndices(lines: string[], expected: string[], start: number, endOfFile: boolean): number[] {
  const matches: number[] = [];
  for (let index = start; index + expected.length <= lines.length; index += 1) {
    if (endOfFile && index + expected.length !== lines.length) continue;
    if (expected.every((line, offset) => lines[index + offset] === line)) matches.push(index);
  }
  return matches;
}

function uniqueLineIndex(lines: string[], expected: string, start: number, path: string): number {
  const matches = lines.flatMap((line, index) => index >= start && line === expected ? [index] : []);
  if (matches.length === 0) throw new Error(`failed to find context '${expected}' in ${path}`);
  if (matches.length > 1) throw new Error(`context '${expected}' matches more than once in ${path}`);
  return matches[0]!;
}

function applyUpdate(content: string, path: string, hunks: PatchHunk[]): string {
  const parsed = splitFile(content);
  let cursor = 0;
  for (const hunk of hunks) {
    let start = cursor;
    if (hunk.context !== undefined) start = uniqueLineIndex(parsed.lines, hunk.context, cursor, path) + 1;
    let index: number;
    if (hunk.oldLines.length === 0) {
      index = hunk.context === undefined || hunk.endOfFile ? parsed.lines.length : start;
    } else {
      const matches = matchingLineIndices(parsed.lines, hunk.oldLines, start, hunk.endOfFile);
      if (matches.length === 0) throw new Error(`failed to find expected lines in ${path}`);
      if (matches.length > 1) throw new Error(`expected lines are ambiguous in ${path}`);
      index = matches[0]!;
    }
    parsed.lines.splice(index, hunk.oldLines.length, ...hunk.newLines);
    cursor = index + hunk.newLines.length;
  }
  return joinFile(parsed.lines, parsed.newline, parsed.trailingNewline);
}

function decode(bytes: Buffer, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`patch target is not valid UTF-8: ${path}`); }
}

function pathsInOrder(operations: PatchOperation[]): string[] {
  return [...new Set(operations.map((operation) => operation.path))];
}

function stage(operations: PatchOperation[], snapshots: Map<string, Snapshot>): Map<string, Buffer | undefined> {
  const staged = new Map<string, Buffer | undefined>();
  for (const [path, snapshot] of snapshots) staged.set(path, snapshot.bytes);
  for (const operation of operations) {
    const before = staged.get(operation.path);
    switch (operation.type) {
      case "add":
        if (before !== undefined) throw new Error(`add target already exists: ${operation.path}`);
        staged.set(operation.path, Buffer.from(operation.content));
        break;
      case "update":
        if (before === undefined) throw new Error(`update target does not exist: ${operation.path}`);
        staged.set(operation.path, Buffer.from(applyUpdate(decode(before, operation.path), operation.path, operation.hunks)));
        break;
      case "delete":
        if (before === undefined) throw new Error(`delete target does not exist: ${operation.path}`);
        staged.set(operation.path, undefined);
        break;
    }
  }
  return staged;
}

function restore(snapshot: Snapshot): void {
  if (snapshot.bytes === undefined) {
    if (existsSync(snapshot.path)) unlinkSync(snapshot.path);
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  writeFileSync(snapshot.path, snapshot.bytes);
}

/**
 * Applies the validated Codex patch grammar after every target has been resolved, snapshotted, and
 * staged. No directory or file is touched during preflight; a failed mutation restores the captured
 * targets in reverse order. Parent paths and all leaf targets remain constrained to `roots`.
 */
export function applyCodexPatch(patch: string, roots: string[]): string {
  const operations = parseCodexPatch(patch);
  const snapshots = new Map<string, Snapshot>();
  for (const requestedPath of pathsInOrder(operations)) {
    const path = resolveWithinAny(roots, requestedPath);
    if (existsSync(path)) {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`patch target must be a regular file: ${requestedPath}`);
      snapshots.set(requestedPath, { requestedPath, path, bytes: readFileSync(path) });
    } else {
      snapshots.set(requestedPath, { requestedPath, path });
    }
  }
  const staged = stage(operations, snapshots);
  const changed: Snapshot[] = [];
  try {
    for (const [requestedPath, snapshot] of snapshots) {
      const next = staged.get(requestedPath);
      changed.push(snapshot);
      if (next === undefined) {
        if (snapshot.bytes !== undefined) unlinkSync(snapshot.path);
      } else {
        mkdirSync(dirname(snapshot.path), { recursive: true });
        writeFileSync(snapshot.path, next);
      }
    }
  } catch (error) {
    const failures: string[] = [];
    for (const snapshot of changed.reverse()) {
      try { restore(snapshot); }
      catch (restoreError) { failures.push(`${snapshot.requestedPath}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`); }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(failures.length === 0 ? `${detail}; patch transaction rolled back` : `${detail}; rollback failed: ${failures.join("; ")}`);
  }
  return `Applied patch to ${snapshots.size} file${snapshots.size === 1 ? "" : "s"}`;
}
