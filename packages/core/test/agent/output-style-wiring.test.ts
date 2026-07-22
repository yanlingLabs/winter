import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "../../src/agent/context";
import { OutputStyleStore } from "../../src/agent/output-styles";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const trustStub = { isTrusted: (_d: string) => true } as any;
const skillsStub = { list: () => [], loadBody: () => null } as any;

// Mirror the daemon's styleResolver closure: name from a getter, resolved via the store; "default"/
// unset/unknown → null.
function styleResolver(store: OutputStyleStore, nameFor: (cwd: string | null) => string | undefined) {
  return (cwd: string | null) => {
    const name = nameFor(cwd);
    if (!name || name === "default") return null;
    return store.resolve(name, cwd);
  };
}

describe("daemon-style styleResolver wiring", () => {
  test("a set outputStyle selects the built-in overlay; unset is byte-identical", () => {
    const home = tmp("nh-");
    const store = new OutputStyleStore({ normaHome: home, trust: trustStub });
    let active: string | undefined = undefined;
    const asm = new ContextAssembler({ normaHome: home, trust: trustStub, skills: skillsStub, basePrompt: "BASE", styleResolver: styleResolver(store, () => active) });

    const off = asm.assemble({ cwd: null });
    expect(off.startsWith("BASE")).toBe(true);
    expect(off.includes("proactive mode")).toBe(false);

    active = "proactive";
    const on = asm.assemble({ cwd: null });
    expect(on.startsWith("BASE")).toBe(true);
    expect(on.includes("proactive mode")).toBe(true); // overlay injected, hot (no reconstruction)
  });
  test("an unknown style name → base prompt (fallback)", () => {
    const store = new OutputStyleStore({ normaHome: tmp("nh-"), trust: trustStub });
    const asm = new ContextAssembler({ normaHome: tmp("nh2-"), trust: trustStub, skills: skillsStub, basePrompt: "BASE", styleResolver: styleResolver(store, () => "does-not-exist") });
    expect(asm.assemble({ cwd: null }).startsWith("BASE")).toBe(true);
  });
});
