/**
 * WS-23: ant's OWN staged record, `runtimes/ant/VERSIONS.json` (`bundle-layout.ts`'s `AntVersionsJson`),
 * spelled in ONE place. Both writers use it: `embed-runtimes.sh` (the Release build, via the CLI entry
 * below) and `verify-runtimes-compiled.ts` (the compiled-binary proof, by import). The daemon's
 * `parseAntVersionsJson` and release-lib's `verifyAntEmbed` are its readers.
 *
 *   bun run scripts/ant-record.ts <path> <tag> <antPreSignSha256>
 */
import { writeFileSync } from "node:fs";
import type { AntVersionsJson } from "../packages/core/src/runtime-sdk/bundle-layout";

export function antVersionsRecord(tag: string, antPreSignSha256: string, now: Date = new Date()): AntVersionsJson {
  return { schema: 1, tag, checksums: { antPreSign: antPreSignSha256 }, stagedAt: now.toISOString() };
}

export function writeAntVersionsJson(path: string, tag: string, antPreSignSha256: string): AntVersionsJson {
  const record = antVersionsRecord(tag, antPreSignSha256);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (import.meta.main) {
  const [path, tag, sha] = process.argv.slice(2);
  if (path === undefined || tag === undefined || sha === undefined) {
    console.error("usage: bun run scripts/ant-record.ts <path> <tag> <antPreSignSha256>");
    process.exit(1);
  }
  writeAntVersionsJson(path, tag, sha);
}
