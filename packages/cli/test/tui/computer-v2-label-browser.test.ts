// ComputerV2 Phase 2: a browser tab's row label names the site `browsers.open("…")` opens (its host) and the tab's
// own verbs — "example.com · click, state" — never the script.
import { describe, expect, test } from "bun:test";
import { computerV2Label } from "../../src/tui/format";

const args = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("computerV2Label for browser tabs", () => {
  test("the host of browsers.open's URL is the label's site, beside the verbs", () => {
    expect(computerV2Label(args({ code: "const tab = await browsers.open('https://example.com/cart'); await tab.click(3); await tab.state();" }))).toBe("example.com · click, state");
  });
  test("a local dev server keeps its port; an app and a site both show; tab verbs are verbs", () => {
    expect(computerV2Label(args({ code: "await browsers.open(\"http://localhost:3000/\", { browser: 'chrome' }); await apps.open('Notes'); await t.goto(u); await t.text();" })))
      .toBe("localhost:3000, Notes · goto, text");
  });
  test("an interpolated or unparsable URL names no site", () => {
    expect(computerV2Label(args({ code: "await browsers.open(`https://${host}/`); await tab.upload(4, 'a.pdf');" }))).toBe("upload");
  });
});
