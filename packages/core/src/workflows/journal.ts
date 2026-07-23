import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentOpts } from "./types";

export function promptKey(prompt: string, opts?: AgentOpts): string {
  return JSON.stringify([prompt, opts ?? null]);
}

export class RunJournal {
  private readonly path: string;
  constructor(dir: string, runId: string) {
    const d = join(dir, runId);
    mkdirSync(d, { recursive: true });
    this.path = join(d, "journal.jsonl");
  }
  append(promptKey: string, value: unknown): void {
    appendFileSync(this.path, JSON.stringify({ promptKey, value }) + "\n");
  }
  load(): Array<{ promptKey: string; value: unknown }> {
    try {
      return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}
