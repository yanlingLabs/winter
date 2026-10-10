// A Markdown file imported with `with { type: "text" }` is its text, embedded by `bun build` (and so by
// `bun build --compile`) at bundle time — the one way a compiled binary can carry a file of the repo with no
// path to find it by at run time. Bun's own types declare `*.txt`, `*.toml`… but not `*.md`.
// A `.ts` file on purpose (the repo ignores every `*.d.ts` under packages/ so tsc output never lands beside
// sources), with no import or export, so it is a global script: its ambient `declare module` is seen by
// every program that includes the importing module (core's and the CLI's) through the `/// <reference path>`
// in `migration/builtin-skills.ts`. It has no run-time code and nothing imports it.
declare module "*.md" {
  const text: string;
  export default text;
}
