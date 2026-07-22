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
