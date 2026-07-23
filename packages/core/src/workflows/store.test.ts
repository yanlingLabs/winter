import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "./store";

function tmp() { const d = join(process.env.NORMA_TEST_TMP ?? "/tmp", `wf_${Math.random().toString(36).slice(2)}`); mkdirSync(d, { recursive: true }); return d; }
const wf = (name: string) => `export const meta = { name: "${name}", description: "does ${name}" };\nreturn 1;`;

test("project workflow resolves ONLY when the cwd is trusted; slug-guard rejects traversal", () => {
  const home = tmp(); const proj = tmp();
  mkdirSync(join(proj, ".norma", "workflows"), { recursive: true });
  writeFileSync(join(proj, ".norma", "workflows", "triage.js"), wf("triage"));
  const trusted = new Set<string>();
  const store = new WorkflowStore({ normaHome: home, trust: { isTrusted: (d) => trusted.has(d) } });
  expect(store.resolve("triage", proj)).toBeNull();       // untrusted → hidden
  trusted.add(proj);
  expect(store.resolve("triage", proj)?.name).toBe("triage");
  expect(store.resolve("../evil", proj)).toBeNull();      // slug-guard
});

test("user workflow is found; project shadows user (closest-wins)", () => {
  const home = tmp(); const proj = tmp();
  mkdirSync(join(home, "workflows"), { recursive: true });
  mkdirSync(join(proj, ".norma", "workflows"), { recursive: true });
  writeFileSync(join(home, "workflows", "t.js"), wf("t-user"));
  writeFileSync(join(proj, ".norma", "workflows", "t.js"), wf("t-proj"));
  const store = new WorkflowStore({ normaHome: home, trust: { isTrusted: () => true } });
  expect(store.resolve("t", proj)?.description).toBe("does t-proj");
});

test("save writes ~/.norma/workflows/<name>.js and rejects a bad slug", () => {
  const home = tmp();
  const store = new WorkflowStore({ normaHome: home, trust: { isTrusted: () => false } });
  store.save("mine", wf("mine"));
  expect(store.resolve("mine", null)?.name).toBe("mine");
  expect(() => store.save("../oops", wf("x"))).toThrow();
});

// SECURITY regressions: the meta block must be parsed as TEXT ONLY. It must never be handed to
// `new Function`/`eval`/`vm` — doing so would let ANY workflow file (a trusted project's, or any
// file dropped in ~/.norma/workflows/) run arbitrary code in the unsandboxed daemon merely by being
// *listed*, defeating the entire point of the workflow feature's sandboxed-subprocess architecture.

test("SECURITY: a statement outside the meta block is never executed by list/resolve/read", () => {
  const home = tmp();
  mkdirSync(join(home, "workflows"), { recursive: true });
  writeFileSync(
    join(home, "workflows", "pwned1.js"),
    'export const meta = { name: "pwned1", description: "y" };\nglobalThis.__WF_PWNED = true;\n',
  );
  delete (globalThis as Record<string, unknown>).__WF_PWNED;
  const store = new WorkflowStore({ normaHome: home, trust: { isTrusted: () => false } });

  store.list(null);
  expect((globalThis as Record<string, unknown>).__WF_PWNED).toBeUndefined();
  store.resolve("pwned1", null);
  expect((globalThis as Record<string, unknown>).__WF_PWNED).toBeUndefined();
  store.read("pwned1", null);
  expect((globalThis as Record<string, unknown>).__WF_PWNED).toBeUndefined();
});

test("SECURITY: a side-effecting expression used as a meta field's value is never executed; description still extracts, no crash", () => {
  const home = tmp();
  mkdirSync(join(home, "workflows"), { recursive: true });
  writeFileSync(
    join(home, "workflows", "pwned2.js"),
    'export const meta = { name: (globalThis.__WF_PWNED2 = true, "x"), description: "d" };\n',
  );
  delete (globalThis as Record<string, unknown>).__WF_PWNED2;
  const store = new WorkflowStore({ normaHome: home, trust: { isTrusted: () => false } });

  expect(() => store.list(null)).not.toThrow();
  expect((globalThis as Record<string, unknown>).__WF_PWNED2).toBeUndefined();

  expect(() => store.resolve("pwned2", null)).not.toThrow();
  expect((globalThis as Record<string, unknown>).__WF_PWNED2).toBeUndefined();

  expect(() => store.read("pwned2", null)).not.toThrow();
  expect((globalThis as Record<string, unknown>).__WF_PWNED2).toBeUndefined();

  // Graceful degradation: identity is ALWAYS the filename stem (never the meta's `name` field), so
  // a bogus/computed `name` expression can't crash resolution — and a well-formed sibling
  // `description` still extracts correctly even though `name` is garbage.
  const resolved = store.resolve("pwned2", null);
  expect(resolved?.name).toBe("pwned2");
  expect(resolved?.description).toBe("d");
});
