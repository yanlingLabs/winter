// ComputerV2: the persistent-REPL transform (`computer-use/worker/repl.ts`) — top-level declarations become
// assignments to pre-seeded store names, line for line; nothing below depth 0 is touched.
import { describe, expect, test } from "bun:test";
import { prepareScript, ReplTransformError, tokenize } from "../../src/computer-use/worker/repl";

describe("prepareScript", () => {
  test("const / let / var become assignments, several declarators included", () => {
    const p = prepareScript("const x = 1, y = await f(2)\nlet z\nvar w = 3;");
    expect(p.body).toBe("; x = 1, y = await f(2);\n; z = undefined;\n; w = 3;");
    expect(p.names).toEqual(["x", "y", "z", "w"]);
  });

  test("destructuring: object patterns are parenthesized, every bound name is collected", () => {
    const p = prepareScript("const {a, b: [c], d = 4, ...rest} = o\nconst [p, , q = 3, ...r] = arr");
    expect(p.body).toBe("; ({a, b: [c], d = 4, ...rest} = o);\n; [p, , q = 3, ...r] = arr;");
    expect(p.names).toEqual(["a", "c", "d", "rest", "p", "q", "r"]);
  });

  test("a computed key and a string key bind only their targets", () => {
    const p = prepareScript("const {[k]: v, 'x-y': w} = o");
    expect(p.names).toEqual(["v", "w"]);
  });

  test("class declarations become assignments of a class expression, ended with a semicolon", () => {
    const p = prepareScript("class C extends Base { m() { const inner = 1; return inner } }\n(foo)()");
    expect(p.body).toBe(";C = class C extends Base { m() { const inner = 1; return inner } };\n(foo)()");
    expect(p.names).toEqual(["C"]);
  });

  test("function declarations stay in place (hoisted) and are listed for the store copy", () => {
    const p = prepareScript("function f() { const local = 2; return local }\nasync function* g() {}\nasync function h() {}");
    expect(p.body).toBe("function f() { const local = 2; return local }\nasync function* g() {}\nasync function h() {}");
    expect(p.functions).toEqual(["f", "g", "h"]);
    expect(p.names).toEqual([]);
  });

  test("nothing below the top level is rewritten: blocks, loops, functions, arrows, template expressions", () => {
    const src = "for (const i of [1]) { let j = i }\nif (x) { const blocked = 1 }\n{ const inBlock = 2 }\nconst g = () => { const inner = 3; return `${(() => { const t = 1; return t })()}` }";
    const p = prepareScript(src);
    expect(p.names).toEqual(["g"]);
    expect(p.body).toContain("for (const i of [1]) { let j = i }");
    expect(p.body).toContain("if (x) { const blocked = 1 }");
    expect(p.body).toContain("const inner = 3");
  });

  test("strings, templates, regex literals and comments do not confuse the depth", () => {
    const p = prepareScript("let s = 'a;b{', t = \"c,d}\", re = /a[,;{]b/g, u = `x${ {k: '}'}.k }y` // const fake = 1\n/* let alsoFake = 2 */ const real = 3");
    expect(p.names).toEqual(["s", "t", "re", "u", "real"]);
  });

  test("division is not a regex", () => {
    const p = prepareScript("const ratio = a / b / c\nconst next = 1");
    expect(p.names).toEqual(["ratio", "next"]);
  });

  test("automatic semicolons: a declaration ends where the next line cannot continue it", () => {
    const p = prepareScript("const fn = () => {\n  return 1\n}\nfoo()\nconst after = 2\nconst cont = a\n  + b");
    expect(p.names).toEqual(["fn", "after", "cont"]);
    expect(p.body).toBe("; fn = () => {\n  return 1\n};\nfoo()\n; after = 2;\n; cont = a\n  + b;");
  });

  test("export is dropped; import is refused", () => {
    expect(prepareScript("export const e = 1").body).toBe(" ; e = 1;");
    expect(() => prepareScript("import x from 'y'")).toThrow(ReplTransformError);
  });

  test("`let` used as an identifier is not a declaration", () => {
    expect(prepareScript("let = 5").names).toEqual([]);
  });

  test("the line structure is preserved exactly", () => {
    const src = "const a = 1\n\nlet {b} = o\nclass K {}\nfunction f() {}\nprint(a)";
    expect(prepareScript(src).body.split("\n").length).toBe(src.split("\n").length);
  });

  test("an unterminated literal is a transform error (the worker then tries the transpiler)", () => {
    expect(() => tokenize("const s = 'abc")).toThrow(ReplTransformError);
    expect(() => tokenize("const t = `abc")).toThrow(ReplTransformError);
  });
});
