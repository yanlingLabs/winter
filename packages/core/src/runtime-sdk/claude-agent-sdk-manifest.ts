// A TYPE-ONLY ambient declaration (this file has no import/export on purpose, so TypeScript reads it
// as a global script and the `declare module` below declares an ambient module; nothing ever
// imports this file at runtime). It is a `.ts`, not a `.d.ts`, because `packages/*/**/*.d.ts` is
// git-ignored as build output.
//
// The `@anthropic-ai/claude-agent-sdk` manifest, imported by `versions.ts` so the compiled daemon
// carries the wrapper's real version (A2). The package's `exports` map does not list
// `./package.json`, so TypeScript's bundler resolution refuses the subpath; bun resolves and embeds
// it regardless (measured in a `bun build --compile` binary). Only the fields this repo reads are
// declared.
declare module "@anthropic-ai/claude-agent-sdk/package.json" {
  const manifest: { readonly name: string; readonly version: string };
  export default manifest;
}
