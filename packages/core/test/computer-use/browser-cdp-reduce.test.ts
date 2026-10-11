// ComputerV2 Phase 3 — `cdp-reduce.ts`: what of an event leaves the browser's process. The shared cases are the
// contract the extension (which bundles this file) and Winter.app's Swift twin both keep.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CDP_EVENT_ARRAY_MAX, CDP_EVENT_STRING_MAX } from "../../src/computer-use/browser/cdp-allowlist";
import { cdpEventParams } from "../../src/computer-use/browser/cdp-reduce";

interface Case { name: string; method: string; params: Record<string, unknown>; expected: Record<string, unknown> }
const cases = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "cdp-reduce-cases.json"), "utf8")) as { cases: Case[] }).cases;
const byName = (n: string): Case => cases.find((c) => c.name.startsWith(n))!;
const text = (v: unknown): string => JSON.stringify(v);

describe("cdpEventParams", () => {
  test("every shared case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) expect(cdpEventParams(c.method, c.params)).toEqual(c.expected);
  });

  test("Set-Cookie never crosses (and no other header but a download's type, name and size)", () => {
    const out = cdpEventParams("Fetch.requestPaused", byName("Fetch.requestPaused").params);
    expect(text(out).toLowerCase()).not.toContain("set-cookie");
    expect(text(out)).not.toContain("sid=");
    expect(text(out)).not.toContain("Authorization");
    expect((out.responseHeaders as Array<{ name: string }>).map((h) => h.name.toLowerCase()).sort()).toEqual(["content-disposition", "content-length", "content-type"]);
    expect((out.request as Record<string, unknown>).headers).toBeUndefined();
  });

  test("no header, cookie or post data from Network events", () => {
    for (const n of ["requestWillBeSent", "responseReceived"]) {
      const s = text(cdpEventParams(`Network.${n}`, byName(n).params));
      for (const bad of ["Cookie", "cookie", "Authorization", "postData", "hunter2", "headers", "securityDetails", "initiator"]) expect(s).not.toContain(bad);
    }
  });

  test("a console call's or an exception's page objects never cross", () => {
    for (const n of ["consoleAPICalled", "exceptionThrown"]) {
      const s = text(cdpEventParams(`Runtime.${n}`, byName(n).params));
      expect(s).not.toContain("objectId");
      expect(s).not.toContain("preview");
      expect(s).not.toContain("sk-123");
      expect(s).not.toContain("nested");
    }
  });

  test("caps: strings at CDP_EVENT_STRING_MAX, arrays at CDP_EVENT_ARRAY_MAX", () => {
    const log = cdpEventParams("Log.entryAdded", byName("Log.entryAdded").params) as { entry: { text: string } };
    expect(log.entry.text.length).toBe(CDP_EVENT_STRING_MAX);
    const con = cdpEventParams("Runtime.consoleAPICalled", byName("consoleAPICalled").params) as { stackTrace: { callFrames: unknown[] } };
    expect(con.stackTrace.callFrames.length).toBe(CDP_EVENT_ARRAY_MAX);
  });

  test("an unlisted event leaves whole; a missing param is simply absent", () => {
    const p = { frame: { id: "F" }, anything: [1, { a: 2 }] };
    expect(cdpEventParams("Page.frameNavigated", p)).toBe(p);
    expect(cdpEventParams("Network.loadingFinished", { requestId: "1" })).toEqual({ requestId: "1" });
    expect(cdpEventParams("Network.loadingFinished", undefined)).toEqual({});
  });

  test("a leaf never carries an object or an array", () => {
    expect(cdpEventParams("Network.requestWillBeSent", { requestId: { a: 1 }, request: { url: ["x"], method: "GET" } })).toEqual({ request: { method: "GET" } });
  });
});
