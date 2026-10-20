import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
const [sdk, builder, out, base, entry] = process.argv.slice(2);
if (!sdk || !builder || !out || !base) throw new Error('explicit SDK source/builder/output/verified Linux Bun base required');
const { buildRuntime } = await import(resolve(builder, 'scripts/build-runtime.ts'));
// The canonical builder compiles ONE fixed entry (packages/runtime/src/main.ts) with its copy, flags and path checks. An optional entry, a path inside the
// SDK source, is compiled through that same builder: it gets an overlay checkout whose main.ts is a single import of the requested file. Nothing of the
// builder is copied or changed.
let checkoutRoot = sdk;
let overlay: string | undefined;
let shim: string | undefined;
if (entry) {
  if (!/^[A-Za-z0-9._\/-]+\.ts$/.test(entry) || entry.startsWith('/') || entry.split('/').includes('..') || !existsSync(join(sdk, entry))) throw new Error('entry must be an existing .ts file inside the SDK source');
  overlay = mkdtempSync(join(tmpdir(), 'winter-entry-overlay-'));
  const copied = spawnSync('rsync', ['-a', '--exclude', '.git', `${sdk}/`, `${overlay}/`], { encoding: 'utf8' });
  if (copied.status !== 0) throw new Error('overlay copy failed: ' + (copied.stderr || copied.stdout));
  shim = `import "${posix.relative('packages/runtime/src', entry)}";\n`;
  writeFileSync(join(overlay, 'packages/runtime/src/main.ts'), shim);
  checkoutRoot = overlay;
}
try {
  const result = await buildRuntime({ target: 'bun-linux-arm64', out, guestBaseExecutable: base, checkoutRoot });
  console.log(JSON.stringify({ compileSucceeded: true, canonicalBuilder: true, entry: entry ?? 'packages/runtime/src/main.ts', entryShimSha256: shim ? createHash('sha256').update(shim).digest('hex') : null, stdout: result.stdout, stderr: result.stderr }));
} finally {
  if (overlay) rmSync(overlay, { recursive: true, force: true });
}
