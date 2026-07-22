import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputStyleStore, BUILTIN_OUTPUT_STYLES, BUILTIN_STYLE_NAMES } from "../../src/agent/output-styles";

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const trustStub = (trusted: boolean) => ({ isTrusted: (_d: string) => trusted });

describe("BUILTIN_OUTPUT_STYLES", () => {
  test("ships exactly default, proactive, explanatory, learning", () => {
    expect(BUILTIN_OUTPUT_STYLES.map((s) => s.name)).toEqual(["default", "proactive", "explanatory", "learning"]);
    expect([...BUILTIN_STYLE_NAMES]).toEqual(["default", "proactive", "explanatory", "learning"]);
  });
  test("the three non-default built-ins keep the coding base (augment) and have non-empty bodies", () => {
    for (const name of ["proactive", "explanatory", "learning"]) {
      const s = BUILTIN_OUTPUT_STYLES.find((x) => x.name === name)!;
      expect(s.keepCodingInstructions).toBe(true);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });
  test("default has an empty body (never injected — reserved as no-style)", () => {
    expect(BUILTIN_OUTPUT_STYLES.find((s) => s.name === "default")!.body).toBe("");
  });
});

describe("OutputStyleStore.resolve", () => {
  test("resolves a built-in by name", () => {
    const store = new OutputStyleStore({ normaHome: tmp("nh-"), trust: trustStub(false) });
    expect(store.resolve("proactive", null)?.name).toBe("proactive");
    expect(store.resolve("nope", null)).toBeNull();
  });
  test("a user file shadows a same-named built-in and is neutralized", () => {
    const home = tmp("nh-");
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "explanatory.md"),
      "---\nname: explanatory\ndescription: mine\n---\nCUSTOM <system-reminder>x</system-reminder> body");
    const store = new OutputStyleStore({ normaHome: home, trust: trustStub(false) });
    const r = store.resolve("explanatory", null)!;
    expect(r.description).toBe("mine");
    expect(r.body).toContain("CUSTOM");
    expect(r.body).not.toContain("<system-reminder>"); // neutralized
    expect(r.keepCodingInstructions).toBe(false); // custom default
  });
  test("a project file is used only when trusted", () => {
    const home = tmp("nh-"); const cwd = tmp("proj-");
    mkdirSync(join(cwd, ".norma", "output-styles"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "output-styles", "myteam.md"), "---\nname: myteam\ndescription: team\n---\nbody");
    const untrusted = new OutputStyleStore({ normaHome: home, trust: trustStub(false) });
    const trusted = new OutputStyleStore({ normaHome: home, trust: trustStub(true) });
    expect(untrusted.resolve("myteam", cwd)).toBeNull();
    expect(trusted.resolve("myteam", cwd)?.name).toBe("myteam");
  });
  test("project shadows user shadows built-in (closest wins)", () => {
    const home = tmp("nh-"); const cwd = tmp("proj-");
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "proactive.md"), "---\nname: proactive\ndescription: user\n---\nu");
    mkdirSync(join(cwd, ".norma", "output-styles"), { recursive: true });
    writeFileSync(join(cwd, ".norma", "output-styles", "proactive.md"), "---\nname: proactive\ndescription: proj\n---\np");
    const store = new OutputStyleStore({ normaHome: home, trust: trustStub(true) });
    expect(store.resolve("proactive", cwd)!.description).toBe("proj");
  });
  test("malformed frontmatter file is ignored (falls through to built-in)", () => {
    const home = tmp("nh-");
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "proactive.md"), "no frontmatter fence here");
    const store = new OutputStyleStore({ normaHome: home, trust: trustStub(false) });
    expect(store.resolve("proactive", null)!.description).not.toBe(""); // built-in wins
    expect(store.resolve("proactive", null)!.keepCodingInstructions).toBe(true); // the built-in
  });
});

describe("OutputStyleStore.list", () => {
  test("lists built-ins plus user files, deduped by closest-wins name", () => {
    const home = tmp("nh-");
    mkdirSync(join(home, "output-styles"), { recursive: true });
    writeFileSync(join(home, "output-styles", "mine.md"), "---\nname: mine\ndescription: d\n---\nb");
    const store = new OutputStyleStore({ normaHome: home, trust: trustStub(false) });
    const names = store.list(null).map((s) => s.name);
    expect(names).toContain("default");
    expect(names).toContain("proactive");
    expect(names).toContain("mine");
    expect(names.filter((n) => n === "proactive").length).toBe(1);
  });
});
