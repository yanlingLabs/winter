import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import stringWidth from "string-width";

/** Rejoin a hard-wrapped token across transcript rows (assistant continuation gutter: 2 cells). */
export async function transcriptFileAtCell(lines: string[], index: number, column: number, columns: number, cwd: string): Promise<string | null> {
  const plain = (i: number) => (lines[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  let line = plain(index);
  const direct = await fileAtCell(line, column, cwd);
  if (direct) return direct;
  let first = index, last = index;
  while (first > 0 && index - first < 64) {
    const before = plain(first - 1);
    if (stringWidth(before) !== columns || /\s$/.test(before) || !/^  \S/.test(line)) break;
    line = before + line.slice(2);
    column += stringWidth(before) - 2;
    first--;
  }
  while (last + 1 < lines.length && last - index < 64) {
    const next = plain(last + 1);
    if (stringWidth(plain(last)) !== columns || /\s$/.test(line) || !/^  \S/.test(next)) break;
    line += next.slice(2);
    last++;
  }
  return first !== index || last !== index ? fileAtCell(line, column, cwd) : null;
}

/** Resolve only the token actually clicked. No filesystem work runs during rendering. */
export async function fileAtCell(line: string, column: number, cwd: string): Promise<string | null> {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  const tokens = /`([^`]+)`|"([^"]+)"|'([^']+)'|[^\s<>`"']+/g;
  for (const match of plain.matchAll(tokens)) {
    const start = stringWidth(plain.slice(0, match.index));
    if (column < start || column >= start + stringWidth(match[0])) continue;
    const token = (match[1] ?? match[2] ?? match[3] ?? match[0]).replace(/^[([]+|[),.;:\]]+$/g, "");
    if (!token || token.includes("://") || !/[./]/.test(token)) return null;
    const candidates = token.startsWith("~/") ? [resolve(homedir(), token.slice(2))]
      : token.startsWith("/") ? [resolve(token)]
      : [resolve(cwd, token), ...(/^(?:private|var|tmp|Users|users)\//.test(token) ? [resolve("/", token)] : [])];
    for (const path of candidates) {
      try { if ((await stat(path)).isFile()) return path; } catch { /* Missing candidates are ordinary prose. */ }
    }
  }
  return null;
}

export function openLocalFile(path: string): void {
  // Absolute argv, no shell interpolation: file names never become commands.
  const child = spawn("/usr/bin/open", [path], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}
