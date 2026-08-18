export interface PatchHunk {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "update"; path: string; hunks: PatchHunk[] }
  | { type: "delete"; path: string };

interface MutableHunk extends PatchHunk { changed: boolean }

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const END_OF_FILE = "*** End of File";

function fail(message: string): never {
  throw new Error("invalid patch: " + message);
}

function operationMarker(line: string): string | undefined {
  if (line.startsWith(ADD)) return ADD;
  if (line.startsWith(UPDATE)) return UPDATE;
  if (line.startsWith(DELETE)) return DELETE;
  return undefined;
}

function patchPath(line: string, marker: string): string {
  const raw = line.slice(marker.length);
  if (raw.length === 0 || raw !== raw.trim() || raw.includes("\0") || raw.includes("\r")) fail("path is empty or malformed");
  const normalized = raw.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || segments.includes("..")) fail("path escapes its root: " + JSON.stringify(raw));
  const result = segments.filter((segment) => segment.length > 0 && segment !== ".").join("/");
  if (result.length === 0) fail("path is empty after normalization");
  return result;
}

function finishHunk(hunk: MutableHunk | undefined, hunks: PatchHunk[]): void {
  if (!hunk) return;
  if (!hunk.changed) fail("update hunk has no added or removed line");
  const { changed: _, ...parsed } = hunk;
  hunks.push(parsed);
}

function parseUpdate(lines: string[], start: number, path: string): { operation: PatchOperation; next: number } {
  const hunks: PatchHunk[] = [];
  const contexts = new Set<string>();
  let hunk: MutableHunk | undefined;
  let endOfFile = false;
  let index = start;
  while (index < lines.length && lines[index] !== END && !operationMarker(lines[index]!)) {
    const line = lines[index]!;
    if (line === "@@" || line.startsWith("@@ ")) {
      if (endOfFile) fail("hunk after " + END_OF_FILE + " in " + path);
      finishHunk(hunk, hunks);
      const context = line === "@@" ? undefined : line.slice(3);
      if (context !== undefined && (context.length === 0 || contexts.has(context))) fail("ambiguous hunk context in " + path);
      if (context !== undefined) contexts.add(context);
      hunk = { ...(context === undefined ? {} : { context }), oldLines: [], newLines: [], endOfFile: false, changed: false };
      index += 1;
      continue;
    }
    if (line === END_OF_FILE) {
      if (!hunk || endOfFile) fail("unexpected " + END_OF_FILE + " in " + path);
      hunk.endOfFile = true;
      endOfFile = true;
      index += 1;
      continue;
    }
    if (endOfFile) fail("content after " + END_OF_FILE + " in " + path);
    hunk ??= { oldLines: [], newLines: [], endOfFile: false, changed: false };
    if (line.startsWith(" ")) {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1));
      hunk.changed = true;
    } else if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1));
      hunk.changed = true;
    } else {
      fail("unexpected update line in " + path);
    }
    index += 1;
  }
  finishHunk(hunk, hunks);
  if (hunks.length === 0) fail("update has no hunks in " + path);
  return { operation: { type: "update", path, hunks }, next: index };
}

/** Parse the raw apply_patch grammar before a later gated filesystem transaction sees it. */
export function parseCodexPatch(source: string): PatchOperation[] {
  if (typeof source !== "string") fail("patch must be a string");
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== BEGIN || lines.at(-1) !== END) fail("patch boundaries are required");
  const operations: PatchOperation[] = [];
  const paths = new Set<string>();
  let index = 1;
  while (index < lines.length - 1) {
    const marker = operationMarker(lines[index]!);
    if (!marker) fail("expected a file operation at line " + (index + 1));
    const path = patchPath(lines[index]!, marker);
    if (paths.has(path)) fail("duplicate operation path: " + path);
    paths.add(path);
    index += 1;
    if (marker === ADD) {
      const content: string[] = [];
      while (index < lines.length && lines[index] !== END && !operationMarker(lines[index]!)) {
        const line = lines[index]!;
        if (!line.startsWith("+")) fail("add content for " + path + " must start with +");
        content.push(line.slice(1));
        index += 1;
      }
      if (content.length === 0) fail("add has no content in " + path);
      operations.push({ type: "add", path, content: content.join("\n") + "\n" });
    } else if (marker === DELETE) {
      operations.push({ type: "delete", path });
    } else {
      const parsed = parseUpdate(lines, index, path);
      operations.push(parsed.operation);
      index = parsed.next;
    }
  }
  if (operations.length === 0) fail("patch contains no operations");
  return operations;
}
