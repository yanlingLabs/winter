import { spawnSync } from "node:child_process";

/** Clipboard writes are explicit user copy actions, never triggered merely by selecting text. */
export function copyToClipboard(text: string): boolean {
  if (text.length === 0 || process.platform !== "darwin") return false;
  return spawnSync("/usr/bin/pbcopy", [], { input: text, encoding: "utf8" }).status === 0;
}
