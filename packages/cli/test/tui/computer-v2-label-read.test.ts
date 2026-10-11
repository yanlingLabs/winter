// ComputerV2 Phase 4: a `browsers.read("…")` names its site (the host) in the row label, beside the tabs and apps the
// script opens, in the order the script names them.
import { describe, expect, test } from "bun:test";
import { computerV2Label } from "../../src/tui/format";

const args = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("computerV2Label for browsers.read", () => {
  test("the host of each URL read is the label's site", () => {
    expect(computerV2Label(args({ code: "const r = await browsers.read('https://docs.example.com/api'); print(r.text)" }))).toBe("docs.example.com");
    expect(computerV2Label(args({ code: "await browsers.read(\"http://localhost:3000/health\"); const t = await browsers.open('https://example.com/'); await t.state()" })))
      .toBe("localhost:3000, example.com · state");
  });

  test("an interpolated URL names nothing; Promise.all over a list falls back to the verbs", () => {
    expect(computerV2Label(args({ code: "await browsers.read(`https://${host}/`)" }))).toBe("Using the computer");
    expect(computerV2Label(args({ code: "await Promise.all(urls.map((u) => browsers.read(u)))" }))).toBe("Using the computer");
  });
});
