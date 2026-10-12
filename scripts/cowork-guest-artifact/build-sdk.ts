import { resolve } from 'node:path';
const [sdk, builder, out, base] = process.argv.slice(2);
if (!sdk || !builder || !out || !base) throw new Error('explicit SDK source/builder/output/verified Linux Bun base required');
const { buildRuntime } = await import(resolve(builder, 'scripts/build-runtime.ts'));
const result = await buildRuntime({ target: 'bun-linux-arm64', out, guestBaseExecutable: base, checkoutRoot: sdk });
console.log(JSON.stringify({compileSucceeded:true,canonicalBuilder:true,stdout:result.stdout,stderr:result.stderr}));
