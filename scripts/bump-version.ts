// Winter Phase 9c (P9c-2): thin CLI over version-lib.ts's `nextVersion` (the pure, unit-tested
// bump logic — see that file for the exact `--patch`/`--feature`/`--major` shapes and the
// `--minor` removal). `bun run version:bump` (= `--patch`), `version:bump:feature`,
// `version:bump:major` — package.json script names.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, nextVersion, readCanonical, stampAll } from "./version-lib";

const mode = process.argv[2] ?? "--patch";
const cur = readCanonical();
const next = nextVersion(cur, mode);

writeFileSync(join(ROOT, "VERSION"), next + "\n");
stampAll(next);
console.log(`${cur} -> ${next}`);
